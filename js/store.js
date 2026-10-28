const STORAGE_KEYS = {
  products: 'pashughar.products.v1',
  cart: 'pashughar.cart.v1',
  orders: 'pashughar.orders.v1',
  session: 'pashughar.demoSession.v1',
  wishlist: 'pashughar.wishlist.v1',
  retailers: 'pashughar.retailers.v1',
  reports: 'pashughar.reports.v1',
  breedingBookings: 'pashughar.breedingBookings.v1'
};

let persistenceAdapter = null;
export const configurePersistenceAdapter = adapter => { persistenceAdapter = adapter || null; };
const persistCloud = (type, previous, next) => {
  if (!persistenceAdapter || typeof persistenceAdapter[type] !== 'function') return Promise.resolve();
  try { return Promise.resolve(persistenceAdapter[type](previous, next)); }
  catch (error) { return Promise.reject(error); }
};

const image = (id, width = 700) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=${width}&q=82`;
const SEEDED_PRODUCTS = [
  {id:'pg-101',name:'Fresh chicken, whole',category:'meat',price:520,unit:'kg',stock:18,description:'Fresh whole chicken supplied by a local poultry retailer. Store chilled and prepare thoroughly before consumption.',location:'Pokhara, Gandaki',retailer:'Green Valley Poultry',retailerId:'retailer-demo',status:'approved',createdAt:'2026-10-20T08:00:00.000Z',condition:'Fresh',attributes:{packaging:'Whole bird',storage:'Keep refrigerated'},image:image('photo-1604503468506-a8da13d82791')},
  {id:'pg-102',name:'Premium goat meat',category:'meat',price:980,unit:'kg',stock:0,description:'A sample goat meat listing. Contact the seller for current cuts, availability and collection or delivery arrangements.',location:'Lakeside, Pokhara',retailer:'Himalayan Meat House',retailerId:'retailer-demo',status:'approved',createdAt:'2026-10-19T08:00:00.000Z',condition:'Fresh',attributes:{cut:'Mixed cuts',storage:'Keep refrigerated'},image:image('photo-1607623814075-e51df1bdc82f')},
  {id:'pg-103',name:'Healthy dairy cow',category:'livestock',price:145000,unit:'animal',stock:2,description:'Live cattle listing for a healthy dairy cow. Buyers should verify animal health, ownership, age and transport arrangements directly with the seller before purchase.',location:'Lekhnath, Pokhara',retailer:'Annapurna Livestock Farm',retailerId:'retailer-demo',status:'approved',createdAt:'2026-10-18T08:00:00.000Z',condition:'Live animal',attributes:{breed:'Local cross',age:'3 years',sex:'Female'},image:image('photo-1516467508483-a7212febe31a')},
  {id:'pg-104',name:'Friendly family dog',category:'pets-supplies',price:18000,unit:'animal',stock:1,description:'Sample pet listing. Meet the animal and verify health records, age, vaccinations, ownership and local requirements before completing a transaction.',location:'New Road, Pokhara',retailer:'Happy Tails Pet House',retailerId:'retailer-demo',status:'approved',createdAt:'2026-10-17T08:00:00.000Z',condition:'Pet',attributes:{age:'5 months',vaccination:'Ask retailer'},image:image('photo-1552053831-71594a27632d')},
  {id:'pg-105',name:'Everyday cat food',category:'pets-supplies',price:750,unit:'pack',stock:24,description:'Complete everyday cat food in a convenient pack. Check product label, ingredients and feeding guidance for your pet.',location:'Chipledhunga, Pokhara',retailer:'Paws & Whiskers',retailerId:'retailer-demo',status:'approved',createdAt:'2026-10-16T08:00:00.000Z',condition:'New',attributes:{weight:'1.2 kg',type:'Dry food'},image:image('photo-1589924691995-400dc9ecc119')},
  {id:'pg-106',name:'Fresh farm eggs',category:'animal-products',price:220,unit:'dozen',stock:14,description:'Farm eggs offered by a local supplier. Handle safely and follow appropriate storage and cooking recommendations.',location:'Hemja, Pokhara',retailer:'Green Valley Poultry',retailerId:'retailer-demo',status:'approved',createdAt:'2026-10-15T08:00:00.000Z',condition:'Fresh',attributes:{quantity:'12 eggs',source:'Farm supplied'},image:image('photo-1518569656558-1f25e69d93d7')},
  {id:'pg-107',name:'Adjustable pet collar',category:'pets-supplies',price:450,unit:'piece',stock:32,description:'Adjustable everyday collar with a secure buckle. Measure your pet before ordering to select the right size.',location:'Online store',retailer:'Paws & Whiskers',retailerId:'retailer-demo',status:'approved',createdAt:'2026-10-14T08:00:00.000Z',condition:'New',attributes:{size:'Adjustable',material:'Nylon'},image:image('photo-1583337130417-3346a1be7dee')},
  {id:'pg-108',name:'Natural cattle feed',category:'animal-care',price:1150,unit:'bag',stock:9,description:'Sample cattle feed listing. Review the ingredient label and confirm suitability for the animal with an appropriate animal-care professional.',location:'Birauta, Pokhara',retailer:'Annapurna Livestock Farm',retailerId:'retailer-demo',status:'approved',createdAt:'2026-10-13T08:00:00.000Z',condition:'New',attributes:{weight:'25 kg',type:'Supplementary feed'},image:image('photo-1500382017468-9049fed747ef')}
];

function readJson(key, fallback) {
  try { const value = localStorage.getItem(key); return value ? JSON.parse(value) : fallback; }
  catch { return fallback; }
}
function writeJson(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
function initializeStore() {
  if (!localStorage.getItem(STORAGE_KEYS.products)) writeJson(STORAGE_KEYS.products, SEEDED_PRODUCTS);
  for (const [key, fallback] of [[STORAGE_KEYS.cart, []],[STORAGE_KEYS.orders, []],[STORAGE_KEYS.wishlist, []],[STORAGE_KEYS.retailers, []],[STORAGE_KEYS.reports, []],[STORAGE_KEYS.breedingBookings, []]]) {
    if (!localStorage.getItem(key)) writeJson(key, fallback);
  }
}
export const store = {
  init: initializeStore,
  products: () => {
    const current = readJson(STORAGE_KEYS.products, SEEDED_PRODUCTS);
    let changed = false;
    const normalized = current.map(product => {
      const category = normalizeCategoryId(product.category);
      if (category !== product.category) changed = true;
      return category === product.category ? product : {...product, category};
    });
    if (changed) writeJson(STORAGE_KEYS.products, normalized);
    return normalized;
  },
  saveProducts: (items) => { const previous = readJson(STORAGE_KEYS.products, []); const next = items.map(product => ({...product, category:normalizeCategoryId(product.category)})); writeJson(STORAGE_KEYS.products, next); return persistCloud('products', previous, next); },
  cart: () => readJson(STORAGE_KEYS.cart, []),
  saveCart: (items) => writeJson(STORAGE_KEYS.cart, items),
  orders: () => readJson(STORAGE_KEYS.orders, []),
  saveOrders: (items) => writeJson(STORAGE_KEYS.orders, items),
  session: () => readJson(STORAGE_KEYS.session, null),
  saveSession: (session) => session ? writeJson(STORAGE_KEYS.session, session) : localStorage.removeItem(STORAGE_KEYS.session),
  wishlist: () => readJson(STORAGE_KEYS.wishlist, []),
  saveWishlist: (items) => writeJson(STORAGE_KEYS.wishlist, items),
  retailers: () => readJson(STORAGE_KEYS.retailers, []),
  saveRetailers: (items) => { const previous = readJson(STORAGE_KEYS.retailers, []); writeJson(STORAGE_KEYS.retailers, items); return persistCloud('retailers', previous, items); },
  reports: () => readJson(STORAGE_KEYS.reports, []),
  saveReports: (items) => writeJson(STORAGE_KEYS.reports, items),
  breedingBookings: () => readJson(STORAGE_KEYS.breedingBookings, []),
  saveBreedingBookings: (items) => writeJson(STORAGE_KEYS.breedingBookings, items),
  resetDemo: () => { Object.values(STORAGE_KEYS).forEach(k => localStorage.removeItem(k)); initializeStore(); }
};
// Each marketplace category has its own palette, inspired by the user's visual references.
// The palette is reused in category cards, category landing banners, and product controls.
export const CATEGORIES = [
  {
    id:'livestock', name:'Live livestock', short:'Livestock', icon:'🐄', kicker:'Farm & livestock',
    description:'Cattle, goats, poultry and farm animals', cardDescription:'Browse farm animals · enquire',
    image:image('photo-1516467508483-a7212febe31a',1100),
    palette:{accent:'#91A32E',deep:'#174B3A',wash:'#EEF2D8',soft:'#FFF3B8',warm:'#F6D449',contrast:'#F06A4D'}
  },
  {
    id:'pets-supplies', name:'Pets & supplies', short:'Pets & supplies', icon:'🐕', kicker:'Companions & everyday essentials',
    description:'Pets, food, toys and accessories', cardDescription:'Pets, food, toys and accessories',
    image:image('photo-1552053831-71594a27632d',1100),
    palette:{accent:'#EC802B',deep:'#654018',wash:'#FFF1C4',soft:'#E8CCAD',warm:'#EDC55B',contrast:'#66BCB4'}
  },
  {
    id:'meat', name:'Meat & poultry', short:'Meat', icon:'🥩', kicker:'Fresh cuts & poultry',
    description:'Fresh meat, poultry and cuts by weight', cardDescription:'Shop by cut and weight',
    image:image('photo-1607623814075-e51df1bdc82f',1100),
    palette:{accent:'#B43526',deep:'#4F0E08',wash:'#F8E7E1',soft:'#DFBC94',warm:'#E5A659',contrast:'#790603'}
  },
  {
    id:'animal-products', name:'Animal products', short:'Animal products', icon:'🥚', kicker:'From farm to home',
    description:'Milk, eggs, honey, wool and more', cardDescription:'Milk, eggs and farm produce',
    image:image('photo-1518569656558-1f25e69d93d7',1100),
    palette:{accent:'#B78335',deep:'#3C572D',wash:'#F7EFD7',soft:'#FFF4DC',warm:'#F6D76A',contrast:'#8F2D19'}
  },
  {
    id:'animal-care', name:'Animal care', short:'Animal care', icon:'🌿', kicker:'Health, care & wellbeing',
    description:'Care essentials, feed and veterinary services', cardDescription:'Browse care essentials and services',
    image:image('photo-1576201836106-db1758fd1c97',1100),
    palette:{accent:'#769382',deep:'#304E40',wash:'#EAF0EA',soft:'#F3EFE3',warm:'#C0C3B9',contrast:'#536C5D'}
  }
];
export const normalizeCategoryId = id => ({pets:'pets-supplies','pet-supplies':'pets-supplies'}[String(id||'')] || String(id||''));
export const money = (amount) => new Intl.NumberFormat('en-NP',{style:'currency',currency:'NPR',maximumFractionDigits:0}).format(Number(amount)||0);
export const categoryName = id => CATEGORIES.find(c=>c.id===normalizeCategoryId(id))?.name || 'Other';
export const slugId = () => `pg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`;
export const safe = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

// Cloud snapshots update the local cache without triggering write-back loops.
export function hydrateCollection(name, items) {
  const key = ({ products: STORAGE_KEYS.products, retailers: STORAGE_KEYS.retailers, orders: STORAGE_KEYS.orders, reports: STORAGE_KEYS.reports, breedingBookings: STORAGE_KEYS.breedingBookings })[name];
  if (!key) throw new Error(`Unknown cache collection: ${name}`);
  writeJson(key, Array.isArray(items) ? items : []);
  try { window.dispatchEvent(new CustomEvent('pashughar:cloud-updated', { detail: { name, count: Array.isArray(items) ? items.length : 0 } })); } catch {}
}
