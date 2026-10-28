const crypto = require('crypto');
const {onCall, HttpsError} = require('firebase-functions/v2/https');
const {setGlobalOptions} = require('firebase-functions/v2');
const {initializeApp} = require('firebase-admin/app');
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
    total = Math.round(total * 100) / 100;
    if (!Number.isFinite(total) || total <= 0 || total > 100000000) throw new HttpsError('failed-precondition', 'The order total is invalid.');

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
      subtotal: total,
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
  if (!productId || !['approved','suspended'].includes(decision)) throw new HttpsError('invalid-argument', 'Invalid product decision.');
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
    const states = siblings.docs.map(doc => doc.id === retailerOrderId ? status : doc.data().status);
    let masterStatus = 'Pending';
    if (states.length && states.every(value => value === 'Delivered')) masterStatus = 'Delivered';
    else if (states.length && states.every(value => value === 'Cancelled')) masterStatus = 'Cancelled';
    else if (states.some(value => value !== 'Pending')) masterStatus = 'Partially fulfilled';
    await db.collection('orders').doc(order.orderId).update({status: masterStatus, updatedAt: FieldValue.serverTimestamp()});
  }
  await db.collection('auditLogs').add({actorId: auth.uid, action:'retailer_order_status_updated', targetId: retailerOrderId, status, createdAt: FieldValue.serverTimestamp()});
  return {retailerOrderId, status};
});

/*
 * Set the admin custom claim only from a trusted environment, never a public client:
 * getAuth().setCustomUserClaims(userUid, {admin:true});
 * A deployed admin dashboard must rely on that claim plus Firestore Rules/Functions.
 */
