import {store, CATEGORIES, money, categoryName, normalizeCategoryId, slugId, safe, hydrateCollection} from './store.js';
import {renderCustomerFeature, installCustomerFeatureHandlers, toggleCloudWishlist, watchChatThreads} from './customer-features.js';
import {renderAdminFeature, installAdminFeatureHandlers, renderAdminProductForm, saveAdminProductFromForm} from './admin-features.js';
import {isFirebaseConfigured, signInGoogle, signInEmail, createEmailAccount, resetEmailPassword, signOutUser, sendVerificationEmail, refreshAuthUser, sendPhoneOtp, confirmPhoneOtp, isVerifiedContact, setRememberMe, startFirebaseBridge, getCallable, moderateRetailerDirect, moderateProductDirect, removeProductDirect, createBreedingBooking, updateBreedingBookingStatus, createProductEnquiry, replyToEnquiry, getPublicStoreProfile, updateRetailerOrderStatusDirect, getPublishedProductReviews, submitProductReview, submitRetailerApplication, uploadRetailerFile, createMarketplaceAppointment, updateMarketplaceAppointment, createMarketplaceReport, updateMarketplaceReport} from './firebase.js';

store.init();
// In Firebase mode, never briefly display fictional sample catalogue/dashboard data while
// the live Firestore listeners are starting. The actual records are loaded by the bridge below.
if (isFirebaseConfigured()) {
  hydrateCollection('products', []);
  hydrateCollection('retailers', []);
  hydrateCollection('orders', []);
  hydrateCollection('reports', []);
}
// Clear legacy role-preview sessions from the earlier prototype after splitting access routes.
const cachedSession = store.session();
if (cachedSession && cachedSession.demoAccessVersion !== 2) store.saveSession(null);
const app = document.getElementById('app');
const toastRegion = document.getElementById('toast-region');
const modal = document.getElementById('modal');
const modalContent = document.getElementById('modal-content');
let activeShopCategory = '';
let activeShopQuery = '';
let activeShopSort = 'featured';
let activeShopStockOnly = false;
let activePriceMin = '';
let activePriceMax = '';
let activeProvince = '';
let activeDistrict = '';
let activeMunicipality = '';
let activeShopPage = 1;
const PAGE_SIZE = 12;
let nearMeEnabled = false;
let shopperGeo = null;
let lastSearchSuggestions = [];
const productReviewCache = new Map();
let locationPermissionRequested = false;
const SEARCH_HISTORY_KEY = 'pashughar.searchHistory.v1';
let activeShopFiltersVisible = false;
let sellerTab = 'products';
let adminTab = 'overview';
let currentProductImageUrl = '';
let currentProductImages = [];
let activeProductImageIndex = 0;
let activeReportFilter = 'open';
let firebaseSession = null;
let catalogueLoaded = !isFirebaseConfigured();
let authMode = 'signin';
let authChannel = 'email';
let authRole = 'customer';
let authGateActive = false;
let authStateReady = !isFirebaseConfigured();
let phoneDraft = '';
let phoneOtpSent = false;
let partnerApplicationDraft = {};
let partnerOtpSent = false;
let rememberAuthSession = true;
let checkoutOtpSent = false;
let verifiedCheckoutPhone = '';
let inactivityTimer = null;
const AUTO_LOGOUT_MS = 30 * 60 * 1000;

const getRoute = () => {
  if (location.hash) {
    const [hashPath, queryString = ''] = location.hash.slice(1).split('?');
    return {path: hashPath || 'home', params: new URLSearchParams(queryString)};
  }
  const segments = location.pathname.split('/').filter(Boolean).map(part => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  const last = String(segments[segments.length - 1] || '').toLowerCase();
  const aliases = {
    'index.html': ['home',''], 'live': ['shop','category=livestock'],
    'live-animals': ['shop','category=livestock'], 'livestock': ['shop','category=livestock'],
    'meat': ['shop','category=meat'], 'meat-poultry': ['shop','category=meat'],
    'supplies': ['pets',''], 'pets': ['pets',''], 'pet-supplies': ['pets',''],
    'vet-care': ['shop','category=animal-care'], 'animal-care': ['shop','category=animal-care'],
    'animal-products': ['shop','category=animal-products'], 'products': ['shop',''],
    'marketplace': ['shop',''], 'cart': ['cart',''], 'wishlist': ['wishlist',''],
    'saved': ['wishlist',''], 'seller': ['dashboard',''], 'dashboard': ['dashboard',''], 'login': ['login',''], 'partner': ['partner',''],
    'admin': ['admin',''], 'about': ['about',''], 'learn': ['learn',''],
    'contact': ['contact',''], 'privacy': ['privacy',''], 'terms': ['terms','']
  };
  if (segments.length >= 2 && String(segments[segments.length - 2]).toLowerCase() === 'product') {
    return {path: 'product/' + encodeURIComponent(segments[segments.length - 1]), params: new URLSearchParams(location.search.slice(1))};
  }
  const mapped = aliases[last];
  if (!mapped) return {path: last || 'home', params: new URLSearchParams(location.search.slice(1))};
  const params = new URLSearchParams(mapped[1]);
  new URLSearchParams(location.search.slice(1)).forEach((value,key) => params.set(key,value));
  return {path: mapped[0], params};
};
const allProducts = () => store.products();
const activeProducts = () => allProducts().filter(p => p.status === 'approved' && (() => { const r = store.retailers().find(x => x.ownerId === p.retailerId || x.id === p.retailerId); return !r || r.status === 'approved'; })());
const isAvailable = p => Number(p.stock) > 0;
const getProduct = id => allProducts().find(p => p.id === id);
const cartCount = () => store.cart().reduce((n, i) => n + Number(i.qty || 0), 0);
const publicProductUrl = p => `#product/${encodeURIComponent(p.id)}`;
const session = () => isFirebaseConfigured() ? firebaseSession : store.session();
const demoSession = role => ({uid:`demo-${role}`,name: role === 'admin' ? 'Pashughar Admin' : role === 'retailer' ? 'Demo Retailer' : 'Demo Customer',email:`${role}@pashughar.demo`,role,storeName: ''});
const statusLabel = status => ({approved:'Published',pending:'Pending verification',rejected:'Rejected',suspended:'Suspended',banned:'Banned',open:'Open',reviewing:'Under review',resolved:'Resolved',dismissed:'Dismissed'})[status] || status || 'Unknown';
const statusClass = status => ({approved:'',pending:'status-pending',rejected:'status-rejected',suspended:'status-inactive',banned:'status-rejected',open:'status-pending',reviewing:'status-pending',resolved:'',dismissed:'status-inactive'})[status] || 'status-inactive';
const shopStatusLabel = status => ({approved:'Verified',pending:'Pending verification',rejected:'Rejected',suspended:'Suspended',banned:'Banned'})[status] || status || 'Unknown';
const showToast = (message, type = '') => {
  const element = document.createElement('div'); element.className = `toast ${type}`; element.textContent = message;
  toastRegion.append(element); setTimeout(() => element.remove(), 3200);
};
const NEPALI_SEARCH_ALIASES = {
  'गाई':'cow', 'गाईको':'cow', 'गोरु':'ox', 'भैंसी':'buffalo', 'राँगा':'buffalo',
  'बाख्रा':'goat', 'खसी':'goat', 'भेडा':'sheep', 'कुखुरा':'chicken', 'हाँस':'duck',
  'कुकुर':'dog', 'बिरालो':'cat', 'मासु':'meat', 'कुखुराको मासु':'chicken meat',
  'दूध':'milk', 'अण्डा':'egg', 'घाँस':'fodder', 'दाना':'feed',
  'औषधि':'medicine', 'भेटेरिनरी':'veterinary', 'पशु चिकित्सक':'veterinarian',
  'पाल्तु':'pet', 'खोर':'cage', 'कलर':'collar', 'डोरी':'leash',
  'खोप':'vaccine', 'खसीको मासु':'goat meat', 'माछा':'fish', 'सुँगुर':'pig'
};
const normalizeSearchText = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/[\u200b-\u200f\ufeff]/g,'').replace(/[àáâãäå]/g,'a').replace(/[èéêë]/g,'e').replace(/[ìíîï]/g,'i').replace(/[òóôõö]/g,'o').replace(/[ùúûü]/g,'u');
function searchExpansion(value) {
  const text=normalizeSearchText(value);
  const extras=[];
  Object.entries(NEPALI_SEARCH_ALIASES).forEach(([nepali,english])=>{if(text.includes(nepali))extras.push(english);});
  return (text+' '+extras.join(' ')).trim();
}
function editDistance(a,b,max=2) {
  if(Math.abs(a.length-b.length)>max)return max+1;
  let prev=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++){
    const cur=[i];let rowMin=i;
    for(let j=1;j<=b.length;j++){
      cur[j]=Math.min(cur[j-1]+1,prev[j]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));
      rowMin=Math.min(rowMin,cur[j]);
    }
    if(rowMin>max)return max+1;
    prev=cur;
  }
  return prev[b.length];
}
function productSearchText(product) {
  const attrs=Object.values(product.attributes||{}).join(' ');
  return searchExpansion([product.name,product.description,product.retailer,product.location,categoryName(product.category),attrs].join(' '));
}
function productMatchesQuery(product, query) {
  const q=normalizeSearchText(query).trim();
  if(!q)return true;
  const hay=productSearchText(product);
  if(hay.includes(q))return true;
  const hayTokens=hay.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const tokens=q.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const matchesToken=token=>hayTokens.some(word=>word.includes(token)||(token.length>=4&&editDistance(token,word,1)<=1));
  if(tokens.length&&tokens.every(matchesToken))return true;
  // Nepali aliases are alternatives; translated words must not become mandatory query tokens.
  for(const [nepali,english] of Object.entries(NEPALI_SEARCH_ALIASES)){
    if(q.includes(nepali)){
      const alternatives=normalizeSearchText(english);
      if(hay.includes(alternatives))return true;
      const alternativeTokens=alternatives.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      if(alternativeTokens.length&&alternativeTokens.every(matchesToken))return true;
    }
  }
  return false;
}
function getSearchHistory() {
  try {const value=JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY)||'[]');return Array.isArray(value)?value.filter(x=>x&&typeof x.term==='string'):[];} catch{return [];}
}
function recordSearch(term) {
  const cleaned=String(term||'').trim().slice(0,80);if(cleaned.length<2)return;
  const key=normalizeSearchText(cleaned);
  const historyItems=getSearchHistory().filter(x=>normalizeSearchText(x.term)!==key);
  historyItems.unshift({term:cleaned,count:(getSearchHistory().find(x=>normalizeSearchText(x.term)===key)?.count||0)+1,at:Date.now()});
  try {localStorage.setItem(SEARCH_HISTORY_KEY,JSON.stringify(historyItems.slice(0,30)));} catch {}
}
function searchTrendTerms() {
  return getSearchHistory().sort((a,b)=>Number(b.count||0)-Number(a.count||0)||Number(b.at||0)-Number(a.at||0)).slice(0,6).map(x=>x.term);
}
function distanceKm(aLat,aLng,bLat,bLng) {
  const toRad=value=>value*Math.PI/180;
  const dLat=toRad(bLat-aLat),dLng=toRad(bLng-aLng);
  const x=Math.sin(dLat/2)**2+Math.cos(toRad(aLat))*Math.cos(toRad(bLat))*Math.sin(dLng/2)**2;
  return 6371*2*Math.asin(Math.sqrt(Math.min(1,x)));
}
function productCoordinates(product) {
  const attrs=product.attributes||{};
  const lat=Number(product.latitude??attrs.latitude),lng=Number(product.longitude??attrs.longitude);
  return Number.isFinite(lat)&&Number.isFinite(lng)&&Math.abs(lat)<=90&&Math.abs(lng)<=180?{lat,lng}:null;
}
function productDistance(product) {
  const coords=productCoordinates(product);
  return shopperGeo&&coords?distanceKm(shopperGeo.lat,shopperGeo.lng,coords.lat,coords.lng):Infinity;
}
function locationOptions(products,key) {
  return [...new Set(products.map(p=>String(p.attributes?.[key]||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
}
function renderSearchTrends() {
  const terms=searchTrendTerms();
  if(terms.length)return '<section class="search-trends"><div class="container"><div class="search-trends-heading"><div><div class="eyebrow">Your discovery history</div><h2>Recent searches on this device</h2></div><span class="small-muted">Updates as you search</span></div><div class="search-trend-chips">'+terms.map(term=>'<button type="button" class="search-trend-chip" data-action="search-suggestion" data-query="'+safe(term)+'">'+safe(term)+' <span>↗</span></button>').join('')+'</div></div></section>';
  const dynamic=CATEGORIES.filter(c=>c.active!==false&&activeProducts().some(p=>normalizeCategoryId(p.category)===c.id)).slice(0,5);
  return '<section class="search-trends"><div class="container"><div class="search-trends-heading"><div><div class="eyebrow">Explore by category</div><h2>Start with a category</h2></div></div><div class="search-trend-chips">'+dynamic.map(c=>'<button type="button" class="search-trend-chip" data-action="search-suggestion" data-query="'+safe(c.name)+'">'+safe(c.name)+' <span>↗</span></button>').join('')+'</div></div></section>';
}
function renderSearchSuggestionItems(query) {
  const host=document.getElementById('search-suggestions');const input=document.getElementById('search-input');
  if(!host||!input)return;
  const q=String(query||'').trim();
  if(q.length<1){host.hidden=true;host.innerHTML='';return;}
  const products=activeProducts().filter(p=>productMatchesQuery(p,q)).slice(0,5);
  const categories=CATEGORIES.filter(c=>c.active!==false&&productMatchesQuery({name:c.name,description:c.description,retailer:'',location:'',category:c.id,attributes:{}},q)).slice(0,3);
  const historyTerms=searchTrendTerms().filter(term=>normalizeSearchText(term).includes(normalizeSearchText(q))).slice(0,3);
  const list=[];
  historyTerms.forEach(term=>list.push({type:'Recent search',label:term,query:term}));
  categories.forEach(c=>list.push({type:'Category',label:c.name,query:c.name,category:c.id}));
  products.forEach(p=>list.push({type:'Product',label:p.name,meta:money(p.price)+' · '+(p.location||'Nepal'),productId:p.id,query:p.name,image:p.image}));
  lastSearchSuggestions=list.slice(0,8);
  if(!list.length){host.innerHTML='<div class="search-suggestion-empty">No direct matches. Press Enter to search all listings.</div>';host.hidden=false;return;}
  host.innerHTML=list.slice(0,8).map((item,index)=>'<button type="button" role="option" aria-selected="false" class="search-suggestion-item" data-action="search-suggestion" data-query="'+safe(item.query)+'" '+(item.productId?'data-product-id="'+safe(item.productId)+'"':'')+' '+(item.category?'data-category="'+safe(item.category)+'"':'')+'><span class="search-suggestion-icon">'+(item.type==='Product'?'⌕':item.type==='Category'?'▦':'↺')+'</span><span class="search-suggestion-copy"><strong>'+safe(item.label)+'</strong>'+(item.meta?'<small>'+safe(item.meta)+'</small>':'')+'</span><small class="search-suggestion-type">'+safe(item.type)+'</small></button>').join('');
  host.hidden=false;
}

function imageSrcset(url) {
  try {
    const parsed=new URL(String(url||''));
    if(parsed.hostname==='images.unsplash.com'){
      return [320,640,960].map(width=>{const copy=new URL(parsed.href);copy.searchParams.set('auto','format');copy.searchParams.set('fit','crop');copy.searchParams.set('w',String(width));copy.searchParams.set('q','80');return copy.href+' '+width+'w';}).join(', ');
    }
  } catch {}
  return '';
}
function sellerIsVerified(product) {
  const seller=store.retailers().find(r=>(r.ownerId||r.id)===product.retailerId);
  return Boolean(seller&&seller.status==='approved');
}
const productCard = p => {
  const canonicalCategory=normalizeCategoryId(p.category);
  const cardCategory=CATEGORIES.some(category=>category.id===canonicalCategory)?canonicalCategory:'other';
  const imageUrl=p.image||'';
  const srcset=imageSrcset(imageUrl);
  const reviewData=productReviewCache.get(p.id);
  const reviewBadge=reviewData&&reviewData.length?'<span class="card-rating" aria-label="Rating '+(reviewData.reduce((sum,r)=>sum+Number(r.rating||0),0)/reviewData.length).toFixed(1)+' out of 5">★ '+(reviewData.reduce((sum,r)=>sum+Number(r.rating||0),0)/reviewData.length).toFixed(1)+' <small>('+reviewData.length+')</small></span>':'';
  return `
  <article class="product-card product-card--${cardCategory}">
    <div class="product-image-wrap"><a href="${publicProductUrl(p)}" aria-label="View ${safe(p.name)}"><img class="product-image" src="${safe(imageUrl)}" ${srcset?'srcset="'+safe(srcset)+'" sizes="(max-width: 600px) 50vw, (max-width: 1000px) 33vw, 25vw"':''} width="640" height="550" alt="${safe(p.name)}" loading="lazy" decoding="async" onerror="this.onerror=null;this.classList.add('image-failed');this.closest('.detail-image')?.classList.add('image-missing');this.closest('.product-image-wrap')?.classList.add('image-missing');this.alt='Image unavailable for ${safe(p.name)}'"></a>
      <span class="product-badge ${isAvailable(p)?'':'sold-out'}">${isAvailable(p)?(p.isNew?'JUST ADDED':'IN STOCK'):'SOLD OUT'}</span>
      <button class="wishlist-button ${store.wishlist().includes(p.id)?'is-saved':''}" data-action="wishlist" data-id="${safe(p.id)}" aria-label="${store.wishlist().includes(p.id)?'Remove':'Add'} ${safe(p.name)} ${store.wishlist().includes(p.id)?'from':'to'} wishlist" aria-pressed="${store.wishlist().includes(p.id)?'true':'false'}">${store.wishlist().includes(p.id)?'♥':'♡'}</button>
    </div>
    <div class="product-content"><div class="product-store"><span class="store-dot"></span><span>${safe(p.retailer||'Local retailer')}</span>${sellerIsVerified(p)?'<span class="verified-badge" title="Verified retailer">✓ Verified</span>':''}</div>
      <a href="${publicProductUrl(p)}"><h3 class="product-title">${safe(p.name)}</h3></a>
      <div class="product-meta"><span>${safe(p.location||'Nepal')}</span><span>${safe(categoryName(canonicalCategory))}</span></div>
      ${reviewBadge}
      <div class="product-bottom"><div><span class="product-price">${money(p.price)}</span><span class="product-unit"> / ${safe(p.unit||'item')}</span></div><button class="add-button" data-action="add-cart" data-id="${safe(p.id)}" aria-label="Add ${safe(p.name)} to basket" ${isAvailable(p)?'':'disabled'}>${isAvailable(p)?'＋ Add':'Sold out'}</button></div>
    </div>
  </article>`;
};
const productSkeletons = (count = 4) => '<div class="product-grid product-grid--skeleton" aria-label="Loading product listings">'+Array.from({length:count},()=>'<article class="skeleton-product"><div class="skeleton-block skeleton-product-image"></div><div class="skeleton-product-copy"><div class="skeleton-block skeleton-line"></div><div class="skeleton-block skeleton-title"></div><div class="skeleton-block skeleton-line short"></div><div class="skeleton-block skeleton-price"></div></div></article>').join('')+'</div>';
const sectionHeading = (eyebrow, title, desc = '', action = '') => `<div class="section-head"><div><div class="eyebrow">${eyebrow}</div><h2>${title}</h2>${desc?`<p>${desc}</p>`:''}</div>${action?`<a href="#shop" class="section-link">${action} →</a>`:''}</div>`;
const emptyState = (icon, title, desc, href = '#shop', label = 'Explore products') => `<div class="empty-state"><div class="empty-state-icon">${icon}</div><h2>${title}</h2><p>${desc}</p><a class="button button-primary" href="${href}">${label}</a></div>`;
const demoNotice = () => isFirebaseConfigured() ? (catalogueLoaded ? '' : `<div class="notice notice-info"><strong>Connecting to live data…</strong> The public catalogue is loading from Firestore.</div>`) : `<div class="notice notice-warn"><strong>Prototype mode:</strong> Records in this browser only. Connect Firebase before a public launch.</div>`;
const retailerProfile = user => store.retailers().find(r => r.ownerId === user?.uid || (user?.email && r.email?.toLowerCase() === user.email.toLowerCase())) || null;
const isVerifiedRetailer = user => Boolean(retailerProfile(user) && retailerProfile(user).status === 'approved');
const openReportCount = retailerId => store.reports().filter(r => r.retailerId === retailerId && ['open','reviewing'].includes(r.status)).length;
const sunIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></svg>';
const moonIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.8 15.3A8.5 8.5 0 0 1 8.7 3.2 8.7 8.7 0 1 0 20.8 15.3Z"/></svg>';
function applyTheme(theme, persist = false) {
  const value = theme === 'dark' ? 'dark' : 'light';
  document.body.dataset.theme = value;
  const button = document.getElementById('theme-toggle');
  if (button) {
    button.innerHTML = value === 'dark' ? sunIcon : moonIcon;
    button.setAttribute('aria-label', value === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    button.title = value === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  }
  if (persist) localStorage.setItem('pashughar.theme.v1', value);
}
function initializeTheme() {
  let selected = 'light';
  try { selected = localStorage.getItem('pashughar.theme.v1') || 'light'; } catch {}
  applyTheme(selected);
}
function renderAuthFrame({eyebrow, title, description, icon, form, footnote = ''}) {
  app.innerHTML = `<div class="auth-page"><div class="auth-card"><div class="auth-icon">${icon}</div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p class="auth-description">${description}</p>${form}${footnote?`<p class="auth-footnote">${footnote}</p>`:''}<a class="auth-back-link" href="#home">← Back to shopping</a></div></div>`;
}
function authFormMarkup(prefix, isAdmin = false) {
  if (!isFirebaseConfigured()) {
    const id = isAdmin ? 'admin' : 'retailer';
    return `<form id="${prefix}-form"><div class="field"><label for="${id}-username">${isAdmin?'Administrator':'Retailer'} ID</label><input id="${id}-username" name="username" autocomplete="username" required placeholder="Enter ${id} ID"></div><div class="field"><label for="${id}-password">Password</label><input id="${id}-password" name="password" type="password" autocomplete="current-password" required placeholder="Enter password"></div><button class="button button-primary button-wide" type="submit">Continue <span aria-hidden="true">→</span></button></form>`;
  }
  return `<form id="${prefix}-form"><div class="field"><label for="${prefix}-email">Email address</label><input id="${prefix}-email" name="email" type="email" autocomplete="email" required maxlength="254" placeholder="you@example.com"></div><div class="field"><label for="${prefix}-password">Password</label><input id="${prefix}-password" name="password" type="password" autocomplete="current-password" minlength="6" required placeholder="At least 6 characters"></div><button class="button button-primary button-wide" type="submit" name="authMode" value="signin">${isAdmin?'Sign in to admin':'Sign in to retailer workspace'} <span aria-hidden="true">→</span></button>${isAdmin?'':'<button class="button button-secondary button-wide" type="submit" name="authMode" value="signup">Create an account</button>'}</form><button class="button button-secondary button-wide" data-action="google-signin" type="button"><span aria-hidden="true">G</span> Continue with Google</button><button class="auth-signout" data-action="password-reset" type="button">Forgot password?</button>${isAdmin && firebaseSession ? '<button class="auth-signout" data-action="signout" type="button">Sign out to switch accounts</button>' : ''}`;
}
function renderRetailerLogin() {
  renderAuthFrame({
    eyebrow: 'Retailer workspace', title: 'Sign in to your shop',
    description: 'Sign in with Google or email and password. Register your shop once, then wait for Pashughar verification before publishing products.',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5 4.5 4h15L21 10.5"/><path d="M5 10.5v9h14v-9M9 19.5v-5h6v5"/><path d="M3 10.5a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/></svg>',
    form: authFormMarkup('retailer-login', false),
    footnote: isFirebaseConfigured() ? 'Your password is handled by Firebase Authentication. Pashughar never asks for your Google password. Shop approval is separate from account creation.' : '<strong>Demo mode:</strong> Retailer ID <code>retailer</code> · Password <code>retailer</code>.'
  });
}

const RETAILER_TYPE_LABELS = {
  meat_poultry:'Meat & poultry', livestock:'Livestock', animal_products:'Animal products',
  pets_supplies:'Pets & supplies', pet_breeding:'Pet breeding', vet:'Veterinary clinic / professional'
};
const RETAILER_CATEGORY = {
  meat_poultry:'meat', livestock:'livestock', animal_products:'animal-products',
  pets_supplies:'pets-supplies', pet_breeding:'pets-supplies', vet:'animal-care'
};
function retailerTypeLabel(type){return RETAILER_TYPE_LABELS[type]||'Retailer';}
function renderPartnerWaiting(user,profile={}) {
  const status=profile.status||user?.status||'pending';
  const approved=status==='approved';
  const blocked=['suspended','banned'].includes(status);
  const title=approved?'Your partner account is approved':blocked?'Partner access is paused':status==='rejected'?'Application not approved':'Your application is awaiting review';
  const description=approved?'Your account is approved. Open the retailer dashboard to manage your listings and inbox.':blocked?'Your partner account is paused. Contact Pashughar support if you believe this is an error.':status==='rejected'?'Your application was not approved. Review the administrator’s reason below or contact Pashughar support.':'Pashughar is reviewing your application. Your retailer dashboard and listing tools stay locked until an administrator approves it.';
  app.innerHTML='<div class="page-wrap"><div class="container"><section class="verification-card"><div class="verification-symbol">'+(approved?'✓':blocked?'!':'◷')+'</div><div class="eyebrow">Pashughar partner application</div><h1>'+safe(title)+'</h1><p>'+safe(description)+'</p><div class="verification-details"><div><span>Business / owner</span><strong>'+safe(profile.storeName||user?.storeName||'Partner application')+'</strong></div><div><span>Account type</span><strong>'+safe(retailerTypeLabel(profile.retailerType||user?.retailerType))+'</strong></div><div><span>Contact</span><strong>'+safe(profile.email||user?.email||user?.phoneNumber||'—')+'</strong></div><div><span>Status</span><strong><span class="status-pill '+statusClass(status)+'">'+safe(shopStatusLabel(status))+'</span></strong></div></div>'+(profile.statusReason?'<div class="notice notice-warn"><strong>Administrator note</strong><p>'+safe(profile.statusReason)+'</p></div>':'')+'<div class="hero-actions" style="justify-content:center">'+(approved?'<a class="button button-primary" href="#dashboard">Open retailer dashboard →</a>':'<a class="button button-secondary" href="#home">Return to shopping</a>')+'<button class="button button-secondary" type="button" data-action="signout">Sign out</button></div></section></div></div>';
}
function renderPartnerRegistration() {
  const user=session();
  const existing=user?.role==='retailer'?retailerProfile(user):null;
  if(user?.role==='admin'){
    app.innerHTML='<div class="page-wrap"><div class="container"><div class="panel-card"><h1>Administrator account</h1><p>Administrator accounts cannot apply for a retailer role.</p><a class="button button-primary" href="#admin">Open admin dashboard</a></div></div></div>';return;
  }
  if(user?.role==='customer'){
    app.innerHTML='<div class="page-wrap"><div class="container"><div class="panel-card"><h1>Become a Pashughar partner</h1><p>You are currently signed in as a customer. Sign out, then create a separate partner account. Customer accounts cannot create listings.</p><button class="button button-primary" type="button" data-action="signout">Sign out to continue</button></div></div></div>';return;
  }
  if(existing){if(existing.status==='approved'){navigate('#dashboard');return;}renderPartnerWaiting(user,existing);return;}
  if(!isFirebaseConfigured()){
    app.innerHTML='<div class="page-wrap"><div class="container"><div class="panel-card"><h1>Partner registration requires Firebase</h1><p>Configure Firebase Authentication and Firestore before creating real retailer accounts. Demo mode cannot create production partner applications.</p></div></div></div>';return;
  }
  const d=partnerApplicationDraft||{};
  const value=(key,fallback='')=>safe(d[key]??fallback);
  const select=(name,label,options)=>'<div class="field"><label for="partner-'+name+'">'+label+'</label><select id="partner-'+name+'" name="'+name+'" required>'+options.map(([v,l])=>'<option value="'+v+'" '+(String(d[name]||'')===v?'selected':'')+'>'+l+'</option>').join('')+'</select></div>';
  const field=(name,label,attrs='')=>'<div class="field"><label for="partner-'+name+'">'+label+'</label><input id="partner-'+name+'" name="'+name+'" '+attrs+' value="'+value(name)+'"></div>';
  const textarea=(name,label,attrs='')=>'<div class="field"><label for="partner-'+name+'">'+label+'</label><textarea id="partner-'+name+'" name="'+name+'" '+attrs+'>'+value(name)+'</textarea></div>';
  const isExistingRetailer=user?.role==='retailer';
  const typeOptions=Object.entries(RETAILER_TYPE_LABELS).map(([v,l])=>[v,l]);
  const accountFields=isExistingRetailer
    ? '<div class="notice notice-info">You are signed in as '+safe(user.email||user.phoneNumber||'your retailer account')+'. Finish submitting the application for this account.</div><input type="hidden" name="contactMethod" value="existing">'
    : '<div class="field"><label for="partner-contact-method">Account verification method</label><select id="partner-contact-method" name="contactMethod"><option value="email" '+(d.contactMethod!=='phone'?'selected':'')+'>Email + password</option><option value="phone" '+(d.contactMethod==='phone'?'selected':'')+'>Phone OTP</option></select></div><div data-partner-contact="email" '+(d.contactMethod==='phone'?'hidden':'')+'>'+field('email','Email address *','type="email" autocomplete="email" maxlength="254" required '+(user?'readonly':''))+field('password','Create password *','type="password" autocomplete="new-password" minlength="6" maxlength="128" '+(user?'disabled':'required'))+'</div>';
  app.innerHTML='<div class="auth-page"><div class="auth-card auth-card-wide"><div class="eyebrow">Pashughar partners</div><h1>Apply to become a partner</h1><p class="auth-description">Create your account and send one application for administrator review. Your retailer type is locked when submitted; only an administrator can change it after approval.</p><form id="partner-register-form">'+accountFields+field('contactName','Your full name *','required maxlength="100" autocomplete="name"')+(!isExistingRetailer?'<div data-partner-contact="phone" '+(d.contactMethod!=='phone'?'':'')+'>'+field('phone','Phone number *','required maxlength="40" inputmode="tel" autocomplete="tel" placeholder="+977 98XXXXXXXX"')+'<div id="partner-recaptcha-container"></div><div id="partner-otp-group" '+(partnerOtpSent?'':'hidden')+'><div class="field"><label for="partner-otp">SMS verification code *</label><input id="partner-otp" name="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" '+(partnerOtpSent?'required':'')+' placeholder="6-digit code"></div></div></div>':field('phone','Contact phone *','required maxlength="40" inputmode="tel"'))+field('storeName','Business / clinic / owner name *','required maxlength="100"')+select('retailerType','Choose one retailer type *',typeOptions)+field('location','Location / municipality / district *','required maxlength="220" autocomplete="street-address"')+textarea('description','Business description','maxlength="700" rows="3" placeholder="Describe your business, animals or services"')+
    '<div data-partner-type="vet" '+(d.retailerType==='vet'?'':'hidden')+'><h3 class="form-section-title">Veterinary professional details</h3>'+field('degree','Degree / qualification *','required maxlength="100" placeholder="e.g. BVSc & AH"')+field('university','University *','required maxlength="180"')+field('graduationYear','Graduation year *','required type="number" min="1950" max="'+new Date().getFullYear()+'"')+field('councilRegistrationNumber','Veterinary council registration number *','required maxlength="120"')+'<div class="field"><label for="partner-certificate">Qualification certificate * (PDF/JPG/PNG/WebP, max 10 MB)</label><input id="partner-certificate" name="certificateFile" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" required></div>'+textarea('workExperience','Work experience *','required maxlength="1000" rows="3"')+textarea('clinicLocations','Clinic locations * (one per line)','required maxlength="1000" rows="3"')+textarea('services','Services offered * (one per line)','required maxlength="1000" rows="3"')+field('fees','Consultation / service fees *','required maxlength="500"')+textarea('availability','Availability *','required maxlength="700" rows="3" placeholder="Days, hours, emergency arrangements"')+'</div>'+
    '<div data-partner-type="pet_breeding" '+(d.retailerType==='pet_breeding'?'':'hidden')+'><h3 class="form-section-title">Pet breeding owner details</h3>'+textarea('ownerInfo','Owner information *','required maxlength="500" rows="2"')+textarea('animalsNote','Initial animals / breeds and health records','maxlength="700" rows="3" placeholder="You can add each animal as a listing after approval.")+'</div>'+
    '<div class="notice notice-info"><strong>After submission:</strong> Your application is pending. You cannot create listings, sell, or accept bookings until approved.</div><button class="button button-primary button-wide" id="partner-submit" type="submit">'+(partnerOtpSent?'Confirm OTP and submit application':'Submit partner application →')+'</button><a class="auth-back-link" href="#home">← Back to marketplace</a></form></div></div>';
  const typeInput=document.getElementById('partner-retailerType');
  const syncType=()=>document.querySelectorAll('[data-partner-type]').forEach(el=>{el.hidden=el.dataset.partnerType!==typeInput?.value;});
  typeInput?.addEventListener('change',syncType);syncType();
  document.getElementById('partner-contact-method')?.addEventListener('change',e=>{
    partnerOtpSent=false;
    document.querySelectorAll('[data-partner-contact]').forEach(el=>el.hidden=el.dataset.partnerContact!==e.target.value);
    const otp=document.getElementById('partner-otp-group');if(otp)otp.hidden=true;
    const submit=document.getElementById('partner-submit');if(submit)submit.textContent='Submit partner application →';
  });
}
async function submitPartnerRegistration(form) {
  const fd=new FormData(form);
  partnerApplicationDraft=Object.fromEntries(fd.entries());
  const method=String(fd.get('contactMethod')||'existing');
  const type=String(fd.get('retailerType')||'');
  if(!isFirebaseConfigured())throw new Error('Firebase is required to register a real partner.');
  if(!RETAILER_CATEGORY[type])throw new Error('Choose a valid retailer type.');
  const user=session();
  if(user?.role==='customer'||user?.role==='admin')throw new Error('Sign out and create a separate retailer account.');
  if(method==='phone'&&!user?.firebase) {
    const phone=String(fd.get('phone')||'').trim();
    if(!partnerOtpSent) {
      await sendPhoneOtp(phone,'retailer',true,'partner-recaptcha-container');
      partnerOtpSent=true;
      const otp=document.getElementById('partner-otp-group');if(otp){otp.hidden=false;otp.querySelector('input')?.setAttribute('required','');}
      const button=document.getElementById('partner-submit');if(button)button.textContent='Confirm OTP and submit application →';
      showToast('Phone verification code sent. Enter the code to finish the application.');return;
    }
    await confirmPhoneOtp(String(fd.get('otp')||''),'retailer');
  } else if(!user?.firebase) {
    const email=String(fd.get('email')||'').trim(),password=String(fd.get('password')||'');
    if(!email||password.length<6)throw new Error('Enter a valid email address and password of at least 6 characters.');
    await createEmailAccount(email,password,'retailer',true);
  }
  let certificateUrl='';
  const certificate=fd.get('certificateFile');
  if(type==='vet') {
    if(certificate instanceof File && certificate.size>0) certificateUrl=await uploadRetailerFile(certificate,'certificate');
    else throw new Error('Upload the veterinary qualification certificate before submitting.');
  }
  const payload={
    retailerType:type,storeName:String(fd.get('storeName')||'').trim(),
    contactName:String(fd.get('contactName')||'').trim(),phone:String(fd.get('phone')||user?.phoneNumber||'').trim(),
    email:String(fd.get('email')||user?.email||'').trim(),location:String(fd.get('location')||'').trim(),
    description:String(fd.get('description')||'').trim(),degree:String(fd.get('degree')||''),university:String(fd.get('university')||''),
    graduationYear:fd.get('graduationYear'),councilRegistrationNumber:String(fd.get('councilRegistrationNumber')||''),
    certificateUrl,workExperience:String(fd.get('workExperience')||''),clinicLocations:String(fd.get('clinicLocations')||''),
    services:String(fd.get('services')||''),fees:String(fd.get('fees')||''),availability:String(fd.get('availability')||''),
    ownerInfo:String(fd.get('ownerInfo')||''),animalsNote:String(fd.get('animalsNote')||'')
  };
  const result=await submitRetailerApplication(payload);
  partnerApplicationDraft={};partnerOtpSent=false;
  if(firebaseSession)firebaseSession={...firebaseSession,role:'retailer',status:'pending',retailerType:type,name:payload.contactName,storeName:payload.storeName};
  renderPartnerWaiting({...session(),role:'retailer',status:'pending',retailerType:type},{...payload,...result,status:'pending'});
  showToast('Partner application submitted. You will see the retailer dashboard after approval.');
}

function renderAdminLogin() {
  renderAuthFrame({
    eyebrow: 'Restricted access', title: 'Pashughar admin',
    description: isFirebaseConfigured() ? 'Admin access is granted only to accounts with a trusted server-side custom claim.' : 'Sign in to review product listings and oversee the marketplace.',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 20 6v5c0 5-3.3 8.2-8 10-4.7-1.8-8-5-8-10V6l8-3Z"/><path d="m9 12 2 2 4-4"/></svg>',
    form: authFormMarkup('admin-login', true),
    footnote: isFirebaseConfigured() ? 'Signing in does not make an account an admin. Accounts without the admin claim cannot open the control panel.' : '<strong>Demo mode only:</strong> ID <code>admin</code> · Password <code>admin</code>. Never deploy demo credentials.'
  });
}
function renderSellerSetup(user) {
  const profile = retailerProfile(user) || {};
  app.innerHTML = `<div class="auth-page"><div class="auth-card auth-card-wide"><div class="auth-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5 4.5 4h15L21 10.5"/><path d="M5 10.5v9h14v-9M9 19.5v-5h6v5"/><path d="M3 10.5a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/></svg></div><div class="eyebrow">One-time shop registration</div><h1>Register your shop</h1><p class="auth-description">Tell us who runs the shop and where it operates. Products cannot be published until an admin verifies the shop.</p><form id="retailer-profile-form"><div class="field"><label for="store-name">Shop / company name <span class="required-star">*</span></label><input id="store-name" name="storeName" required maxlength="100" ${isFirebaseConfigured()&&profile.id?'readonly':''} value="${safe(profile.storeName || user.storeName || '')}" placeholder="e.g. Himalayan Farm Supplies"></div><div class="field"><label for="store-contact-name">Contact person's full name <span class="required-star">*</span></label><input id="store-contact-name" name="contactName" required maxlength="100" ${isFirebaseConfigured()&&profile.id?'readonly':''} value="${safe(profile.contactName || user.name || '')}" placeholder="Person responsible for the shop"></div><div class="field-grid"><div class="field"><label for="store-contact">Phone number <span class="required-star">*</span></label><input id="store-contact" name="phone" inputmode="tel" required value="${safe(profile.phone || user.storePhone || '')}" placeholder="98XXXXXXXX"></div><div class="field"><label for="store-email">Email address <span class="required-star">*</span></label><input id="store-email" name="email" type="email" required ${isFirebaseConfigured()&&profile.id?'readonly':''} value="${safe(profile.email || user.email || '')}" placeholder="shop@example.com"></div></div><div class="field"><label for="store-location">Shop location / address <span class="required-star">*</span></label><input id="store-location" name="location" required maxlength="220" value="${safe(profile.location || user.storeLocation || '')}" placeholder="Municipality, district, province"></div><div class="field"><label for="store-about">About your shop</label><textarea id="store-about" name="description" maxlength="700" placeholder="What do you sell?">${safe(profile.description || user.storeDescription || '')}</textarea></div><div class="notice notice-info"><strong>Next step:</strong> ${isFirebaseConfigured()&&profile.id?'Shop name, contact name and account email are locked after submission; phone, location and description can be edited.':'Your shop status will be <strong>Pending verification</strong>.'} You can return to this retailer area to check the decision. After verification, you can publish products directly without product-by-product approval.</div><button class="button button-primary button-wide" type="submit">Submit shop for verification <span aria-hidden="true">→</span></button></form><button class="auth-signout" data-action="signout" type="button">Sign out</button></div></div>`;
}
function renderRetailerVerificationState(user, profile) {
  const rejected = profile.status === 'rejected';
  const banned = ['suspended','banned'].includes(profile.status);
  const canEdit = !banned && !(isFirebaseConfigured() && rejected);
  const title = rejected ? 'Shop verification needs attention' : banned ? 'Retailer access is paused' : 'Your shop is awaiting verification';
  const copy = rejected
    ? (isFirebaseConfigured() ? `The admin did not approve ${safe(profile.storeName)}. Contact Pashughar support to request another review.` : `The admin did not approve ${safe(profile.storeName)} yet. Update your shop details and request another review.`)
    : banned ? `Retailer access for ${safe(profile.storeName)} is currently ${profile.status}. Contact Pashughar support for more information.` : `Pashughar is checking the details for ${safe(profile.storeName)}. You can publish products as soon as your shop is approved.`;
  app.innerHTML = `<div class="page-wrap"><div class="container"><section class="verification-card"><div class="verification-symbol">${banned?'!':'◷'}</div><div class="eyebrow">Retailer verification</div><h1>${title}</h1><p>${copy}</p><div class="verification-details"><div><span>Shop</span><strong>${safe(profile.storeName)}</strong></div><div><span>Contact</span><strong>${safe(profile.contactName || user.name || '—')}</strong></div><div><span>Submitted email</span><strong>${safe(profile.email || user.email || '—')}</strong></div><div><span>Status</span><strong><span class="status-pill ${statusClass(profile.status)}">${shopStatusLabel(profile.status)}</span></strong></div></div><div class="hero-actions" style="justify-content:center">${canEdit?'<button class="button button-primary" data-action="edit-shop-registration">Update shop details</button>':''}<a class="button button-secondary" href="#home">Return to shopping</a><button class="button button-secondary" data-action="signout">Sign out</button></div></section></div></div>`;
}

function renderHome() {
  delete app.dataset.sectionTheme;
  const products = activeProducts();
  const featured = products.slice().sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,4);
  app.innerHTML = `
    <section class="hero"><div class="container hero-grid"><div class="hero-copy"><div class="eyebrow">One marketplace. Every animal need.</div><h1>${safe(store.siteSettings().bannerTitle || 'Everything for animals, all in one place.')}</h1><p>${safe(store.siteSettings().bannerText || 'Discover livestock, fresh meat, pets, pet essentials and animal products from retailers in one convenient marketplace.')}</p><div class="hero-actions"><a href="#shop" class="button button-primary">Explore marketplace <span>→</span></a><a href="#learn" class="button button-secondary">How it works</a></div><div class="hero-proof"><span class="proof-point"><span class="proof-check">✓</span> Local retailers</span><span class="proof-point"><span class="proof-check">✓</span> Clear stock status</span><span class="proof-point"><span class="proof-check">✓</span> One easy marketplace</span></div></div>
    <div class="hero-visual"><img src="${safe(store.siteSettings().bannerImage || "https://images.unsplash.com/photo-1500382017468-9049fed747ef?auto=format&fit=crop&w=1200&q=85")}" alt="Pashughar homepage banner" fetchpriority="high"><div class="hero-sticker"><strong>All together.</strong><span>From farm essentials to pet favourites.</span></div><div class="hero-image-label"><span>Welcome to Pashughar</span><h2>Closer to the things you care for.</h2><p>Shop from a growing community of animal and farm retailers.</p></div></div></div></section>
    <section class="category-section"><div class="container">${sectionHeading('Browse the marketplace','What are you looking for?','Choose a category to start.')}</div><div class="container category-grid">${CATEGORIES.filter(c=>c.active!==false).map(c=>`<a class="category-card category-card--${c.id}" href="${c.id==='pets-supplies'?'#pets':'#shop?category='+c.id}" style="--category-accent:${c.palette.accent};--category-deep:${c.palette.deep};--category-wash:${c.palette.wash}"><img class="category-photo" src="${safe(c.image)}" alt="" loading="lazy"><span class="category-card-copy"><span class="category-kicker">${safe(c.kicker)}</span><h3>${safe(c.name)}</h3><p>${safe(c.cardDescription)}</p><span class="category-card-link">Explore category <span aria-hidden="true">↗</span></span></span></a>`).join('')}</div></section>
    <section class="products-section"><div class="container">${sectionHeading('Picked for you','Recently added','New listings from participating retailers.','View all products')}<div class="product-grid">${featured.map(productCard).join('')}</div>${featured.length===0?(catalogueLoaded?emptyState('⌕','No products yet','Approved product listings will appear here.','#partner','Become a partner'):productSkeletons()):''}</div></section>
    ${renderSearchTrends()}<section class="trust-strip"><div class="container trust-grid"><div class="trust-item"><div class="trust-icon"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10.5 4.5 4h15L21 10.5M5 10.5v9h14v-9M9 19.5v-5h6v5M3 10.5a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/></svg></div><div><strong>A wider choice</strong><span>Products from multiple retailers</span></div></div><div class="trust-item"><div class="trust-icon"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.6 2.6L16.5 9"/></svg></div><div><strong>Clear availability</strong><span>Know what is in stock before ordering</span></div></div><div class="trust-item"><div class="trust-icon"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg></div><div><strong>Local marketplace</strong><span>Discover sellers around Nepal</span></div></div><div class="trust-item"><div class="trust-icon"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 8.7c0 5.2-8.8 11-8.8 11s-8.8-5.8-8.8-11a4.8 4.8 0 0 1 8.8-2.4 4.8 4.8 0 0 1 8.8 2.4Z"/></svg></div><div><strong>Animal needs, together</strong><span>From livestock to everyday pet care</span></div></div></div></section>
`;
}

function renderShop(params = new URLSearchParams()) {
  activeShopCategory=normalizeCategoryId(params.get('category')||activeShopCategory||'');
  activeShopQuery=params.has('q')?params.get('q'):activeShopQuery;
  const searchBox=document.getElementById('search-input');if(searchBox&&searchBox.value!==activeShopQuery)searchBox.value=activeShopQuery;
  document.getElementById('search-suggestions')?.setAttribute('hidden','');
  const all=activeProducts();
  const sectionCategory=CATEGORIES.find(category=>category.id===activeShopCategory);
  if(sectionCategory)app.dataset.sectionTheme=sectionCategory.id;else delete app.dataset.sectionTheme;
  let items=all.slice();
  if(activeShopCategory)items=items.filter(p=>normalizeCategoryId(p.category)===activeShopCategory);
  const q=activeShopQuery.trim();
  if(q)items=items.filter(p=>productMatchesQuery(p,q));
  if(activeShopStockOnly)items=items.filter(isAvailable);
  if(activePriceMin!=='')items=items.filter(p=>Number(p.price)>=Number(activePriceMin));
  if(activePriceMax!=='')items=items.filter(p=>Number(p.price)<=Number(activePriceMax));
  if(activeProvince)items=items.filter(p=>String(p.attributes?.province||'')===activeProvince);
  if(activeDistrict)items=items.filter(p=>String(p.attributes?.district||'')===activeDistrict);
  if(activeMunicipality)items=items.filter(p=>String(p.attributes?.municipality||'')===activeMunicipality);
  if(nearMeEnabled && shopperGeo)items=items.filter(p=>Number.isFinite(productDistance(p)));
  if(activeShopSort==='price-asc')items.sort((x,y)=>Number(x.price)-Number(y.price));
  if(activeShopSort==='price-desc')items.sort((x,y)=>Number(y.price)-Number(x.price));
  if(activeShopSort==='newest')items.sort((x,y)=>new Date(y.createdAt||0)-new Date(x.createdAt||0));
  if(activeShopSort==='name')items.sort((x,y)=>String(x.name).localeCompare(String(y.name)));
  if(activeShopSort==='nearest')items.sort((x,y)=>productDistance(x)-productDistance(y));
  const total=items.length;
  const pageCount=Math.max(1,Math.ceil(total/PAGE_SIZE));
  activeShopPage=Math.max(1,Math.min(activeShopPage,pageCount));
  const start=(activeShopPage-1)*PAGE_SIZE;
  const visible=items.slice(start,start+PAGE_SIZE);
  const checked=id=>activeShopCategory===id?'checked':'';
  const provinceOptions=locationOptions(all,'province');
  const districtProducts=activeProvince?all.filter(p=>p.attributes?.province===activeProvince):all;
  const districtOptions=locationOptions(districtProducts,'district');
  const municipalityProducts=activeDistrict?districtProducts.filter(p=>p.attributes?.district===activeDistrict):districtProducts;
  const municipalityOptions=locationOptions(municipalityProducts,'municipality');
  const selectOptions=(options,current,placeholder)=>'<option value="">'+placeholder+'</option>'+options.map(value=>'<option value="'+safe(value)+'" '+(current===value?'selected':'')+'>'+safe(value)+'</option>').join('');
  const categoryBanner=sectionCategory
    ? '<section class="category-shop-banner" style="--section-accent:'+sectionCategory.palette.accent+';--section-deep:'+sectionCategory.palette.deep+';--section-wash:'+sectionCategory.palette.wash+';--section-soft:'+sectionCategory.palette.soft+';--section-warm:'+sectionCategory.palette.warm+'"><div class="category-shop-copy"><div class="eyebrow">'+safe(sectionCategory.kicker)+'</div><h1>'+safe(sectionCategory.name)+'</h1><p>'+safe(sectionCategory.description)+'. Explore approved listings from local retailers.</p><a href="#shop" class="category-back-link">View all categories <span aria-hidden="true">→</span></a></div><div class="category-shop-image"><img src="'+safe(sectionCategory.image)+'" width="640" height="450" alt="" loading="lazy" decoding="async"></div></section>'
    : '<div class="page-title-row"><div><div class="eyebrow">The Pashughar marketplace</div><h1>Explore all products</h1><p>Find products and livestock offered by local retailers.</p></div></div>';
  const noResults=total===0
    ? '<div class="empty-state search-no-results"><div class="empty-state-icon">⌕</div><h2>No matching products</h2><p>Try a shorter phrase, a Nepali word, a wider price range or a nearby district.</p><div class="no-results-actions"><button class="button button-secondary" type="button" data-action="reset-filters">Clear filters</button><button class="button button-primary" type="button" data-action="search-suggestion" data-query="">Browse all products</button></div><div class="search-trend-chips">'+CATEGORIES.slice(0,5).map(c=>'<button type="button" class="search-trend-chip" data-action="set-category" data-category="'+safe(c.id)+'">'+safe(c.name)+'</button>').join('')+'</div></div>'
    : '';
  const resultLabel=total?('Showing '+(start+1)+'–'+Math.min(start+PAGE_SIZE,total)+' of '+total+' listings'):'0 listings';
  app.innerHTML='<div class="page-wrap"><div class="container"><div class="shop-heading-row">'+categoryBanner+'<button class="button button-secondary mobile-filter-button" data-action="toggle-filters">☷ Filters</button></div>'+demoNotice()+'<div class="shop-layout"><aside class="filter-panel '+(activeShopFiltersVisible?'filters-open':'')+'" id="filter-panel"><h3>Filter products</h3><div class="filter-group"><h4>Categories</h4><div class="filter-options"><label class="filter-option"><input type="radio" name="category-filter" value="" '+(!activeShopCategory?'checked':'')+'> All categories</label>'+CATEGORIES.filter(c=>c.active!==false).map(c=>'<label class="filter-option"><input type="radio" name="category-filter" value="'+safe(c.id)+'" '+checked(c.id)+'> '+safe(c.name)+'</label>').join('')+'</div></div><div class="filter-group"><h4>Price range (NPR)</h4><div class="price-filter-grid"><label class="filter-option" for="price-min">Min<input id="price-min" type="number" min="0" step="1" value="'+safe(activePriceMin)+'" placeholder="0"></label><label class="filter-option" for="price-max">Max<input id="price-max" type="number" min="0" step="1" value="'+safe(activePriceMax)+'" placeholder="Any"></label></div><button type="button" class="button button-secondary button-small" data-action="apply-price-filter">Apply price</button></div><div class="filter-group"><h4>Location</h4><label class="filter-option" for="province-filter">Province<select id="province-filter">'+selectOptions(provinceOptions,activeProvince,'All provinces')+'</select></label><label class="filter-option" for="district-filter">District<select id="district-filter">'+selectOptions(districtOptions,activeDistrict,'All districts')+'</select></label><label class="filter-option" for="municipality-filter">Municipality<select id="municipality-filter">'+selectOptions(municipalityOptions,activeMunicipality,'All municipalities')+'</select></label><button type="button" class="button button-secondary button-small" data-action="near-me">'+(nearMeEnabled?'✓ Near me enabled':'⌖ Near me')+'</button><p class="small-muted">'+(nearMeEnabled?'Showing listings with coordinates.': 'Uses your device location only after you approve the browser prompt.')+'</p></div><div class="filter-group"><h4>Availability</h4><label class="filter-option"><input type="checkbox" id="stock-filter" '+(activeShopStockOnly?'checked':'')+'> In stock only</label></div><div class="filter-group"><button class="button button-secondary button-wide" data-action="reset-filters">Clear filters</button></div></aside><div class="shop-results-column"><div class="shop-toolbar"><span class="result-count">'+resultLabel+'</span><select id="sort-select" aria-label="Sort products"><option value="featured" '+(activeShopSort==='featured'?'selected':'')+'>Featured</option><option value="newest" '+(activeShopSort==='newest'?'selected':'')+'>Newest first</option><option value="price-asc" '+(activeShopSort==='price-asc'?'selected':'')+'>Price: low to high</option><option value="price-desc" '+(activeShopSort==='price-desc'?'selected':'')+'>Price: high to low</option><option value="nearest" '+(activeShopSort==='nearest'?'selected':'')+' '+(!nearMeEnabled?'disabled':'')+'>Nearest to me</option><option value="name" '+(activeShopSort==='name'?'selected':'')+'>Name A–Z</option></select></div><div class="product-grid">'+visible.map(productCard).join('')+'</div>'+noResults+(total>PAGE_SIZE?'<nav class="listing-pagination" aria-label="Product pages"><button type="button" class="button button-secondary" data-action="page-listings" data-page="'+(activeShopPage-1)+'" '+(activeShopPage<=1?'disabled':'')+'>← Previous</button><span>Page '+activeShopPage+' of '+pageCount+'</span><button type="button" class="button button-secondary" data-action="page-listings" data-page="'+(activeShopPage+1)+'" '+(activeShopPage>=pageCount?'disabled':'')+'>Next →</button></nav>':'')+'</div></div></div></div>';
}

function renderProductVideos(product) {
  const urls=Array.isArray(product?.videoUrls)?product.videoUrls:[];
  if(!urls.length)return '';
  return '<div class="product-video-section"><strong>Product videos</strong>'+urls.map((url,index)=>{
    let playable=false;
    try{playable=/\.(mp4|webm|ogv)(?:$|[?#])/i.test(new URL(url).pathname);}catch{}
    return playable
      ? '<video controls preload="metadata" playsinline width="640" height="360" aria-label="'+safe(product.name)+' video '+(index+1)+'"><source src="'+safe(url)+'"></video>'
      : '<a href="'+safe(url)+'" target="_blank" rel="noopener noreferrer">Open product video '+(index+1)+' ↗</a>';
  }).join('')+'</div>';
}

function renderProductReviewSection(productId) {
  const reviews=productReviewCache.get(productId);
  if(!reviews) return '<section class="product-reviews" id="product-reviews"><div class="panel-card"><h2>Ratings & reviews</h2><p class="small-muted">Loading verified-buyer reviews…</p></div></section>';
  const average=reviews.length?(reviews.reduce((sum,r)=>sum+Number(r.rating||0),0)/reviews.length):0;
  const stars=value=>'★'.repeat(Math.max(0,Math.min(5,Math.round(Number(value)||0))))+'☆'.repeat(5-Math.max(0,Math.min(5,Math.round(Number(value)||0))));
  const user=session();
  const reviewForm=user&&isVerifiedContact({emailVerified:user.emailVerified,phoneNumber:user.phoneNumber})
    ? '<div class="review-submit-card"><h3>Write a verified-buyer review</h3><p class="small-muted">Enter the order ID shown when your purchase was placed. Firestore checks that the order belongs to your account, includes this product and is marked Delivered.</p><form id="product-review-form" data-product-id="'+safe(productId)+'"><div class="field"><label for="review-order-id">Order ID</label><input id="review-order-id" name="orderId" required maxlength="180" placeholder="Your Pashughar order ID"></div><div class="field"><label for="review-rating">Rating</label><select id="review-rating" name="rating" required><option value="5">5 — Excellent</option><option value="4">4 — Good</option><option value="3">3 — Average</option><option value="2">2 — Poor</option><option value="1">1 — Very poor</option></select></div><div class="field"><label for="review-body">Your experience</label><textarea id="review-body" name="body" required minlength="10" maxlength="1500" placeholder="Share an honest account of your purchase."></textarea></div><button class="button button-primary" type="submit">Submit review</button></form></div>'
    : '<div class="review-submit-card"><h3>Purchased this product?</h3><p class="small-muted">Sign in using the account used for purchase and verify your email or phone to submit a review. Only delivered purchases can be reviewed.</p><a class="button button-secondary" href="'+(user?'#account':'#login')+'">'+(user?'Verify your account':'Log in to review')+'</a></div>';
  return '<section class="product-reviews" id="product-reviews"><div class="reviews-heading"><div><div class="eyebrow">Customer feedback</div><h2>Ratings & reviews</h2></div><div class="review-average">'+(reviews.length?'<strong>'+average.toFixed(1)+'</strong><span>'+stars(average)+'</span><small>'+reviews.length+' verified review(s)</small>':'<strong>—</strong><span>No ratings yet</span><small>Be the first verified buyer to review.</small>')+'</div></div><div class="review-layout"><div class="review-list">'+(reviews.length?reviews.map(review=>'<article class="review-card"><div class="review-card-top"><strong>'+safe(review.customerName||'Verified buyer')+'</strong><span class="verified-badge">✓ Verified purchase</span></div><div class="review-stars" aria-label="'+Number(review.rating)+' out of 5 stars">'+stars(review.rating)+'</div><p>'+safe(review.body||'')+'</p><small class="small-muted">'+safe(review.createdAt||'')+'</small></article>').join(''):'<div class="empty-state review-empty"><div class="empty-state-icon">☆</div><h3>No reviews yet</h3><p>Ratings will appear here after a verified buyer submits feedback for a delivered order.</p></div>')+'</div>'+reviewForm+'</div></section>';
}
async function loadProductReviews(productId, force=false) {
  if(!force&&productReviewCache.has(productId)){const cached=document.getElementById('product-reviews');if(cached)cached.outerHTML=renderProductReviewSection(productId);return;}
  try{
    const reviews=await getPublishedProductReviews(productId);
    productReviewCache.set(productId,reviews);
    const section=document.getElementById('product-reviews');
    if(section&&section.dataset.productId===productId)section.outerHTML=renderProductReviewSection(productId);
  }catch(error){
    productReviewCache.set(productId,[]);
    const section=document.getElementById('product-reviews');
    if(section)section.innerHTML='<div class="panel-card"><h2>Ratings & reviews</h2><p class="small-muted">Reviews could not be loaded. Refresh the product page and retry.</p></div>';
  }
}

function loadListingContactActions(product) {
  const host=document.getElementById('seller-direct-contact');
  if(!host||!product?.retailerId)return;
  getPublicStoreProfile(product.retailerId).then(profile=>{
    if(!profile||!host.isConnected)return;
    const raw=String(profile.publicPhone||'').trim();
    const digits=raw.replace(/[^0-9]/g,'');
    const whatsappNumber=digits.length===10 && digits.startsWith('9') ? '977'+digits : digits;
    const msg=encodeURIComponent('Hello, I am asking about '+String(product.name||'this listing')+'. '+location.origin+location.pathname+'#product/'+encodeURIComponent(product.id));
    const buttons=[];
    if(raw)buttons.push('<a class="button button-secondary" href="tel:'+safe(raw)+'">Call seller</a>');
    if(whatsappNumber.length>=7)buttons.push('<a class="button button-secondary" target="_blank" rel="noopener noreferrer" href="https://wa.me/'+whatsappNumber+'?text='+msg+'">WhatsApp seller</a>');
    if(raw)buttons.push('<a class="button button-secondary" href="viber://chat?number='+encodeURIComponent(raw)+'">Viber seller</a>');
    if(buttons.length)host.insertAdjacentHTML('beforeend',buttons.join(''));
  }).catch(()=>{});
}
function renderProduct(id) {
  const p = getProduct(id);
  if (p) app.dataset.sectionTheme = normalizeCategoryId(p.category); else delete app.dataset.sectionTheme;
  if(!p || p.status!=='approved' || !activeProducts().some(x=>x.id===p.id)) { app.innerHTML = `<div class="page-wrap"><div class="container">${emptyState('⌕','Product not found','This product may have been removed or is not currently published.','#shop','Back to marketplace')}</div></div>`; return; }
  const related = activeProducts().filter(x=>x.category===p.category && x.id!==p.id).slice(0,4);
  const attrs = Object.entries(p.attributes||{}).filter(([,v])=>v).slice(0,8);
  const images = (Array.isArray(p.images) && p.images.length ? p.images : [p.image]).filter(Boolean).slice(0,5);
  if(activeProductImageIndex >= images.length) activeProductImageIndex = 0;
  const mainImage = images[activeProductImageIndex] || p.image || '';
  app.innerHTML = `<div class="page-wrap"><div class="container"><div class="product-detail-grid"><div class="detail-image" data-action="zoom-product-image" data-id="${safe(p.id)}" role="button" tabindex="0" aria-label="Zoom product image"><img src="${safe(mainImage)}" width="900" height="900" alt="${safe(p.name)}" loading="eager" decoding="async" onerror="this.onerror=null;this.classList.add('image-failed')">${images.length>1?`<div class="detail-gallery">${images.map((src,i)=>`<button type="button" class="gallery-thumb ${i===activeProductImageIndex?'active':''}" data-action="set-product-image" data-id="${safe(p.id)}" data-index="${i}" aria-label="View product image ${i+1}"><img src="${safe(src)}" alt=""></button>`).join('')}</div>`:''}</div><div class="detail-copy"><div class="detail-category">${safe(categoryName(p.category))} · ${safe(p.condition||'Listed product')}</div><h1>${safe(p.name)}</h1><div class="product-store"><span class="store-dot"></span><a href="#store/${encodeURIComponent(p.retailerId||'')}">${safe(p.retailer||'Local retailer')}</a>${sellerIsVerified(p)?'<span class="verified-badge">✓ Verified retailer</span>':''} · ${safe(p.location||'Nepal')}</div><div class="detail-price">${money(p.price)} <span>/ ${safe(p.unit||'item')}</span></div><span class="status-pill ${isAvailable(p)?'':'status-soldout'}"><span class="status-dot"></span>${isAvailable(p)?`In stock · ${Number(p.stock)} ${safe(p.unit||'item')}${Number(p.stock)===1?'':'s'}`:'Sold out'}</span><p class="detail-description">${safe(p.description)}</p>${renderProductVideos(p)}${attrs.length?`<div class="detail-meta">${attrs.map(([k,v])=>`<div class="meta-box"><span>${safe(k.replace(/([A-Z])/g,' $1').replace(/^./,s=>s.toUpperCase()))}</span><strong>${safe(v)}</strong></div>`).join('')}</div>`:''}<div class="quantity-row"><label for="detail-qty">Quantity</label><div class="quantity-control"><button data-action="qty-minus" aria-label="Decrease quantity">−</button><input id="detail-qty" type="number" value="${['kg','litre'].includes(String(p.unit||'').toLowerCase())?0.5:1}" min="${['kg','litre'].includes(String(p.unit||'').toLowerCase())?0.5:1}" step="${['kg','litre'].includes(String(p.unit||'').toLowerCase())?0.5:1}" max="${Math.max(1,Number(p.stock))}" aria-label="Quantity"><button data-action="qty-plus" aria-label="Increase quantity" ${isAvailable(p)?'':'disabled'}>+</button></div><span class="small-muted">per ${safe(p.unit||'item')}</span></div><div class="detail-actions"><button class="button button-primary" data-action="detail-add" data-id="${safe(p.id)}" ${isAvailable(p)?'':'disabled'}>${isAvailable(p)?'Add to cart':'Sold out'}</button><button class="button button-secondary" data-action="wishlist" data-id="${safe(p.id)}">${store.wishlist().includes(p.id)?'♥ Saved':'♡ Save item'}</button></div><div id="seller-direct-contact" class="product-contact-actions"><button class="button button-secondary" data-action="enquire-product" data-id="${safe(p.id)}" type="button">Ask retailer a question</button><button class="report-link" data-action="report-product" data-id="${safe(p.id)}" type="button"><span aria-hidden="true">⚑</span> Report this listing</button></div><div class="product-share-actions" aria-label="Share product"><strong>Share listing</strong><button type="button" data-action="share-product" data-id="${safe(p.id)}" data-channel="whatsapp">WhatsApp</button><button type="button" data-action="share-product" data-id="${safe(p.id)}" data-channel="viber">Viber</button><button type="button" data-action="share-product" data-id="${safe(p.id)}" data-channel="copy">Copy link</button></div><div class="notice notice-info">Marketplace note: verify seller details, product specifications and any relevant animal health or food-safety documentation before completing a purchase.</div></div></div><div id="product-reviews" data-product-id="${safe(p.id)}">${renderProductReviewSection(p.id)}</div>${related.length?`<section class="products-section">${sectionHeading('Keep exploring','Similar listings','','View all')}<div class="product-grid">${related.map(productCard).join('')}</div></section>`:''}</div></div>`;
  loadProductReviews(id);
  loadListingContactActions(p);
}
function cartTotals(cart) {
  const subtotal = cart.reduce((sum, item)=>{const p=getProduct(item.id);return sum+(p?Number(p.price)*Number(item.qty):0)},0);
  const delivery = subtotal > 0 ? Math.max(0,Number(store.siteSettings().deliveryCharge)||0) : 0;
  return {subtotal,delivery,total:subtotal+delivery};
}
function renderCart() {
  const cart = store.cart().filter(i=>getProduct(i.id));
  if(cart.length===0) {app.innerHTML=`<div class="page-wrap"><div class="container"><div class="page-title-row"><div><div class="eyebrow">Your basket</div><h1>Shopping cart</h1></div></div>${emptyState('♧','Your cart is empty','Browse the marketplace and add products you want to order.','#shop','Explore products')}</div></div>`;return;}
  const {subtotal,delivery,total}=cartTotals(cart);
  app.innerHTML=`<div class="page-wrap"><div class="container"><div class="breadcrumbs"><a href="#home">Home</a> / Your cart</div><div class="page-title-row"><div><div class="eyebrow">Nearly there</div><h1>Your shopping cart</h1><p>${cartCount()} items across ${new Set(cart.map(i=>getProduct(i.id)?.retailerId)).size} retailer(s)</p></div><a class="button button-secondary" href="#shop">← Continue shopping</a></div>${demoNotice()}<div class="cart-layout"><section class="cart-items">${cart.map(i=>{const p=getProduct(i.id);return `<div class="cart-row"><img class="cart-thumb" src="${safe(p.image||'')}" alt="${safe(p.name)}" onerror="this.style.display='none'"><div><a href="${publicProductUrl(p)}" class="cart-name">${safe(p.name)}</a><div class="cart-sub">${safe(p.retailer||'Local retailer')} · ${money(p.price)} / ${safe(p.unit||'item')}</div><div class="cart-row-controls"><div class="mini-quantity"><button data-action="cart-minus" data-id="${safe(p.id)}" aria-label="Decrease">−</button><span>${i.qty}</span><button data-action="cart-plus" data-id="${safe(p.id)}" aria-label="Increase" ${Number(p.stock)<=Number(i.qty)?'disabled':''}>+</button></div><button class="remove-button" data-action="remove-cart" data-id="${safe(p.id)}">Remove</button></div></div><div class="cart-row-price">${money(Number(p.price)*Number(i.qty))}</div></div>`}).join('')}</section><aside class="summary-card"><h3>Order summary</h3><div class="summary-line"><span>Subtotal</span><strong>${money(subtotal)}</strong></div><div class="summary-line"><span>Delivery</span><strong>${delivery===0?'No delivery fee':money(delivery)}</strong></div><div class="summary-line total"><span>Estimated total</span><strong>${money(total)}</strong></div><p class="summary-note">The configured flat delivery fee is included in the estimate. Final fulfilment details are confirmed by the retailer; online payments are not enabled.</p><button class="button button-primary button-wide" data-action="go-checkout">Continue to checkout →</button></aside></div><div id="checkout-area"></div></div></div>`;
}
function renderCheckout() {
  const cart = store.cart().filter(i=>getProduct(i.id));
  if(!cart.length) {location.hash='#cart';return;}
  const {subtotal,total}=cartTotals(cart);
  const existing = document.getElementById('checkout-area');
  if(existing) existing.innerHTML=`<div class="panel-card" style="margin-top:22px"><div class="panel-heading"><div><h2>Checkout</h2><p>${isFirebaseConfigured()?'Enter delivery information. Stock and order totals are validated on the server.':'Enter delivery information to place a demo order.'}</p></div></div>${demoNotice()}<form id="checkout-form" data-request-id="${safe((globalThis.crypto?.randomUUID?.() || slugId()))}"><div class="field-grid"><div class="field"><label for="checkout-name">Full name *</label><input id="checkout-name" name="name" required value="${safe(session()?.name||'')}" placeholder="Your full name"></div><div class="field"><label for="checkout-phone">Phone number *</label><input id="checkout-phone" name="phone" required inputmode="tel" placeholder="98XXXXXXXX"></div></div>${!session()&&isFirebaseConfigured()?'<div class="checkout-phone-verify"><p><strong>Guest checkout phone verification</strong><br><span>Verify your mobile number by OTP. No password or separate sign-up form is required.</span></p><div id="checkout-recaptcha-container"></div><button class="button button-secondary" type="button" id="checkout-send-otp" data-action="checkout-send-otp">Verify phone by OTP</button><div id="checkout-otp-group" hidden><div class="field"><label for="checkout-otp">SMS verification code</label><input id="checkout-otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6-digit code"></div><button class="button button-primary" type="button" data-action="checkout-confirm-otp">Confirm phone</button></div><p id="checkout-verified-message" class="small-muted" hidden>Phone verified.</p></div>':''}<div class="field"><label for="checkout-address">Delivery address *</label><textarea id="checkout-address" name="address" required placeholder="Street, area, municipality"></textarea></div><div class="field-grid"><div class="field"><label for="checkout-city">City / district *</label><input id="checkout-city" name="city" required placeholder="e.g. Pokhara"></div><div class="field"><label for="checkout-notes">Order notes</label><input id="checkout-notes" name="notes" placeholder="Optional instructions"></div></div><h4 class="form-section-title">Payment method</h4><label class="radio-card"><input type="radio" name="payment" value="cod" checked><div><strong>Cash on delivery</strong><span>No online payment is processed; the retailer will coordinate fulfilment.</span></div></label><label class="radio-card"><input type="radio" name="payment" value="contact_seller"><div><strong>Contact retailer to arrange payment</strong><span>Use this for listings that require coordination before fulfilment.</span></div></label><div class="summary-line total"><span>Order subtotal</span><strong>${money(total)}</strong></div><p class="small-muted">${isFirebaseConfigured()?'No online payment is processed. The order will be placed only if the secure order service is deployed and validation succeeds.':'Placing this demo order records it only in this browser. No real order is sent to a retailer.'}</p><button type="submit" class="button button-primary">${isFirebaseConfigured()?'Place order':'Place demo order'} · ${money(subtotal)} →</button></form></div>`;
  existing?.scrollIntoView({behavior:'smooth',block:'start'});
}
function renderSellerLanding() { renderRetailerLogin(); }
function renderSellerDashboard() {
  const user=session();
  if (!user || user.role !== 'retailer') { renderAuthPage('retailer'); return; }
  const profile = retailerProfile(user);
  if (!profile || !String(profile.storeName || '').trim()) { renderSellerSetup(user); return; }
  Object.assign(user,{storeName:profile.storeName,storeSetupComplete:true,storePhone:profile.phone,storeLocation:profile.location,storeDescription:profile.description,storeStatus:profile.status});
  if(!isFirebaseConfigured()) store.saveSession(user);
  if(profile.status !== 'approved') { renderRetailerVerificationState(user, profile); return; }
  const myProducts=allProducts().filter(p=>p.retailerId===user.uid || (user.uid==='demo-retailer' && p.retailerId==='retailer-demo'));
  const myOrders=store.orders().filter(o=>o.retailerId===user.uid || o.items?.some(item=>item.retailerId===user.uid || myProducts.some(p=>p.id===(item.id||item.productId))));
  const tabNames={products:'My listings',orders:'Order inbox',enquiries:'Enquiries',appointments:'Vet appointments',analytics:'Sales analytics',earnings:'Earnings statement',breeding:'Breeding requests',profile:'Store & vet profile'};
  app.innerHTML=`<div class="dashboard-shell retailer-workspace"><div class="container"><div class="dashboard-header"><div><div class="eyebrow">Retailer workspace</div><h1>${safe(user.storeName)}</h1><p>Welcome, ${safe(profile.contactName || user.name)}. Manage inventory, customers and store information.</p><div class="retailer-badges"><span class="status-pill">✓ Verified shop</span><span class="status-pill status-pending">${openReportCount(profile.ownerId)} open report(s)</span></div></div><div class="hero-actions"><a class="button button-secondary" href="#store/${encodeURIComponent(user.uid)}" target="_blank">View public store ↗</a><button class="button button-primary" data-action="seller-new-product">＋ Add listing</button></div></div>${demoNotice()}<div class="dashboard-layout"><aside class="dashboard-sidebar"><div class="sidebar-identity"><div class="avatar">${safe((user.storeName||user.name).slice(0,1).toUpperCase())}</div><div><strong>${safe(user.storeName)}</strong><span>Verified retailer</span></div></div><nav class="sidebar-nav"><button class="${sellerTab==='products'?'active':''}" data-action="seller-tab" data-tab="products">▦ My listings</button><button class="${sellerTab==='orders'?'active':''}" data-action="seller-tab" data-tab="orders">▤ Order inbox</button><button class="${sellerTab==='enquiries'?'active':''}" data-action="seller-tab" data-tab="enquiries">✉ Enquiries</button><button class="${sellerTab==='appointments'?'active':''}" data-action="seller-tab" data-tab="appointments">◷ Vet appointments</button><button class="${sellerTab==='analytics'?'active':''}" data-action="seller-tab" data-tab="analytics">▥ Sales analytics</button><button class="${sellerTab==='earnings'?'active':''}" data-action="seller-tab" data-tab="earnings">₨ Earnings</button><button class="${sellerTab==='breeding'?'active':''}" data-action="seller-tab" data-tab="breeding">🐕 Breeding requests</button><button class="${sellerTab==='profile'?'active':''}" data-action="seller-tab" data-tab="profile">♙ Store & vet profile</button><button data-action="signout">↪ Sign out</button></nav></aside><section class="dashboard-content" aria-label="${safe(tabNames[sellerTab]||'Retailer dashboard')}">${sellerTab==='products'?renderSellerProducts(myProducts):sellerTab==='orders'?renderRetailerOrders(myOrders):sellerTab==='enquiries'?renderSellerEnquiries(store.enquiries()):sellerTab==='appointments'?renderSellerVetAppointments(store.vetAppointments()):sellerTab==='analytics'?renderSellerAnalytics(myProducts,myOrders):sellerTab==='earnings'?renderSellerEarnings(myOrders,profile):sellerTab==='breeding'?renderBreedingBookings(store.breedingBookings(),false):renderSellerProfile(user)}</section></div></div></div>`;
  if(sellerTab==='enquiries') watchChatThreads(app);
}
function renderSellerProducts(items) {
  const published=items.filter(p=>p.status==='approved').length;
  return `<div class="metric-grid"><div class="metric-card"><div class="metric-top">All listings <span class="metric-symbol">▦</span></div><div class="metric-number">${items.length}</div><div class="metric-foot">Products in your store</div></div><div class="metric-card"><div class="metric-top">Published <span class="metric-symbol">✓</span></div><div class="metric-number">${published}</div><div class="metric-foot">Visible to customers</div></div><div class="metric-card"><div class="metric-top">Open reports <span class="metric-symbol">⚑</span></div><div class="metric-number">${openReportCount(session()?.uid)}</div><div class="metric-foot">Reports awaiting admin action</div></div><div class="metric-card"><div class="metric-top">Sold out / paused <span class="metric-symbol">−</span></div><div class="metric-number">${items.filter(p=>Number(p.stock)<=0||p.status==='paused').length}</div><div class="metric-foot">Not currently sellable</div></div></div>
  <div class="panel-card"><div class="panel-heading"><div><h2>Your product listings</h2><p>Edit, pause, resume or remove a listing. Stock can be set to zero to show sold out.</p></div><button class="button button-primary button-small" data-action="seller-new-product">＋ Add listing</button></div>${items.length?`<div class="table-scroll"><table><thead><tr><th>Product</th><th>Price</th><th>Stock</th><th>Status</th><th>Actions</th></tr></thead><tbody>${items.map(p=>`<tr><td><div class="table-product"><img src="${safe(p.image||'')}" alt="" onerror="this.style.display='none'"><div><strong>${safe(p.name)}</strong><span>${safe(categoryName(p.category))} · ${safe(p.unit)}</span></div></div></td><td>${money(p.price)}</td><td>${Number(p.stock)} ${safe(p.unit)}</td><td><span class="status-pill ${p.status==='approved'?'':'status-inactive'}"><span class="status-dot"></span>${p.status==='paused'?'Paused':p.status==='approved'?(isAvailable(p)?'Published':'Sold out'):statusLabel(p.status)}</span></td><td><div class="inline-actions"><button class="tiny-action" data-action="edit-product" data-id="${safe(p.id)}">Edit</button>${p.status==='paused'?'<button class="tiny-action" data-action="resume-product" data-id="'+safe(p.id)+'">Resume</button>':p.status==='approved'?'<button class="tiny-action" data-action="pause-product" data-id="'+safe(p.id)+'">Pause</button>':''}<button class="tiny-action danger" data-action="delete-product" data-id="${safe(p.id)}">Delete</button></div></td></tr>`).join('')}</tbody></table></div>`:`${emptyState('＋','No listings yet','Once your shop is verified, add your first product to start selling.','#seller','Return to shop dashboard')}`}</div>
  <div class="panel-card bulk-price-card"><div class="panel-heading"><div><h2>Bulk price update</h2><p>Apply the same fixed or percentage change to a category or all listings. Review the values before applying.</p></div></div><form id="bulk-price-form"><div class="field-grid"><div class="field"><label for="bulk-price-scope">Apply to</label><select id="bulk-price-scope" name="scope"><option value="all">All listings</option>${CATEGORIES.filter(c=>c.active!==false).map(c=>'<option value="'+safe(c.id)+'">'+safe(c.name)+'</option>').join('')}</select></div><div class="field"><label for="bulk-price-mode">Change type</label><select id="bulk-price-mode" name="mode"><option value="set">Set a new price (NPR)</option><option value="percent">Increase / decrease (%)</option></select></div><div class="field"><label for="bulk-price-value">New price / change value</label><input id="bulk-price-value" name="value" type="number" step="0.01" required min="-100" max="100000000" placeholder="e.g. 5 or 650"></div></div><p class="small-muted">Percentage changes may be negative, but the resulting price must stay above NPR 0. Paused listings are included.</p><button class="button button-secondary" type="submit">Preview and apply bulk price update</button></form></div>`;
}
function renderRetailerOrders(orders) {
  if(!orders.length)return '<div class="panel-card">'+emptyState('▤','No orders yet','When customers order your published products, their orders will appear here.','#shop','View marketplace')+'</div>';
  return '<div class="panel-card"><div class="panel-heading"><div><h2>Orders for your products</h2><p>Accept or reject new orders, then update fulfilment status as you process them.</p></div></div><div class="table-scroll"><table><thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Total</th><th>Status</th><th>Actions</th></tr></thead><tbody>'+orders.map(o=>{
    const pending=o.status==='Pending';
    const actions=pending?'<button class="tiny-action" data-action="retailer-order-action" data-id="'+safe(o.id)+'" data-status="Confirmed">Accept</button><button class="tiny-action danger" data-action="retailer-order-action" data-id="'+safe(o.id)+'" data-status="Rejected">Reject</button>':'';
    const transitions={Pending:['Pending','Confirmed','Rejected','Cancelled'],Confirmed:['Confirmed','Processing','Cancelled'],Processing:['Processing','Shipped','Cancelled'],Shipped:['Shipped','Delivered'],Delivered:['Delivered'],Rejected:['Rejected'],Cancelled:['Cancelled']};
    const options=transitions[o.status]||[o.status];
    return '<tr><td>'+safe(o.orderId||o.id)+'</td><td>'+safe(o.customerName||'Customer')+'<div class="small-muted">'+safe(o.customerEmail||'')+'</div></td><td>'+((o.items||[]).length)+'</td><td>'+money(orderRevenue(o))+'</td><td><span class="status-pill '+(['Rejected','Cancelled'].includes(o.status)?'status-inactive':o.status==='Delivered'?'':'status-pending')+'">'+safe(o.status)+'</span></td><td><div class="inline-actions">'+actions+'</div><label class="small-muted" for="order-status-'+safe(o.id)+'">Fulfilment status</label><select id="order-status-'+safe(o.id)+'" data-action="retailer-order-status" data-id="'+safe(o.id)+'" aria-label="Update order status">'+options.map(status=>'<option '+(o.status===status?'selected':'')+'>'+status+'</option>').join('')+'</select></td></tr>';
  }).join('')+'</tbody></table></div></div>';
}

function renderSellerProfile(user) {
  const profile=retailerProfile(user)||{};
  const docs=Array.isArray(profile.verificationDocs)?profile.verificationDocs:[];
  return `<div class="panel-card"><div class="panel-heading"><div><h2>Public store & professional profile</h2><p>Public store details are shown to shoppers. Verification document URLs remain in the private retailer record for admin review.</p></div><span class="status-pill">${shopStatusLabel(profile.status)}</span></div>
  <form id="seller-profile-form">
  <div class="field-grid"><div class="field"><label for="store-name">Shop / clinic name *</label><input id="store-name" name="storeName" required maxlength="100" readonly value="${safe(profile.storeName||user.storeName||'')}"></div><div class="field"><label for="store-contact-name">Contact name *</label><input id="store-contact-name" name="contactName" required maxlength="100" readonly value="${safe(profile.contactName||user.name||'')}"></div></div>
  <div class="field-grid"><div class="field"><label for="store-contact">Private account phone *</label><input id="store-contact" name="phone" required value="${safe(profile.phone||user.storePhone||'')}" placeholder="98XXXXXXXX"></div><div class="field"><label for="store-email">Account email *</label><input id="store-email" name="email" type="email" required readonly value="${safe(profile.email||user.email||'')}"></div></div>
  <div class="field"><label for="store-location">Location *</label><input id="store-location" name="location" required maxlength="220" value="${safe(profile.location||user.storeLocation||'')}" placeholder="Municipality, district, province"></div>
  <div class="field"><label for="store-about">Public store description</label><textarea id="store-about" name="description" maxlength="700" placeholder="Describe your store or clinic">${safe(profile.description||user.storeDescription||'')}</textarea></div>
  <div class="field-grid"><div class="field"><label for="public-phone">Public contact phone</label><input id="public-phone" name="publicPhone" maxlength="40" value="${safe(profile.publicPhone||profile.phone||'')}" placeholder="Phone customers may contact"></div><div class="field"><label for="public-email">Public contact email</label><input id="public-email" name="publicEmail" type="email" maxlength="254" value="${safe(profile.publicEmail||profile.email||'')}" placeholder="Contact address for shoppers"></div></div>
  <div class="field-grid"><div class="field"><label for="store-website">Website / social page (HTTPS)</label><input id="store-website" name="website" type="url" maxlength="300" value="${safe(profile.website||'')}" placeholder="https://..."></div><div class="field"><label for="store-hours">Opening hours</label><input id="store-hours" name="openingHours" maxlength="700" value="${safe(profile.openingHours||'')}" placeholder="e.g. Sun–Fri, 9 AM–6 PM"></div></div>
  <hr><div class="eyebrow">Veterinarian profile (optional)</div>
  <label class="remember-choice"><input type="checkbox" id="is-vet" name="isVet" ${profile.isVet?'checked':''}> This store provides veterinary services</label>
  <div class="field"><label for="vet-specialties">Specialties (comma-separated)</label><input id="vet-specialties" name="vetSpecialties" maxlength="500" value="${safe((profile.vetSpecialties||[]).join(', '))}" placeholder="e.g. livestock, surgery, vaccination"></div>
  <div class="field"><label for="vet-availability">Vet availability / schedule</label><textarea id="vet-availability" name="vetAvailability" maxlength="700" placeholder="Days, hours, appointment instructions">${safe(profile.vetAvailability||'')}</textarea></div>
  <div class="field"><label for="consultation-fee">Consultation fee (NPR)</label><input id="consultation-fee" name="consultationFee" type="number" min="0" max="100000" step="1" value="${safe(profile.consultationFee??'')}" placeholder="0 if free or not charged"></div>
  <hr><div class="eyebrow">Verification documents</div>
  <p class="small-muted">Add secure HTTPS links to your business licence, PAN certificate or veterinary credentials. Keep documents access-restricted to Pashughar admin; a link pasted here is not an upload.</p>
  <div class="field"><label for="verification-docs">Private document URLs (one per line, up to 5)</label><textarea id="verification-docs" name="verificationDocs" rows="3" maxlength="6000" placeholder="https://secure-host.example/licence.pdf">${safe(docs.join('\n'))}</textarea></div>
  <p class="small-muted">Shop identity and approval status can only be changed by Pashughar admin. The public store page contains only the public contact fields above.</p>
  <button class="button button-primary" type="submit">Save store & vet profile</button></form></div>`;
}

function retailerOrderAction(orderId,status) {
  if(!isFirebaseConfigured()){
    const orders=store.orders();const order=orders.find(o=>o.id===orderId);
    if(!order)return showToast('Order was not found.','error');
    order.status=status;store.saveOrders(orders);renderSellerDashboard();return showToast('Order marked '+status+' in demo mode.');
  }
  updateRetailerOrderStatusDirect({retailerOrderId:orderId,status}).then(()=>{renderSellerDashboard();showToast('Order status updated.');}).catch(error=>showToast(error.message||firebaseErrorMessage(error),'error'));
}
function orderRevenue(order) {
  if(typeof order.total==='number')return order.total;
  return (order.items||[]).reduce((n,item)=>n+(Number(item.price||item.unitPrice||0)*Number(item.qty||item.quantity||0)),0);
}
function renderSellerAnalytics(products, orders) {
  const fulfilled=orders.filter(o=>['Confirmed','Processing','Shipped','Delivered','Partially fulfilled'].includes(o.status));
  const sales=fulfilled.reduce((sum,o)=>sum+orderRevenue(o),0);
  const units=orders.reduce((sum,o)=>sum+(o.items||[]).reduce((n,i)=>n+Number(i.qty||i.quantity||0),0),0);
  const top=new Map();
  for(const order of orders)for(const item of (order.items||[])){
    const id=item.id||item.productId;const name=item.name||getProduct(id)?.name||'Product';
    const row=top.get(id)||{name,qty:0,revenue:0};row.qty+=Number(item.qty||item.quantity||0);row.revenue+=Number(item.price||item.unitPrice||0)*Number(item.qty||item.quantity||0);top.set(id,row);
  }
  const topRows=[...top.values()].sort((x,y)=>y.qty-x.qty).slice(0,5);
  return '<div class="metric-grid"><div class="metric-card"><div class="metric-top">Orders</div><div class="metric-number">'+orders.length+'</div><div class="metric-foot">All orders for this shop</div></div><div class="metric-card"><div class="metric-top">Fulfilled / accepted sales</div><div class="metric-number">'+money(sales)+'</div><div class="metric-foot">Based on order statuses</div></div><div class="metric-card"><div class="metric-top">Units ordered</div><div class="metric-number">'+units+'</div><div class="metric-foot">Across recorded orders</div></div><div class="metric-card"><div class="metric-top">Active listings</div><div class="metric-number">'+products.filter(p=>p.status==='approved'&&Number(p.stock)>0).length+'</div><div class="metric-foot">Published and in stock</div></div></div><div class="panel-card"><div class="panel-heading"><div><h2>Top items by quantity</h2><p>Calculated from the available retailer order history.</p></div></div>'+(topRows.length?'<div class="table-scroll"><table><thead><tr><th>Product</th><th>Units</th><th>Recorded line revenue</th></tr></thead><tbody>'+topRows.map(x=>'<tr><td>'+safe(x.name)+'</td><td>'+x.qty+'</td><td>'+money(x.revenue)+'</td></tr>').join('')+'</tbody></table></div>':'<p class="small-muted">Top item analytics will appear after orders are received.</p>')+'</div>';
}
function renderSellerEarnings(orders, profile) {
  const revenue=orders.filter(o=>!['Cancelled','Rejected'].includes(o.status)).reduce((sum,o)=>sum+orderRevenue(o),0);
  const completed=orders.filter(o=>o.status==='Delivered');
  const completedRevenue=completed.reduce((sum,o)=>sum+orderRevenue(o),0);
  const commissionRate=Number.isFinite(Number(store.siteSettings().commissionPercent))?Number(store.siteSettings().commissionPercent):null;
  const commission=commissionRate===null?null:revenue*commissionRate/100;
  return '<div class="metric-grid"><div class="metric-card"><div class="metric-top">Recorded gross order value</div><div class="metric-number">'+money(revenue)+'</div><div class="metric-foot">Excludes cancelled/rejected orders</div></div><div class="metric-card"><div class="metric-top">Delivered order value</div><div class="metric-number">'+money(completedRevenue)+'</div><div class="metric-foot">Orders marked Delivered</div></div><div class="metric-card"><div class="metric-top">Orders</div><div class="metric-number">'+orders.length+'</div><div class="metric-foot">Recorded retailer orders</div></div></div><div class="panel-card"><div class="panel-heading"><div><h2>Earnings & commission statement</h2><p>Summary based on order records currently available in Pashughar.</p></div></div><div class="earnings-statement"><div><span>Gross order value</span><strong>'+money(revenue)+'</strong></div><div><span>Commission rate</span><strong>'+(commissionRate===null?'Not configured':commissionRate+'%')+'</strong></div><div><span>Estimated commission</span><strong>'+(commission===null?'Pending platform policy':money(commission))+'</strong></div><div><span>Estimated amount after commission</span><strong>'+(commission===null?'Not calculated':money(revenue-commission))+'</strong></div></div><p class="small-muted">This is a management summary, not a payment or tax statement. Pashughar has not configured an official commission rate or payout reconciliation for this shop.</p></div>';
}
function renderSellerEnquiries(enquiries) {
  if(!enquiries.length)return '<div class="panel-card"><div class="panel-heading"><div><h2>Customer enquiries</h2><p>Questions sent from your product pages will appear here.</p></div></div><p class="small-muted">No enquiries yet.</p></div>';
  const rows=enquiries.slice().sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
  return '<div class="panel-card"><div class="panel-heading"><div><h2>Enquiry inbox</h2><p>Chat with customers about listing questions.</p></div><span class="status-pill">'+rows.filter(x=>x.status==='open').length+' open</span></div>'+rows.map(e=>'<article class="enquiry-card"><div class="enquiry-card-head"><div><strong>'+safe(e.productName||'Product enquiry')+'</strong><div class="small-muted">'+safe(e.customerName||'Customer')+' · '+safe(e.customerPhone||e.customerEmail||'')+'</div></div><span class="status-pill '+(e.status==='replied'?'':'status-pending')+'">'+safe(e.status||'open')+'</span></div><p><strong>Customer question</strong><br>'+safe(e.message)+'</p>'+(e.reply?'<div class="enquiry-reply"><strong>Earlier reply</strong><p>'+safe(e.reply)+'</p></div>':'')+'<div data-chat-list="'+safe(e.id)+'" class="enquiry-thread small-muted">Loading conversation…</div><form data-chat-seller="'+safe(e.id)+'"><div class="field"><label for="seller-chat-'+safe(e.id)+'">Reply to customer</label><textarea id="seller-chat-'+safe(e.id)+'" name="message" required minlength="2" maxlength="1500" placeholder="Write a message"></textarea></div><button class="button button-secondary button-small" type="submit">Send message</button></form></article>').join('')+'</div>';
}
function renderSellerVetAppointments(appointments) {
  const rows=(appointments||[]).slice().sort((a,b)=>String(a.date||'').localeCompare(String(b.date||''))||String(a.time||'').localeCompare(String(b.time||'')));
  if(!rows.length)return '<div class="panel-card"><h2>Veterinary appointments</h2><p>No veterinary booking requests have arrived yet. Publish a veterinary profile in Store & vet profile before customers can book.</p></div>';
  return '<div class="panel-card"><div class="panel-heading"><div><h2>Appointment requests</h2><p>Confirm or decline requests, then mark completed visits.</p></div><span class="status-pill">'+rows.filter(a=>a.status==='pending').length+' pending</span></div>'+rows.map(a=>'<article class="enquiry-card"><div class="enquiry-card-head"><div><strong>'+safe(a.date||'Date pending')+' · '+safe(a.time||'Time pending')+' Nepal time</strong><div class="small-muted">'+safe(a.customerName||'Customer')+'</div></div><span class="status-pill '+(a.status==='pending'?'status-pending':'')+'">'+safe(a.status||'pending')+'</span></div><p>'+safe(a.reason||'No visit details supplied')+'</p>'+((a.status==='pending')?'<button class="button button-primary button-small" data-vet-status="confirmed" data-id="'+safe(a.id)+'">Confirm</button> <button class="button button-secondary button-small" data-vet-status="declined" data-id="'+safe(a.id)+'">Decline</button>':(a.status==='confirmed'?'<button class="button button-secondary button-small" data-vet-status="completed" data-id="'+safe(a.id)+'">Mark completed</button> <button class="button button-secondary button-small" data-vet-status="cancelled" data-id="'+safe(a.id)+'">Cancel</button>':''))+'</article>').join('')+'</div>';
}


function openEnquiryForm(productId) {
  const product=getProduct(productId);
  if(!product || product.status!=='approved') return showToast('This listing is no longer available.','error');
  const user=session();
  if(!user){showToast('Sign in to message the retailer.','warn');navigate('#login');return;}
  if(!isVerifiedContact({emailVerified:user.emailVerified,phoneNumber:user.phoneNumber})){showToast('Verify your email or phone before sending an enquiry.','warn');navigate('#account');return;}
  if(!isFirebaseConfigured()) return showToast('Customer enquiries require the live Firebase project.','warn');
  modalContent.innerHTML='<div class="modal-inner"><div class="modal-head"><div><div class="eyebrow">Contact retailer</div><h2>Ask about this listing</h2><p>'+safe(product.name)+' · '+safe(product.location||'Nepal')+'</p></div><button class="modal-close" data-action="close-modal" aria-label="Close">×</button></div><form id="product-enquiry-form" data-product-id="'+safe(product.id)+'" data-product-name="'+safe(product.name)+'" data-retailer-id="'+safe(product.retailerId)+'"><div class="field"><label for="enquiry-name">Your name</label><input id="enquiry-name" name="customerName" maxlength="120" value="'+safe(user.name||'')+'" required></div><div class="field"><label for="enquiry-phone">Phone</label><input id="enquiry-phone" name="customerPhone" maxlength="40" inputmode="tel" value="'+safe(user.phoneNumber||'')+'" placeholder="98XXXXXXXX"></div><div class="field"><label for="enquiry-message">Your question</label><textarea id="enquiry-message" name="message" minlength="5" maxlength="1500" required placeholder="Ask about availability, delivery, vaccination or product details."></textarea></div><div class="notice notice-info">Your enquiry is visible only to you, the assigned retailer and Pashughar administrators.</div><div class="modal-actions"><button type="button" class="button button-secondary" data-action="close-modal">Cancel</button><button type="submit" class="button button-primary">Send enquiry →</button></div></form></div>';
  showModalWithHistory();
}
function renderPublicStore(storeId) {
  app.innerHTML='<div class="page-wrap"><div class="container"><div class="initial-loading">Loading store profile…</div></div></div>';
  getPublicStoreProfile(storeId).then(function(profile){
    if(!profile){
      app.innerHTML='<div class="page-wrap"><div class="container">'+emptyState('⌕','Store profile not available','This retailer has not published a public store profile yet.','#shop','Back to marketplace')+'</div></div>';
      return;
    }
    const products=activeProducts().filter(function(p){return String(p.retailerId)===String(storeId);});
    const vet=profile.isVet===true;
    const facts='<span>⌖ '+safe(profile.location||'Nepal')+'</span>'+
      (profile.openingHours?'<span>◷ '+safe(profile.openingHours)+'</span>':'')+
      (profile.publicPhone?'<a href="tel:'+safe(profile.publicPhone)+'">☎ '+safe(profile.publicPhone)+'</a>':'')+
      (profile.publicEmail?'<a href="mailto:'+safe(profile.publicEmail)+'">✉ '+safe(profile.publicEmail)+'</a>':'')+
      (profile.website?'<a href="'+safe(profile.website)+'" target="_blank" rel="noopener noreferrer">Website ↗</a>':'');
    const vetHtml=vet?'<div class="vet-profile-summary"><strong>Veterinary services</strong><p>Specialties: '+safe((profile.vetSpecialties||[]).join(', ')||'Contact for details')+'</p><p>Availability: '+safe(profile.vetAvailability||'Contact the clinic')+'</p><p>Consultation fee: '+(Number(profile.consultationFee)>0?money(profile.consultationFee):'Contact for fee')+'</p></div>':'';
    app.innerHTML='<div class="page-wrap public-store-page"><div class="container"><div class="route-context"><a class="button button-secondary" href="#shop">← Back to marketplace</a><nav class="route-breadcrumbs" aria-label="Breadcrumb"><a href="#home">Home</a> / <a href="#shop">Marketplace</a> / <strong>'+safe(profile.storeName||'Local store')+'</strong></nav></div><section class="public-store-hero"><div class="store-avatar">'+safe(String(profile.storeName||'P').slice(0,1).toUpperCase())+'</div><div><div class="eyebrow">'+(vet?'Veterinary services & retailer':'Pashughar verified retailer')+'</div><h1>'+safe(profile.storeName||'Local retailer')+'</h1><p>'+safe(profile.description||'Local supplier on Pashughar.')+'</p><div class="public-store-facts">'+facts+'</div>'+vetHtml+'</div></section><section class="products-section"><div class="section-head"><div><div class="eyebrow">Retailer catalogue</div><h2>Available listings</h2><p>'+products.length+' approved listing(s) from this store.</p></div></div>'+(products.length?'<div class="product-grid">'+products.map(productCard).join('')+'</div>':'<p class="small-muted">No products currently published.</p>')+'</section></div></div>';
  }).catch(function(error){
    app.innerHTML='<div class="page-wrap"><div class="container">'+emptyState('!','Could not load store','Please check your connection and retry.','#shop','Back to marketplace')+'<button class="button button-secondary" data-action="retry-store" data-id="'+safe(storeId)+'">Retry</button></div></div>';
    showToast(firebaseErrorMessage(error),'error');
  });
}

function renderBreedingBookings(bookings, isAdmin) {
  const rows = bookings.slice().sort((a,b)=>String(b.requestedDate||'').localeCompare(String(a.requestedDate||''))).map(b=>'<tr><td><strong>'+safe(b.productName||'Dog listing')+'</strong><div class="small-muted">'+safe(b.location||'')+'</div></td><td>'+safe(b.customerName||'Customer')+'<div class="small-muted">'+safe(b.customerPhone||'')+'</div></td><td><strong>'+safe(b.requestedDate||'—')+'</strong><div class="small-muted">'+safe(b.customerEmail||'')+'</div></td><td><span class="status-pill '+statusClass(b.status)+'">'+safe(statusLabel(b.status))+'</span></td><td><div class="inline-actions">'+(b.status==='pending'?'<button class="tiny-action" data-action="booking-status" data-id="'+safe(b.id)+'" data-status="accepted">Accept</button><button class="tiny-action danger" data-action="booking-status" data-id="'+safe(b.id)+'" data-status="declined">Decline</button>':'')+(b.status==='accepted'?'<button class="tiny-action" data-action="booking-status" data-id="'+safe(b.id)+'" data-status="completed">Complete</button>':'')+'</div></td></tr>').join('');
  return '<div class="panel-card"><div class="panel-heading"><div><h2>Pet breeding date requests</h2><p>'+(isAdmin?'Marketplace-wide requests.':'Requests for dogs listed by your shop.')+' A request is not a confirmed booking until accepted by the owner.</p></div><span class="status-pill">'+bookings.length+' total</span></div>'+(bookings.length?'<div class="table-scroll"><table><thead><tr><th>Dog / location</th><th>Customer</th><th>Requested date</th><th>Status</th><th>Action</th></tr></thead><tbody>'+rows+'</tbody></table></div>':'<p class="small-muted">No breeding date requests yet.</p>')+'</div>';
}
function renderAdmin() {
  const all=allProducts();const orders=store.orders();const retailers=store.retailers();const reports=store.reports();
  const awaiting=retailers.filter(r=>r.status==='pending');
  const pendingProducts=all.filter(p=>p.status==='pending').length;
  const awaitingVets=retailers.filter(r=>r.status==='pending'&&r.isVet).length;
  const openReports=reports.filter(r=>['open','reviewing'].includes(r.status));
  const published=all.filter(p=>p.status==='approved');
  app.innerHTML=`<div class="dashboard-shell"><div class="container"><div class="dashboard-header"><div><div class="eyebrow">Private Pashughar control centre</div><h1>Main administrator</h1><p>Verify shops, review live reports and protect the marketplace.</p></div><div class="hero-actions"><a class="button button-secondary" href="#home">← Back to marketplace</a>${isFirebaseConfigured()?'':'<button class="button button-secondary" data-action="reset-demo">Reset demo data</button>'}</div></div>${demoNotice()}<div class="dashboard-layout"><aside class="dashboard-sidebar"><div class="sidebar-identity"><div class="avatar">P</div><div><strong>Pashughar Admin</strong><span>Private administration</span></div></div><nav class="sidebar-nav">
<button class="${adminTab==='overview'?'active':''}" data-action="admin-tab" data-tab="overview">▦ Overview</button>
<button class="${adminTab==='retailers'?'active':''}" data-action="admin-tab" data-tab="retailers">♙ Retailer & vet approvals (${awaiting.length})</button>
<button class="${adminTab==='reports'?'active':''}" data-action="admin-tab" data-tab="reports">⚑ Reports (${openReports.length})</button>
<button class="${adminTab==='products'?'active':''}" data-action="admin-tab" data-tab="products">▦ Listing moderation (${pendingProducts} pending)</button>
<button class="${adminTab==='categories'?'active':''}" data-action="admin-tab" data-tab="categories">▤ Categories</button>
<button class="${adminTab==='orders'?'active':''}" data-action="admin-tab" data-tab="orders">▣ All orders</button>
<button class="${adminTab==='users'?'active':''}" data-action="admin-tab" data-tab="users">♙ Users</button>
<button class="${adminTab==='analytics'?'active':''}" data-action="admin-tab" data-tab="analytics">▥ Analytics</button>
<button class="${adminTab==='audit'?'active':''}" data-action="admin-tab" data-tab="audit">⌕ Audit log</button>
<button class="${adminTab==='breeding'?'active':''}" data-action="admin-tab" data-tab="breeding">🐕 Breeding requests</button>
<button class="${adminTab==='settings'?'active':''}" data-action="admin-tab" data-tab="settings">⚙ Site settings</button>
<button data-action="signout">↪ Sign out</button></nav></aside><section class="dashboard-content"><div class="metric-grid">
<div class="metric-card"><div class="metric-top">Published products</div><div class="metric-number">${published.length}</div><div class="metric-foot">Visible listings</div></div>
<div class="metric-card"><div class="metric-top">Listings to review</div><div class="metric-number">${pendingProducts}</div><div class="metric-foot">Not yet published</div></div>
<div class="metric-card"><div class="metric-top">Retailer / vet applications</div><div class="metric-number">${awaiting.length}</div><div class="metric-foot">${awaitingVets} veterinary profiles pending</div></div>
<div class="metric-card"><div class="metric-top">Live reports</div><div class="metric-number">${openReports.length}</div><div class="metric-foot">Open or under review</div></div>
<div class="metric-card"><div class="metric-top">Orders</div><div class="metric-number">${orders.length}</div><div class="metric-foot">${isFirebaseConfigured()?'Stored in Firestore':'Saved in this browser'}</div></div></div>${adminTab==='products'?renderAdminProducts(all):adminTab==='orders'?renderAdminOrders(orders):adminTab==='retailers'?renderAdminRetailers(retailers):adminTab==='reports'?renderAdminReports(reports):adminTab==='breeding'?renderBreedingBookings(store.breedingBookings(),true):(['overview','categories','users','analytics','audit','settings'].includes(adminTab)?'<div id="admin-feature-panel"></div>':renderAdminSettings())}</section></div></div></div>`;
  if(['overview','categories','users','analytics','audit','settings'].includes(adminTab)) renderAdminFeature(adminTab,document.getElementById('admin-feature-panel'));
}
function renderAdminProducts(items) {
  const pending=items.filter(p=>p.status==='pending').length;
  return '<div class="panel-card"><div class="panel-heading"><div><h2>Listing moderation</h2><p>Retailer-submitted listings remain hidden until approved. Admins can edit, approve, reject, suspend or remove listings.</p></div><div class="inline-actions"><span class="status-pill">'+pending+' pending</span><button class="button button-primary button-small" type="button" data-action="admin-new-product">＋ Add product</button></div></div><div class="tabs"><button class="tab-button active" data-action="admin-list-filter" data-filter="all">All ('+items.length+')</button><button class="tab-button" data-action="admin-list-filter" data-filter="pending">Pending ('+pending+')</button><button class="tab-button" data-action="admin-list-filter" data-filter="approved">Published</button><button class="tab-button" data-action="admin-list-filter" data-filter="rejected">Rejected</button><button class="tab-button" data-action="admin-list-filter" data-filter="suspended">Suspended</button></div><div class="table-scroll"><table><thead><tr><th>Product</th><th>Retailer</th><th>Price</th><th>Stock</th><th>Status</th><th>Actions</th></tr></thead><tbody id="admin-products-body">'+items.map(adminProductRow).join('')+'</tbody></table></div></div>';
}
function adminProductRow(p) {
  let actions='';
  if(p.status==='pending') actions+='<button class="tiny-action" data-action="approve-product" data-id="'+safe(p.id)+'">Approve</button><button class="tiny-action danger" data-action="reject-product" data-id="'+safe(p.id)+'">Reject</button>';
  else if(p.status==='approved') actions+='<button class="tiny-action danger" data-action="suspend-product" data-id="'+safe(p.id)+'">Suspend</button>';
  else actions+='<button class="tiny-action" data-action="restore-product" data-id="'+safe(p.id)+'">Approve / restore</button>';
  actions+='<button class="tiny-action" data-action="admin-edit-product" data-id="'+safe(p.id)+'">Edit</button><button class="tiny-action danger" data-action="admin-remove-product" data-id="'+safe(p.id)+'">Remove</button>';
  return '<tr data-product-status="'+safe(p.status)+'"><td><div class="table-product"><img src="'+safe(p.image||'')+'" alt="" onerror="this.hidden=true"><div><strong>'+safe(p.name)+'</strong><span>'+safe(categoryName(p.category))+'</span></div></div></td><td>'+safe(p.retailer||'Local retailer')+'<div class="small-muted">'+safe(p.retailerId||'')+'</div></td><td>'+money(p.price)+' / '+safe(p.unit||'item')+'</td><td>'+Number(p.stock)+'</td><td><span class="status-pill '+statusClass(p.status)+'">'+(p.status==='approved'?(Number(p.stock)>0?'Published':'Sold out'):statusLabel(p.status))+'</span></td><td><div class="inline-actions">'+actions+'</div></td></tr>';
}
function renderAdminOrders(orders) {
  const rows=(orders||[]).slice().sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
  const statuses=[...new Set(rows.map(o=>String(o.status||'Pending')))].sort();
  const body=rows.map(o=>{
    const itemList=Array.isArray(o.items)?o.items:[];
    const itemsText=itemList.map(item=>(item.name||item.productName||item.productId||'Item')+' x '+(item.quantity??item.qty??1)).join('; ');
    const search=[o.id,o.customerName,o.customerEmail,o.shipping?.phone,o.shipping?.address,o.shipping?.city,o.status,o.paymentMethod,itemsText].join(' ').toLowerCase();
    return '<tr data-admin-order-row data-order-status="'+safe(o.status||'Pending')+'" data-order-search="'+safe(search)+'"><td>'+safe(o.id)+'<div class="small-muted">'+safe(o.createdAt||'')+'</div></td><td>'+safe(o.customerName||'Customer')+'<div class="small-muted">'+safe(o.customerEmail||'')+'</div></td><td>'+itemList.length+'<div class="small-muted">'+safe(itemsText)+'</div></td><td>'+money(o.subtotal??o.total)+'</td><td>'+money(o.deliveryFee||0)+'</td><td>'+money(o.total??o.subtotal)+'</td><td>'+safe(o.paymentMethod||'—')+'</td><td><span class="status-pill">'+safe(o.status||'Pending')+'</span></td></tr>';
  }).join('');
  return '<div class="panel-card"><div class="panel-heading"><div><h2>All marketplace orders</h2><p>'+orders.length+' order record(s). Filters apply to the table; export downloads the full available order set.</p></div><button class="button button-primary button-small" type="button" data-admin-export-orders>Export all orders (CSV)</button></div><div class="field-grid"><div class="field"><label for="admin-orders-search">Search orders</label><input id="admin-orders-search" type="search" placeholder="Order ID, customer, phone, location, product"></div><div class="field"><label for="admin-order-status">Filter by status</label><select id="admin-order-status"><option value="all">All statuses</option>'+statuses.map(s=>'<option value="'+safe(s)+'">'+safe(s)+'</option>').join('')+'</select></div></div><div class="table-scroll"><table><thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Subtotal</th><th>Delivery</th><th>Total</th><th>Payment</th><th>Status</th></tr></thead><tbody>'+body+'</tbody></table></div><p class="small-muted">Order totals are gross checkout records, not reconciled revenue or tax records. Guest checkout records may not include an account UID.</p></div>';
}
function renderAdminRetailers(retailers) {
  const pending=retailers.filter(r=>r.status==='pending');
  const pendingVets=pending.filter(r=>r.isVet).length;
  const pendingShops=pending.filter(r=>!r.isVet).length;
  return `<div class="panel-card"><div class="panel-heading"><div><h2>Retailer & veterinary verification</h2><p>Review each shop once. Verified retailers can then publish products directly.</p></div><span class="status-pill status-pending">${pending.length} awaiting review</span></div><div class="tabs"><button type="button" class="tab-button active" data-action="admin-retailer-filter" data-filter="all">All profiles</button><button type="button" class="tab-button" data-action="admin-retailer-filter" data-filter="vet">Veterinary providers</button><button type="button" class="tab-button" data-action="admin-retailer-filter" data-filter="retailer">Retailers</button><button type="button" class="tab-button" data-action="admin-retailer-filter" data-filter="pending">Pending (${pendingVets} vets / ${pendingShops} shops)</button></div>${retailers.length?`<div class="table-scroll"><table><thead><tr><th>Retailer / vet profile</th><th>Contact details</th><th>Location</th><th>Verification documents</th><th>Open reports</th><th>Status</th><th>Actions</th></tr></thead><tbody>${retailers.map(r=>`<tr data-admin-retailer-row data-retailer-type="${r.isVet?'vet':'retailer'}" data-retailer-status="${safe(r.status)}"><td><strong>${safe(r.storeName)}</strong><div class="small-muted">${safe(r.isVet ? (r.contactName||'Contact not added')+' · Vet provider' : (r.contactName||'Contact not added'))}</div></td><td>${safe(r.email||'—')}<div class="small-muted">${safe(r.phone||'—')}</div></td><td>${safe(r.location||'Not specified')}</td><td>${Array.isArray(r.verificationDocs)&&r.verificationDocs.length?r.verificationDocs.map((url,i)=>'<a href="'+safe(url)+'" target="_blank" rel="noopener noreferrer">Document '+(i+1)+' ↗</a>').join('<br>'):'—'}</td><td><strong>${openReportCount(r.ownerId || r.id)}</strong></td><td><span class="status-pill ${statusClass(r.status)}">${shopStatusLabel(r.status)}</span></td><td><div class="inline-actions">${r.status==='pending'||r.status==='rejected'?`<button class="tiny-action" data-action="verify-retailer" data-id="${safe(r.id)}">${r.isVet?'Approve vet':'Approve retailer'}</button><button class="tiny-action danger" data-action="reject-retailer" data-id="${safe(r.id)}">${r.isVet?"Reject vet":"Reject retailer"}</button>`:''}${r.status==='approved'?`<button class="tiny-action danger" data-action="suspend-retailer" data-id="${safe(r.id)}">Suspend</button>`:''}${r.status==='suspended'?`<button class="tiny-action" data-action="reinstate-retailer" data-id="${safe(r.id)}">Reinstate</button>`:''}${r.status!=='banned'?`<button class="tiny-action danger" data-action="ban-retailer" data-id="${safe(r.id)}">Remove / ban</button>`:''}</div></td></tr>`).join('')}</tbody></table></div>`:`<div class="empty-state"><div class="empty-state-icon">♙</div><h2>No shop applications yet</h2><p>When a retailer submits their shop profile, it will appear here for verification.</p><a class="button button-secondary" href="#seller">Open retailer sign-in</a></div>`}<p class="small-muted" style="margin-top:14px">Retailer approval enables provider access; every new listing must still be approved in the listing moderation queue.</p></div>`;
}
function renderAdminReports(reports) {
  const live=reports.filter(r=>['open','reviewing'].includes(r.status));
  const grouped=new Map();
  live.forEach(r=>{const key=r.retailerId||'unknown';if(!grouped.has(key))grouped.set(key,{retailerId:key,retailerName:r.retailerName||'Unknown retailer',reports:[]});grouped.get(key).reports.push(r);});
  const current=activeReportFilter==='all'?reports:reports.filter(r=>activeReportFilter==='open'?['open','reviewing'].includes(r.status):r.status===activeReportFilter);
  return `<div class="panel-card"><div class="panel-heading"><div><h2>Customer reports</h2><p>Live counts include only reports that are open or under review. Resolved and dismissed records remain in history.</p></div><span class="status-pill ${live.length?'status-pending':''}">${live.length} live reports</span></div><div class="report-summary-grid">${grouped.size?[...grouped.values()].sort((a,b)=>b.reports.length-a.reports.length).map(g=>`<button type="button" class="report-summary-card" data-action="filter-retailer-reports" data-retailer-id="${safe(g.retailerId)}"><span class="report-summary-name">${safe(g.retailerName)}</span><strong>${g.reports.length}</strong><small>open report(s) · click to inspect</small></button>`).join(''):`<div class="empty-inline"><strong>No live reports</strong><span>New product reports will appear here as soon as they are submitted.</span></div>`}</div><div class="tabs report-tabs"><button class="tab-button ${activeReportFilter==='open'?'active':''}" data-action="report-filter" data-filter="open">Live (${live.length})</button><button class="tab-button ${activeReportFilter==='resolved'?'active':''}" data-action="report-filter" data-filter="resolved">Resolved (${reports.filter(r=>r.status==='resolved').length})</button><button class="tab-button ${activeReportFilter==='dismissed'?'active':''}" data-action="report-filter" data-filter="dismissed">Dismissed (${reports.filter(r=>r.status==='dismissed').length})</button><button class="tab-button ${activeReportFilter==='all'?'active':''}" data-action="report-filter" data-filter="all">All history (${reports.length})</button></div><div class="reports-list">${current.length?current.slice().sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).map(r=>`<article class="report-card" data-retailer-id="${safe(r.retailerId||'unknown')}"><div class="report-card-top"><div><span class="eyebrow">${safe(r.reasonLabel||r.reason)}</span><h3>${safe(r.productName||'Product report')}</h3><p>${safe(r.retailerName||'Unknown retailer')} · ${safe(r.location||'Location not provided')}</p></div><span class="status-pill ${statusClass(r.status)}">${statusLabel(r.status)}</span></div><p class="report-details">${safe(r.details||'No additional details provided.')}</p><div class="report-meta"><span>Report ID: ${safe(r.id)}</span><span>${safe(new Date(r.createdAt).toLocaleString())}</span><span>Reporter: ${safe(r.reporterName||'Guest')}${r.reporterContact?` · ${safe(r.reporterContact)}`:''}</span></div><div class="report-actions">${r.status==='open'?`<button class="tiny-action" data-action="review-report" data-id="${safe(r.id)}">Mark reviewing</button>`:''}${['open','reviewing'].includes(r.status)?`<button class="tiny-action" data-action="resolve-report" data-id="${safe(r.id)}">Resolve report</button><button class="tiny-action danger" data-action="dismiss-report" data-id="${safe(r.id)}">Dismiss</button>`:''}<button class="tiny-action danger" data-action="suspend-reported-product" data-id="${safe(r.productId)}">Suspend product</button><button class="tiny-action danger" data-action="suspend-reported-retailer" data-id="${safe(r.retailerId)}">Suspend retailer</button></div></article>`).join(''):`<div class="empty-inline"><strong>No reports in this view</strong><span>Select another filter or return to the live reports view.</span></div>`}</div></div>`;
}
function renderAdminSettings() {
  return `<div class="panel-card"><div class="panel-heading"><div><h2>Launch checklist</h2><p>Configuration required before Pashughar handles real users and transactions.</p></div></div><div class="notice notice-warn">This panel is available only to an account with the trusted Firebase admin custom claim.</div>${[['Firebase Authentication','Google and email/password sign-in are wired to Firebase Authentication.'],['Shop verification','Firestore Rules restrict verification controls to the trusted admin claim.'],['Product images','Firebase Storage is disabled; provide public HTTPS image URLs.'],['Customer reports','Requires the included callable function deployment for private submissions and moderation.'],['Orders and stock','Requires the callable function deployment for transactional stock validation.'],['Payments and delivery','Only offline/COD arrangements are available; online payments are not integrated.'],['Production launch','Set the admin claim, deploy Firestore rules, test access boundaries, and publish legal/support policies.']].map(([title,desc],i)=>`<div style="display:flex;gap:12px;padding:15px 0;border-bottom:1px solid var(--line)"><div class="step-number" style="flex-shrink:0">${i+1}</div><div><strong style="font-size:12px">${title}</strong><p class="small-muted" style="margin:5px 0 0">${desc}</p></div></div>`).join('')}<p class="small-muted" style="margin-top:18px">Firebase web configuration present: ${isFirebaseConfigured()?'Yes — test on the deployed site before real launch':'No — add your web app configuration in js/firebase.js'}.</p></div>`;
}

function renderWishlist() {
  const ids=store.wishlist();const products=ids.map(getProduct).filter(Boolean);
  app.innerHTML=`<div class="page-wrap"><div class="container"><div class="page-title-row"><div><div class="eyebrow">Saved for later</div><h1>Your wishlist</h1><p>Keep the products you may want to order.</p></div></div>${products.length?`<div class="product-grid">${products.map(productCard).join('')}</div>`:emptyState('♡','No saved products yet','Tap the heart on any product to save it here.','#shop','Browse products')}</div></div>`;
}
function renderAuthPage() {
  authGateActive = true;
  authRole = 'customer';
  const channelTabs = '<div class="auth-channel-tabs"><button type="button" class="'+(authChannel==='email'?'active':'')+'" data-action="auth-channel" data-channel="email">Email and password</button><button type="button" class="'+(authChannel==='phone'?'active':'')+'" data-action="auth-channel" data-channel="phone">Phone OTP</button></div>';
  const remember = '<label class="remember-choice"><input id="remember-me" type="checkbox" '+(rememberAuthSession?'checked':'')+'> Keep me signed in on this device</label>';
  const emailPanel = authChannel==='email'
    ? '<form id="auth-email-form"><div class="field"><label for="auth-email">Email address</label><input id="auth-email" name="email" type="email" required autocomplete="email" maxlength="254" placeholder="you@example.com"></div><div class="field"><label for="auth-password">Password</label><input id="auth-password" name="password" type="password" minlength="6" required autocomplete="'+(authMode==='signup'?'new-password':'current-password')+'" placeholder="At least 6 characters"></div>'+remember+'<button class="button button-primary button-wide" type="submit">'+(authMode==='signup'?'Create customer account':'Log in')+' →</button></form><button class="button button-secondary button-wide" data-action="auth-password-reset" type="button">Forgot password?</button><button class="button button-secondary button-wide" data-action="auth-google" type="button">Continue with Google</button>'
    : '';
  const phonePanel = authChannel==='phone'
    ? '<form id="auth-phone-form" onsubmit="return false"><div class="field"><label for="auth-phone">Mobile number</label><input id="auth-phone" name="phone" inputmode="tel" autocomplete="tel" required value="'+safe(phoneDraft)+'" placeholder="+977 98XXXXXXXX"><small>Nepal numbers such as 98XXXXXXXX are accepted.</small></div>'+remember+'<div id="phone-recaptcha-container"></div><button class="button button-primary button-wide" type="button" id="auth-send-phone-otp" data-action="send-phone-otp">'+(phoneOtpSent?'Resend verification code':'Send phone OTP')+' →</button>'+(phoneOtpSent?'<div class="field"><label for="auth-otp">6-digit verification code</label><input id="auth-otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required placeholder="Enter code"></div><button class="button button-primary button-wide" type="button" data-action="confirm-phone-otp">Verify and continue →</button>':'')+'</form>'
    : '';
  app.innerHTML = '<div class="auth-page"><div class="auth-card auth-card-wide"><div class="auth-icon">♙</div><div class="eyebrow">Pashughar account</div><h1>'+(authMode==='signup'?'Create your customer account':'Log in to Pashughar')+'</h1><p class="auth-description">'+(authMode==='signup'?'Create a customer account to shop, save listings, order, enquire and book appointments. To sell, use Become a partner.':'Use the same login for customers, retailers and administrators. Your access is assigned by your trusted account role.')+'</p><div class="auth-mode-tabs"><button type="button" class="'+(authMode==='signin'?'active':'')+'" data-action="auth-mode" data-mode="signin">Log in</button><button type="button" class="'+(authMode==='signup'?'active':'')+'" data-action="auth-mode" data-mode="signup">Sign up</button></div>'+channelTabs+emailPanel+phonePanel+'<div class="auth-footnote">Retailers sign in here like everyone else and are routed to their retailer dashboard by account role. Administrator access is controlled by a trusted Firebase custom claim.</div><a class="auth-back-link" href="#home">← Back to shopping</a></div></div>';
}
function renderAccount() {
  const user = session();
  if (!user && !authStateReady) { app.innerHTML='<div class="page-wrap"><div class="container"><div class="initial-loading">Checking your account…</div></div></div>'; return; }
  if (!user) { renderAuthPage('customer'); return; }
  authGateActive = false;
  const verified = isVerifiedContact({emailVerified:user.emailVerified,phoneNumber:user.phoneNumber});
  const roleName = user.role==='admin'?'Administrator':user.role==='retailer'?'Retailer':'Customer';
  const destination = user.role==='admin'?'#admin':user.role==='retailer'?'#dashboard':'#shop';
  const verifyBlock = verified
    ? '<div class="notice notice-info"><strong>Contact verified.</strong> You can continue using your account.</div>'
    : '<div class="notice notice-warn"><strong>Contact verification needed.</strong> Verify your email or use phone OTP before publishing listings or placing an account-based order.</div>'+(user.email?'<button class="button button-primary" type="button" data-action="send-email-verification">Send verification email</button> ':'')+'<button class="button button-secondary" type="button" data-action="refresh-verification">I have verified — refresh status</button>';
  app.innerHTML = '<div class="page-wrap"><div class="container"><div class="account-page-card"><a class="button button-secondary" href="#home">← Back to shopping</a><div class="eyebrow">My Pashughar</div><h1>My Account</h1><p class="account-user-name">'+safe(user.name||'Pashughar user')+'</p><p class="small-muted">'+safe(user.email||user.phoneNumber||'')+' · '+roleName+'</p>'+verifyBlock+'<div class="account-actions"><a class="button button-primary" href="'+destination+'">'+(user.role==='admin'?'Open admin dashboard':user.role==='retailer'?'Open retailer dashboard':'Continue shopping')+' →</a><a class="button button-secondary" href="#profile">Edit profile</a><a class="button button-secondary" href="#orders">My orders</a><a class="button button-secondary" href="#enquiries">My enquiries</a><a class="button button-secondary" href="#notifications">Notifications</a><a class="button button-secondary" href="#appointments">Vet appointments</a><button class="button button-secondary" type="button" data-action="signout">Sign out</button></div><p class="small-muted">Remember me is controlled when you sign in. Unchecked sessions end when the browser session closes. Inactive sessions are signed out automatically.</p></div></div></div>';
}
function resetAutoLogoutTimer() {
  clearTimeout(inactivityTimer);
  if (!session()) return;
  inactivityTimer = setTimeout(() => {
    signOutUser().catch(()=>{});
    firebaseSession = null;
    store.saveSession(null);
    navigate('#login');
    showToast('You were signed out after 30 minutes of inactivity.','warn');
  }, AUTO_LOGOUT_MS);
}

function renderSimplePage(path) {
  const content={
    learn:['Learn about buying and selling safely','Compare listings carefully, confirm the seller and location, check stock status, and request appropriate animal-health or food-safety documentation before arranging a purchase. Retailers should provide accurate descriptions, pricing, stock and location details.'],
    about:['About Pashughar','Pashughar is a marketplace concept designed to bring livestock, meat and poultry, pets & supplies, animal products, and animal-care essentials together in one place. Our goal is to make product discovery easier while helping retailers organize listings and stock.'],
    contact:['Contact support','For this prototype, customer support contact information has not yet been configured. Add your business email, telephone number, service hours, and support workflow before launch.'],
    privacy:['Privacy policy','This prototype stores demo session details, sample orders, product listings, and cart data in local browser storage. That is not a production privacy or data-security arrangement. Publish a legally reviewed privacy policy covering account information, orders, seller verification, payments, retention, and user rights before collecting real customer data.'],
    terms:['Terms & conditions','Marketplace terms should define retailer responsibilities, product accuracy, fulfilment, cancellations, returns, refunds, commissions, disputes, prohibited listings, and customer responsibilities. Obtain appropriate legal review for every location where Pashughar will operate before launch.']
  }[path]||['Page not found','The requested page is not available. Return to the marketplace and continue browsing.'];
  app.innerHTML=`<div class="simple-page"><div class="container"><article><div class="eyebrow">Pashughar information</div><h1>${content[0]}</h1><p>${content[1]}</p><a class="button button-primary" href="#home">Back to home</a></article></div></div>`;
}
function applySiteSettings(settings = store.siteSettings()) {
  const bar=document.getElementById('site-announcement');
  if(bar){
    const text=String(settings.announcementText||'').trim();
    bar.textContent=text;
    bar.style.display=(settings.announcementEnabled!==false&&text)?'flex':'none';
  }
}
function updateCartCount(){
  const cartEl=document.getElementById('cart-count'); if(cartEl)cartEl.textContent=cartCount();
  const savedEl=document.getElementById('wishlist-count'); if(savedEl)savedEl.textContent=store.wishlist().length;
  const accountLink=document.getElementById('account-link');
  if(accountLink){const user=session();accountLink.href=user?'#account':'#login';const label=accountLink.querySelector('span');if(label)label.textContent=user?'My Account':'Login';accountLink.setAttribute('aria-label',user?'My Account':'Login');}
}
function scrollTop(){window.scrollTo({top:0,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});}
function renderPetsHub() {
  delete app.dataset.sectionTheme;
  const cards = [
    {id:'pets',title:'Pets',kicker:'Find your companion',desc:'Browse pets from verified local retailers. Check age, health and vaccination details before arranging a visit.',image:'https://images.unsplash.com/photo-1552053831-71594a27632d?auto=format&fit=crop&w=1000&q=85',tone:'#e8a23a'},
    {id:'accessories',title:'Pet accessories',kicker:'Everyday essentials',desc:'Collars, leads, beds, toys, carriers, grooming tools and other pet essentials.',image:'https://images.unsplash.com/photo-1583337130417-3346a1be7dee?auto=format&fit=crop&w=1000&q=85',tone:'#5b9f93'},
    {id:'breeding',title:'Pet breeding',kicker:'Location-based listings',desc:'Find dogs offered for planned breeding by location. Review health, breed and owner terms before arranging a date.',image:'https://images.unsplash.com/photo-1516734212186-a967f81ad0d7?auto=format&fit=crop&w=1000&q=85',tone:'#bd7950'}
  ];
  const cardsHtml = cards.map(c => '<a class="pet-section-card" href="#pet-section?type='+c.id+'" style="--pet-accent:'+c.tone+'"><div class="pet-section-image"><img src="'+c.image+'" alt="" loading="lazy"></div><div class="pet-section-copy"><span class="eyebrow">'+c.kicker+'</span><h2>'+c.title+'</h2><p>'+c.desc+'</p><span class="pet-section-link">Explore section <b>→</b></span></div></a>').join('');
  app.innerHTML = '<div class="page-wrap pet-marketplace"><div class="container"><div class="pet-page-top"><a class="button button-secondary" href="#home">← Back to home</a><div class="eyebrow">Pashughar · pets</div><h1>Everything your pet needs, in one place.</h1><p>Choose a dedicated section to shop pets, accessories, or location-based breeding listings.</p></div><div class="pet-section-grid">'+cardsHtml+'</div></div></div>';
}
function renderPetSection(params) {
  const type = ['pets','accessories','breeding'].includes(params.get('type')) ? params.get('type') : 'pets';
  const info = {
    pets:{title:'Pets for sale',eyebrow:'Meet your next companion',desc:'Browse pets from verified retailers. Confirm health records, age, vaccinations and ownership before arranging a visit.',empty:'No pet listings yet. Retailers can add a pet and choose Pets as its section.'},
    accessories:{title:'Pet accessories',eyebrow:'Comfort, play and care',desc:'Find collars, leads, beds, toys, carriers, grooming tools and other accessories.',empty:'No accessories listed yet. Retailers can select Pet accessories when creating a listing.'},
    breeding:{title:'Pet breeding bookings',eyebrow:'Find a dog by location',desc:'Browse dogs offered for responsible breeding. Check breed, age, health screening and location. A date is confirmed only after the owner accepts the request.',empty:'No breeding listings yet. Retailers can add a dog and choose Pet breeding.'}
  }[type];
  const petSectionOf = p => {
    const raw = p.attributes?.petSection || p.petSection || p.attributes?.pet_section || 'pets';
    const value = String(raw).toLowerCase().trim().replace(/[ _]+/g,'-');
    if (['pet','pets','pet-sale','pets-for-sale','for-sale'].includes(value)) return 'pets';
    if (['accessory','accessories','pet-accessories','supplies','pet-supplies'].includes(value)) return 'accessories';
    if (['breeding','pet-breeding','breeding-booking','breeding-bookings'].includes(value)) return 'breeding';
    return value;
  };
  const items = activeProducts().filter(p => normalizeCategoryId(p.category) === 'pets-supplies' && petSectionOf(p) === type);
  const cards = items.map(p => type === 'breeding'
    ? '<article class="product-card pet-breeding-card"><div class="product-image-wrap"><a href="'+publicProductUrl(p)+'"><img class="product-image" src="'+safe(p.image||'')+'" alt="'+safe(p.name)+'" loading="lazy"></a><span class="product-badge">'+safe(p.location||'Location not set')+'</span></div><div class="product-content"><div class="product-store">'+safe(p.retailer||'Verified retailer')+'</div><a href="'+publicProductUrl(p)+'"><h3 class="product-title">'+safe(p.name)+'</h3></a><div class="product-meta"><span>'+safe(p.location||'Nepal')+'</span><span>'+safe((p.attributes && p.attributes.breed)||'Breed details on listing')+'</span></div><p class="small-muted">Fee / arrangement: '+money(p.price)+'</p><div class="pet-breeding-actions"><a class="button button-secondary button-wide" href="'+publicProductUrl(p)+'">View dog</a><button class="button button-primary button-wide" type="button" data-action="book-breeding" data-id="'+safe(p.id)+'">Request a date</button></div></div></article>'
    : productCard(p)).join('');
  const filters = [['pets','Pets'],['accessories','Pet accessories'],['breeding','Pet breeding']].map(x => '<a class="pet-filter-chip '+(x[0]===type?'active':'')+'" href="#pet-section?type='+x[0]+'">'+x[1]+'</a>').join('');
  app.innerHTML = '<div class="page-wrap pet-marketplace"><div class="container"><div class="pet-page-top"><a class="button button-secondary" href="#pets">← Back to pet sections</a><div class="eyebrow">'+info.eyebrow+'</div><h1>'+info.title+'</h1><p>'+info.desc+'</p></div><div class="pet-filter-row">'+filters+'</div>'+(items.length?'<div class="product-grid">'+cards+'</div>':'<div class="pet-empty"><div class="pet-empty-icon">'+(type==='breeding'?'🐕':type==='accessories'?'🦴':'🐾')+'</div><h2>No listings yet</h2><p>'+info.empty+'</p><a class="button button-primary" href="#partner">Become a partner →</a></div>')+'</div></div>';
}
function routeTitle(path, params) {
  if (path.startsWith('product/')) return getProduct(decodeURIComponent(path.slice(8)))?.name || 'Product details';
  if (path === 'shop') {
    const cat = CATEGORIES.find(item => item.id === normalizeCategoryId(params.get('category') || ''));
    return cat?.name || 'Marketplace';
  }
  if (path === 'pet-section') return ({pets:'Pets for sale',accessories:'Pet accessories',breeding:'Pet breeding'})[params.get('type')] || 'Pet section';
  return ({pets:'Pets & supplies',cart:'Shopping cart',wishlist:'Saved items',seller:'Retailer workspace',admin:'Admin dashboard',about:'About Pashughar',learn:'Learn',contact:'Contact',privacy:'Privacy policy',terms:'Terms & conditions'})[path] || 'Page not found';
}
function renderRouteChrome(path, params) {
  if (['home','admin','login','account','pets','pet-section','about','learn','contact','privacy','terms'].includes(path)) return;
  if (path==='seller' && session()?.role!=='retailer') return;
  if (!['shop','cart','wishlist','seller'].includes(path) && !path.startsWith('product/')) return;
  const title = routeTitle(path, params);
  let parent = '<a href="#home">Home</a>';
  if (path.startsWith('product/')) {
    const p = getProduct(decodeURIComponent(path.slice(8)));
    parent += ' <span aria-hidden="true">/</span> <a href="#shop">Marketplace</a>';
    if (p) parent += ' <span aria-hidden="true">/</span> <a href="#shop?category='+encodeURIComponent(normalizeCategoryId(p.category))+'">'+safe(categoryName(p.category))+'</a>';
  } else if (path === 'pet-section') {
    parent += ' <span aria-hidden="true">/</span> <a href="#pets">Pets & supplies</a>';
  } else if (path === 'shop' && params.get('category')) {
    parent += ' <span aria-hidden="true">/</span> <a href="#shop">Marketplace</a>';
  }
  app.insertAdjacentHTML('afterbegin','<div class="route-context"><button type="button" class="route-back-button" data-action="route-back">← Back</button><nav class="route-breadcrumbs" aria-label="Breadcrumb">'+parent+' <span aria-hidden="true">/</span> <strong>'+safe(title)+'</strong></nav></div>');
}
function fallbackBackRoute(path) {
  if (path === 'pet-section') return '#pets';
  if (path.startsWith('product/')) {
    const p = getProduct(decodeURIComponent(path.slice(8)));
    return p ? '#shop?category='+encodeURIComponent(normalizeCategoryId(p.category)) : '#shop';
  }
  if (path === 'seller' || path === 'admin') return '#home';
  if (['shop','cart','wishlist','pets','about','learn','contact'].includes(path)) return '#home';
  return '#shop';
}

function render() {
  authGateActive = false;
  const {path,params}=getRoute();
  delete app.dataset.sectionTheme;
  document.querySelectorAll('.nav-inner a').forEach(a=>a.classList.toggle('current',a.getAttribute('href')===`#${path}`));
  const known = ['home','shop','pets','pet-section','cart','account','login','seller','dashboard','partner','admin','wishlist','orders','enquiries','profile','notifications','appointments','about','learn','contact','privacy','terms'];
  if(path==='home')renderHome();
  else if(path==='login')renderAuthPage();
  else if(path==='partner')renderPartnerRegistration();
  else if(path==='dashboard'||path==='seller') { if(session()?.role==='retailer')renderSellerDashboard(); else renderAuthPage(); }
  else if(path==='shop') { activeShopQuery=params.get('q')??''; activeShopCategory=params.get('category')??''; renderShop(params); }
  else if(path==='pets')renderPetsHub();
  else if(path==='pet-section')renderPetSection(params);
  else if(path.startsWith('product/'))renderProduct(decodeURIComponent(path.slice(8)));
  else if(path.startsWith('store/'))renderPublicStore(decodeURIComponent(path.slice(6)));
  else if(path==='cart')renderCart();
  else if(path==='account')renderAccount();
  else if(path==='seller'||path==='dashboard') { if(session()?.role==='retailer')renderSellerDashboard(); else renderAuthPage(); }
  else if(path==='admin') { if(session()?.role==='admin')renderAdmin(); else renderAdminLogin(); }
  else if(['wishlist','orders','enquiries','profile','notifications','appointments'].includes(path)) { renderCustomerFeature(path,app).then(handled=>{ if(!handled) renderSimplePage(path); }).catch(()=>renderSimplePage(path)); }
  else if(known.includes(path))renderSimplePage(path);
  else renderSimplePage('not-found');
  renderRouteChrome(path,params);
  updateCartCount();
  if(session())resetAutoLogoutTimer();
}
function navigate(hash, options = {}) {
  const target = String(hash || '#home').startsWith('#') ? String(hash || '#home') : '#'+String(hash);
  if (target === location.hash && location.hash) return;
  history.replaceState({... (history.state || {}), pashugharRoute: location.hash || location.pathname, pashugharScrollY: window.scrollY}, '', location.href);
  history.pushState({pashugharRoute:target,pashugharScrollY:0,pashugharInternal:true}, '', target);
  const nav=document.getElementById('main-nav');
  nav?.classList.remove('open');
  document.getElementById('menu-toggle')?.setAttribute('aria-expanded','false');
  render();
  if (!options.preserveScroll) window.scrollTo({top:0,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
}
function quantityStep(product){return ['kg','litre'].includes(String(product?.unit||'').toLowerCase())?0.5:1;}
function addToCart(id, qty=1){
  const product=getProduct(id);if(!product||product.status!=='approved')return showToast('This product is not available to purchase.','error');
  if(!isAvailable(product))return showToast('This product is sold out.','warn');
  const cart=store.cart();const existing=cart.find(i=>i.id===id);const requested=(existing?Number(existing.qty):0)+Number(qty);
  if(!Number.isFinite(requested)||requested<=0||Math.abs(requested*2-Math.round(requested*2))>0.00001||(quantityStep(product)===1&&!Number.isInteger(requested)))return showToast('Enter a valid quantity for this product unit.','warn');
  if(requested>Number(product.stock))return showToast(`Only ${product.stock} ${product.unit||'unit'}${Number(product.stock)===1?'':'s'} available.`,'warn');
  if(existing)existing.qty=requested;else cart.push({id,qty:Number(qty)});
  store.saveCart(cart);updateCartCount();showToast(`Added to basket: ${product.name}.`);
}
function updateCartQty(id, delta){const cart=store.cart();const item=cart.find(i=>i.id===id);const p=getProduct(id);if(!item||!p)return;const step=quantityStep(p);if(delta>0&&item.qty+step>Number(p.stock))return showToast('No more stock is available.','warn');item.qty+=delta*step;if(item.qty<=0){store.saveCart(cart.filter(i=>i.id!==id));}else{store.saveCart(cart);}renderCart();}
function toggleWishlist(id){const user=session();if(isFirebaseConfigured()){if(!user?.firebase){showToast('Sign in to save products to your account wishlist.','warn');navigate('#login');return;}toggleCloudWishlist(id).then(saved=>{showToast(saved?'Saved to your account wishlist.':'Removed from your wishlist.');render();}).catch(error=>showToast(firebaseErrorMessage(error),'error'));return;}const list=store.wishlist();if(list.includes(id)){store.saveWishlist(list.filter(i=>i!==id));showToast('Removed from your wishlist.');}else{store.saveWishlist([...list,id]);showToast('Saved to wishlist.');}render();}
function openProductForm(product=null){
  const user=session();if(!user || user.role!=='retailer')return showToast('Sign in to the retailer workspace first.','warn');const profile=retailerProfile(user);if(!profile||profile.status!=='approved'){if(profile)renderRetailerVerificationState(user,profile);else renderSellerSetup(user);return showToast('Your shop must be verified before publishing products.','warn');}
  const p=product||{};if(product&&!(p.retailerId===user.uid||(user.uid==='demo-retailer'&&p.retailerId==='retailer-demo')))return showToast('You can only edit your own listings.','error');
  currentProductImages=(Array.isArray(p.images)&&p.images.length?p.images:[p.image]).filter(Boolean).slice(0,5);activeProductImageIndex=0;
  const imageUrls=currentProductImages.filter(x=>!String(x).startsWith('data:')).join('\n');
  modalContent.innerHTML=`<div class="modal-inner"><div class="modal-head"><div><h2>${product?'Edit listing':'Add a product'}</h2><p>Verified retailers can publish directly. Add accurate details and up to five product photos or hosted image URLs.</p></div><button class="modal-close" data-action="close-modal" aria-label="Close">×</button></div><form id="product-form" data-id="${safe(p.id||'')}"><div class="field"><label for="pf-name">Product name *</label><input id="pf-name" name="name" required maxlength="120" value="${safe(p.name||'')}" placeholder="e.g. Fresh farm eggs"></div><div class="field-grid"><div class="field"><label for="pf-category">Category *</label><select id="pf-category" name="category" required>${CATEGORIES.filter(c=>c.active!==false).map(c=>`<option value="${c.id}" ${normalizeCategoryId(p.category)===c.id?'selected':''}>${c.name}</option>`).join('')}</select></div><div class="field"><label for="pf-condition">Product type / condition</label><input id="pf-condition" name="condition" value="${safe(p.condition||'New')}" placeholder="Fresh, new, live animal"></div></div><div class="field" data-category-fields="pets-supplies"><label for="pf-pet-section">Pet section</label><select id="pf-pet-section" name="petSection"><option value="pets" ${((p.attributes&&p.attributes.petSection)||"pets")==="pets"?"selected":""}>Pets</option><option value="accessories" ${(p.attributes&&p.attributes.petSection)==="accessories"?"selected":""}>Pet accessories</option><option value="breeding" ${(p.attributes&&p.attributes.petSection)==="breeding"?"selected":""}>Pet breeding</option></select><span class="small-muted">For breeding listings, include breed, age, health screening and service location.</span></div>
<div class="category-attributes-grid">
<div class="field" data-category-fields="livestock,pets-supplies"><label for="pf-breed">Breed / variety</label><input id="pf-breed" name="breed" maxlength="100" value="${safe(p.attributes?.breed||'')}" placeholder="e.g. Local cross, Golden Retriever"></div>
<div class="field" data-category-fields="livestock,pets-supplies"><label for="pf-age">Age</label><input id="pf-age" name="age" maxlength="80" value="${safe(p.attributes?.age||'')}" placeholder="e.g. 2 years, 8 months"></div>
<div class="field" data-category-fields="livestock,pets-supplies"><label for="pf-weight">Weight</label><input id="pf-weight" name="weight" maxlength="80" value="${safe(p.attributes?.weight||'')}" placeholder="e.g. 18 kg"></div>
<div class="field" data-category-fields="livestock,pets-supplies"><label for="pf-vaccination">Vaccination / health record</label><input id="pf-vaccination" name="vaccination" maxlength="160" value="${safe(p.attributes?.vaccination||'')}" placeholder="e.g. Vaccinated, records available"></div>
<div class="field" data-category-fields="meat"><label for="pf-cut">Meat cut</label><input id="pf-cut" name="cut" maxlength="100" value="${safe(p.attributes?.cut||'')}" placeholder="e.g. Boneless, curry cut, whole"></div>
<div class="field" data-category-fields="meat"><label for="pf-cut-notes">Processing / packing</label><input id="pf-cut-notes" name="cutNotes" maxlength="160" value="${safe(p.attributes?.cutNotes||'')}" placeholder="e.g. Fresh, chilled, packed"></div>
</div><div class="field"><label for="pf-description">Description *</label><textarea id="pf-description" name="description" required maxlength="2500" placeholder="Describe the product clearly">${safe(p.description||'')}</textarea></div><div class="field-grid"><div class="field"><label for="pf-price">Price in NPR *</label><input id="pf-price" name="price" type="number" required min="0.01" max="100000000" step="0.01" value="${safe(p.price??'')}" placeholder="e.g. 750"></div><div class="field"><label for="pf-unit">Selling unit *</label><select id="pf-unit" name="unit" required>${['piece','kg','g','litre','ml','dozen','pack','bag','animal','pair','box'].map(u=>`<option value="${u}" ${p.unit===u?'selected':''}>${u}</option>`).join('')}</select></div></div><div class="field-grid"><div class="field"><label for="pf-stock">Available quantity *</label><input id="pf-stock" name="stock" type="number" required min="0" max="1000000" step="${['kg','litre'].includes(String(p.unit||'').toLowerCase())?'0.5':'1'}" value="${safe(p.stock??0)}"></div><div class="field"><label for="pf-location">Location / service area *</label><input id="pf-location" name="location" required maxlength="220" value="${safe(p.location||profile.location||'Pokhara, Nepal')}" placeholder="City / district"></div></div>
<div class="field-grid"><div class="field"><label for="pf-province">Province</label><input id="pf-province" name="province" maxlength="100" value="${safe(p.attributes?.province||'')}" placeholder="e.g. Gandaki Province"></div><div class="field"><label for="pf-district">District</label><input id="pf-district" name="district" maxlength="100" value="${safe(p.attributes?.district||'')}" placeholder="e.g. Kaski"></div></div>
<div class="field-grid"><div class="field"><label for="pf-municipality">Municipality / rural municipality</label><input id="pf-municipality" name="municipality" maxlength="120" value="${safe(p.attributes?.municipality||'')}" placeholder="e.g. Pokhara Metropolitan City"></div><div class="field"><label for="pf-latitude">Latitude (optional)</label><input id="pf-latitude" name="latitude" type="number" min="-90" max="90" step="any" value="${safe(p.attributes?.latitude??'')}" placeholder="28.2096"></div></div>
<div class="field"><label for="pf-longitude">Longitude (optional)</label><input id="pf-longitude" name="longitude" type="number" min="-180" max="180" step="any" value="${safe(p.attributes?.longitude??'')}" placeholder="83.9856"><span class="small-muted">Coordinates enable distance sorting. Only enter coordinates you are authorized to publish.</span></div><div class="field"><label for="pf-images">Upload product photos (up to 5)</label><input id="pf-images" name="images" type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple ${isFirebaseConfigured()?"disabled":""}><span class="small-muted">${isFirebaseConfigured()?"Firebase Storage is disabled. Use public HTTPS image URLs below; uploads are unavailable in this version.":"Photos are resized in your browser and stored locally in this prototype."}</span><div id="pf-image-preview" class="uploaded-image-grid">${currentProductImages.map((src,i)=>`<div><img src="${safe(src)}" alt="Product photo ${i+1}"><button type="button" data-action="remove-product-image" data-index="${i}" aria-label="Remove image">×</button></div>`).join('')}</div></div><div class="field"><label for="pf-image-urls">Hosted image URLs (up to 5, one per line)</label><textarea id="pf-image-urls" name="imageUrls" rows="2" placeholder="https://example.com/product-photo.jpg">${safe(imageUrls)}</textarea><span class="small-muted">Live Firebase mode currently accepts hosted HTTPS image URLs. File uploads require a storage provider, which is not configured.</span></div><div class="field"><label for="pf-video-urls">Hosted video URLs (up to 3, one per line)</label><textarea id="pf-video-urls" name="videoUrls" rows="2" placeholder="https://example.com/video.mp4">${safe((p.videoUrls||[]).join('\n'))}</textarea><span class="small-muted">Add public HTTPS video links from a host you control. Direct video uploads are not enabled.</span></div><div class="field-grid"><div class="field"><label for="pf-attr1">Specification label</label><input id="pf-attr1" name="attr1" value="${safe(Object.keys(p.attributes||{})[0]||'')}" placeholder="e.g. Breed / Weight"></div><div class="field"><label for="pf-attrv1">Specification value</label><input id="pf-attrv1" name="attrv1" value="${safe(Object.values(p.attributes||{})[0]||'')}" placeholder="e.g. Local cross"></div></div><div class="notice notice-info">Stock zero automatically shows <strong>SOLD OUT</strong>. Your listing will become visible as soon as you publish it.</div><div class="modal-actions"><button type="button" class="button button-secondary" data-action="close-modal">Cancel</button><button type="submit" class="button button-primary">${product?'Save changes':'Publish product'} →</button></div></form></div>`;
  const categorySelect=document.getElementById('pf-category');
  const syncCategoryFields=()=>{
    const category=normalizeCategoryId(categorySelect?.value||'');
    document.querySelectorAll('[data-category-fields]').forEach(field=>{
      const allowed=String(field.dataset.categoryFields||'').split(',').map(x=>x.trim());
      field.hidden=!allowed.includes(category);
    });
  };
  categorySelect?.addEventListener('change',syncCategoryFields);
  syncCategoryFields();
  showModalWithHistory();
}

let modalHistoryActive = false;
function showModalWithHistory() {
  history.pushState({... (history.state || {}), pashugharOverlay:'modal', pashugharScrollY:window.scrollY}, '', location.href);
  modalHistoryActive = true;
  if(typeof modal.showModal==='function')modal.showModal();else modal.setAttribute('open','');
}
function closeModal() {
  const wasOpen=Boolean(modal.open || modal.hasAttribute('open'));
  if(modal.open)modal.close();else modal.removeAttribute('open');
  if(wasOpen && modalHistoryActive) { modalHistoryActive=false; history.back(); }
}
function submitProduct(form){
  const data=new FormData(form);const name=String(data.get('name')||'').trim();const desc=String(data.get('description')||'').trim();const price=Number(data.get('price'));const stock=Number(data.get('stock'));const unit=String(data.get('unit')||'');const allowsFraction=['kg','litre'].includes(unit.toLowerCase());
  const user=session();const profile=retailerProfile(user);if(!user||user.role!=='retailer'||!profile||profile.status!=='approved')return showToast('Only verified retailers can publish products.','error');
  if(isFirebaseConfigured()&&!isVerifiedContact({emailVerified:user.emailVerified,phoneNumber:user.phoneNumber})){showToast('Verify your email or phone before publishing listings.','warn');navigate('#account');return;}
  if(!name||name.length>120||!desc||desc.length>2500||!Number.isFinite(price)||price<=0||price>100000000||!Number.isFinite(stock)||(allowsFraction?Math.abs(stock*2-Math.round(stock*2))>0.00001:!Number.isInteger(stock))||stock<0||stock>1000000)return showToast('Check the product name, description, price and whole-number stock limits.','error');
  const products=allProducts();const id=form.dataset.id;const existing=id?products.find(p=>p.id===id):null;
  if(existing&&!(existing.retailerId===user.uid||(user.uid==='demo-retailer'&&existing.retailerId==='retailer-demo')))return showToast('You can only edit your own listings.','error');
  const attrs={...(existing?.attributes||{})};
  if(String(data.get('attr1')||'').trim()&&String(data.get('attrv1')||'').trim())attrs[String(data.get('attr1')).trim()]=String(data.get('attrv1')).trim();
  ['breed','age','weight','vaccination','cut','cutNotes'].forEach(key=>{const value=String(data.get(key)||'').trim();if(value)attrs[key]=value;else delete attrs[key];});
  if (normalizeCategoryId(String(data.get('category'))) === 'pets-supplies') attrs.petSection = ['pets','accessories','breeding'].includes(String(data.get('petSection'))) ? String(data.get('petSection')) : 'pets';
  else delete attrs.petSection;
  const videoUrls=String(data.get('videoUrls')||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  if(videoUrls.length>3||videoUrls.some(url=>{try{return new URL(url).protocol!=='https:';}catch{return true;}}))return showToast('Use up to three valid HTTPS video URLs.','error');
  const rawImageUrls=String(data.get('imageUrls')||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  const urlImages=rawImageUrls.filter(x=>{try{const u=new URL(x);return u.protocol==='https:' && Boolean(u.hostname);}catch{return false;}});
  if(rawImageUrls.length!==urlImages.length)return showToast('Each image must be a valid HTTPS URL. Firebase Storage is disabled in this version.','error');
  if(rawImageUrls.length>5)return showToast('Add no more than five image URLs.','error');
  const localImages=isFirebaseConfigured()?[]:currentProductImages.filter(x=>String(x).startsWith('data:'));
  const preservedImages=!isFirebaseConfigured()&&existing&&Array.isArray(existing.images)?existing.images.filter(x=>String(x).startsWith('data:')):[];
  const images=[...new Set([...urlImages,...localImages,...preservedImages])].slice(0,5);
  const primary=images[0]||existing?.image||'https://images.unsplash.com/photo-1500382017468-9049fed747ef?auto=format&fit=crop&w=700&q=80';
  const entry={...(existing||{}),id:id||slugId(),name,category:normalizeCategoryId(String(data.get('category'))),condition:String(data.get('condition')||'New'),description:desc,price,unit,stock,location:String(data.get('location')||'Nepal').trim(),image:primary,images:images.length?images:[primary],videoUrls,attributes:attrs,retailer:profile.storeName,retailerId:user.uid,status:isFirebaseConfigured()?'pending':(existing?.status==='paused'?'paused':'approved'),createdAt:existing?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
  const saveResult = store.saveProducts(existing?products.map(p=>p.id===id?entry:p):[entry,...products]);
  if (isFirebaseConfigured()) {
    showToast('Saving product to Firestore…');
    Promise.resolve(saveResult).then(()=>{closeModal();renderSellerDashboard();showToast(existing?'Listing changes saved and sent for review.':'Product submitted for admin approval; it will appear after approval.');}).catch(()=>{});
    return;
  }
  closeModal();renderSellerDashboard();showToast(existing?'Listing updated and published.':'Product published to the marketplace.');
}


function openBreedingBookingForm(productId) {
  const product = getProduct(productId);
  if (!product || product.status !== 'approved' || product.category !== 'pets-supplies' || product.attributes?.petSection !== 'breeding') return showToast('This breeding listing is not available.','error');
  if (!isFirebaseConfigured()) return showToast('Breeding booking requests require Firebase sign-in and the live Firestore rules.','warn');
  const user = session();
  if (!user) { showToast('Sign in with a customer account before requesting a breeding date.','warn'); navigate('#login'); return; }
  if (!isVerifiedContact({emailVerified:user.emailVerified,phoneNumber:user.phoneNumber})) { showToast('Verify your email or phone before requesting a breeding date.','warn'); navigate('#account'); return; }
  const today = new Date(); const minDate = [today.getFullYear(),String(today.getMonth()+1).padStart(2,'0'),String(today.getDate()).padStart(2,'0')].join('-');
  modalContent.innerHTML = '<div class="modal-inner"><div class="modal-head"><div><div class="eyebrow">Pet breeding</div><h2>Request a breeding date</h2><p>'+safe(product.name)+' · '+safe(product.location||'Location not specified')+'</p></div><button class="modal-close" data-action="close-modal" aria-label="Close">×</button></div><form id="breeding-booking-form" data-product-id="'+safe(product.id)+'" data-retailer-id="'+safe(product.retailerId)+'" data-product-name="'+safe(product.name)+'"><div class="field"><label for="booking-name">Your name *</label><input id="booking-name" name="customerName" required maxlength="120" value="'+safe(user.name||'')+'"></div><div class="field"><label for="booking-phone">Phone number *</label><input id="booking-phone" name="customerPhone" required maxlength="40" inputmode="tel" placeholder="98XXXXXXXX"></div><div class="field"><label for="booking-date">Requested date *</label><input id="booking-date" name="requestedDate" type="date" min="'+minDate+'" required></div><div class="field"><label for="booking-location">Your location *</label><input id="booking-location" name="location" required maxlength="180" placeholder="City / district"></div><div class="field"><label for="booking-note">Note to the dog owner</label><textarea id="booking-note" name="note" maxlength="1000" placeholder="Share breed questions or preferred time."></textarea></div><div class="notice notice-info">This sends a request, not a confirmed booking. The dog owner must review and accept the date.</div><div class="modal-actions"><button type="button" class="button button-secondary" data-action="close-modal">Cancel</button><button type="submit" class="button button-primary">Send booking request →</button></div></form></div>';
  showModalWithHistory();
}

function openReportForm(productId){
  const p=getProduct(productId);if(!p)return showToast('This listing is no longer available.','error');
  modalContent.innerHTML=`<div class="modal-inner"><div class="modal-head"><div><div class="eyebrow">Marketplace safety</div><h2>Report this listing</h2><p>Report a specific concern so Pashughar can review the retailer and product.</p></div><button class="modal-close" data-action="close-modal" aria-label="Close">×</button></div><form id="report-form" data-product-id="${safe(p.id)}"><div class="reported-product-mini"><img src="${safe(p.image||'')}" alt="" onerror="this.style.display='none'"><div><strong>${safe(p.name)}</strong><span>${safe(p.retailer||'Local retailer')}</span></div></div><div class="field"><label for="report-reason">What is the issue? *</label><select id="report-reason" name="reason" required><option value="">Select a reason</option><option value="suspected-scam">Suspected scam or fraud</option><option value="misleading-listing">Misleading description or price</option><option value="fake-product">Fake or misrepresented product</option><option value="non-delivery">Order not delivered</option><option value="animal-welfare">Animal welfare concern</option><option value="prohibited-item">Prohibited or unsafe listing</option><option value="other">Other concern</option></select></div><div class="field"><label for="report-details">Tell us what happened *</label><textarea id="report-details" name="details" required minlength="10" maxlength="1800" placeholder="Provide dates, order reference (if any), and a clear description. Do not include passwords or payment credentials."></textarea></div><div class="field-grid"><div class="field"><label for="reporter-name">Your name (optional)</label><input id="reporter-name" name="reporterName" maxlength="100" placeholder="Name"></div><div class="field"><label for="reporter-contact">Contact (optional)</label><input id="reporter-contact" name="reporterContact" maxlength="150" placeholder="Email or phone for follow-up"></div></div><div class="notice notice-info">Reports are reviewed by Pashughar. A report is an allegation, not proof that a retailer has done something wrong.</div><div class="modal-actions"><button type="button" class="button button-secondary" data-action="close-modal">Cancel</button><button type="submit" class="button button-primary">Submit report</button></div></form></div>`;
  showModalWithHistory();
}
function submitReport(form){
  const data=new FormData(form);const p=getProduct(form.dataset.productId);if(!p)return showToast('This product was removed before the report could be submitted.','error');
  const reason=String(data.get('reason')||'').trim();const details=String(data.get('details')||'').trim();if(!reason||details.length<10)return showToast('Choose a reason and provide at least 10 characters of detail.','error');
  const reporterContact=String(data.get('reporterContact')||'').trim();const reporterName=String(data.get('reporterName')||'').trim();
  if(isFirebaseConfigured()){callCloudFunction('submitReport',{productId:p.id,reason,details,reporterName,reporterContact},'Report submitted to Pashughar for review.').then(()=>closeModal()).catch(()=>{});return;}
  const reports=store.reports();
  if(reporterContact&&reports.some(r=>r.productId===p.id&&r.reporterContact?.toLowerCase()===reporterContact.toLowerCase()&&r.reason===reason&&['open','reviewing'].includes(r.status)))return showToast('A similar report from this contact is already open.','warn');
  const reasonLabel=({ 'suspected-scam':'Suspected scam or fraud','misleading-listing':'Misleading description or price','fake-product':'Fake or misrepresented product','non-delivery':'Order not delivered','animal-welfare':'Animal welfare concern','prohibited-item':'Prohibited or unsafe listing','other':'Other concern'})[reason]||reason;
  const report={id:slugId(),productId:p.id,productName:p.name,retailerId:p.retailerId||'unknown',retailerName:p.retailer||'Unknown retailer',location:p.location||'Not specified',category:p.category,reason,reasonLabel,details,reporterName:reporterName||'Guest shopper',reporterContact,status:'open',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  store.saveReports([report,...reports]);closeModal();showToast('Report submitted. Pashughar can now review it.');
}
async function shrinkImage(file){
  if(!file||!String(file.type).startsWith('image/'))throw new Error('Choose an image file.');
  if(file.size>10*1024*1024)throw new Error('Each original image must be under 10 MB.');
  const bitmap=await createImageBitmap(file);const scale=Math.min(1,1200/Math.max(bitmap.width,bitmap.height));const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close?.();
  let data=canvas.toDataURL('image/webp',0.78);if(!data.startsWith('data:image/webp'))data=canvas.toDataURL('image/jpeg',0.78);return data;
}
function renderProductImagePreview(){const preview=document.getElementById('pf-image-preview');if(!preview)return;const urls=(document.getElementById('pf-image-urls')?.value||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);const local=currentProductImages.filter(x=>String(x).startsWith('data:'));const all=[...urls,...local].slice(0,5);preview.innerHTML=all.map((src,i)=>`<div><img src="${safe(src)}" alt="Product photo ${i+1}"><span>${i+1}</span></div>`).join('');}
function normalizePhoneDigits(value){
  let digits=String(value||'').replace(/\D/g,'');
  if(digits.startsWith('977'))return digits;
  if(digits.startsWith('0'))return '977'+digits.slice(1);
  if(digits.startsWith('9'))return '977'+digits;
  return digits;
}
function submitCheckout(form){
  const data=new FormData(form);const cart=store.cart();if(!cart.length)return showToast('Your cart is empty.','error');
  if(isFirebaseConfigured()&&session()&&!isVerifiedContact({emailVerified:session().emailVerified,phoneNumber:session().phoneNumber})){showToast('Verify your email or phone before ordering.','warn');navigate('#account');return;}
  if(isFirebaseConfigured()&&!session()&&!verifiedCheckoutPhone){showToast('Verify the guest checkout phone by OTP before placing this order.','warn');return;}
  if(isFirebaseConfigured()&&verifiedCheckoutPhone&&normalizePhoneDigits(String(new FormData(form).get('phone')||''))!==normalizePhoneDigits(verifiedCheckoutPhone)){showToast('The delivery phone number must match the verified number.','warn');return;}
  for(const item of cart){const p=getProduct(item.id);if(!p||p.status!=='approved'||!isAvailable(p)||Number(item.qty)>Number(p.stock))return showToast('One or more items are no longer available in the requested quantity. Review your cart.','error');}
  const name=String(data.get('name')||'').trim(), phone=String(data.get('phone')||'').trim(), address=String(data.get('address')||'').trim(), city=String(data.get('city')||'').trim(), notes=String(data.get('notes')||'').trim();
  if(!name||!phone||!address||!city)return showToast('Complete your name, phone, address and city.','error');
  if(isFirebaseConfigured()){
    const paymentMethod=data.get('payment')==='cod'?'cod':'contact_seller';
    const submitButton=form.querySelector('button[type="submit"]');
    if (submitButton?.disabled) return;
    if (submitButton) { submitButton.disabled = true; submitButton.textContent = 'Submitting order…'; }
    callCloudFunction('createOrder',{clientRequestId:form.dataset.requestId || slugId(),items:cart.map(i=>({productId:i.id,quantity:Number(i.qty)})),shipping:{name,phone,address,city,email:session()?.email||'',notes},paymentMethod})
      .then(result=>{
        store.saveCart([]);
        app.innerHTML=`<div class="page-wrap"><div class="container"><section class="panel-card status-hero"><div class="symbol">✓</div><div class="eyebrow" style="justify-content:center">Order submitted</div><h2>Thank you, ${safe(name)}.</h2><p>Your order <strong>${safe(result.orderId)}</strong> has been saved. No online payment has been taken; payment is ${paymentMethod==='cod'?'cash on delivery':'to be arranged with the retailer'}.</p><div style="font:800 23px Manrope;margin:15px 0">${money(result.total)}</div><span class="status-pill status-pending">Pending</span><div class="hero-actions" style="justify-content:center;margin-top:20px"><a href="#shop" class="button button-primary">Browse products</a><a href="#home" class="button button-secondary">Home</a></div></section></div></div>`;
        updateCartCount();window.scrollTo({top:0,behavior:'smooth'});
      }).catch(()=>{ if (submitButton) { submitButton.disabled = false; submitButton.textContent = `Place order · ${money(cartTotals(cart).subtotal)} →`; } });
    return;
  }
  const totals=cartTotals(cart);const customer=session();const order={id:`PG-${new Date().getFullYear()}-${Math.random().toString(36).slice(2,8).toUpperCase()}`,customerName:name,customerEmail:customer?.email||'guest@pashughar.demo',phone,address,city,notes,paymentMethod:data.get('payment')==='cod'?'Cash on delivery (demo)':'Contact retailer (demo)',status:'Pending',items:cart.map(i=>({id:i.id,qty:Number(i.qty),price:Number(getProduct(i.id).price),retailerId:getProduct(i.id).retailerId})),subtotal:totals.subtotal,total:totals.total,createdAt:new Date().toISOString(),demo:true};
  const products=allProducts().map(p=>{const item=cart.find(i=>i.id===p.id);return item?{...p,stock:Math.max(0,Number(p.stock)-Number(item.qty))}:p;});
  store.saveProducts(products);store.saveOrders([...store.orders(),order]);store.saveCart([]);
  app.innerHTML=`<div class="page-wrap"><div class="container"><div class="panel-card status-hero"><div class="symbol">✓</div><div class="eyebrow" style="justify-content:center">Demo order created</div><h2>Thank you, ${safe(order.customerName)}.</h2><p>Your local demo order <strong>${safe(order.id)}</strong> has been recorded in this browser. No real payment has been taken and no retailer has been notified.</p><div style="font:800 23px Manrope;margin:15px 0">${money(order.total)}</div><span class="status-pill status-pending">${safe(order.status)}</span><p style="margin-top:16px">This is a local demo order only.</p><div class="hero-actions" style="justify-content:center"><a href="#shop" class="button button-primary">Browse products</a><a href="#shop" class="button button-secondary">Continue shopping</a></div></div></div></div>`;
  updateCartCount();window.scrollTo({top:0,behavior:'smooth'});
}

function firebaseErrorMessage(error) {
  const code = String(error?.code || '');
  const messages = {
    'auth/invalid-credential':'Email or password is incorrect.',
    'auth/user-not-found':'No account was found for this email.',
    'auth/wrong-password':'Email or password is incorrect.',
    'auth/email-already-in-use':'An account already uses this email. Sign in instead.',
    'auth/weak-password':'Choose a stronger password with at least 6 characters.',
    'auth/popup-closed-by-user':'The Google sign-in window was closed before signing in.',
    'auth/unauthorized-domain':'This website domain is not authorized in Firebase Authentication.',
    'permission-denied':'Firestore rejected this change. Confirm the security rules and account permissions.',
    'functions/not-found':'This server function is not deployed yet. No change was made.',
    'functions/failed-precondition':'The requested action is not available for the current account or listing.',
    'functions/internal':'A server-side Firebase action failed. Shop and listing moderation now uses direct admin-authorized Firestore writes; other backend-only actions require Cloud Functions deployment.'
  };
  return messages[code] || error?.message || 'Firebase operation failed. No success was assumed.';
}
function callCloudFunction(name, payload, successMessage) {
  return getCallable(name)(payload).then(result => {
    if (successMessage) showToast(successMessage);
    return result.data;
  }).catch(error => { showToast(firebaseErrorMessage(error), 'error'); throw error; });
}
function endDemoSession() {
  if (isFirebaseConfigured()) {
    signOutUser().catch(error => showToast(firebaseErrorMessage(error), 'error'));
    return;
  }
  const role = session()?.role;
  store.saveSession(null);
  if (role === 'admin') { navigate('#admin'); if (getRoute().path === 'admin') render(); }
  else if (role === 'retailer') { navigate('#dashboard'); if (getRoute().path === 'seller') render(); }
  else { navigate('#home'); if (getRoute().path === 'home') render(); }
}

// Shared event delegation keeps page templates simple.
installCustomerFeatureHandlers();
installAdminFeatureHandlers();
window.addEventListener('pashughar:admin-toast',event=>showToast(String(event.detail?.message||'Admin action completed.')));
window.addEventListener('pashughar:customer-toast',event=>showToast(String(event.detail?.message||'Action completed.')));
window.addEventListener('pashughar:site-settings',event=>{applySiteSettings(event.detail||store.siteSettings());if(getRoute().path==='home')render();});
window.addEventListener('pashughar:categories',()=>{const active=document.activeElement;if(getRoute().path==='admin'&&adminTab==='categories')return;if(active&&['INPUT','TEXTAREA','SELECT'].includes(active.tagName))return;render();});
window.addEventListener('pashughar:profile-updated',event=>{if(firebaseSession){firebaseSession.name=event.detail?.displayName||firebaseSession.name;firebaseSession.phoneNumber=event.detail?.phone||firebaseSession.phoneNumber;}render();});
document.addEventListener('click',e=>{
  const actionEl=e.target.closest('[data-action]');
  if(!actionEl)return;
  const action=actionEl.dataset.action;const id=actionEl.dataset.id;
  if(action==='route-back'){
    if(history.state?.pashugharInternal && history.length>1) history.back();
    else navigate(fallbackBackRoute(getRoute().path));
  }
  else if(action==='auth-mode'){authRole=document.getElementById('auth-role')?.value||authRole;rememberAuthSession=document.getElementById('remember-me')?.checked!==false;authMode=actionEl.dataset.mode==='signup'?'signup':'signin';phoneOtpSent=false;renderAuthPage(authRole);}
  else if(action==='auth-channel'){authRole=document.getElementById('auth-role')?.value||authRole;rememberAuthSession=document.getElementById('remember-me')?.checked!==false;authChannel=actionEl.dataset.channel==='phone'?'phone':'email';phoneOtpSent=false;renderAuthPage(authRole);}
  else if(action==='auth-google'){
    if(!isFirebaseConfigured())return showToast('Firebase is not configured.','error');
    const selectedRole=document.getElementById('auth-role')?.value||authRole;
    const remember=document.getElementById('remember-me')?.checked!==false;rememberAuthSession=remember;
    signInGoogle(selectedRole,remember).then(()=>showToast('Signed in with Google.')).catch(error=>showToast(firebaseErrorMessage(error),'error'));
  }
  else if(action==='send-phone-otp'){
    if(!isFirebaseConfigured())return showToast('Phone OTP requires Firebase Authentication.','error');
    const input=document.getElementById('auth-phone');phoneDraft=String(input?.value||'').trim();authRole=document.getElementById('auth-role')?.value||authRole;
    const remember=document.getElementById('remember-me')?.checked!==false;rememberAuthSession=remember;
    if(!phoneDraft)return showToast('Enter your mobile number first.','warn');
    sendPhoneOtp(phoneDraft,authRole,remember,'auth-send-phone-otp').then(()=>{phoneOtpSent=true;renderAuthPage(authRole);showToast('Verification code sent. Enter the code to continue.');}).catch(error=>showToast(firebaseErrorMessage(error),'error'));
  }
  else if(action==='checkout-send-otp'){
    if(!isFirebaseConfigured())return showToast('Phone OTP requires Firebase Authentication.','error');
    const input=document.getElementById('checkout-phone');const phone=String(input?.value||'').trim();
    if(!phone)return showToast('Enter the delivery mobile number first.','warn');
    sendPhoneOtp(phone,'customer',false,'checkout-send-otp').then(()=>{
      checkoutOtpSent=true;verifiedCheckoutPhone='';
      const group=document.getElementById('checkout-otp-group');if(group)group.hidden=false;
      document.getElementById('checkout-otp')?.focus();
      showToast('Verification code sent. Enter it to verify your guest checkout phone.');
    }).catch(error=>showToast(firebaseErrorMessage(error),'error'));
  }
  else if(action==='checkout-confirm-otp'){
    if(!checkoutOtpSent)return showToast('Request a verification code first.','warn');
    const code=document.getElementById('checkout-otp')?.value||'';
    confirmPhoneOtp(code,'customer').then(credential=>{
      verifiedCheckoutPhone=credential.user.phoneNumber||'';
      firebaseSession={...(firebaseSession||{}),uid:credential.user.uid,name:credential.user.displayName||credential.user.phoneNumber,email:credential.user.email||'',phoneNumber:credential.user.phoneNumber||'',emailVerified:Boolean(credential.user.emailVerified),role:'customer',firebase:true};
      const group=document.getElementById('checkout-otp-group');if(group)group.hidden=true;
      const verifyButton=document.querySelector('[data-action="checkout-send-otp"]');if(verifyButton){verifyButton.disabled=true;verifyButton.textContent='✓ Phone verified';}
      const message=document.getElementById('checkout-verified-message');if(message)message.hidden=false;
      updateCartCount();
      showToast('Phone verified. You can place your order without setting a password.');
    }).catch(error=>showToast(firebaseErrorMessage(error),'error'));
  }
  else if(action==='confirm-phone-otp'){
    const code=document.getElementById('auth-otp')?.value||'';authRole='customer';
    confirmPhoneOtp(code,authRole).then(credential=>{firebaseSession={...(firebaseSession||{}),uid:credential.user.uid,name:credential.user.displayName||credential.user.phoneNumber,phoneNumber:credential.user.phoneNumber,email:credential.user.email||'',emailVerified:credential.user.emailVerified,role:credential.pashugharRole||authRole,firebase:true};showToast('Phone verified. Signed in successfully.');navigate((credential.pashugharRole||authRole)==='retailer'?'#seller':'#shop');}).catch(error=>showToast(firebaseErrorMessage(error),'error'));
  }
  else if(action==='auth-password-reset'){
    const email=document.getElementById('auth-email')?.value?.trim();if(!email)return showToast('Enter your email address first.','warn');
    resetEmailPassword(email).then(()=>showToast('Password reset email sent.')).catch(error=>showToast(firebaseErrorMessage(error),'error'));
  }
  else if(action==='send-email-verification'){
    sendVerificationEmail().then(sent=>showToast(sent===false?'Your email is already verified.':'Verification email sent. Check your inbox.')).catch(error=>showToast(firebaseErrorMessage(error),'error'));
  }
  else if(action==='refresh-verification'){
    refreshAuthUser().then(user=>{if(user)firebaseSession={...(firebaseSession||{}),emailVerified:user.emailVerified,phoneNumber:user.phoneNumber||''};renderAccount();showToast(isVerifiedContact(user)?'Contact verification confirmed.':'Verification is not detected yet.');}).catch(error=>showToast(firebaseErrorMessage(error),'error'));
  }
  else if(action==='retry-app'){window.location.reload();}
  else if(action==='toggle-theme'){applyTheme(document.body.dataset.theme==='dark'?'light':'dark',true);}
  else if(action==='google-signin'){if(!isFirebaseConfigured())return showToast('Firebase is not configured.','warn');signInGoogle(getRoute().path==='seller'?'retailer':'customer',document.getElementById('remember-me')?.checked!==false).then(()=>showToast('Signed in with Google.')).catch(error=>showToast(firebaseErrorMessage(error),'error'));}
  else if(action==='password-reset'){const prefix=getRoute().path==='admin'?'admin-login':'retailer-login';const email=document.getElementById(`${prefix}-email`)?.value?.trim();if(!email)return showToast('Enter your email address first, then select Forgot password.','warn');resetEmailPassword(email).then(()=>showToast('Password reset email sent.')).catch(error=>showToast(firebaseErrorMessage(error),'error'));}
  else if(action==='add-cart'){addToCart(id);}
  else if(action==='wishlist'){toggleWishlist(id);}
  else if(action==='remove-cart'){store.saveCart(store.cart().filter(i=>i.id!==id));renderCart();updateCartCount();showToast('Item removed from cart.');}
  else if(action==='cart-minus'){updateCartQty(id,-1);}
  else if(action==='cart-plus'){updateCartQty(id,1);}
  else if(action==='detail-add'){const qty=Math.max(1,Math.floor(Number(document.getElementById('detail-qty')?.value||1)));addToCart(id,qty);}
  else if(action==='set-product-image'){activeProductImageIndex=Math.max(0,Number(actionEl.dataset.index)||0);renderProduct(id);}
  else if(action==='zoom-product-image'){const p=getProduct(id);if(!p)return;const image=(Array.isArray(p.images)&&p.images.length?p.images:[p.image]).filter(Boolean)[activeProductImageIndex]||p.image;modalContent.innerHTML='<div class="modal-inner image-zoom-modal"><div class="modal-head"><h2>'+safe(p.name)+'</h2><button class="modal-close" data-action="close-modal" aria-label="Close">×</button></div><img src="'+safe(image)+'" width="1200" height="1200" alt="'+safe(p.name)+' enlarged image" loading="eager"></div>';showModalWithHistory();}
  else if(action==='report-product'){openReportForm(id);}
  else if(action==='share-product'){
    const p=getProduct(id);if(!p)return showToast('This listing is no longer available.','warn');
    const url=location.origin+location.pathname+'#product/'+encodeURIComponent(p.id);
    const text=encodeURIComponent(p.name+' · '+money(p.price)+' · '+url);
    if(actionEl.dataset.channel==='whatsapp'){window.open('https://wa.me/?text='+text,'_blank','noopener,noreferrer');}
    else if(actionEl.dataset.channel==='viber'){window.open('viber://forward?text='+text,'_blank','noopener,noreferrer');}
    else if(navigator.clipboard?.writeText){navigator.clipboard.writeText(url).then(()=>showToast('Product link copied.')).catch(()=>showToast('Could not copy automatically. Copy the URL from the address bar.','warn'));}
    else {const temp=document.createElement('textarea');temp.value=url;temp.style.position='fixed';temp.style.opacity='0';document.body.append(temp);temp.select();const ok=document.execCommand('copy');temp.remove();showToast(ok?'Product link copied.':'Copy the URL from the address bar.',ok?'':'warn');}
  }
  else if(action==='enquire-product'){openEnquiryForm(id);}
  else if(action==='retry-store'){renderPublicStore(id);}
  else if(action==='book-breeding'){openBreedingBookingForm(id);}
  else if(action==='edit-shop-registration'){const user=session();if(user)renderSellerSetup(user);}
  else if(action==='qty-minus'){const el=document.getElementById('detail-qty');if(el){const step=Number(el.step||1);el.value=Math.max(Number(el.min||1),Number(el.value)-step);}}
  else if(action==='qty-plus'){const el=document.getElementById('detail-qty');if(el){const step=Number(el.step||1);el.value=Math.min(Number(el.max),Number(el.value)+step);}}
  else if(action==='go-checkout'){renderCheckout();}
  else if(action==='toggle-filters'){activeShopFiltersVisible=!activeShopFiltersVisible;document.getElementById('filter-panel')?.classList.toggle('filters-open',activeShopFiltersVisible);}
  else if(action==='reset-filters'){activeShopCategory='';activeShopQuery='';activeShopStockOnly=false;activeShopSort='featured';activePriceMin='';activePriceMax='';activeProvince='';activeDistrict='';activeMunicipality='';activeShopPage=1;nearMeEnabled=false;shopperGeo=null;const searchBox=document.getElementById('search-input');if(searchBox)searchBox.value='';renderShop(new URLSearchParams());}
  else if(action==='search-suggestion'){const q=String(actionEl.dataset.query||'');const productId=actionEl.dataset.productId;if(productId){document.getElementById('search-suggestions')?.setAttribute('hidden','');navigate(publicProductUrl({id:productId}));return;}if(actionEl.dataset.category){activeShopCategory=actionEl.dataset.category;activeShopQuery='';activeShopPage=1;document.getElementById('search-suggestions')?.setAttribute('hidden','');navigate('#shop?category='+encodeURIComponent(activeShopCategory));return;}const box=document.getElementById('search-input');if(box)box.value=q;document.getElementById('search-suggestions')?.setAttribute('hidden','');activeShopPage=1;activeShopCategory='';if(!q){activeShopQuery='';activePriceMin='';activePriceMax='';activeProvince='';activeDistrict='';activeMunicipality='';activeShopStockOnly=false;activeShopSort='featured';nearMeEnabled=false;shopperGeo=null;navigate('#shop');return;}activeShopQuery=q;recordSearch(q);navigate('#shop?q='+encodeURIComponent(q));}
  else if(action==='set-category'){activeShopCategory=actionEl.dataset.category||'';activeShopQuery='';activeShopPage=1;navigate(activeShopCategory?'#shop?category='+encodeURIComponent(activeShopCategory):'#shop');}
  else if(action==='apply-price-filter'){const min=document.getElementById('price-min')?.value??'';const max=document.getElementById('price-max')?.value??'';if(min!==''&&Number(min)<0||max!==''&&Number(max)<0)return showToast('Prices cannot be negative.','warn');if(min!==''&&max!==''&&Number(min)>Number(max))return showToast('Minimum price must not exceed maximum price.','warn');activePriceMin=min;activePriceMax=max;activeShopPage=1;renderShop(new URLSearchParams());}
  else if(action==='page-listings'){activeShopPage=Math.max(1,Number(actionEl.dataset.page)||1);renderShop(new URLSearchParams());document.querySelector('.shop-toolbar')?.scrollIntoView({behavior:'smooth',block:'start'});}
  else if(action==='near-me'){if(!navigator.geolocation)return showToast('Geolocation is not available in this browser.','warn');if(locationPermissionRequested&&nearMeEnabled){nearMeEnabled=false;shopperGeo=null;activeShopSort='featured';renderShop(new URLSearchParams());return;}locationPermissionRequested=true;actionEl.disabled=true;actionEl.textContent='Finding location…';navigator.geolocation.getCurrentPosition(position=>{shopperGeo={lat:position.coords.latitude,lng:position.coords.longitude};nearMeEnabled=true;activeShopSort='nearest';activeShopPage=1;renderShop(new URLSearchParams());const located=activeProducts().filter(p=>Number.isFinite(productDistance(p))).length;if(!located)showToast('Your location is ready, but listings need latitude/longitude coordinates for distance sorting.','warn');else showToast('Near me enabled. Showing listings with location coordinates.');},error=>{showToast(error.code===1?'Location permission was denied. You can still filter by province, district and municipality.':'Could not get your location. Check device location settings.','warn');renderShop(new URLSearchParams());},{enableHighAccuracy:false,timeout:10000,maximumAge:300000});}
  else if(action==='open-demo-retailer'){navigate('#partner');}
  else if(action==='seller-new-product'){const user=session();if(user?.role!=='retailer')return showToast('Sign in to the retailer workspace first.','warn');const profile=retailerProfile(user);if(!profile)return renderSellerSetup(user);if(profile.status!=='approved')return renderRetailerVerificationState(user,profile);openProductForm();}
  else if(action==='edit-product'){const p=getProduct(id);if(p&&p.retailerId===session()?.uid)openProductForm(p);else if(p&&session()?.uid==='demo-retailer'&&p.retailerId==='retailer-demo')openProductForm(p);else showToast('You can only edit your own listings.','error');}
  else if(action==='delete-product'){const p=getProduct(id);if(!p)return;const user=session();if(!(p.retailerId===user?.uid||(user?.uid==='demo-retailer'&&p.retailerId==='retailer-demo')))return showToast('You can only remove your own listings.','error');if(!confirm(`Remove “${p.name}” from ${isFirebaseConfigured()?'the marketplace':'your demo catalogue'}?`))return;const saveResult=store.saveProducts(allProducts().filter(x=>x.id!==id));if(isFirebaseConfigured()){showToast('Removing listing…');Promise.resolve(saveResult).then(()=>{renderSellerDashboard();showToast('Listing removed.');}).catch(()=>{});}else{renderSellerDashboard();showToast('Listing removed from this browser.');}}
  else if(action==='close-modal'){closeModal();}
  else if(action==='remove-product-image'){const index=Number(actionEl.dataset.index);const src=currentProductImages[index];if(src&&String(src).startsWith('data:'))currentProductImages=currentProductImages.filter((x,i)=>i!==index);else if(src){const field=document.getElementById('pf-image-urls');if(field){const lines=field.value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);const urlIndex=currentProductImages.slice(0,index).filter(x=>!String(x).startsWith('data:')).length;lines.splice(urlIndex,1);field.value=lines.join('\n');}currentProductImages=currentProductImages.filter((x,i)=>i!==index);}renderProductImagePreview();}
  else if(action==='seller-tab'){sellerTab=actionEl.dataset.tab;renderSellerDashboard();}
  else if(action==='pause-product'||action==='resume-product'){
    const p=getProduct(id);const user=session();
    if(!p||!(p.retailerId===user?.uid||(user?.uid==='demo-retailer'&&p.retailerId==='retailer-demo')))return showToast('You can only manage your own listings.','error');
    const nextStatus=action==='pause-product'?'paused':(isFirebaseConfigured()?'pending':'approved');
    const changed={...p,status:nextStatus,updatedAt:new Date().toISOString()};
    const all=allProducts().map(x=>x.id===id?changed:x);
    Promise.resolve(store.saveProducts(all)).then(()=>{renderSellerDashboard();showToast(nextStatus==='paused'?'Listing paused. It is hidden from the marketplace.':(isFirebaseConfigured()?'Listing sent for re-approval.':'Listing resumed and published.'));}).catch(()=>showToast('Listing status could not be changed. Check Firestore rules and retry.','error'));
  }
  else if(action==='retailer-order-action'){retailerOrderAction(id,actionEl.dataset.status);}
  else if(action==='booking-status'){updateBreedingBookingStatus(id,actionEl.dataset.status).then(()=>showToast('Breeding request updated.')).catch(error=>showToast(error.message||firebaseErrorMessage(error),'error'));}
  else if(action==='admin-tab'){adminTab=actionEl.dataset.tab;renderAdmin();}
  else if(action==='admin-retailer-filter'){document.querySelectorAll('[data-action="admin-retailer-filter"]').forEach(b=>b.classList.toggle('active',b===actionEl));const filter=actionEl.dataset.filter;document.querySelectorAll('[data-admin-retailer-row]').forEach(row=>{row.hidden=!(filter==='all'||(filter==='pending'&&row.dataset.retailerStatus==='pending')||row.dataset.retailerType===filter);});}
  else if(action==='admin-new-product'||action==='admin-edit-product'){
    const user=session();if(!user||user.role!=='admin')return showToast('Administrator access required.','error');
    const product=action==='admin-edit-product'?allProducts().find(p=>p.id===id):null;
    if(action==='admin-edit-product'&&!product)return showToast('Product was not found.','warn');
    modalContent.innerHTML=renderAdminProductForm(product,store.retailers());showModalWithHistory();
  }
  else if(action==='approve-product'||action==='reject-product'){
    const product=allProducts().find(p=>p.id===id);if(!product)return showToast('Product was not found.','warn');
    const decision=action==='approve-product'?'approved':'rejected';
    if(decision==='rejected'&&!confirm('Reject listing "'+product.name+'"? It will remain hidden from shoppers.'))return;
    moderateProductDirect({productId:id,decision,reason:decision==='approved'?'Approved by admin from moderation queue':'Rejected by admin from moderation queue'})
      .then(()=>{showToast(decision==='approved'?'Listing approved and published.':'Listing rejected.');renderAdmin();})
      .catch(error=>showToast(firebaseErrorMessage(error),'error'));
  }
  else if(action==='suspend-product'||action==='restore-product'||action==='admin-remove-product'){
    if(isFirebaseConfigured()){if(action==='admin-remove-product'&&!confirm('Permanently remove this listing? Report history will remain.'))return;const p=getProduct(id);if(!p)return;const operation=action==='admin-remove-product'?removeProductDirect({productId:id}):moderateProductDirect({productId:id,decision:action==='suspend-product'?'suspended':'approved',reason:'Admin action from Pashughar dashboard'});operation.then(()=>{showToast(action==='admin-remove-product'?'Product removed.':action==='suspend-product'?'Product suspended.':'Product restored.');renderAdmin();}).catch(error=>showToast(firebaseErrorMessage(error),'error'));return;}
    const products=allProducts();const p=products.find(x=>x.id===id);if(!p)return;
    if(action==='admin-remove-product'){
      if(!confirm(`Permanently remove “${p.name}” from this demo catalogue? Report history will remain.`))return;
      store.saveProducts(products.filter(x=>x.id!==id));
      renderAdmin();showToast('Product removed from the demo catalogue.');
    } else {
      p.status=action==='suspend-product'?'suspended':'approved';p.adminActionAt=new Date().toISOString();store.saveProducts(products);renderAdmin();showToast(action==='suspend-product'?'Product suspended.':'Product restored.');
    }
  }
  else if(action==='verify-retailer'||action==='reject-retailer'||action==='suspend-retailer'||action==='reinstate-retailer'||action==='ban-retailer'){
    if(isFirebaseConfigured()){const r=store.retailers().find(x=>x.id===id);if(!r)return;const decision=action==='verify-retailer'||action==='reinstate-retailer'?'approved':action==='reject-retailer'?'rejected':action==='suspend-retailer'?'suspended':'banned';if(action==='ban-retailer'&&!confirm(`Remove / ban ${r.storeName}? Its listing history will be retained.`))return;moderateRetailerDirect({retailerId:r.ownerId||r.id,decision,reason:'Admin action from Pashughar dashboard'}).then(()=>{showToast(`Shop status changed to ${decision}.`);renderAdmin();}).catch(error=>showToast(firebaseErrorMessage(error),'error'));return;}
    const retailers=store.retailers();const r=retailers.find(x=>x.id===id);if(!r)return;
    let next=r.status;
    if(action==='verify-retailer')next='approved';
    else if(action==='reject-retailer')next='rejected';
    else if(action==='suspend-retailer')next='suspended';
    else if(action==='reinstate-retailer')next='approved';
    else if(action==='ban-retailer')next='banned';
    if(action==='ban-retailer'&&!confirm(`Remove / ban ${r.storeName}? Its listings will be hidden, but the history will remain.`))return;
    r.status=next;r.updatedAt=new Date().toISOString();
    const products=allProducts().map(p=>{
      const linked=p.retailerId===r.ownerId||p.retailerId===r.id;
      if(!linked)return p;
      if(['suspended','banned','rejected'].includes(next)&&p.status==='approved')return {...p,status:'suspended',suspensionCause:'retailer'};
      if(next==='approved'&&p.status==='suspended'&&p.suspensionCause==='retailer'){const copy={...p,status:'approved'};delete copy.suspensionCause;return copy;}
      return p;
    });
    store.saveRetailers(retailers);store.saveProducts(products);renderAdmin();showToast(next==='approved'?'Shop verified. Retailer can now publish products directly.':`Shop status changed to ${next}.`);
  }
  else if(action==='review-report'||action==='resolve-report'||action==='dismiss-report'){
    if(isFirebaseConfigured()){const decision=action==='review-report'?'reviewing':action==='resolve-report'?'resolved':'dismissed';const resolutionNote=action==='dismiss-report'?(prompt('Optional reason for dismissing this report:','Insufficient evidence / duplicate report')||'Dismissed by admin'):action==='resolve-report'?(prompt('Resolution note (optional):','Reviewed and actioned')||'Reviewed and actioned'):'';callCloudFunction('moderateReport',{reportId:id,decision,resolutionNote},`Report marked ${decision}.`).then(()=>renderAdmin()).catch(()=>{});return;}
    const reports=store.reports();const report=reports.find(r=>r.id===id);if(!report)return;
    report.status=action==='review-report'?'reviewing':action==='resolve-report'?'resolved':'dismissed';report.updatedAt=new Date().toISOString();report.reviewedBy='demo-admin';
    if(action==='dismiss-report'){report.resolutionNote=prompt('Optional reason for dismissing this report:','Insufficient evidence / duplicate report')||'Dismissed by admin';}
    else if(action==='resolve-report'){report.resolutionNote=prompt('Resolution note (optional):','Reviewed and actioned')||'Reviewed and actioned';}
    store.saveReports(reports);renderAdmin();showToast(`Report marked ${report.status}.`);
  }
  else if(action==='suspend-reported-product'){
    if(isFirebaseConfigured()){moderateProductDirect({productId:id,decision:'suspended',reason:'Suspended following customer report; review separately'}).then(()=>{showToast('Reported product suspended.');renderAdmin();}).catch(error=>showToast(firebaseErrorMessage(error),'error'));return;}
    const products=allProducts();const p=products.find(x=>x.id===id);if(!p)return showToast('The product may already have been removed.','warn');p.status='suspended';p.suspensionCause='admin-report';p.adminActionAt=new Date().toISOString();store.saveProducts(products);renderAdmin();showToast('Reported product suspended and hidden from shoppers.');
  }
  else if(action==='suspend-reported-retailer'){
    if(isFirebaseConfigured()){moderateRetailerDirect({retailerId:id,decision:'suspended',reason:'Suspended following customer report; review separately'}).then(()=>{showToast('Retailer suspended.');renderAdmin();}).catch(error=>showToast(firebaseErrorMessage(error),'error'));return;}
    const retailers=store.retailers();const r=retailers.find(x=>x.ownerId===id||x.id===id);if(!r)return showToast('No retailer profile found for this listing.','warn');r.status='suspended';r.updatedAt=new Date().toISOString();const products=allProducts().map(p=>{if((p.retailerId===r.ownerId||p.retailerId===r.id)&&p.status==='approved')return {...p,status:'suspended',suspensionCause:'retailer'};return p;});store.saveRetailers(retailers);store.saveProducts(products);renderAdmin();showToast('Retailer suspended; their listings are hidden.');
  }
  else if(action==='report-filter'){activeReportFilter=actionEl.dataset.filter||'open';renderAdmin();}
  else if(action==='filter-retailer-reports'){const retailerId=actionEl.dataset.retailerId;activeReportFilter='open';renderAdmin();document.querySelectorAll('.report-card').forEach(card=>{card.hidden=card.dataset.retailerId!==retailerId;});}
  else if(action==='admin-list-filter'){document.querySelectorAll('[data-action="admin-list-filter"]').forEach(b=>b.classList.toggle('active',b===actionEl));document.querySelectorAll('#admin-products-body tr').forEach(row=>row.hidden=actionEl.dataset.filter!=='all'&&row.dataset.productStatus!==actionEl.dataset.filter);}
  else if(action==='signout'){endDemoSession();firebaseSession=null;clearTimeout(inactivityTimer);navigate('#home');showToast('You have signed out.');}
  else if(action==='reset-demo'){if(confirm('Reset all locally saved Pashughar demo data to the original sample state?')){store.resetDemo();sellerTab='products';adminTab='products';renderAdmin();showToast('Demo data reset.');}}
});

document.addEventListener('input', e => {
  if(e.target.id==='search-input') renderSearchSuggestionItems(e.target.value);
});
document.addEventListener('focusin', e => {
  if(e.target.id==='search-input' && e.target.value.trim())renderSearchSuggestionItems(e.target.value);
});
document.addEventListener('keydown', e => {
  if(e.target.id==='search-input'&&e.key==='Escape')document.getElementById('search-suggestions')?.setAttribute('hidden','');
  if(e.target.id==='search-input'&&e.key==='ArrowDown'){
    const first=document.querySelector('#search-suggestions .search-suggestion-item');
    if(first){e.preventDefault();first.focus();}
  }
  if(e.target.matches('.detail-image[data-action="zoom-product-image"]')&&(e.key==='Enter'||e.key===' ')){
    e.preventDefault();e.target.click();
  }
});
document.addEventListener('change',async e=>{
  const el=e.target;
  if(el.id==='pf-images'){
    if(isFirebaseConfigured()){showToast('Firebase Storage is disabled. Add HTTPS image URLs instead.','warn');el.value='';return;}
    const files=Array.from(el.files||[]);if(!files.length)return;const currentLocal=currentProductImages.filter(x=>String(x).startsWith('data:'));const currentUrls=(document.getElementById('pf-image-urls')?.value||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);const remaining=Math.max(0,5-currentUrls.length-currentLocal.length);if(files.length>remaining){showToast(`You can add only ${remaining} more image(s).`,'warn');el.value='';return;}try{for(const file of files){const resized=await shrinkImage(file);currentProductImages.push(resized);}currentProductImages=currentProductImages.slice(-5);renderProductImagePreview();showToast('Product photo(s) added and compressed.');}catch(error){showToast(error.message||'Could not process that image.','error');}el.value='';return;
  }
  if(el.id==='pf-image-urls'){renderProductImagePreview();return;}
  if(el.id==='pf-unit'){const stock=document.getElementById('pf-stock');if(stock)stock.step=['kg','litre'].includes(String(el.value).toLowerCase())?'0.5':'1';return;}
  if(el.name==='category-filter'){activeShopCategory=el.value;activeShopPage=1;renderShop(new URLSearchParams());}
  else if(el.id==='stock-filter'){activeShopStockOnly=el.checked;activeShopPage=1;renderShop(new URLSearchParams());}
  else if(el.id==='province-filter'){activeProvince=el.value;activeDistrict='';activeMunicipality='';activeShopPage=1;renderShop(new URLSearchParams());}
  else if(el.id==='district-filter'){activeDistrict=el.value;activeMunicipality='';activeShopPage=1;renderShop(new URLSearchParams());}
  else if(el.id==='municipality-filter'){activeMunicipality=el.value;activeShopPage=1;renderShop(new URLSearchParams());}
  else if(el.id==='sort-select'){activeShopSort=el.value;activeShopPage=1;renderShop(new URLSearchParams());}
  else if(el.matches('[data-action="retailer-order-status"]')){
    if(isFirebaseConfigured()){updateRetailerOrderStatusDirect({retailerOrderId:el.dataset.id,status:el.value}).then(()=>{showToast('Order status updated.');}).catch(error=>{showToast(error.message||firebaseErrorMessage(error),'error');renderSellerDashboard();});}
    else {const orders=store.orders();const order=orders.find(o=>o.id===el.dataset.id);if(order){order.status=el.value;store.saveOrders(orders);showToast('Order status updated in demo.');}}
  }
});

document.addEventListener('submit',e=>{
  const form=e.target;
  if(form.id==='admin-product-form'){
    e.preventDefault();const button=form.querySelector('button[type="submit"]');if(button){button.disabled=true;button.textContent='Saving product…';}
    saveAdminProductFromForm(form).then(result=>{closeModal();adminTab='products';renderAdmin();showToast(result.created?'Product created and queued for approval.':'Product changes saved.');}).catch(error=>{if(button){button.disabled=false;button.textContent='Save product';}showToast(firebaseErrorMessage(error),'error');});
  } else if(form.id==='global-search'){
    e.preventDefault();const q=String(document.getElementById('search-input').value||'').trim();activeShopQuery=q;activeShopCategory='';activeShopPage=1;recordSearch(q);document.getElementById('search-suggestions')?.setAttribute('hidden','');navigate(`#shop?q=${encodeURIComponent(q)}`);
  } else if(form.id==='product-review-form'){
    e.preventDefault();const fd=new FormData(form);const button=form.querySelector('button[type="submit"]');if(button){button.disabled=true;button.textContent='Submitting review…';}
    submitProductReview({productId:form.dataset.productId,orderId:String(fd.get('orderId')||''),rating:Number(fd.get('rating')),body:String(fd.get('body')||'')})
      .then(()=>{showToast('Review published. Thank you for sharing verified purchase feedback.');loadProductReviews(form.dataset.productId,true);})
      .catch(error=>{if(button){button.disabled=false;button.textContent='Submit review';}showToast(firebaseErrorMessage(error),'error');});
  } else if(form.id==='product-enquiry-form'){
    e.preventDefault();const fd=new FormData(form);const submit=form.querySelector('button[type="submit"]');if(submit)submit.disabled=true;
    createProductEnquiry({productId:form.dataset.productId,productName:form.dataset.productName,retailerId:form.dataset.retailerId,customerName:String(fd.get('customerName')||''),customerPhone:String(fd.get('customerPhone')||''),message:String(fd.get('message')||'')})
      .then(()=>{closeModal();showToast('Enquiry sent to the retailer.');})
      .catch(error=>{if(submit)submit.disabled=false;showToast(firebaseErrorMessage(error),'error');});
  } else if(form.classList.contains('enquiry-reply-form')){
    e.preventDefault();const fd=new FormData(form);const submit=form.querySelector('button[type="submit"]');if(submit)submit.disabled=true;
    replyToEnquiry(form.dataset.enquiryId,String(fd.get('reply')||'')).then(()=>{showToast('Reply sent to customer.');renderSellerDashboard();}).catch(error=>{if(submit)submit.disabled=false;showToast(firebaseErrorMessage(error),'error');});
  } else if(form.id==='bulk-price-form'){
    e.preventDefault();const fd=new FormData(form);const scope=String(fd.get('scope')||'all');const mode=String(fd.get('mode')||'set');const value=Number(fd.get('value'));
    const user=session();const list=allProducts();const own=list.filter(p=>(p.retailerId===user?.uid||(user?.uid==='demo-retailer'&&p.retailerId==='retailer-demo'))&&(scope==='all'||normalizeCategoryId(p.category)===scope));
    if(!own.length)return showToast('There are no matching listings for this bulk update.','warn');
    if(!Number.isFinite(value)||(mode==='percent'&&(value < -100||value>100))||(mode==='set'&&value<=0))return showToast('Enter a valid price or percentage change.','warn');
    const updated=own.map(p=>{const next=mode==='set'?value:Number(p.price)*(1+value/100);return {...p,price:Math.round(next*100)/100,updatedAt:new Date().toISOString()};});
    if(updated.some(p=>p.price<=0||p.price>100000000))return showToast('The change would create an invalid price. No listing was changed.','error');
    const count=updated.length;const description=mode==='set'?'set price for '+count+' listing(s)':'change prices on '+count+' listing(s) by '+value+'%';
    if(!confirm('Confirm bulk update: '+description+'?'))return;
    const replacements=new Map(updated.map(p=>[p.id,p]));const save=store.saveProducts(list.map(p=>replacements.get(p.id)||p));
    Promise.resolve(save).then(()=>{renderSellerDashboard();showToast('Bulk price update saved.');}).catch(()=>showToast('The bulk price update failed. Check retailer permissions and retry.','error'));
  } else if(form.id==='auth-email-form'){
    e.preventDefault();
    const fd=new FormData(form);const email=String(fd.get('email')||'').trim();const password=String(fd.get('password')||'');
    authRole='customer';const remember=document.getElementById('remember-me')?.checked!==false;
    if(!email||!password)return showToast('Enter your email and password.','warn');
    if(!isFirebaseConfigured())return showToast('Connect Firebase Authentication before creating real accounts.','error');
    const operation=authMode==='signup'?createEmailAccount(email,password,authRole,remember):signInEmail(email,password,authRole,remember);
    operation.then(()=>{if(authMode==='signup'){showToast('Account created. Check your email for a verification link.');navigate('#account');}else showToast('Signed in successfully.');}).catch(error=>showToast(firebaseErrorMessage(error),'error'));
  } else if(form.id==='auth-phone-form'){e.preventDefault();}
  else if(form.id==='retailer-login-form'||form.id==='admin-login-form'){
    e.preventDefault();const fd=new FormData(form);
    if(isFirebaseConfigured()){
      const email=String(fd.get('email')||'').trim();const password=String(fd.get('password')||'');const mode=String(e.submitter?.value||fd.get('authMode')||'signin');
      if(!email||!password)return showToast('Enter your email and password.','warn');
      const role=form.id==='retailer-login-form'?'retailer':'customer';const remember=document.getElementById('remember-me')?.checked!==false;const operation=mode==='signup'?createEmailAccount(email,password,role,remember):signInEmail(email,password,role,remember);
      operation.then(()=>showToast(mode==='signup'?'Account created. Complete shop registration next.':'Signed in successfully.')).catch(error=>showToast(firebaseErrorMessage(error),'error'));
      return;
    }
    const username=String(fd.get('username')||'');const password=String(fd.get('password')||'');
    if(form.id==='retailer-login-form'){
      if(username!=='retailer'||password!=='retailer')return showToast('Incorrect retailer ID or password.','error');
      const profile=store.retailers().find(r=>r.ownerId==='demo-retailer'||r.email==='retailer@pashughar.demo')||{};
      store.saveSession({uid:'demo-retailer',name:profile.contactName||'Demo Retailer',email:profile.email||'retailer@pashughar.demo',role:'retailer',demoAccessVersion:2,storeName:profile.storeName||'',storeSetupComplete:Boolean(profile.storeName),storePhone:profile.phone||'',storeLocation:profile.location||'',storeDescription:profile.description||'',storeStatus:profile.status||'pending'});
      render();showToast(profile.storeName?(profile.status==='approved'?'Welcome back to your verified shop.':'Your shop is awaiting admin verification.'):'Sign in complete. Register your shop to request verification.');
      return;
    }
    if(username!=='admin'||password!=='admin')return showToast('Incorrect administrator ID or password.','error');
    store.saveSession({uid:'demo-admin',name:'Pashughar Admin',email:'admin@pashughar.demo',role:'admin',demoAccessVersion:2});render();showToast('Admin demo session opened.');
  } else if(form.id==='retailer-profile-form'){
    e.preventDefault();const fd=new FormData(form);const user=session();if(!user||user.role!=='retailer')return showToast('Please sign in as a retailer.','error');
    let storeName=String(fd.get('storeName')||'').trim();let contactName=String(fd.get('contactName')||'').trim();const phone=String(fd.get('phone')||'').trim();let email=String(fd.get('email')||'').trim();const location=String(fd.get('location')||'').trim();const description=String(fd.get('description')||'').trim();
    const retailers=store.retailers();const existing=retailers.find(r=>r.ownerId===user.uid||r.email?.toLowerCase()===email.toLowerCase());
    if(isFirebaseConfigured()&&existing){storeName=existing.storeName;contactName=existing.contactName;email=existing.email;}
    if(!storeName||!contactName||!phone||!email||!location)return showToast('Complete shop name, contact name, phone, email and location.','error');
    const changedIdentity=existing&&(['storeName','contactName','phone','email','location'].some(k=>String(existing[k]||'').trim()!==String(({storeName,contactName,phone,email,location})[k]||'').trim()));
    let status=existing?.status||'pending';
    if(!existing)status='pending';
    if(isFirebaseConfigured()&&existing&&status==='rejected')return showToast('This application was rejected. Contact Pashughar support to request another review.','warn');
    if(existing&&status==='approved'&&changedIdentity&&!isFirebaseConfigured()){status='pending';showToast('Shop contact details changed. Please wait for re-verification.','warn');}
    const record={...(existing||{}),id:isFirebaseConfigured()?user.uid:(existing?.id||slugId()),ownerId:user.uid,storeName,contactName,email,phone,location,description,status,createdAt:existing?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
    Object.assign(user,{name:contactName,email,storeName,storeSetupComplete:true,storePhone:phone,storeLocation:location,storeDescription:description,storeStatus:status});if(!isFirebaseConfigured())store.saveSession(user);
    const saveResult=store.saveRetailers(existing?retailers.map(r=>r.id===existing.id?record:r):[record,...retailers]);
    if(isFirebaseConfigured()){
      showToast('Submitting shop details…');
      Promise.resolve(saveResult).then(()=>{renderSellerDashboard();showToast(status==='approved'?'Shop profile saved.':'Shop submitted for admin verification.');}).catch(()=>{});
    } else {renderSellerDashboard();showToast(status==='approved'?'Shop profile saved.':'Shop submitted for admin verification.');}
  } else if(form.id==='product-form'){
    e.preventDefault();submitProduct(form);
  } else if(form.id==='breeding-booking-form'){
    e.preventDefault();
    const fd=new FormData(form);
    const submit=form.querySelector('button[type="submit"]'); if(submit) submit.disabled=true;
    createBreedingBooking({
      productId:form.dataset.productId, productName:form.dataset.productName, retailerId:form.dataset.retailerId,
      requestedDate:String(fd.get('requestedDate')||''), customerName:String(fd.get('customerName')||''),
      customerPhone:String(fd.get('customerPhone')||''), location:String(fd.get('location')||''), note:String(fd.get('note')||'')
    }).then(()=>{closeModal();showToast('Breeding date request sent to the retailer.');}).catch(error=>{if(submit)submit.disabled=false;showToast(error.message||firebaseErrorMessage(error),'error');});
  } else if(form.id==='report-form'){
    e.preventDefault();submitReport(form);
  } else if(form.id==='checkout-form'){
    e.preventDefault();submitCheckout(form);
  } else if(form.id==='seller-profile-form'){
    e.preventDefault();const fd=new FormData(form);const user=session();if(!user||user.role!=='retailer')return showToast('Sign in as a retailer first.','error');
    let storeName=String(fd.get('storeName')||'').trim();let contactName=String(fd.get('contactName')||'').trim();const phone=String(fd.get('phone')||'').trim();let email=String(fd.get('email')||'').trim();const location=String(fd.get('location')||'').trim();const description=String(fd.get('description')||'').trim();
    const publicPhone=String(fd.get('publicPhone')||'').trim();const publicEmail=String(fd.get('publicEmail')||'').trim();const website=String(fd.get('website')||'').trim();const openingHours=String(fd.get('openingHours')||'').trim();const vetSpecialties=String(fd.get('vetSpecialties')||'').split(',').map(x=>x.trim()).filter(Boolean).slice(0,20);const vetAvailability=String(fd.get('vetAvailability')||'').trim();const consultationFee=Math.max(0,Number(fd.get('consultationFee')||0));const isVet=fd.get('isVet')==='on';const verificationDocs=String(fd.get('verificationDocs')||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
    if(website && !/^https:\/\//i.test(website))return showToast('Website must use an HTTPS URL.','warn');if(verificationDocs.length>5||verificationDocs.some(url=>{try{return new URL(url).protocol!=='https:';}catch{return true;}}))return showToast('Add up to five valid HTTPS document links.','warn');
    const retailers=store.retailers();const existing=retailerProfile(user);if(!existing)return renderSellerSetup(user);
    if(isFirebaseConfigured()){storeName=existing.storeName;contactName=existing.contactName;email=existing.email;}
    if(!storeName||!contactName||!phone||!email||!location)return showToast('Complete all required shop details.','error');
    const changed=['storeName','contactName','phone','email','location'].some(k=>String(existing[k]||'').trim()!==String(({storeName,contactName,phone,email,location})[k]||'').trim());
    const nextStatus=isFirebaseConfigured()?existing.status:(changed&&existing.status==='approved'?'pending':existing.status);
    const record={...existing,storeName,contactName,phone,email,location,description,publicPhone,publicEmail,website,openingHours,vetSpecialties,vetAvailability,consultationFee,isVet,verificationDocs,status:nextStatus,updatedAt:new Date().toISOString()};
    const saveResult=store.saveRetailers(retailers.map(r=>r.id===existing.id?record:r));
    Object.assign(user,{name:contactName,email,storeName,storePhone:phone,storeLocation:location,storeDescription:description,storeStatus:nextStatus});if(!isFirebaseConfigured())store.saveSession(user);
    if(isFirebaseConfigured()){
      showToast('Saving shop profile…');
      Promise.resolve(saveResult).then(()=>{renderSellerDashboard();showToast(nextStatus==='pending'&&changed?'Shop details changed and need re-verification.':'Shop profile saved.');}).catch(()=>{});
    } else {renderSellerDashboard();showToast(nextStatus==='pending'&&changed?'Shop details changed and need re-verification.':'Shop profile saved.');}
  }
});

document.addEventListener('click', e => {
  const link=e.target.closest('a[href^="#"]');
  if(!link || e.defaultPrevented || e.button!==0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || link.target==='_blank')return;
  const href=link.getAttribute('href');
  if(!href || href==='#')return;
  e.preventDefault(); navigate(href);
}, true);
document.getElementById('menu-toggle')?.addEventListener('click',()=>{
  const nav=document.getElementById('main-nav');
  const open=!nav.classList.contains('open');
  if(open)history.pushState({... (history.state||{}),pashugharOverlay:'menu',pashugharScrollY:window.scrollY},'',location.href);
  else if(history.state?.pashugharOverlay==='menu'){nav.classList.remove('open');document.getElementById('menu-toggle').setAttribute('aria-expanded','false');history.back();return;}
  nav.classList.toggle('open',open);document.getElementById('menu-toggle').setAttribute('aria-expanded',String(open));
});
window.addEventListener('popstate',event=>{
  const nav=document.getElementById('main-nav');
  if(nav?.classList.contains('open')){nav.classList.remove('open');document.getElementById('menu-toggle')?.setAttribute('aria-expanded','false');return;}
  if(modalHistoryActive && (modal.open || modal.hasAttribute('open'))){modalHistoryActive=false;if(modal.open)modal.close();else modal.removeAttribute('open');return;}
  modalHistoryActive=false;render();
  const y=Number(event.state?.pashugharScrollY);
  requestAnimationFrame(()=>window.scrollTo({top:Number.isFinite(y)?y:0,behavior:'auto'}));
});
const backToTopButton = document.getElementById('back-to-top');
const readScrollTop = () => Math.max(
  Number(window.scrollY) || 0,
  Number(document.documentElement?.scrollTop) || 0,
  Number(document.body?.scrollTop) || 0
);
const updateBackToTopVisibility = () => {
  backToTopButton?.classList.toggle('visible', readScrollTop() > 500);
};
window.addEventListener('scroll',()=>{
  const scrollTop = readScrollTop();
  try{history.replaceState({... (history.state||{}),pashugharRoute:location.hash||location.pathname,pashugharScrollY:scrollTop},'',location.href);}catch{}
  updateBackToTopVisibility();
},{passive:true});
document.addEventListener('scroll',updateBackToTopVisibility,{passive:true,capture:true});
window.addEventListener('pageshow',updateBackToTopVisibility);
window.addEventListener('resize',updateBackToTopVisibility,{passive:true});
backToTopButton?.addEventListener('click',()=>window.scrollTo({top:0,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'}));
updateBackToTopVisibility();
modal?.addEventListener('click',e=>{if(e.target===modal)closeModal();});
modal?.addEventListener('cancel',e=>{e.preventDefault();closeModal();});
document.getElementById('year').textContent=new Date().getFullYear();
initializeTheme();
try{history.replaceState({... (history.state||{}),pashugharRoute:location.hash||location.pathname,pashugharScrollY:window.scrollY},'',location.href);}catch{}
window.addEventListener('pashughar:cloud-error', event => {
  const detail=event.detail||{};
  showToast(firebaseErrorMessage({code:detail.code,message:detail.message}), 'error');
  let notice=document.getElementById('cloud-error-retry');
  if(!notice){notice=document.createElement('div');notice.id='cloud-error-retry';notice.className='cloud-error-banner';notice.setAttribute('role','alert');notice.innerHTML='<strong>Some live data could not be loaded.</strong><span>Check your connection or Firebase permissions, then retry.</span><button type="button" class="button button-secondary" data-action="retry-app">Retry</button>';app.prepend(notice);}
});
['pointerdown','keydown','touchstart','mousemove'].forEach(type=>document.addEventListener(type,()=>{if(session())resetAutoLogoutTimer();},{passive:true}));
window.addEventListener('pashughar:cloud-updated', event => {
  if(event.detail?.name==='products')catalogueLoaded=true;
  if(getRoute().path==='cart'&&document.getElementById('checkout-form')){updateCartCount();return;}
  const active=document.activeElement;
  if(active && ['INPUT','TEXTAREA','SELECT'].includes(active.tagName)) return;
  render();
});
applySiteSettings();
render();
if(isFirebaseConfigured()) {
  startFirebaseBridge({onSessionChanged: next => {
    authStateReady = true;
    firebaseSession = next;
    if(next)resetAutoLogoutTimer();else clearTimeout(inactivityTimer);
    if (next && next.role === 'admin' && getRoute().path !== 'admin') { navigate('#admin'); return; }
    if(next && (['login','seller'].includes(getRoute().path)||authGateActive)){
      authGateActive=false;
      if(next.role==='retailer')navigate('#dashboard');
      else if(next.role==='customer')navigate('#shop');
      else navigate('#admin');
      return;
    }
    if(getRoute().path==='admin' && next && next.role!=='admin') showToast('This account is not authorized for the admin panel.','warn');
    if(getRoute().path==='cart'&&document.getElementById('checkout-form')){updateCartCount();return;}
    render();
  }});
}
