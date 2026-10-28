const crypto = require('crypto');
const {onCall, HttpsError} = require('firebase-functions/v2/https');
const {onDocumentCreated, onDocumentUpdated} = require('firebase-functions/v2/firestore');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const {setGlobalOptions} = require('firebase-functions/v2');
const {initializeApp} = require('firebase-admin/app');
const {getAuth: getAdminAuth} = require('firebase-admin/auth');
const {getFirestore, FieldValue} = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();
setGlobalOptions({maxInstances: 10, region: 'asia-south2'});

function requireAuth(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Please sign in first.');
  return request.auth;
}
function isAdmin(auth) { return Boolean(auth && auth.token && auth.token.admin === true); }
function requireAdmin(request) {
  const auth = requireAuth(request);
  if (!isAdmin(auth)) throw new HttpsError('permission-denied', 'Only a Pashughar administrator can perform this action.');
  return auth;
}
function asText(value, max = 250) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}
function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function cleanId(value, max = 160) { return asText(value, max).replace(/[/.#\[\]]/g, ''); }
function safeReason(value) {
  return ['suspected-scam','misleading-listing','fake-product','non-delivery','animal-welfare','prohibited-item','other'].includes(value) ? value : '';
}

/**
 * Guest-capable checkout. The frontend must call this function; never create orders
 * directly from the browser. Prices and stock come only from Firestore.
 * Required data: { items: [{ productId, quantity }], shipping: { name, phone, address, city, email? }, paymentMethod: 'cod' | 'contact_seller' }
 */
exports.createOrder = onCall(async (request) => {
  const auth = request.auth || null;
  const verifiedContact = Boolean(auth && (
    auth.token.email_verified === true
    || (typeof auth.token.phone_number === 'string' && auth.token.phone_number.trim().length > 0)
  ));
  if (!verifiedContact) {
    throw new HttpsError('unauthenticated', 'Verify your email or phone before placing an order. Phone OTP checkout does not require a password or separate sign-up form.');
  }
  const items = request.data && request.data.items;
  const shipping = request.data && request.data.shipping;
  const paymentMethod = request.data && request.data.paymentMethod;
  const clientRequestId = asText(request.data && request.data.clientRequestId, 100);

  if (!Array.isArray(items) || items.length < 1 || items.length > 30) {
    throw new HttpsError('invalid-argument', 'Add between 1 and 30 order lines.');
  }
  if (!shipping || !asText(shipping.name, 120) || !asText(shipping.phone, 40) || !asText(shipping.address, 300) || !asText(shipping.city, 100)) {
    throw new HttpsError('invalid-argument', 'Complete all required delivery details.');
  }
  if (!['cod', 'contact_seller'].includes(paymentMethod)) {
    throw new HttpsError('invalid-argument', 'Unsupported payment method.');
  }
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(clientRequestId)) {
    throw new HttpsError('invalid-argument', 'The order request ID is missing or invalid. Refresh checkout and try again.');
  }

  const consolidated = new Map();
  for (const item of items) {
    const productId = cleanId(item && item.productId, 160);
    const quantity = Number(item && item.quantity);
    if (!productId || !Number.isFinite(quantity) || quantity <= 0 || quantity > 1000 || Math.abs(quantity * 100 - Math.round(quantity * 100)) > 0.0001) {
      throw new HttpsError('invalid-argument', 'One or more product quantities are invalid.');
    }
    consolidated.set(productId, (consolidated.get(productId) || 0) + quantity);
  }
  if (consolidated.size !== items.length) throw new HttpsError('invalid-argument', 'Each product should appear once in the order.');

  const productRefs = [...consolidated.keys()].map(id => db.collection('products').doc(id));
  const orderRef = db.collection('orders').doc();
  const requestDocId = hash(`${auth ? auth.uid : 'guest'}:${clientRequestId}`);
  const requestRef = db.collection('orderRequests').doc(requestDocId);
  const retailerOrderRefs = new Map();

  return db.runTransaction(async (tx) => {
    const requestSnap = await tx.get(requestRef);
    if (requestSnap.exists) return { orderId: requestSnap.data().orderId, total: requestSnap.data().total, retailerCount: requestSnap.data().retailerCount, duplicateRequest: true };
    const settingsSnap = await tx.get(db.collection('platformSettings').doc('public'));
    const snapshots = [];
    for (const ref of productRefs) snapshots.push(await tx.get(ref));
    const retailerIds = [...new Set(snapshots.filter(s => s.exists).map(s => asText(s.data().retailerId, 160)).filter(Boolean))];
    const retailerRefs = retailerIds.map(id => db.collection('retailers').doc(id));
    const retailerSnapshots = [];
    for (const ref of retailerRefs) retailerSnapshots.push(await tx.get(ref));
    const retailerStatus = new Map(retailerSnapshots.map((snap, i) => [retailerIds[i], snap.exists ? snap.data().status : 'missing']));

    const resolvedItems = [];
    let total = 0;
    snapshots.forEach((snapshot, index) => {
      if (!snapshot.exists) throw new HttpsError('failed-precondition', 'A selected product no longer exists.');
      const product = snapshot.data();
      const quantity = consolidated.get(snapshot.id);
      if (product.status !== 'approved' || retailerStatus.get(product.retailerId) !== 'approved') {
        throw new HttpsError('failed-precondition', `${product.name || 'A product'} is not available.`);
      }
      if (!Number.isFinite(Number(product.stock)) || Number(product.stock) < quantity) throw new HttpsError('failed-precondition', `${product.name || 'A product'} does not have enough stock.`);
      if (!['kg','litre'].includes(String(product.unit||'').toLowerCase()) && !Number.isInteger(quantity)) throw new HttpsError('invalid-argument', `${product.name || 'This product'} must be ordered in whole units.`);
      if (typeof product.price !== 'number' || product.price <= 0) throw new HttpsError('failed-precondition', 'A product has an invalid price.');
      if (!product.retailerId) throw new HttpsError('failed-precondition', 'A product is missing its retailer assignment.');
      const lineTotal = Math.round(product.price * quantity * 100) / 100;
      total += lineTotal;
      resolvedItems.push({productId: snapshot.id, name: asText(product.name, 160), retailerId: product.retailerId, retailerName: asText(product.retailer, 160), quantity, unitPrice: product.price, lineTotal, unit: asText(product.unit, 30)});
    });
    const subtotal = Math.round(total * 100) / 100;
    const deliveryFee = Math.max(0, Number(settingsSnap.exists ? settingsSnap.data().deliveryCharge : 0) || 0);
    total = Math.round((subtotal + deliveryFee) * 100) / 100;
    if (!Number.isFinite(total) || total <= 0 || total > 100100000) throw new HttpsError('failed-precondition', 'The order total is invalid.');

    const grouped = new Map();
    for (const item of resolvedItems) {
      const group = grouped.get(item.retailerId) || [];
      group.push(item); grouped.set(item.retailerId, group);
    }
    for (const retailerId of grouped.keys()) retailerOrderRefs.set(retailerId, db.collection('retailerOrders').doc());

    resolvedItems.forEach((item, index) => {
      const original = snapshots[index].data();
      tx.update(productRefs[index], {stock: Math.round((Number(original.stock) - item.quantity) * 100) / 100, updatedAt: FieldValue.serverTimestamp()});
    });
    tx.create(orderRef, {
      customerId: auth ? auth.uid : null,
      customerEmail: asText((auth && auth.token.email) || shipping.email, 254),
      customerName: asText(shipping.name, 120),
      shipping: {name: asText(shipping.name, 120), phone: asText(shipping.phone, 40), address: asText(shipping.address, 300), city: asText(shipping.city, 100), email: asText(shipping.email || (auth && auth.token.email) || '', 254)},
      notes: asText(shipping.notes, 800),
      items: resolvedItems,
      productIds: resolvedItems.map(item => item.productId),
      deliveredProductIds: [],
      subtotal,
      deliveryFee,
      total,
      currency: 'NPR',
      paymentMethod,
      paymentStatus: 'unpaid',
      status: 'Pending',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    for (const [retailerId, retailerItems] of grouped) {
      tx.create(retailerOrderRefs.get(retailerId), {
        orderId: orderRef.id, retailerId, customerId: auth ? auth.uid : null,
        customerName: asText(shipping.name, 120),
        customerEmail: asText(shipping.email || (auth && auth.token.email) || '', 254),
        shipping: {name: asText(shipping.name, 120), phone: asText(shipping.phone, 40), address: asText(shipping.address, 300), city: asText(shipping.city, 100)},
        items: retailerItems,
        subtotal: Math.round(retailerItems.reduce((sum, i) => sum + i.lineTotal, 0) * 100) / 100,
        paymentMethod, status: 'Pending', createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
      });
    }
    tx.create(requestRef, {orderId: orderRef.id, total, retailerCount: grouped.size, createdAt: FieldValue.serverTimestamp()});
    return {orderId: orderRef.id, total, retailerCount: grouped.size, duplicateRequest: false};
  });
});

/**
 * Submit a public, guest-capable report from the product page. Before production,
 * enable Firebase App Check, tune rate limits and monitor abuse. Reporter contact is private.
 */
exports.submitReport = onCall(async (request) => {
  const productId = cleanId(request.data && request.data.productId, 160);
  const reason = safeReason(asText(request.data && request.data.reason, 40));
  const details = asText(request.data && request.data.details, 1800);
  const reporterName = asText(request.data && request.data.reporterName, 100) || 'Guest shopper';
  const reporterContact = asText(request.data && request.data.reporterContact, 150);
  if (!productId || !reason || details.length < 10) throw new HttpsError('invalid-argument', 'Choose a valid report reason and provide at least 10 characters of detail.');

  const productRef = db.collection('products').doc(productId);
  const reportRef = db.collection('reports').doc();
  const clientIp = asText(request.rawRequest && request.rawRequest.ip, 120);
  const rateRef = clientIp ? db.collection('reportRateLimits').doc(hash(`report-ip:${clientIp}`)) : null;
  const dedupeKey = reporterContact ? hash(`${productId}:${reporterContact.toLowerCase()}:${reason}`) : '';
  const dedupeRef = dedupeKey ? db.collection('reportDedupe').doc(dedupeKey) : null;
  const reasonLabels = {
    'suspected-scam': 'Suspected scam or fraud', 'misleading-listing': 'Misleading description or price',
    'fake-product': 'Fake or misrepresented product', 'non-delivery': 'Order not delivered',
    'animal-welfare': 'Animal welfare concern', 'prohibited-item': 'Prohibited or unsafe listing', other: 'Other concern'
  };

  return db.runTransaction(async tx => {
    const productSnap = await tx.get(productRef);
    if (!productSnap.exists) throw new HttpsError('not-found', 'This listing no longer exists.');
    const product = productSnap.data();
    if (product.status !== 'approved') throw new HttpsError('failed-precondition', 'This listing is not available for reporting.');
    const retailerRef = product.retailerId ? db.collection('retailers').doc(product.retailerId) : null;
    const retailerSnap = retailerRef ? await tx.get(retailerRef) : null;
    if (!retailerSnap || !retailerSnap.exists || retailerSnap.data().status !== 'approved') throw new HttpsError('failed-precondition', 'This retailer is not currently verified.');
    const rateSnap = rateRef ? await tx.get(rateRef) : null;
    const dedupeSnap = dedupeRef ? await tx.get(dedupeRef) : null;

    const nowMs = Date.now();
    if (rateSnap && rateSnap.exists) {
      const rate = rateSnap.data();
      const windowStart = Number(rate.windowStartMs || 0);
      const count = nowMs - windowStart < 10 * 60 * 1000 ? Number(rate.count || 0) : 0;
      if (count >= 5) throw new HttpsError('resource-exhausted', 'Too many reports submitted in a short period. Please try again later.');
    }
    if (dedupeSnap && dedupeSnap.exists && dedupeSnap.data().isOpen === true) {
      throw new HttpsError('already-exists', 'A similar report for this listing is already open from this contact.');
    }

    const reportData = {
      productId, productName: asText(product.name, 160), category: asText(product.category, 80),
      retailerId: asText(product.retailerId, 160), retailerName: asText(product.retailer, 160),
      location: asText(product.location, 160), reason, reasonLabel: reasonLabels[reason],
      details, reporterName, reporterContact, reporterContactNormalized: reporterContact.toLowerCase(),
      reporterUid: request.auth ? request.auth.uid : null,
      status: 'open', dedupeKey: dedupeKey || null,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
    };
    tx.create(reportRef, reportData);
    if (dedupeRef) tx.set(dedupeRef, {isOpen: true, reportId: reportRef.id, updatedAt: FieldValue.serverTimestamp()});
    if (rateRef) {
      const rate = rateSnap && rateSnap.exists ? rateSnap.data() : {};
      const sameWindow = nowMs - Number(rate.windowStartMs || 0) < 10 * 60 * 1000;
      tx.set(rateRef, {windowStartMs: sameWindow ? Number(rate.windowStartMs) : nowMs, count: sameWindow ? Number(rate.count || 0) + 1 : 1, updatedAt: FieldValue.serverTimestamp()});
    }
    return {reportId: reportRef.id, status: 'open'};
  });
});

/** Admin-only one-time shop verification and retailer suspension/removal. */
exports.moderateRetailer = onCall(async request => {
  const auth = requireAdmin(request);
  const retailerId = cleanId(request.data && request.data.retailerId, 160);
  const decision = asText(request.data && request.data.decision, 20);
  const reason = asText(request.data && request.data.reason, 500);
  if (!retailerId || !['approved','rejected','suspended','banned'].includes(decision)) throw new HttpsError('invalid-argument', 'Invalid retailer decision.');
  const retailerRef = db.collection('retailers').doc(retailerId);
  const retailerSnap = await retailerRef.get();
  if (!retailerSnap.exists) throw new HttpsError('not-found', 'Retailer profile not found.');
  const previousStatus = retailerSnap.data().status;
  await retailerRef.update({status: decision, statusReason: reason || null, reviewedBy: auth.uid, reviewedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()});

  // Update linked product states in bounded batches. The retailer status is changed first;
  // Firestore Rules also refuse public reads while the retailer is not approved.
  const products = await db.collection('products').where('retailerId', '==', retailerId).get();
  let batch = db.batch(); let count = 0;
  for (const doc of products.docs) {
    const data = doc.data();
    let next = null;
    if (['rejected','suspended','banned'].includes(decision) && data.status === 'approved') next = {status:'suspended', suspensionCause:'retailer', updatedAt:FieldValue.serverTimestamp()};
    if (decision === 'approved' && data.status === 'suspended' && data.suspensionCause === 'retailer') next = {status:'approved', suspensionCause:FieldValue.delete(), updatedAt:FieldValue.serverTimestamp()};
    if (next) { batch.update(doc.ref, next); count++; }
    if (count && count % 400 === 0) { await batch.commit(); batch = db.batch(); }
  }
  if (count % 400) await batch.commit();
  await db.collection('auditLogs').add({actorId:auth.uid, action:`retailer_${decision}`, targetId:retailerId, previousStatus, reason, createdAt:FieldValue.serverTimestamp()});
  return {retailerId, status:decision, productsUpdated:count};
});

/** Admin-only product suspension/restoration or permanent removal. */
exports.moderateProduct = onCall(async request => {
  const auth = requireAdmin(request);
  const productId = cleanId(request.data && request.data.productId, 160);
  const decision = asText(request.data && request.data.decision, 20);
  const reason = asText(request.data && request.data.reason, 500);
  if (!productId || !['approved','rejected','suspended'].includes(decision)) throw new HttpsError('invalid-argument', 'Invalid product decision.');
  const ref = db.collection('products').doc(productId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Product not found.');
  if (decision === 'approved') {
    const retailer = await db.collection('retailers').doc(snap.data().retailerId).get();
    if (!retailer.exists || retailer.data().status !== 'approved') throw new HttpsError('failed-precondition', 'The retailer must be verified before restoring this product.');
  }
  await ref.update({status:decision, adminReason:reason || null, reviewedBy:auth.uid, reviewedAt:FieldValue.serverTimestamp(), updatedAt:FieldValue.serverTimestamp()});
  await db.collection('auditLogs').add({actorId:auth.uid, action:`product_${decision}`, targetId:productId, reason, createdAt:FieldValue.serverTimestamp()});
  return {productId, status:decision};
});

exports.removeProduct = onCall(async request => {
  const auth = requireAdmin(request);
  const productId = cleanId(request.data && request.data.productId, 160);
  if (!productId) throw new HttpsError('invalid-argument', 'Product ID is required.');
  const ref = db.collection('products').doc(productId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Product not found.');
  await ref.delete();
  await db.collection('auditLogs').add({actorId:auth.uid, action:'product_removed', targetId:productId, productName:asText(snap.data().name,160), createdAt:FieldValue.serverTimestamp()});
  return {productId, removed:true};
});

/** Admin-only report status management; resolved/dismissed reports leave the live count but remain in history. */
exports.moderateReport = onCall(async request => {
  const auth = requireAdmin(request);
  const reportId = cleanId(request.data && request.data.reportId, 160);
  const decision = asText(request.data && request.data.decision, 20);
  const resolutionNote = asText(request.data && request.data.resolutionNote, 1000);
  if (!reportId || !['reviewing','resolved','dismissed'].includes(decision)) throw new HttpsError('invalid-argument', 'Invalid report action.');
  const ref = db.collection('reports').doc(reportId);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Report not found.');
    const data = snap.data();
    const lockRef = data.dedupeKey ? db.collection('reportDedupe').doc(data.dedupeKey) : null;
    const lockSnap = lockRef ? await tx.get(lockRef) : null;
    tx.update(ref, {status:decision, resolutionNote:resolutionNote || null, reviewedBy:auth.uid, reviewedAt:FieldValue.serverTimestamp(), updatedAt:FieldValue.serverTimestamp()});
    if (lockRef && lockSnap && lockSnap.exists && decision !== 'reviewing') tx.update(lockRef, {isOpen:false, updatedAt:FieldValue.serverTimestamp()});
    tx.create(db.collection('auditLogs').doc(), {actorId:auth.uid, action:`report_${decision}`, targetId:reportId, reason:resolutionNote, createdAt:FieldValue.serverTimestamp()});
  });
  return {reportId, status:decision};
});

/**
 * Update one retailer-specific order. A retailer can update only their own sub-order;
 * the order state is checked server-side and cannot be edited directly from the browser.
 */
exports.updateRetailerOrderStatus = onCall(async request => {
  const auth = requireAuth(request);
  const retailerOrderId = cleanId(request.data && request.data.retailerOrderId, 160);
  const status = asText(request.data && request.data.status, 30);
  const allowed = ['Pending','Confirmed','Rejected','Processing','Shipped','Delivered','Cancelled'];
  if (!retailerOrderId || !allowed.includes(status)) throw new HttpsError('invalid-argument', 'Invalid retailer order or status.');
  const ref = db.collection('retailerOrders').doc(retailerOrderId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Order not found.');
  const order = snap.data();
  if (!isAdmin(auth) && order.retailerId !== auth.uid) throw new HttpsError('permission-denied', 'You can update only orders assigned to your shop.');
  if (['Cancelled','Delivered'].includes(order.status) && order.status !== status) {
    throw new HttpsError('failed-precondition', 'A cancelled or delivered order is final. Contact support if it needs correction.');
  }
  await ref.update({status, statusUpdatedBy: auth.uid, updatedAt: FieldValue.serverTimestamp()});
  if (order.orderId) {
    const siblings = await db.collection('retailerOrders').where('orderId', '==', order.orderId).get();
    const statusById = new Map(siblings.docs.map(doc => [doc.id, doc.id === retailerOrderId ? status : doc.data().status]));
    const states = [...statusById.values()];
    let masterStatus = 'Pending';
    if (states.length && states.every(value => value === 'Delivered')) masterStatus = 'Delivered';
    else if (states.length && states.every(value => value === 'Cancelled' || value === 'Rejected')) masterStatus = 'Cancelled';
    else if (states.some(value => value !== 'Pending')) masterStatus = 'Partially fulfilled';
    const deliveredProductIds = [...new Set(siblings.docs
      .filter(doc => statusById.get(doc.id) === 'Delivered')
      .flatMap(doc => (doc.data().items || []).map(item => asText(item.productId,160)).filter(Boolean)))];
    await db.collection('orders').doc(order.orderId).update({
      status: masterStatus,
      deliveredProductIds,
      updatedAt: FieldValue.serverTimestamp()
    });
  }
  await db.collection('auditLogs').add({actorId: auth.uid, action:'retailer_order_status_updated', targetId: retailerOrderId, status, createdAt: FieldValue.serverTimestamp()});
  return {retailerOrderId, status};
});

/*
 * Set the admin custom claim only from a trusted environment, never a public client:
 * getAuth().setCustomUserClaims(userUid, {admin:true});
 * A deployed admin dashboard must rely on that claim plus Firestore Rules/Functions.
 */


/**
 * Private in-site notifications. Writes are made only by trusted server triggers;
 * notification documents contain minimal copy and never expose another user's record.
 */
async function createUserNotification(userId, eventKey, payload) {
  if (!userId || typeof userId !== 'string') return;
  const id = hash(userId + ':' + eventKey).slice(0, 48);
  const ref = db.collection('notifications').doc(id);
  await db.runTransaction(async tx => {
    const existing = await tx.get(ref);
    if (existing.exists) return;
    tx.create(ref, {
      userId,
      title: asText(payload.title, 120) || 'Pashughar update',
      message: asText(payload.message, 700),
      kind: asText(payload.kind, 40) || 'update',
      href: asText(payload.href, 220),
      read: false,
      createdAt: FieldValue.serverTimestamp()
    });
  });
}

exports.notifyCustomerNewOrder = onDocumentCreated('orders/{orderId}', async event => {
  const order = event.data && event.data.data();
  if (!order || !order.customerId) return;
  await createUserNotification(order.customerId, 'order-created-' + event.params.orderId, {
    title: 'Order placed',
    message: 'Your order ' + event.params.orderId.slice(-8).toUpperCase() + ' was placed. Current status: ' + (order.status || 'Pending') + '.',
    kind: 'order',
    href: '#orders'
  });
});

exports.notifyCustomerOrderStatus = onDocumentUpdated('orders/{orderId}', async event => {
  const before = event.data && event.data.before.data();
  const after = event.data && event.data.after.data();
  if (!before || !after || !after.customerId || before.status === after.status) return;
  await createUserNotification(after.customerId, 'order-status-' + event.id, {
    title: 'Order status updated',
    message: 'Order ' + event.params.orderId.slice(-8).toUpperCase() + ' is now ' + asText(after.status, 60) + '.',
    kind: 'order',
    href: '#orders'
  });
});

exports.notifyWishlistProductChanges = onDocumentUpdated('products/{productId}', async event => {
  const before = event.data && event.data.before.data();
  const after = event.data && event.data.after.data();
  if (!before || !after || after.status !== 'approved') return;
  const notices = [];
  if (Number(after.price) > 0 && Number(before.price) > Number(after.price)) {
    notices.push({key:'price-drop', title:'A saved item is cheaper', message:asText(after.name,120) + ' now costs Rs. ' + Number(after.price).toLocaleString('en-IN') + ' (previously Rs. ' + Number(before.price).toLocaleString('en-IN') + ').', kind:'price-drop'});
  }
  if (Number(before.stock) <= 0 && Number(after.stock) > 0) {
    notices.push({key:'restocked', title:'A saved item is back in stock', message:asText(after.name,120) + ' is available again.', kind:'back-in-stock'});
  }
  if (!notices.length) return;
  const saved = await db.collection('wishlists').where('productIds', 'array-contains', event.params.productId).get();
  await Promise.all(saved.docs.flatMap(item => notices.map(n => createUserNotification(item.id, n.key + '-' + event.id, {
    title:n.title, message:n.message, kind:n.kind, href:'#wishlist'
  }))));
});

exports.notifyCustomerEnquiryReply = onDocumentUpdated('enquiries/{enquiryId}', async event => {
  const before = event.data && event.data.before.data();
  const after = event.data && event.data.after.data();
  if (!before || !after || !after.customerUid) return;
  if (String(before.reply || '') === String(after.reply || '') || !String(after.reply || '').trim()) return;
  // Modern seller chat already creates a message-triggered notification. Avoid double
  // notifying the customer when the parent enquiry's compatibility reply field is updated.
  const matchingChat = await db.collection('enquiries').doc(event.params.enquiryId)
    .collection('messages').where('message', '==', String(after.reply || '')).where('senderRole', '==', 'retailer').limit(1).get();
  if (!matchingChat.empty) return;
  await createUserNotification(after.customerUid, 'enquiry-reply-' + event.id, {
    title:'Seller replied to your enquiry',
    message:'The seller replied about ' + asText(after.productName || 'your listing enquiry', 140) + '.',
    kind:'enquiry',
    href:'#enquiries'
  });
});

exports.notifyEnquiryChatParticipant = onDocumentCreated('enquiries/{enquiryId}/messages/{messageId}', async event => {
  const message = event.data && event.data.data();
  if (!message) return;
  const enquirySnap = await db.collection('enquiries').doc(event.params.enquiryId).get();
  if (!enquirySnap.exists) return;
  const enquiry = enquirySnap.data();
  const recipient = message.senderUid === enquiry.customerUid ? enquiry.retailerId : enquiry.customerUid;
  if (!recipient || recipient === message.senderUid) return;
  await createUserNotification(recipient, 'enquiry-message-' + event.id, {
    title:'New message about a listing',
    message:'A new message was sent about ' + asText(enquiry.productName || 'a listing', 140) + '.',
    kind:'chat',
    href:recipient === enquiry.customerUid ? '#enquiries' : '#seller'
  });
});

exports.notifyVetAppointmentCreated = onDocumentCreated('vetAppointments/{appointmentId}', async event => {
  const appointment = event.data && event.data.data();
  if (!appointment) return;
  await Promise.all([
    createUserNotification(appointment.vetId, 'vet-request-' + event.id, {
      title:'New veterinary appointment request',
      message:asText(appointment.customerName || 'A customer', 100) + ' requested ' + asText(appointment.date, 20) + ' at ' + asText(appointment.time, 10) + '.',
      kind:'vet-appointment', href:'#seller'
    }),
    createUserNotification(appointment.customerUid, 'vet-request-confirmation-' + event.id, {
      title:'Veterinary request submitted',
      message:'Your request with ' + asText(appointment.vetName || 'the clinic', 120) + ' for ' + asText(appointment.date, 20) + ' at ' + asText(appointment.time, 10) + ' is pending confirmation.',
      kind:'vet-appointment', href:'#appointments'
    })
  ]);
});

exports.notifyVetAppointmentStatus = onDocumentUpdated('vetAppointments/{appointmentId}', async event => {
  const before = event.data && event.data.before.data();
  const after = event.data && event.data.after.data();
  if (!before || !after || before.status === after.status) return;
  if (after.customerUid) await createUserNotification(after.customerUid, 'vet-status-customer-' + event.id, {
    title:'Veterinary appointment updated',
    message:asText(after.vetName || 'Your veterinary clinic', 120) + ': appointment ' + asText(after.status, 30) + ' for ' + asText(after.date, 20) + ' at ' + asText(after.time, 10) + '.',
    kind:'vet-appointment',
    href:'#appointments'
  });
  if (before.status !== 'cancelled' && after.status === 'cancelled' && after.vetId) await createUserNotification(after.vetId, 'vet-cancel-vet-' + event.id, {
    title:'Veterinary appointment cancelled',
    message:asText(after.customerName || 'A customer', 100) + ' cancelled the appointment for ' + asText(after.date, 20) + ' at ' + asText(after.time, 10) + '.',
    kind:'vet-appointment',
    href:'#seller'
  });
});

/**
 * Scheduled reminder notices are in-app reminders. Two reminder windows are supported
 * (roughly 24 hours and 1 hour before an appointment); notification IDs are idempotent.
 */
exports.sendVetAppointmentReminders = onSchedule('every 15 minutes', async () => {
  const now = Date.now();
  const appointments = await db.collection('vetAppointments').where('status', '==', 'confirmed').limit(500).get();
  for (const appointmentDoc of appointments.docs) {
    const appointment = appointmentDoc.data();
    const start = new Date(appointment.startAt || (appointment.date + 'T' + appointment.time + ':00')).getTime();
    if (!Number.isFinite(start) || start <= now) continue;
    const remaining = start - now;
    const reminder = remaining >= (23.75 * 60 * 60 * 1000) && remaining <= (24.25 * 60 * 60 * 1000) ? '24h'
      : remaining >= (45 * 60 * 1000) && remaining <= (75 * 60 * 1000) ? '1h' : '';
    if (!reminder) continue;
    let claimed = false;
    await db.runTransaction(async tx => {
      const fresh = await tx.get(appointmentDoc.ref);
      if (!fresh.exists || fresh.data().status !== 'confirmed') return;
      const sent = fresh.data().remindersSent || [];
      if (sent.includes(reminder)) return;
      tx.update(appointmentDoc.ref, {remindersSent:[...sent, reminder], updatedAt:FieldValue.serverTimestamp()});
      claimed = true;
    });
    if (claimed) await createUserNotification(appointment.customerUid, 'vet-reminder-' + appointmentDoc.id + '-' + reminder, {
      title:reminder === '24h' ? 'Veterinary appointment tomorrow' : 'Veterinary appointment in about one hour',
      message:asText(appointment.vetName || 'Veterinary clinic', 120) + ' · ' + asText(appointment.date, 20) + ' at ' + asText(appointment.time, 10) + '.',
      kind:'vet-reminder',
      href:'#appointments'
    });
  }
});


function validateVetSlot(date, time) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new HttpsError('invalid-argument', 'Choose a valid appointment date.');
  }
  if (typeof time !== 'string' || !/^(?:09|1[0-6]):(?:00|30)$/.test(time)) {
    throw new HttpsError('invalid-argument', 'Choose a listed half-hour slot between 09:00 and 16:30 Nepal time.');
  }
  const [year, month, day] = date.split('-').map(Number);
  const daysInMonth = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
  if (!daysInMonth || day < 1 || day > daysInMonth) throw new HttpsError('invalid-argument', 'Choose a real calendar date.');
  const startAt = new Date(date + 'T' + time + ':00+05:45');
  if (!Number.isFinite(startAt.getTime()) || startAt.getTime() <= Date.now()) {
    throw new HttpsError('failed-precondition', 'Appointment must be scheduled for a future time.');
  }
  return startAt;
}
function vetSlotKey(vetId, date, time) {
  return hash(vetId + ':' + date + ':' + time).slice(0, 40);
}
function vetAppointmentInput(request) {
  const auth = requireAuth(request);
  if (!(auth.token.email_verified === true || (typeof auth.token.phone_number === 'string' && auth.token.phone_number.trim()))) {
    throw new HttpsError('failed-precondition', 'Verify your email or phone number before booking.');
  }
  const vetId = cleanId(request.data && request.data.vetId, 160);
  const date = asText(request.data && request.data.date, 10);
  const time = asText(request.data && request.data.time, 5);
  const reason = asText(request.data && request.data.reason, 1000);
  if (!vetId || reason.length < 5) throw new HttpsError('invalid-argument', 'Choose a clinic and describe the reason for the visit.');
  const startAt = validateVetSlot(date, time);
  return {auth, vetId, date, time, reason, startAt, slotKey:vetSlotKey(vetId,date,time)};
}

exports.createVetAppointment = onCall(async request => {
  const input = vetAppointmentInput(request);
  const appointmentRef = db.collection('vetAppointments').doc();
  const slotRef = db.collection('vetAppointmentSlots').doc(input.slotKey);
  await db.runTransaction(async tx => {
    const [slotSnap, vetSnap, retailerSnap] = await Promise.all([
      tx.get(slotRef), tx.get(db.collection('publicStores').doc(input.vetId)), tx.get(db.collection('retailers').doc(input.vetId))
    ]);
    if (!vetSnap.exists || vetSnap.data().isVet !== true || !retailerSnap.exists || retailerSnap.data().status !== 'approved') throw new HttpsError('failed-precondition', 'This veterinary clinic is not currently accepting appointments.');
    if (slotSnap.exists) throw new HttpsError('already-exists', 'That time slot is already requested. Choose another.');
    const vet = vetSnap.data();
    const customerName = asText(input.auth.token.name || input.auth.token.email || input.auth.token.phone_number || 'Customer', 120);
    tx.create(slotRef, {vetId:input.vetId,date:input.date,time:input.time,appointmentId:appointmentRef.id,createdAt:FieldValue.serverTimestamp()});
    tx.create(appointmentRef, {
      customerUid:input.auth.uid, customerName, vetId:input.vetId,
      vetName:asText(vet.storeName || 'Veterinary clinic',120),
      date:input.date,time:input.time,startAt:input.startAt.toISOString(),
      slotKey:input.slotKey,reason:input.reason,status:'pending',
      remindersSent:[],createdAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()
    });
  });
  return {appointmentId:appointmentRef.id,status:'pending'};
});

exports.cancelVetAppointment = onCall(async request => {
  const auth = requireAuth(request);
  const appointmentId = cleanId(request.data && request.data.appointmentId, 160);
  if (!appointmentId) throw new HttpsError('invalid-argument', 'Appointment ID is required.');
  const ref = db.collection('vetAppointments').doc(appointmentId);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Appointment not found.');
    const appointment = snap.data();
    if (appointment.customerUid !== auth.uid && !isAdmin(auth)) throw new HttpsError('permission-denied', 'You can cancel only your own appointment.');
    if (!['pending','confirmed'].includes(appointment.status)) throw new HttpsError('failed-precondition', 'This appointment can no longer be cancelled.');
    const slotRef = appointment.slotKey ? db.collection('vetAppointmentSlots').doc(appointment.slotKey) : null;
    const slotSnap = slotRef ? await tx.get(slotRef) : null;
    tx.update(ref,{status:'cancelled',updatedAt:FieldValue.serverTimestamp()});
    if (slotRef && slotSnap && slotSnap.exists && slotSnap.data().appointmentId === appointmentId) tx.delete(slotRef);
  });
  return {appointmentId,status:'cancelled'};
});

exports.rescheduleVetAppointment = onCall(async request => {
  const auth = requireAuth(request);
  const appointmentId = cleanId(request.data && request.data.appointmentId,160);
  const date = asText(request.data && request.data.date,10);
  const time = asText(request.data && request.data.time,5);
  const startAt = validateVetSlot(date,time);
  if (!appointmentId) throw new HttpsError('invalid-argument','Appointment ID is required.');
  const oldRef = db.collection('vetAppointments').doc(appointmentId);
  const newRef = db.collection('vetAppointments').doc();
  await db.runTransaction(async tx => {
    const oldSnap = await tx.get(oldRef);
    if (!oldSnap.exists) throw new HttpsError('not-found','Appointment not found.');
    const old = oldSnap.data();
    if (old.customerUid !== auth.uid) throw new HttpsError('permission-denied','You can reschedule only your own appointment.');
    if (!['pending','confirmed'].includes(old.status)) throw new HttpsError('failed-precondition','This appointment can no longer be rescheduled.');
    const newKey = vetSlotKey(old.vetId,date,time);
    const oldSlotRef = old.slotKey ? db.collection('vetAppointmentSlots').doc(old.slotKey) : null;
    const newSlotRef = db.collection('vetAppointmentSlots').doc(newKey);
    const oldSlotSnap = oldSlotRef ? await tx.get(oldSlotRef) : null;
    const newSlotSnap = await tx.get(newSlotRef);
    if (newSlotSnap.exists) throw new HttpsError('already-exists','That time slot is already requested. Choose another.');
    tx.update(oldRef,{status:'cancelled',updatedAt:FieldValue.serverTimestamp()});
    if (oldSlotRef && oldSlotSnap && oldSlotSnap.exists && oldSlotSnap.data().appointmentId === appointmentId) tx.delete(oldSlotRef);
    tx.create(newSlotRef,{vetId:old.vetId,date,time,appointmentId:newRef.id,createdAt:FieldValue.serverTimestamp()});
    tx.create(newRef,{
      ...old,date,time,startAt:startAt.toISOString(),slotKey:newKey,status:'pending',
      rescheduledFrom:appointmentId,remindersSent:[],createdAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()
    });
  });
  return {appointmentId:newRef.id,status:'pending'};
});

exports.updateVetAppointmentStatus = onCall(async request => {
  const auth = requireAuth(request);
  const appointmentId = cleanId(request.data && request.data.appointmentId,160);
  const status = asText(request.data && request.data.status,20);
  if (!appointmentId || !['confirmed','declined','completed','cancelled'].includes(status)) throw new HttpsError('invalid-argument','Choose a valid appointment status.');
  const ref = db.collection('vetAppointments').doc(appointmentId);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found','Appointment not found.');
    const appointment = snap.data();
    const admin = isAdmin(auth);
    if (!admin && appointment.vetId !== auth.uid) throw new HttpsError('permission-denied','You can manage only appointments assigned to your clinic.');
    if (!admin) {
      const retailerSnap = await tx.get(db.collection('retailers').doc(auth.uid));
      if (!retailerSnap.exists || retailerSnap.data().status !== 'approved') throw new HttpsError('permission-denied','An approved veterinary retailer account is required.');
    }
    const transitions = {pending:['confirmed','declined','cancelled'],confirmed:['completed','cancelled'],declined:[],completed:[],cancelled:[]};
    if (!(transitions[appointment.status] || []).includes(status)) throw new HttpsError('failed-precondition','This appointment status transition is not allowed.');
    const slotRef = appointment.slotKey ? db.collection('vetAppointmentSlots').doc(appointment.slotKey) : null;
    const slotSnap = slotRef ? await tx.get(slotRef) : null;
    tx.update(ref,{status,updatedAt:FieldValue.serverTimestamp(),statusUpdatedBy:auth.uid});
    if (['declined','cancelled'].includes(status) && slotRef && slotSnap && slotSnap.exists && slotSnap.data().appointmentId === appointmentId) tx.delete(slotRef);
  });
  return {appointmentId,status};
});


exports.getVetUnavailableSlots = onCall(async request => {
  requireAuth(request);
  const vetId = cleanId(request.data && request.data.vetId, 160);
  const date = asText(request.data && request.data.date, 10);
  if (!vetId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new HttpsError('invalid-argument', 'Choose a veterinary clinic and a valid date.');
  }
  const [year, month, day] = date.split('-').map(Number);
  const daysInMonth = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
  if (!daysInMonth || day < 1 || day > daysInMonth) throw new HttpsError('invalid-argument', 'Choose a real calendar date.');
  const todayNepal = new Date(Date.now() + (5 * 60 + 45) * 60 * 1000).toISOString().slice(0, 10);
  if (date < todayNepal) throw new HttpsError('failed-precondition', 'Choose today or a future date.');
  const [storeSnap, retailerSnap] = await Promise.all([
    db.collection('publicStores').doc(vetId).get(),
    db.collection('retailers').doc(vetId).get()
  ]);
  if (!storeSnap.exists || storeSnap.data().isVet !== true || !retailerSnap.exists || retailerSnap.data().status !== 'approved') {
    throw new HttpsError('failed-precondition', 'This veterinary clinic is not available for appointments.');
  }
  const slots = await db.collection('vetAppointmentSlots')
    .where('vetId', '==', vetId).where('date', '==', date).get();
  return {unavailable: slots.docs.map(slot => asText(slot.data().time, 5)).filter(Boolean)};
});


/** Admin-only user directory. Never expose this endpoint to ordinary users. */
exports.listAdminUsers = onCall(async request => {
  requireAdmin(request);
  const auth = getAdminAuth();
  const listed = await auth.listUsers(1000);
  const userRecords = listed.users;
  const profileDocs = [];
  for (let i = 0; i < userRecords.length; i += 300) {
    const chunk = userRecords.slice(i, i + 300);
    const docs = await db.getAll(...chunk.map(u => db.collection('users').doc(u.uid)));
    profileDocs.push(...docs);
  }
  const profiles = new Map(profileDocs.filter(d => d.exists).map(d => [d.id, d.data()]));
  return {
    users: userRecords.map(user => {
      const profile = profiles.get(user.uid) || {};
      return {
        uid:user.uid, email:asText(user.email,254), phoneNumber:asText(user.phoneNumber,40),
        displayName:asText(profile.displayName || user.displayName || '',120),
        role:asText(profile.role || (user.customClaims && user.customClaims.admin ? 'admin' : 'customer'),30),
        adminStatus:asText(profile.adminStatus || (user.disabled ? 'suspended' : 'active'),30),
        disabled:Boolean(user.disabled), emailVerified:Boolean(user.emailVerified),
        createdAt:asText(user.metadata && user.metadata.creationTime,40),
        lastSignInAt:asText(user.metadata && user.metadata.lastSignInTime,40)
      };
    }),
    truncated:Boolean(listed.pageToken)
  };
});

/** Admin-managed Auth state and password-reset link generation; never writes reset URLs to audit logs. */
exports.manageUserAccount = onCall(async request => {
  const actor = requireAdmin(request);
  const uid = cleanId(request.data && request.data.uid, 160);
  const action = asText(request.data && request.data.action, 30);
  const reason = asText(request.data && request.data.reason, 500);
  if (!uid || !['suspend','ban','reinstate','reset-password'].includes(action)) {
    throw new HttpsError('invalid-argument','Choose a user and a valid account action.');
  }
  if (uid === actor.uid && ['suspend','ban'].includes(action)) {
    throw new HttpsError('failed-precondition','You cannot suspend or ban the administrator account currently in use.');
  }
  const auth = getAdminAuth();
  let result = {};
  if (action === 'reset-password') {
    const target = await auth.getUser(uid);
    if (!target.email) throw new HttpsError('failed-precondition','This account has no email address for password reset. Phone OTP accounts must use phone authentication.');
    const actionLink = await auth.generatePasswordResetLink(target.email);
    result = {uid,action,actionLink,email:target.email};
  } else {
    const nextStatus = action === 'reinstate' ? 'active' : action === 'ban' ? 'banned' : 'suspended';
    await auth.updateUser(uid,{disabled:nextStatus !== 'active'});
    await db.collection('users').doc(uid).set({
      adminStatus:nextStatus,
      adminStatusReason:reason || null,
      adminStatusBy:actor.uid,
      adminStatusAt:FieldValue.serverTimestamp(),
      updatedAt:FieldValue.serverTimestamp()
    },{merge:true});
    result = {uid,action,adminStatus:nextStatus};
  }
  await db.collection('auditLogs').add({
    actorId:actor.uid,action:'user_'+action,targetId:uid,reason,
    createdAt:FieldValue.serverTimestamp()
  });
  return result;
});

/** Create/update a category override. Defaults are in the client; Firestore holds edits and custom categories. */
exports.saveAdminCategory = onCall(async request => {
  const actor = requireAdmin(request);
  const input = request.data || {};
  const id = asText(input.id,60).toLowerCase();
  const name = asText(input.name,80);
  const short = asText(input.short || name,60);
  const icon = asText(input.icon || '•',12);
  const kicker = asText(input.kicker || name,80);
  const description = asText(input.description,400);
  const cardDescription = asText(input.cardDescription || description,180);
  const image = asText(input.image,2048);
  const active = input.active !== false;
  if (!/^[a-z0-9][a-z0-9-]{1,59}$/.test(id) || !name || !description) {
    throw new HttpsError('invalid-argument','Use a valid category ID, name and description.');
  }
  if (image && !/^https:\\/\\//i.test(image)) throw new HttpsError('invalid-argument','Category image must be an HTTPS URL.');
  const paletteIn = input.palette && typeof input.palette === 'object' ? input.palette : {};
  const palette = {};
  for (const key of ['accent','deep','wash','soft','warm','contrast']) {
    const value = asText(paletteIn[key],16);
    if (value && !/^#[0-9a-fA-F]{6}$/.test(value)) throw new HttpsError('invalid-argument','Category palette values must be six-digit hex colours.');
    if (value) palette[key] = value;
  }
  const ref = db.collection('categories').doc(id);
  const previous = await ref.get();
  await ref.set({
    id,name,short,icon,kicker,description,cardDescription,active,
    image:image || (previous.exists ? asText(previous.data().image,2048) : ''),
    ...(Object.keys(palette).length ? {palette} : {}),
    createdAt:previous.exists ? previous.data().createdAt : FieldValue.serverTimestamp(),
    updatedAt:FieldValue.serverTimestamp(),updatedBy:actor.uid
  },{merge:true});
  await db.collection('auditLogs').add({actorId:actor.uid,action:previous.exists?'category_updated':'category_created',targetId:id,createdAt:FieldValue.serverTimestamp()});
  return {id,created:!previous.exists};
});

exports.deleteAdminCategory = onCall(async request => {
  const actor = requireAdmin(request);
  const id = cleanId(request.data && request.data.id,60);
  if (!id) throw new HttpsError('invalid-argument','Category ID is required.');
  const usage = await db.collection('products').where('category','==',id).limit(1).get();
  if (!usage.empty) throw new HttpsError('failed-precondition','This category is used by at least one listing. Reassign those listings before hiding it.');
  await db.collection('categories').doc(id).set({id,active:false,updatedAt:FieldValue.serverTimestamp(),updatedBy:actor.uid},{merge:true});
  await db.collection('auditLogs').add({actorId:actor.uid,action:'category_hidden',targetId:id,createdAt:FieldValue.serverTimestamp()});
  return {id,deleted:true,active:false};
});

exports.saveAdminSiteSettings = onCall(async request => {
  const actor = requireAdmin(request);
  const input = request.data || {};
  const announcementText = asText(input.announcementText,180);
  const bannerTitle = asText(input.bannerTitle,140);
  const bannerText = asText(input.bannerText,500);
  const bannerImage = asText(input.bannerImage,2048);
  const deliveryCharge = Number(input.deliveryCharge);
  const commissionPercent = Number(input.commissionPercent);
  const announcementEnabled = input.announcementEnabled === true;
  if (!Number.isFinite(deliveryCharge) || deliveryCharge < 0 || deliveryCharge > 100000
    || !Number.isFinite(commissionPercent) || commissionPercent < 0 || commissionPercent > 100) {
    throw new HttpsError('invalid-argument','Delivery charge must be 0–100,000 NPR and commission must be 0–100%.');
  }
  if (bannerImage && !/^https:\\/\\//i.test(bannerImage)) throw new HttpsError('invalid-argument','Banner image must be an HTTPS URL.');
  const data = {announcementText,bannerTitle,bannerText,bannerImage,announcementEnabled,deliveryCharge,commissionPercent,updatedBy:actor.uid,updatedAt:FieldValue.serverTimestamp()};
  await db.collection('platformSettings').doc('public').set(data,{merge:true});
  await db.collection('auditLogs').add({actorId:actor.uid,action:'site_settings_updated',targetId:'public',reason:'deliveryCharge='+deliveryCharge+'; commissionPercent='+commissionPercent,createdAt:FieldValue.serverTimestamp()});
  return {saved:true,settings:{announcementText,bannerTitle,bannerText,bannerImage,announcementEnabled,deliveryCharge,commissionPercent}};
});

/** Admin product CRUD. New admin-created listings remain pending until explicitly approved. */
exports.saveAdminProduct = onCall(async request => {
  const actor = requireAdmin(request);
  const input = request.data || {};
  const productId = cleanId(input.productId,160);
  const name = asText(input.name,120);
  const description = asText(input.description,2500);
  const category = asText(input.category,80);
  const condition = asText(input.condition || 'New',80);
  const unit = asText(input.unit || 'item',30);
  const location = asText(input.location || 'Nepal',220);
  const imageUrl = asText(input.image,2048);
  const price = Number(input.price);
  const stock = Number(input.stock);
  const retailerId = cleanId(input.retailerId,160);
  if (!name || !description || !category || !imageUrl || !retailerId
    || !/^https:\\/\\//i.test(imageUrl) || !Number.isFinite(price) || price <= 0 || price > 100000000
    || !Number.isFinite(stock) || stock < 0 || stock > 1000000
    || (!['kg','litre'].includes(unit.toLowerCase()) && !Number.isInteger(stock))
    || (['kg','litre'].includes(unit.toLowerCase()) && Math.abs(stock*2-Math.round(stock*2)) > 0.00001)) {
    throw new HttpsError('invalid-argument','Complete valid product name, description, category, HTTPS image, price, stock, unit and retailer.');
  }
  const [categorySnap,retailerSnap] = await Promise.all([
    db.collection('categories').doc(category).get(),
    db.collection('retailers').doc(retailerId).get()
  ]);
  // A category may be a built-in category that has not needed a Firestore override yet.
  const builtin = ['livestock','pets-supplies','meat','animal-products','animal-care'].includes(category);
  if (!categorySnap.exists && !builtin) throw new HttpsError('failed-precondition','Choose an existing category.');
  if (!retailerSnap.exists || retailerSnap.data().status !== 'approved') throw new HttpsError('failed-precondition','Choose an approved retailer.');
  const ref = productId ? db.collection('products').doc(productId) : db.collection('products').doc();
  const current = productId ? await ref.get() : null;
  if (productId && !current.exists) throw new HttpsError('not-found','Product not found.');
  const previous = current && current.exists ? current.data() : {};
  if (previous.retailerId && previous.retailerId !== retailerId) throw new HttpsError('failed-precondition','Product ownership cannot be changed from this form.');
  const images = Array.isArray(previous.images) && previous.images.length ? previous.images : [imageUrl];
  const data = {
    name,description,category,condition,price,unit,stock,location,
    image:imageUrl,images:images.map((src,i)=>i===0?imageUrl:asText(src,2048)).slice(0,5),
    videoUrls:Array.isArray(previous.videoUrls)?previous.videoUrls:[],
    attributes:previous.attributes && typeof previous.attributes === 'object' ? previous.attributes : {},
    retailer:asText(retailerSnap.data().storeName || 'Verified retailer',160),retailerId,
    status:productId ? previous.status : 'pending',
    createdAt:productId ? (previous.createdAt || FieldValue.serverTimestamp()) : FieldValue.serverTimestamp(),
    updatedAt:FieldValue.serverTimestamp(),
    adminEditedBy:actor.uid
  };
  if (!productId) data.images = [imageUrl];
  await ref.set(data,{merge:false});
  await db.collection('auditLogs').add({actorId:actor.uid,action:productId?'product_edited':'product_created',targetId:ref.id,productName:name,createdAt:FieldValue.serverTimestamp()});
  return {productId:ref.id,status:data.status,created:!productId};
});
