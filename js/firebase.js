/* Pashughar Firebase client integration.
 * This file contains only the public web-app configuration. Never put service-account
 * credentials, payment secrets, or privileged Admin SDK keys in browser code.
 * Certificate and listing-photo uploads use per-user paths governed by storage.rules.
 */
import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, RecaptchaVerifier, onAuthStateChanged, signInWithPopup,
  signInWithPhoneNumber, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
  sendPasswordResetEmail, sendEmailVerification, getIdTokenResult, setPersistence,
  browserLocalPersistence, browserSessionPersistence, reload
} from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js';
import {
  getFirestore, collection, doc, getDoc, onSnapshot, query, where, addDoc,
  setDoc, updateDoc, deleteDoc, getDocs, writeBatch, serverTimestamp, deleteField, runTransaction
} from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-storage.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-functions.js';
import { store, configurePersistenceAdapter, hydrateCollection, hydrateCategories, hydrateSiteSettings } from './store.js';

export const firebaseConfig = {
  apiKey: 'AIzaSyBDpG4pEd4bv3yQGB8nSjeKRwMtNJ4DILs',
  authDomain: 'pashughar-25ecc.firebaseapp.com',
  projectId: 'pashughar-25ecc',
  storageBucket: 'pashughar-25ecc.firebasestorage.app',
  messagingSenderId: '437614878388',
  appId: '1:437614878388:web:ce8551792d5ff6f69901e1',
  measurementId: 'G-J34XYVTZTE'
};

export const isFirebaseConfigured = () => Boolean(
  firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId
);

const firebaseApp = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);
export const storage = getStorage(firebaseApp);
// The included functions scaffold uses this region. Deploying callable functions may require
// upgrading the Firebase project to the Blaze plan; the client does not upgrade billing.
export const functions = getFunctions(firebaseApp, 'asia-south2');
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

let phoneVerifier = null;
let phoneConfirmationResult = null;
let pendingAuthRole = 'customer';

export async function setRememberMe(rememberMe = true) {
  await setPersistence(auth, rememberMe ? browserLocalPersistence : browserSessionPersistence);
}
async function ensureUserProfile(user, requestedRole = 'customer') {
  const profileRef = doc(db, 'users', user.uid);
  const profileSnap = await getDoc(profileRef);
  if (profileSnap.exists()) return profileSnap.data();
  const retailerSnap = await getDoc(doc(db, 'retailers', user.uid));
  const role = retailerSnap.exists() ? 'retailer' : (requestedRole === 'retailer' ? 'retailer' : 'customer');
  const profile = {
    displayName: user.displayName || '',
    email: user.email || '',
    phone: user.phoneNumber || '',
    createdAt: serverTimestamp(),
    role
  };
  await setDoc(profileRef, profile);
  return profile;
}
export const signInGoogle = async (role = 'customer', rememberMe = true) => {
  pendingAuthRole = ['customer','retailer'].includes(role) ? role : 'customer';
  await setRememberMe(rememberMe);
  const credential = await signInWithPopup(auth, googleProvider);
  await ensureUserProfile(credential.user, role);
  return credential;
};
export const signInEmail = async (email, password, role = 'customer', rememberMe = true) => {
  pendingAuthRole = ['customer','retailer'].includes(role) ? role : 'customer';
  await setRememberMe(rememberMe);
  const credential = await signInWithEmailAndPassword(auth, email.trim(), password);
  await ensureUserProfile(credential.user, role);
  return credential;
};
export const createEmailAccount = async (email, password, role = 'customer', rememberMe = true) => {
  if (!['customer','retailer'].includes(role)) throw new Error('Choose customer or retailer for sign-up.');
  pendingAuthRole = role;
  await setRememberMe(rememberMe);
  const credential = await createUserWithEmailAndPassword(auth, email.trim(), password);
  await ensureUserProfile(credential.user, role);
  await sendEmailVerification(credential.user, {url:'https://pashughar.pages.dev/#account', handleCodeInApp:false});
  return credential;
};
export const resetEmailPassword = email => sendPasswordResetEmail(auth, email.trim(), {url:'https://pashughar.pages.dev/#login', handleCodeInApp:false});
export const sendVerificationEmail = async () => {
  if (!auth.currentUser) throw new Error('Sign in first to verify your email.');
  if (!auth.currentUser.email) throw new Error('This account has no email address to verify.');
  if (auth.currentUser.emailVerified) return false;
  await sendEmailVerification(auth.currentUser, {url:'https://pashughar.pages.dev/#account', handleCodeInApp:false});
  return true;
};
export const refreshAuthUser = async () => {
  if (!auth.currentUser) return null;
  await reload(auth.currentUser);
  await getIdTokenResult(auth.currentUser, true);
  return auth.currentUser;
};
function normalizePhoneNumber(value) {
  let phone = String(value || '').trim().replace(/[\s().-]/g, '');
  if (/^0[0-9]{9,10}$/.test(phone)) phone = '+977' + phone.slice(1);
  else if (/^9[0-9]{9}$/.test(phone)) phone = '+977' + phone;
  else if (/^977[0-9]{9,10}$/.test(phone)) phone = '+' + phone;
  else if (!phone.startsWith('+')) phone = '+' + phone;
  if (!/^\+[1-9][0-9]{7,14}$/.test(phone)) throw new Error('Enter a valid phone number with country code, for example +97798XXXXXXXX.');
  return phone;
}
export async function sendPhoneOtp(phone, role = 'customer', rememberMe = true, containerId = 'phone-recaptcha-container') {
  if (!['customer','retailer'].includes(role)) throw new Error('Choose customer or retailer for sign-in.');
  pendingAuthRole = role;
  await setRememberMe(rememberMe);
  const normalized = normalizePhoneNumber(phone);
  if (phoneVerifier) { try { await phoneVerifier.clear(); } catch {} phoneVerifier = null; }
  phoneVerifier = new RecaptchaVerifier(auth, containerId, {size:'invisible'});
  try {
    phoneConfirmationResult = await signInWithPhoneNumber(auth, normalized, phoneVerifier);
    return true;
  } catch (error) {
    try { await phoneVerifier.clear(); } catch {}
    phoneVerifier = null;
    phoneConfirmationResult = null;
    throw error;
  }
}
export async function confirmPhoneOtp(code, role = 'customer') {
  if (!phoneConfirmationResult) throw new Error('Send a verification code to your phone first.');
  const confirmation = await phoneConfirmationResult.confirm(String(code || '').trim());
  phoneConfirmationResult = null;
  if (phoneVerifier) { try { await phoneVerifier.clear(); } catch {} phoneVerifier = null; }
  const profile = await ensureUserProfile(confirmation.user, role);
  return {...confirmation, pashugharRole: profile.role || role};
}
export const isVerifiedContact = user => Boolean(user && (user.emailVerified === true || (typeof user.phoneNumber === 'string' && user.phoneNumber.length > 0)));

export const signOutUser = () => signOut(auth);
export const getCallable = name => httpsCallable(functions, name);

const RETAILER_TYPES = new Set(['meat_poultry','livestock','animal_products','pets_supplies','pet_breeding','vet']);
const cleanField = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const asList = (value, maxItems = 30, maxLen = 180) => String(value ?? '').split(/[,\n]/).map(v => cleanField(v,maxLen)).filter(Boolean).slice(0,maxItems);
const validHttps = value => { try { return new URL(String(value || '')).protocol === 'https:'; } catch { return false; } };

/** Create the retailer profile and one-time retailerType/status on the user's own account.
 * Firestore Rules restrict this to a self-owned, not-yet-applied retailer account. */
export async function submitRetailerApplication(input = {}) {
  const user = auth.currentUser;
  if (!user) throw new Error('Sign in or finish account registration before submitting your partner application.');
  const type = cleanField(input.retailerType, 40);
  if (!RETAILER_TYPES.has(type)) throw new Error('Choose one valid retailer type.');
  const storeName = cleanField(input.storeName, 100);
  const contactName = cleanField(input.contactName, 100);
  const phone = cleanField(input.phone || user.phoneNumber, 40);
  const email = cleanField(input.email || user.email, 254).toLowerCase();
  const location = cleanField(input.location, 220);
  const description = cleanField(input.description, 700);
  if (!storeName || !contactName || !phone || !location) throw new Error('Complete your name, business/owner name, phone and location.');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
  let vetDetails = {};
  if (type === 'vet') {
    const year = Number(input.graduationYear), certificateUrl = cleanField(input.certificateUrl,2048);
    if (!cleanField(input.degree,100) || !cleanField(input.university,180)
      || !Number.isInteger(year) || year < 1950 || year > new Date().getFullYear()
      || !cleanField(input.councilRegistrationNumber,120) || !cleanField(input.workExperience,1000)
      || !asList(input.clinicLocations,20,220).length || !asList(input.services,30,180).length
      || !cleanField(input.fees,500) || !cleanField(input.availability,700) || !validHttps(certificateUrl)) {
      throw new Error('Complete the vet qualification, registration, certificate upload/URL, experience, clinic locations, services, fees and availability.');
    }
    vetDetails = {
      degree:cleanField(input.degree,100), university:cleanField(input.university,180), graduationYear:year,
      councilRegistrationNumber:cleanField(input.councilRegistrationNumber,120), certificateUrl,
      workExperience:cleanField(input.workExperience,1000), clinicLocations:asList(input.clinicLocations,20,220),
      services:asList(input.services,30,180), fees:cleanField(input.fees,500), availability:cleanField(input.availability,700)
    };
  }
  const breedingDetails = type === 'pet_breeding' ? {
    ownerInfo:cleanField(input.ownerInfo || contactName,500), location,
    animalsNote:cleanField(input.animalsNote,700)
  } : {};
  const userRef = doc(db,'users',user.uid), retailerRef = doc(db,'retailers',user.uid);
  await runTransaction(db, async tx => {
    const [userSnap,retailerSnap] = await Promise.all([tx.get(userRef),tx.get(retailerRef)]);
    if (!userSnap.exists() || userSnap.data().role !== 'retailer') {
      throw new Error('This is not a retailer account. Start from the Become a partner registration flow.');
    }
    const existing = userSnap.data();
    if (retailerSnap.exists() || existing.retailerType || existing.status) {
      throw new Error('A retailer application already exists. Retailer type cannot be changed in the application form.');
    }
    tx.update(userRef,{displayName:contactName,phone,retailerType:type,status:'pending',updatedAt:serverTimestamp()});
    tx.set(retailerRef,{
      ownerId:user.uid,retailerType:type,storeName,contactName,email,phone,location,description,status:'pending',
      publicPhone:phone,publicEmail:email,website:'',openingHours:'',vetDetails,breedingDetails,
      createdAt:serverTimestamp(),updatedAt:serverTimestamp()
    });
  });
  return {uid:user.uid,role:'retailer',retailerType:type,status:'pending'};
}

/** Upload a certificate or product photo to a UID-scoped Firebase Storage path. */
export async function uploadRetailerFile(file, purpose = 'product') {
  const user = auth.currentUser;
  if (!user) throw new Error('Sign in before uploading files.');
  if (!file || typeof file.size !== 'number') throw new Error('Choose a file to upload.');
  const certificate = purpose === 'certificate';
  const maxBytes = certificate ? 10*1024*1024 : 8*1024*1024;
  const allowed = certificate ? ['application/pdf','image/jpeg','image/png','image/webp'] : ['image/jpeg','image/png','image/webp','image/avif'];
  if (file.size <= 0 || file.size > maxBytes) throw new Error('File is empty or exceeds the '+(certificate?'10 MB':'8 MB')+' upload limit.');
  if (!allowed.includes(String(file.type||'').toLowerCase())) throw new Error(certificate?'Upload a PDF, JPEG, PNG or WebP certificate.':'Upload a JPEG, PNG, WebP or AVIF image.');
  const safeName = String(file.name||'upload').toLowerCase().replace(/[^a-z0-9._-]+/g,'-').slice(-100) || 'upload';
  const path = (certificate?'retailer-certificates':'product-photos')+'/'+user.uid+'/'+Date.now()+'-'+safeName;
  const target = storageRef(storage,path);
  await uploadBytes(target,file,{contentType:file.type,customMetadata:{ownerUid:user.uid,purpose:certificate?'vet-certificate':'listing-photo'}});
  return getDownloadURL(target);
}

/** Shared appointment records for veterinary visits and breeding appointments. */
export async function createMarketplaceAppointment(input = {}) {
  const user = auth.currentUser;
  if (!user) throw new Error('Sign in as a customer before booking an appointment.');
  const customerProfile = await getDoc(doc(db,'users',user.uid));
  if (!customerProfile.exists() || customerProfile.data().role !== 'customer') throw new Error('Only customer accounts can book appointments.');
  const appointmentType = input.appointmentType === 'breeding' ? 'breeding' : 'vet';
  const retailerId = cleanField(input.retailerId,160), date = cleanField(input.date,10), time = cleanField(input.time,5);
  const customerName = cleanField(input.customerName || user.displayName || user.email?.split('@')[0],120);
  const customerPhone = cleanField(input.customerPhone || user.phoneNumber,40);
  const reason = cleanField(input.reason,1000), location = cleanField(input.location,220);
  if (!retailerId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || !customerName || !customerPhone || reason.length < 5) {
    throw new Error('Complete your contact details, a future date/time and appointment reason.');
  }
  const start = new Date(date+'T'+time+':00');
  if (!Number.isFinite(start.getTime()) || start <= new Date()) throw new Error('Choose a future date and time.');
  let providerName = cleanField(input.retailerName,120), productId = '', productName = cleanField(input.productName,160);
  if (appointmentType === 'breeding') {
    productId = cleanField(input.productId,160);
    if (!productId) throw new Error('Choose an animal listing for the breeding appointment.');
    const productSnap = await getDoc(doc(db,'products',productId));
    if (!productSnap.exists()) throw new Error('The animal listing is no longer available.');
    const product = productSnap.data();
    if (product.status !== 'approved' || product.category !== 'pets-supplies' || product.attributes?.petSection !== 'breeding' || product.retailerId !== retailerId) throw new Error('This animal is not available for appointment requests.');
    providerName = cleanField(product.retailer || providerName,120);
    productName = cleanField(product.name || productName,160);
  } else {
    const provider = await getDoc(doc(db,'retailers',retailerId));
    if (!provider.exists() || provider.data().retailerType !== 'vet' || provider.data().status !== 'approved') throw new Error('This veterinary provider is not currently approved.');
    providerName = cleanField(provider.data().storeName || providerName,120);
  }
  const payload = {
    appointmentType,customerUid:user.uid,customerName,customerPhone,customerEmail:user.email||'',
    retailerId,retailerName:providerName,date,time,reason,location,status:'pending',
    createdAt:serverTimestamp(),updatedAt:serverTimestamp()
  };
  if (productId) { payload.productId=productId; payload.productName=productName; }
  return addDoc(collection(db,'appointments'),payload);
}
export async function updateMarketplaceAppointment({appointmentId,action,date='',time='',reason=''}) {
  const user=auth.currentUser;
  if(!user||!appointmentId)throw new Error('Sign in to update this appointment.');
  const updates={updatedAt:serverTimestamp()};
  if(action==='confirm')updates.status='confirmed';
  else if(action==='reject'){updates.status='rejected';updates.statusReason=cleanField(reason,500);}
  else if(action==='reschedule'){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)||new Date(date+'T'+time+':00')<=new Date())throw new Error('Choose a future date and time for the reschedule.');
    updates.status='reschedule_requested';updates.proposedDate=date;updates.proposedTime=time;updates.statusReason=cleanField(reason,500);
  } else if(action==='cancel')updates.status='cancelled';
  else if(action==='complete')updates.status='completed';
  else throw new Error('Unknown appointment action.');
  return updateDoc(doc(db,'appointments',appointmentId),updates);
}
export async function createMarketplaceReport({product,reason,details,reporterName='',reporterContact=''}) {
  const user=auth.currentUser;
  if(!user)throw new Error('Sign in to submit a marketplace report.');
  if(!product?.id||!['suspected-scam','misleading-listing','fake-product','non-delivery','animal-welfare','prohibited-item','other'].includes(reason)||String(details||'').trim().length<10)throw new Error('Choose a report reason and provide at least 10 characters of detail.');
  return addDoc(collection(db,'reports'),{
    productId:String(product.id),productName:cleanField(product.name,160),retailerId:cleanField(product.retailerId,160),
    retailerName:cleanField(product.retailer,160),location:cleanField(product.location,220),category:cleanField(product.category,80),
    reason,reasonLabel:reason,details:cleanField(details,1800),reporterUid:user.uid,
    reporterName:cleanField(reporterName||user.displayName||user.email?.split('@')[0],100),
    reporterContact:cleanField(reporterContact||user.email||user.phoneNumber,180),
    status:'open',createdAt:serverTimestamp(),updatedAt:serverTimestamp()
  });
}
export async function updateMarketplaceReport({reportId,status,resolutionNote=''}) {
  await requireCurrentAdmin();
  if(!reportId||!['reviewing','resolved','dismissed'].includes(status))throw new Error('Choose a valid report status.');
  return updateDoc(doc(db,'reports',reportId),{status,resolutionNote:cleanField(resolutionNote,500),reviewedBy:auth.currentUser.uid,updatedAt:serverTimestamp()});
}
export async function updateRetailerOrderStatusDirect({retailerOrderId,status}) {
  const user=auth.currentUser;
  if(!user)throw new Error('Sign in as the assigned retailer first.');
  const allowed=['Confirmed','Rejected','Processing','Shipped','Delivered','Cancelled'];
  if(!retailerOrderId||!allowed.includes(status))throw new Error('Choose a valid order status.');
  const ref=doc(db,'retailerOrders',retailerOrderId);
  const snap=await getDoc(ref);
  if(!snap.exists())throw new Error('Order was not found.');
  const order=snap.data();
  if(order.retailerId!==user.uid)throw new Error('You can update only orders assigned to your shop.');
  const transitions={
    Pending:['Confirmed','Rejected','Cancelled'],
    Confirmed:['Processing','Cancelled'],
    Processing:['Shipped','Cancelled'],
    Shipped:['Delivered'],
    Delivered:[],Rejected:[],Cancelled:[]
  };
  if(!(transitions[order.status]||[]).includes(status))throw new Error('This order status cannot be changed from '+String(order.status)+'.');
  await updateDoc(ref,{status,statusUpdatedBy:user.uid,updatedAt:serverTimestamp()});
  return {retailerOrderId,status};
}
export async function getPublishedProductReviews(productId) {
  if(!productId) return [];
  const snapshot=await getDocs(query(collection(db,'reviews'),where('productId','==',productId),where('status','==','published')));
  return snapshot.docs.map(item=>({id:item.id,...toPlain(item.data())})).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
}
export async function submitProductReview({productId,orderId,rating,body}) {
  const user=auth.currentUser;
  if(!user) throw new Error('Sign in with the account used for the purchase to leave a review.');
  if(!(user.emailVerified || user.phoneNumber)) throw new Error('Verify your email or phone before reviewing.');
  const score=Number(rating),text=String(body||'').trim(),purchase=String(orderId||'').trim();
  if(!productId||!purchase||!Number.isInteger(score)||score<1||score>5||text.length<10||text.length>1500) throw new Error('Enter the order ID, a rating from 1 to 5, and a review of 10 to 1,500 characters.');
  // Deterministic ID prevents the same buyer reviewing the same product/order twice.
  const reviewId=purchase+'_'+productId;
  const ref=doc(db,'reviews',reviewId);
  await setDoc(ref,{
    productId,orderId:purchase,customerId:user.uid,
    customerName:String(user.displayName||user.email?.split('@')[0]||'Verified buyer').slice(0,80),
    rating:score,body:text,status:'published',createdAt:serverTimestamp()
  });
  return {id:reviewId};
}
export async function getPublicStoreProfile(storeId) {
  if (!storeId) throw new Error('Store ID is missing.');
  const snap = await getDoc(doc(db,'publicStores',storeId));
  if (!snap.exists()) return null;
  return {id:snap.id,...toPlain(snap.data())};
}
async function writePublicStore(retailer) {
  if (!auth.currentUser || auth.currentUser.uid !== String(retailer.ownerId || retailer.id)) return;
  if (retailer.status !== 'approved') return;
  const payload = {
    storeId:auth.currentUser.uid,
    storeName:String(retailer.storeName||'').slice(0,100),
    description:String(retailer.description||'').slice(0,700),
    location:String(retailer.location||'').slice(0,220),
    publicPhone:String(retailer.publicPhone||'').slice(0,40),
    publicEmail:String(retailer.publicEmail||'').slice(0,254),
    website:String(retailer.website||'').slice(0,300),
    openingHours:String(retailer.openingHours||'').slice(0,700),
    vetSpecialties:Array.isArray(retailer.vetSpecialties)?retailer.vetSpecialties.slice(0,20):[],
    vetAvailability:String(retailer.vetAvailability||'').slice(0,700),
    consultationFee:Math.max(0,Number(retailer.consultationFee)||0),
    isVet:Boolean(retailer.isVet),
    updatedAt:serverTimestamp()
  };
  await setDoc(doc(db,'publicStores',auth.currentUser.uid),payload,{merge:true});
}

export async function createProductEnquiry({productId, productName, retailerId, customerName, customerPhone, message}) {
  if (!auth.currentUser) throw new Error('Sign in to send the retailer an enquiry.');
  const text = String(message || '').trim();
  if (!productId || !retailerId || !text || text.length < 5) throw new Error('Write an enquiry with at least five characters.');
  return addDoc(collection(db,'enquiries'), {
    productId, productName:String(productName||'').slice(0,160), retailerId,
    customerUid:auth.currentUser.uid, customerName:String(customerName||auth.currentUser.displayName||'Customer').trim().slice(0,120),
    customerEmail:auth.currentUser.email||'', customerPhone:String(customerPhone||auth.currentUser.phoneNumber||'').slice(0,40),
    message:text.slice(0,1500), reply:'', status:'open',
    createdAt:serverTimestamp(), updatedAt:serverTimestamp()
  });
}
export async function replyToEnquiry(enquiryId, reply) {
  if (!auth.currentUser) throw new Error('Sign in to reply.');
  const text=String(reply||'').trim();
  if(!enquiryId||text.length<2||text.length>1500) throw new Error('Reply must contain 2 to 1,500 characters.');
  return updateDoc(doc(db,'enquiries',enquiryId),{reply:text,status:'replied',updatedAt:serverTimestamp()});
}
export async function saveRetailerVerificationAndProfile({retailerId, updates}) {
  const user=auth.currentUser;
  if(!user||user.uid!==retailerId) throw new Error('You can update only your own retailer profile.');
  const allowed={...updates};
  delete allowed.ownerId; delete allowed.status; delete allowed.reviewedBy; delete allowed.reviewedAt;
  return updateDoc(doc(db,'retailers',retailerId),{...allowed,updatedAt:serverTimestamp()});
}
export async function updateBreedingBookingStatus(bookingId, status) {
  if (!['accepted','declined','completed','cancelled'].includes(status)) throw new Error('Invalid booking status.');
  const user = auth.currentUser;
  if (!user) throw new Error('Sign in to manage this request.');
  return updateDoc(doc(db, 'breedingBookings', bookingId), { status, updatedAt: serverTimestamp() });
}
export async function createBreedingBooking({ productId, productName, retailerId, requestedDate, customerName, customerPhone, location, note = '' }) {
  const user = auth.currentUser;
  if (!user) throw new Error('Sign in before requesting a breeding date.');
  if (!productId || !retailerId || !requestedDate || !customerName?.trim() || !customerPhone?.trim() || !location?.trim()) {
    throw new Error('Complete your name, phone, location and requested date.');
  }
  const chosen = new Date(requestedDate + 'T00:00:00');
  const today = new Date(); today.setHours(0,0,0,0);
  if (!Number.isFinite(chosen.getTime()) || chosen < today) throw new Error('Choose today or a future date.');
  const productSnap = await getDoc(doc(db, 'products', productId));
  if (!productSnap.exists()) throw new Error('This dog listing is no longer available.');
  const product = productSnap.data();
  if (product.status !== 'approved' || product.category !== 'pets-supplies' || product.attributes?.petSection !== 'breeding' || product.retailerId !== retailerId) {
    throw new Error('This listing is not available for breeding requests.');
  }
  return addDoc(collection(db, 'breedingBookings'), {
    productId, productName: String(productName || product.name || '').slice(0,160),
    retailerId, customerUid: user.uid, customerName: customerName.trim().slice(0,120),
    customerEmail: user.email || '', customerPhone: customerPhone.trim().slice(0,40),
    location: location.trim().slice(0,180), requestedDate, note: String(note).trim().slice(0,1000),
    status: 'pending', createdAt: serverTimestamp(), updatedAt: serverTimestamp()
  });
}
export const getRoleClaims = async user => {
  const result = await getIdTokenResult(user);
  return result.claims || {};
};

function toPlain(value) {
  if (value == null) return value;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(toPlain);
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = toPlain(item);
    return out;
  }
  return value;
}
function unpack(snapshot) {
  return snapshot.docs.map(item => ({ id: item.id, ...toPlain(item.data()) }));
}
function fireError(error) {
  window.dispatchEvent(new CustomEvent('pashughar:cloud-error', {
    detail: { code: error?.code || 'unknown', message: error?.message || 'Cloud operation failed.' }
  }));
}
function docData(record) {
  const out = { ...record };
  delete out.id; // document ID is the canonical ID; do not duplicate it in product documents.
  return out;
}
const byId = items => new Map((items || []).map(item => [String(item.id), item]));
const equivalent = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function persistChanges(collectionName, previous, next) {
  if (!auth.currentUser) throw new Error('Sign in before saving marketplace changes.');
  const before = byId(previous);
  const after = byId(next);
  for (const [id, record] of after) {
    const old = before.get(id);
    if (old && equivalent(old, record)) continue;
    const documentId = collectionName === 'retailers' ? String(record.ownerId || id) : id;
    const ref = doc(db, collectionName, documentId);
    const data = docData(record);
    if (old) await updateDoc(ref, data);
    else await setDoc(ref, data);
  }
  for (const [id] of before) {
    if (after.has(id)) continue;
    const record = before.get(id);
    const documentId = collectionName === 'retailers' ? String(record.ownerId || id) : id;
    await deleteDoc(doc(db, collectionName, documentId));
  }
}

configurePersistenceAdapter({
  products: (previous, next) => persistChanges('products', previous, next).catch(error => {
    hydrateCollection('products', previous);
    fireError(error);
    throw error;
  }),
  retailers: async (previous, next) => {
    try {
      await persistChanges('retailers', previous, next);
      for (const record of (next || [])) {
        if (record && record.status === 'approved' && String(record.ownerId || record.id) === auth.currentUser?.uid) {
          await writePublicStore(record);
        }
      }
    } catch(error) {
      hydrateCollection('retailers', previous);
      fireError(error);
      throw error;
    }
  },
  enquiries: (previous, next) => persistChanges('enquiries', previous, next).catch(error => {
    hydrateCollection('enquiries', previous);
    fireError(error);
    throw error;
  })
});

function requireCurrentAdmin() {
  if (!auth.currentUser) throw new Error('Sign in with the designated administrator account first.');
  return getIdTokenResult(auth.currentUser).then(result => {
    if (result.claims?.admin !== true) throw new Error('This account does not have the trusted Pashughar admin role.');
    return auth.currentUser;
  });
}

/** Admin operations secured by Firestore Rules/custom claims, so shop/product moderation
 * does not need a Cloud Function deployment. Never accept an admin role from form data. */
export async function moderateRetailerDirect({ retailerId, decision, reason = '' }) {
  const user = await requireCurrentAdmin();
  if (!retailerId || !['approved', 'rejected', 'suspended', 'banned'].includes(decision)) throw new Error('Invalid shop moderation request.');
  const retailerRef = doc(db, 'retailers', retailerId);
  const retailerSnap = await getDoc(retailerRef);
  if (!retailerSnap.exists()) throw new Error('Retailer profile not found.');
  await updateDoc(retailerRef, {
    status: decision,
    statusReason: String(reason).slice(0, 500) || null,
    reviewedBy: user.uid,
    reviewedAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

  const matches = await getDocs(query(collection(db, 'products'), where('retailerId', '==', retailerId)));
  let batch = writeBatch(db);
  let pending = 0;
  let updated = 0;
  for (const productSnap of matches.docs) {
    const product = productSnap.data();
    let change = null;
    if (['rejected', 'suspended', 'banned'].includes(decision) && product.status === 'approved') {
      change = { status: 'suspended', suspensionCause: 'retailer', updatedAt: serverTimestamp() };
    } else if (decision === 'approved' && product.status === 'suspended' && product.suspensionCause === 'retailer') {
      change = { status: 'approved', suspensionCause: deleteField(), updatedAt: serverTimestamp() };
    }
    if (change) {
      batch.update(productSnap.ref, change);
      pending += 1;
      updated += 1;
      if (pending === 400) { await batch.commit(); batch = writeBatch(db); pending = 0; }
    }
  }
  if (pending) await batch.commit();
  return { retailerId, status: decision, productsUpdated: updated };
}

export async function moderateProductDirect({ productId, decision, reason = '' }) {
  const user = await requireCurrentAdmin();
  if (!productId || !['approved', 'rejected', 'suspended'].includes(decision)) throw new Error('Invalid product moderation request.');
  const ref = doc(db, 'products', productId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('Product not found.');
  if (decision === 'approved') {
    const retailerRef = doc(db, 'retailers', String(snap.data().retailerId || ''));
    const retailerSnap = await getDoc(retailerRef);
    if (!retailerSnap.exists() || retailerSnap.data().status !== 'approved') throw new Error('The retailer must be verified before restoring this product.');
  }
  await updateDoc(ref, {
    status: decision,
    adminReason: String(reason).slice(0, 500) || null,
    reviewedBy: user.uid,
    reviewedAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  return { productId, status: decision };
}

export async function removeProductDirect({ productId }) {
  await requireCurrentAdmin();
  if (!productId) throw new Error('Product ID is required.');
  const ref = doc(db, 'products', productId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('Product not found.');
  await deleteDoc(ref);
  return { productId, removed: true };
}

/**
 * Attach real auth state and live Firestore data to the existing UI.
 * The app keeps localStorage as a cache for cart/theme/wishlist only; cloud listeners
 * replace the catalogue and protected dashboard datasets when Firebase is connected.
 */
export function startFirebaseBridge({ onSessionChanged }) {
  if (!isFirebaseConfigured()) return () => {};
  let dataUnsubscribers = [];
  let publicProducts = [];
  let ownProducts = [];
  let ownRetailerOrderDocs = [];
  let authRun = 0;

  const stopDataListeners = () => {
    dataUnsubscribers.forEach(unsub => { try { unsub(); } catch {} });
    dataUnsubscribers = [];
  };
  const listen = (target, callback, onError = fireError) => {
    const unsub = onSnapshot(target, callback, onError);
    dataUnsubscribers.push(unsub);
    return unsub;
  };
  const mergeProducts = () => {
    const map = new Map();
    for (const item of [...publicProducts, ...ownProducts]) map.set(item.id, item);
    hydrateCollection('products', [...map.values()]);
  };
  const startPublicData = () => {
    publicProducts = [];
    ownProducts = [];
    const q = query(collection(db, 'products'), where('status', '==', 'approved'));
    listen(q, snapshot => { publicProducts = unpack(snapshot); mergeProducts(); });
    listen(collection(db, 'categories'), snapshot => hydrateCategories(unpack(snapshot)));
    listen(doc(db, 'platformSettings', 'public'), snapshot => hydrateSiteSettings(snapshot.exists() ? toPlain(snapshot.data()) : {}));
    hydrateCollection('retailers', []);
    hydrateCollection('reports', []);
    hydrateCollection('orders', []);
  };
  const startRetailerData = uid => {
    listen(doc(db, 'retailers', uid), snapshot => {
      const profile = snapshot.exists() ? [{ id: snapshot.id, ...toPlain(snapshot.data()) }] : [];
      hydrateCollection('retailers', profile);
      if (profile[0]?.status === 'approved') writePublicStore(profile[0]).catch(fireError);
    });
    listen(query(collection(db, 'products'), where('retailerId', '==', uid)), snapshot => {
      ownProducts = unpack(snapshot);
      mergeProducts();
    });
    listen(query(collection(db, 'breedingBookings'), where('retailerId', '==', uid)), snapshot => hydrateCollection('breedingBookings', unpack(snapshot)));
    listen(query(collection(db, 'enquiries'), where('retailerId', '==', uid)), snapshot => hydrateCollection('enquiries', unpack(snapshot)));
    listen(query(collection(db, 'vetAppointments'), where('vetId', '==', uid)), snapshot => hydrateCollection('vetAppointments', unpack(snapshot)));
    listen(query(collection(db, 'retailerOrders'), where('retailerId', '==', uid)), snapshot => {
      ownRetailerOrderDocs = unpack(snapshot);
      const orders = ownRetailerOrderDocs.map(order => ({
        ...order,
        id: order.id,
        total: Number(order.subtotal || 0),
        customerName: order.customerName || 'Customer',
        customerEmail: order.customerEmail || '',
        items: (order.items || []).map(item => ({
          ...item, id: item.productId, qty: Number(item.quantity || 0), price: Number(item.unitPrice || 0)
        }))
      }));
      hydrateCollection('orders', orders);
    });
  };
  const startAdminData = () => {
    // These listeners are only created after a server-assigned admin custom claim is verified.
    listen(collection(db, 'products'), snapshot => hydrateCollection('products', unpack(snapshot)));
    listen(collection(db, 'retailers'), snapshot => hydrateCollection('retailers', unpack(snapshot)));
    listen(collection(db, 'orders'), snapshot => hydrateCollection('orders', unpack(snapshot)));
    listen(collection(db, 'reports'), snapshot => hydrateCollection('reports', unpack(snapshot)));
    listen(collection(db, 'breedingBookings'), snapshot => hydrateCollection('breedingBookings', unpack(snapshot)));
    listen(collection(db, 'enquiries'), snapshot => hydrateCollection('enquiries', unpack(snapshot)));
    listen(collection(db, 'vetAppointments'), snapshot => hydrateCollection('vetAppointments', unpack(snapshot)));
  };

  const unsubscribeAuth = onAuthStateChanged(auth, async user => {
    const run = ++authRun;
    stopDataListeners();
    publicProducts = [];
    ownProducts = [];
    ownRetailerOrderDocs = [];
    if (!user) {
      hydrateCollection('retailers', []);
      hydrateCollection('reports', []);
      hydrateCollection('orders', []);
      hydrateCollection('breedingBookings', []);
      hydrateCollection('enquiries', []);
      hydrateCollection('vetAppointments', []);
      store.saveWishlist([]);
      startPublicData();
      onSessionChanged(null);
      return;
    }
    let claims = {};
    let profileData = {};
    let retailerExists = false;
    try {
      claims = await getRoleClaims(user);
      const [profileSnap, retailerSnap] = await Promise.all([
        getDoc(doc(db, 'users', user.uid)),
        getDoc(doc(db, 'retailers', user.uid))
      ]);
      retailerExists = retailerSnap.exists();
      if (profileSnap.exists()) profileData = profileSnap.data() || {};
      else profileData = {role: retailerExists ? 'retailer' : pendingAuthRole};
    } catch (error) { fireError(error); }
    if (run !== authRun) return;
    const isAdmin = claims.admin === true;
    const userRole = profileData.role === 'retailer' || retailerExists ? 'retailer' : 'customer';
    const session = {
      uid: user.uid,
      name: user.displayName || user.email?.split('@')[0] || user.phoneNumber || 'Customer',
      email: user.email || '',
      photoURL: user.photoURL || '',
      phoneNumber: user.phoneNumber || '',
      emailVerified: Boolean(user.emailVerified),
      role: isAdmin ? 'admin' : userRole,
      firebase: true
    };
    onSessionChanged(session);
    if (isAdmin) {
      startAdminData();
      return;
    }
    startPublicData();
    listen(doc(db, 'wishlists', user.uid), snapshot => store.saveWishlist(snapshot.exists() ? (snapshot.data().productIds || []) : []));
    if (session.role === 'retailer') startRetailerData(user.uid);
  });
  return () => { stopDataListeners(); unsubscribeAuth(); };
}
