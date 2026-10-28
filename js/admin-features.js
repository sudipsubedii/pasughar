import {auth,db,getCallable} from './firebase.js';
import {store,CATEGORIES,hydrateCategories,hydrateSiteSettings} from './store.js';
import {collection,doc,getDoc,getDocs,query,orderBy,limit,serverTimestamp} from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';

const $=(selector,root=document)=>root.querySelector(selector);
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const dateText=value=>{const date=value?.toDate?value.toDate():new Date(value||'');return Number.isNaN(date.getTime())?'—':date.toLocaleString();};
const npr=value=>'Rs. '+Number(value||0).toLocaleString('en-IN',{maximumFractionDigits:2});
const panel=(title,desc,body,action='')=>'<div class="panel-card"><div class="panel-heading"><div><h2>'+esc(title)+'</h2><p>'+esc(desc)+'</p></div>'+action+'</div>'+body+'</div>';
const note=message=>'<p class="small-muted">'+esc(message)+'</p>';
const call=async(name,payload)=>{const result=await getCallable(name)(payload);return result.data||{};};
const toast=message=>window.dispatchEvent(new CustomEvent('pashughar:admin-toast',{detail:{message:String(message||'Action completed.')}}));
const builtInIds=new Set(['livestock','pets-supplies','meat','animal-products','animal-care']);
const defaultPalette={accent:'#769382',deep:'#304E40',wash:'#EAF0EA',soft:'#F3EFE3',warm:'#C0C3B9',contrast:'#536C5D'};

function applyOrderFilters(){
 const queryText=String($('#admin-orders-search')?.value||'').toLowerCase().trim();
 const status=String($('#admin-order-status')?.value||'all');
 document.querySelectorAll('[data-admin-order-row]').forEach(row=>{
  const matchesText=!queryText||String(row.dataset.orderSearch||'').includes(queryText);
  const matchesStatus=status==='all'||row.dataset.orderStatus===status;
  row.hidden=!(matchesText&&matchesStatus);
 });
}
function downloadOrdersCsv(){
 const headers=['Order ID','Created at','Customer','Email','Phone','Address','City','Items','Subtotal NPR','Delivery fee NPR','Total NPR','Payment method','Payment status','Order status'];
 const csvValue=value=>'"'+String(value??'').replace(/"/g,'""')+'"';
 const orders=store.orders().slice().sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
 const lines=[headers.map(csvValue).join(',')];
 for(const order of orders){
  const shipping=order.shipping||{};
  const items=(Array.isArray(order.items)?order.items:[]).map(item=>(item.name||item.productName||item.productId||'Item')+' x '+(item.quantity??item.qty??1)).join('; ');
  const created=order.createdAt?.toDate?order.createdAt.toDate().toISOString():String(order.createdAt||'');
  const values=[order.id,created,order.customerName,order.customerEmail,shipping.phone||order.phone,shipping.address||order.shippingAddress,shipping.city,items,order.subtotal,order.deliveryFee,order.total??order.subtotal,order.paymentMethod,order.paymentStatus,order.status];
  lines.push(values.map(csvValue).join(','));
 }
 const blob=new Blob(['\uFEFF'+lines.join('\r\n')],{type:'text/csv;charset=utf-8;'});
 const url=URL.createObjectURL(blob),anchor=document.createElement('a');
 anchor.href=url;anchor.download='pashughar-orders-'+new Date().toISOString().slice(0,10)+'.csv';
 document.body.appendChild(anchor);anchor.click();anchor.remove();URL.revokeObjectURL(url);
 toast('Order CSV export generated.');
}
export async function renderAdminFeature(tab,host){
 if(!host)return;
 const currentAdmin=auth.currentUser;
 if(!currentAdmin){host.innerHTML=panel('Admin session required','Sign in with the designated administrator account.','');return;}
 host.innerHTML=panel('Loading administration tools','Loading live records and settings…','<div class="initial-loading">Loading…</div>');
 try{
  if(tab==='overview')renderOverview(host);
  else if(tab==='categories')renderCategories(host);
  else if(tab==='settings')await renderSettings(host);
  else if(tab==='users')await renderUsers(host);
  else if(tab==='analytics')await renderAnalytics(host);
  else if(tab==='audit')await renderAudit(host);
  else host.innerHTML=panel('Admin tools','Choose a dashboard section.','');
 }catch(error){host.innerHTML=panel('Unable to load this section',error?.message||'Check your administrator permissions and retry.','<button class="button button-secondary" type="button" data-admin-refresh>Retry</button>');}
}

function renderOverview(host){
 const products=store.products(),retailers=store.retailers(),orders=store.orders(),reports=store.reports();
 const pendingProducts=products.filter(p=>p.status==='pending').length;
 const pendingRetailers=retailers.filter(r=>r.status==='pending').length;
 const pendingVets=retailers.filter(r=>r.isVet&&r.status==='pending').length;
 const activeReports=reports.filter(r=>['open','reviewing'].includes(r.status)).length;
 const fulfilled=orders.filter(o=>o.status==='Delivered').length;
 const value=orders.reduce((sum,o)=>sum+Number(o.total||o.subtotal||0),0);
 const statusRows=['pending','approved','rejected','suspended','paused'].map(status=>({status,count:products.filter(p=>p.status===status).length})).filter(x=>x.count);
 host.innerHTML=
  '<div class="metric-grid">'+[
   ['All listings',products.length,'Total catalogue records'],
   ['Awaiting listing review',pendingProducts,'Not visible in public catalogue'],
   ['Retailer applications',pendingRetailers,'Awaiting a decision'],
   ['Vet applications',pendingVets,'Veterinary profiles awaiting review'],
   ['Live reports',activeReports,'Open or being reviewed'],
   ['Orders',orders.length,'Delivered: '+fulfilled]
  ].map(x=>'<div class="metric-card"><div class="metric-top">'+esc(x[0])+'</div><div class="metric-number">'+x[1]+'</div><div class="metric-foot">'+esc(x[2])+'</div></div>').join('')+'</div>'+
  panel('Operations snapshot','Current Firestore records available to the admin session.',
   '<div class="metric-grid"><div class="metric-card"><div class="metric-top">Recorded order value</div><div class="metric-number">'+npr(value)+'</div><div class="metric-foot">Order totals in current records; not a payout report.</div></div><div class="metric-card"><div class="metric-top">Verified shops</div><div class="metric-number">'+retailers.filter(r=>r.status==='approved').length+'</div><div class="metric-foot">Approved retailer profiles.</div></div><div class="metric-card"><div class="metric-top">Published products</div><div class="metric-number">'+products.filter(p=>p.status==='approved').length+'</div><div class="metric-foot">Currently marked approved.</div></div></div>'+
   (statusRows.length?'<div class="table-scroll"><table><thead><tr><th>Listing status</th><th>Count</th></tr></thead><tbody>'+statusRows.map(x=>'<tr><td>'+esc(x.status)+'</td><td>'+x.count+'</td></tr>').join('')+'</tbody></table></div>':'<p class="small-muted">No listing records yet.</p>'));
}

function renderCategories(host){
 const cats=[...CATEGORIES].sort((a,b)=>String(a.name).localeCompare(String(b.name)));
 const select='<option value="">Create a new category</option>'+cats.map(c=>'<option value="'+esc(c.id)+'">'+esc(c.name)+' ('+esc(c.id)+')</option>').join('');
 const form='<form id="admin-category-form" class="panel-card" style="margin-bottom:16px"><div class="panel-heading"><div><h2>Category editor</h2><p>Create, edit, hide or restore marketplace categories. Hidden categories remain in history and cannot be selected for new listings.</p></div></div><input type="hidden" name="originalId" value=""><div class="field"><label for="admin-category-existing">Edit existing category</label><select id="admin-category-existing">'+select+'</select></div><div class="field-grid"><div class="field"><label for="admin-category-id">Category ID</label><input id="admin-category-id" name="id" required maxlength="60" pattern="[a-z0-9][a-z0-9-]{1,59}" placeholder="e.g. fish-supplies"></div><div class="field"><label for="admin-category-name">Display name</label><input id="admin-category-name" name="name" required maxlength="80"></div></div><div class="field-grid"><div class="field"><label for="admin-category-short">Short label</label><input id="admin-category-short" name="short" maxlength="60"></div><div class="field"><label for="admin-category-icon">Icon / emoji</label><input id="admin-category-icon" name="icon" maxlength="12" value="•"></div></div><div class="field"><label for="admin-category-kicker">Small heading</label><input id="admin-category-kicker" name="kicker" maxlength="80"></div><div class="field"><label for="admin-category-description">Description</label><textarea id="admin-category-description" name="description" required maxlength="400" rows="2"></textarea></div><div class="field"><label for="admin-category-card-description">Card description</label><input id="admin-category-card-description" name="cardDescription" maxlength="180"></div><div class="field"><label for="admin-category-image">Category image URL (HTTPS)</label><input id="admin-category-image" name="image" type="url" maxlength="2048" placeholder="https://…"></div><div class="field-grid"><div class="field"><label>Accent colour</label><input name="accent" value="'+defaultPalette.accent+'" pattern="#[0-9a-fA-F]{6}"></div><div class="field"><label>Deep colour</label><input name="deep" value="'+defaultPalette.deep+'" pattern="#[0-9a-fA-F]{6}"></div><div class="field"><label>Wash colour</label><input name="wash" value="'+defaultPalette.wash+'" pattern="#[0-9a-fA-F]{6}"></div></div><div class="field"><label for="admin-category-active">Visibility</label><select id="admin-category-active" name="active"><option value="true">Active — visible in storefront</option><option value="false">Hidden — not selectable</option></select></div><div class="modal-actions"><button class="button button-primary" type="submit">Save category</button><button class="button button-secondary" type="button" data-admin-category-clear>Clear form</button></div></form>';
 const rows=cats.map(c=>'<tr><td><strong>'+esc(c.icon||'•')+' '+esc(c.name)+'</strong><div class="small-muted">'+esc(c.id)+'</div></td><td>'+esc(c.description||'')+'</td><td>'+esc(builtInIds.has(c.id)?'Built-in':'Custom')+'</td><td><span class="status-pill">'+(c.active===false?'Hidden':'Active')+'</span></td><td><div class="inline-actions"><button class="tiny-action" type="button" data-admin-category-edit="'+esc(c.id)+'">Edit</button><button class="tiny-action '+(c.active===false?'':'danger')+'" type="button" data-admin-category-toggle="'+(c.active===false?'restore':'hide')+'" data-id="'+esc(c.id)+'">'+(c.active===false?'Restore':'Hide')+'</button></div></td></tr>').join('');
 host.innerHTML=form+panel('Categories','Hide a category without deleting its historical ID. Categories in use cannot be hidden until listings are reassigned.',
  '<div class="table-scroll"><table><thead><tr><th>Category</th><th>Description</th><th>Type</th><th>Visibility</th><th>Actions</th></tr></thead><tbody>'+rows+'</tbody></table></div>');
}

async function renderSettings(host){
 const snap=await getDoc(doc(db,'platformSettings','public'));
 const s={...store.siteSettings(),...(snap.exists()?snap.data():{})};
 host.innerHTML=panel('Site settings','Changes are saved to Firestore and apply to the public storefront. Delivery fee is added to new orders; commission is used for retailer earnings estimates.',
 '<form id="admin-site-settings-form"><div class="field-grid"><div class="field"><label for="admin-announcement-enabled">Announcement bar</label><select id="admin-announcement-enabled" name="announcementEnabled"><option value="true" '+(s.announcementEnabled?'selected':'')+'>Enabled</option><option value="false" '+(!s.announcementEnabled?'selected':'')+'>Hidden</option></select></div><div class="field"><label for="admin-announcement-text">Announcement text</label><input id="admin-announcement-text" name="announcementText" maxlength="180" value="'+esc(s.announcementText||'')+'"></div></div><div class="field"><label for="admin-banner-title">Homepage banner title</label><input id="admin-banner-title" name="bannerTitle" maxlength="140" value="'+esc(s.bannerTitle||'')+'"></div><div class="field"><label for="admin-banner-text">Homepage banner description</label><textarea id="admin-banner-text" name="bannerText" maxlength="500" rows="3">'+esc(s.bannerText||'')+'</textarea></div><div class="field"><label for="admin-banner-image">Homepage banner image URL (HTTPS)</label><input id="admin-banner-image" name="bannerImage" type="url" maxlength="2048" value="'+esc(s.bannerImage||'')+'" placeholder="Leave blank to use the default image"></div><div class="field-grid"><div class="field"><label for="admin-delivery-charge">Flat delivery charge (NPR)</label><input id="admin-delivery-charge" type="number" min="0" max="100000" step="1" name="deliveryCharge" required value="'+Number(s.deliveryCharge||0)+'"></div><div class="field"><label for="admin-commission-percent">Marketplace commission (%)</label><input id="admin-commission-percent" type="number" min="0" max="100" step="0.1" name="commissionPercent" required value="'+Number(s.commissionPercent||0)+'"></div></div><div class="notice notice-info">Commission is a calculation setting only; it does not collect payments. Online payment processing is not configured.</div><button class="button button-primary" type="submit">Save site settings</button></form>');
}

async function renderUsers(host){
 const response=await call('listAdminUsers',{});
 const users=response.users||[];
 const rows=users.map(u=>{
  const status=u.adminStatus|| (u.disabled?'suspended':'active');
  return '<tr data-admin-user-row data-search="'+esc([u.uid,u.displayName,u.email,u.phoneNumber,u.role,status].join(' ').toLowerCase())+'"><td><strong>'+esc(u.displayName||'Unnamed user')+'</strong><div class="small-muted">'+esc(u.uid)+'</div></td><td>'+esc(u.email||u.phoneNumber||'—')+'<div class="small-muted">'+(u.emailVerified?'Email verified':'Contact not email-verified')+'</div></td><td>'+esc(u.role||'customer')+'</td><td><span class="status-pill">'+esc(status)+'</span></td><td>'+esc(u.createdAt||'—')+'</td><td>'+esc(u.lastSignInAt||'—')+'</td><td><div class="inline-actions">'+(u.disabled?'<button class="tiny-action" data-admin-user-action="reinstate" data-id="'+esc(u.uid)+'">Reinstate</button>':'<button class="tiny-action danger" data-admin-user-action="suspend" data-id="'+esc(u.uid)+'">Suspend</button>')+'<button class="tiny-action danger" data-admin-user-action="ban" data-id="'+esc(u.uid)+'">Ban</button><button class="tiny-action" data-admin-user-action="reset-password" data-id="'+esc(u.uid)+'">Reset password</button></div></td></tr>';
 }).join('');
 host.innerHTML=panel('User management','Search account records, disable/reinstate accounts, ban accounts or generate a password-reset link.',
 '<div class="field"><label for="admin-user-search">Search users</label><input id="admin-user-search" type="search" placeholder="Name, email, phone, role or UID"></div><div class="notice notice-info">'+users.length+' account(s) returned'+(response.truncated?' (the first 1,000 Auth records are shown).':'.')+' Password reset creates a link; the administrator must deliver it securely to the user.</div><div class="table-scroll"><table><thead><tr><th>User</th><th>Contact</th><th>Role</th><th>Status</th><th>Created</th><th>Last sign-in</th><th>Actions</th></tr></thead><tbody>'+rows+'</tbody></table></div>');
}

async function renderAudit(host){
 const snap=await getDocs(query(collection(db,'auditLogs'),orderBy('createdAt','desc'),limit(100)));
 const rows=snap.docs.map(d=>({id:d.id,...d.data()}));
 host.innerHTML=panel('Audit log','Latest 100 administrative and system actions. Audit records are written by trusted backend functions and are not editable in the browser.',
 rows.length?'<div class="table-scroll"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Notes</th></tr></thead><tbody>'+rows.map(r=>'<tr><td>'+esc(dateText(r.createdAt))+'</td><td>'+esc(r.actorId||'system')+'</td><td>'+esc(r.action||'—')+'</td><td>'+esc(r.targetId||'—')+'</td><td>'+esc(r.reason||r.productName||r.status||'')+'</td></tr>').join('')+'</tbody></table></div>':'<p class="small-muted">No audit events recorded yet. Admin actions performed through the new backend endpoints will appear here.</p>');
}

async function renderAnalytics(host){
 const products=store.products(),retailers=store.retailers(),orders=store.orders(),reports=store.reports();
 const userResponse=await call('listAdminUsers',{});
 const revenue=orders.reduce((sum,o)=>sum+Number(o.total||o.subtotal||0),0);
 const delivered=orders.filter(o=>o.status==='Delivered').reduce((sum,o)=>sum+Number(o.total||o.subtotal||0),0);
 const buckets=new Map();
 orders.forEach(o=>{
  const d=o.createdAt?.toDate?o.createdAt.toDate():new Date(o.createdAt||'');
  if(Number.isNaN(d.getTime()))return;
  const key=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
  const row=buckets.get(key)||{month:key,orders:0,value:0};
  row.orders++;row.value+=Number(o.total||o.subtotal||0);buckets.set(key,row);
 });
 const categoryRows=new Map();
 products.forEach(p=>{
  const key=p.category||'other',row=categoryRows.get(key)||{category:key,listings:0,stock:0};
  row.listings++;row.stock+=Number(p.stock)||0;categoryRows.set(key,row);
 });
 const metricData=[
  ['Users',userResponse.users?.length||0],
  ['Retailers',retailers.length],
  ['Listings',products.length],
  ['Order value',npr(revenue)],
  ['Delivered value',npr(delivered)],
  ['Reports awaiting review',reports.filter(r=>['open','reviewing'].includes(r.status)).length]
 ];
 const metricHtml='<div class="metric-grid">'+metricData.map(row=>'<div class="metric-card"><div class="metric-top">'+esc(row[0])+'</div><div class="metric-number">'+esc(row[1])+'</div></div>').join('')+'</div>';
 const months=[...buckets.values()].sort((a,b)=>b.month.localeCompare(a.month));
 const monthlyHtml=months.length?'<div class="table-scroll"><table><thead><tr><th>Month</th><th>Orders</th><th>Order value</th></tr></thead><tbody>'+months.map(row=>'<tr><td>'+esc(row.month)+'</td><td>'+row.orders+'</td><td>'+npr(row.value)+'</td></tr>').join('')+'</tbody></table></div>':'<p class="small-muted">No dated orders available.</p>';
 const categories=[...categoryRows.values()].sort((a,b)=>b.listings-a.listings);
 const categoryHtml=categories.length?'<div class="table-scroll"><table><thead><tr><th>Category</th><th>Listings</th><th>Stock units</th></tr></thead><tbody>'+categories.map(row=>'<tr><td>'+esc(row.category)+'</td><td>'+row.listings+'</td><td>'+String(row.stock)+'</td></tr>').join('')+'</tbody></table></div>':'<p class="small-muted">No product records available.</p>';
 host.innerHTML=metricHtml+panel('Monthly orders and value','Aggregated from order creation dates. Amounts are order totals, not accounting revenue.',monthlyHtml)+panel('Catalogue by category','Listings and combined stock by category.',categoryHtml);
}
export function installAdminFeatureHandlers(){
 document.addEventListener('submit',async event=>{
  const form=event.target;
  try{
   if(form.id==='admin-category-form'){
    event.preventDefault();const fd=new FormData(form),originalId=String(fd.get('originalId')||''),id=String(fd.get('id')||'').trim().toLowerCase();
    if(originalId&&id!==originalId)throw Error('Category IDs are fixed after creation. Clear the form to create a different category.');
    const payload={id,active:String(fd.get('active'))!=='false',name:String(fd.get('name')||'').trim(),short:String(fd.get('short')||'').trim(),icon:String(fd.get('icon')||'•').trim(),kicker:String(fd.get('kicker')||'').trim(),description:String(fd.get('description')||'').trim(),cardDescription:String(fd.get('cardDescription')||'').trim(),image:String(fd.get('image')||'').trim(),palette:{...(CATEGORIES.find(c=>c.id===id)?.palette||defaultPalette),accent:String(fd.get('accent')||''),deep:String(fd.get('deep')||''),wash:String(fd.get('wash')||'')}};
    const result=await call('saveAdminCategory',payload);hydrateCategories([payload]);toast(result.created?'Category created.':'Category updated.');await renderAdminFeature('categories',$('#admin-feature-panel')); 
   }else if(form.id==='admin-site-settings-form'){
    event.preventDefault();const fd=new FormData(form);
    const settings={announcementEnabled:String(fd.get('announcementEnabled'))==='true',announcementText:String(fd.get('announcementText')||'').trim(),bannerTitle:String(fd.get('bannerTitle')||'').trim(),bannerText:String(fd.get('bannerText')||'').trim(),bannerImage:String(fd.get('bannerImage')||'').trim(),deliveryCharge:Number(fd.get('deliveryCharge')||0),commissionPercent:Number(fd.get('commissionPercent')||0)};
    const result=await call('saveAdminSiteSettings',settings);hydrateSiteSettings(result.settings||settings);toast('Site settings saved.');await renderAdminFeature('settings',$('#admin-feature-panel'));
   }
  }catch(error){event.preventDefault();toast(error?.message||'Admin action failed.');}
 });
 document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-admin-user-action],[data-admin-category-edit],[data-admin-category-delete],[data-admin-category-toggle],[data-admin-category-clear],[data-admin-refresh],[data-admin-export-orders]');
  if(!button)return;
  try{
   if(button.hasAttribute('data-admin-export-orders')){downloadOrdersCsv();return;}
   if(button.hasAttribute('data-admin-refresh')){await renderAdminFeature((window.location.hash||'').split('=')[1]||'overview',$('#admin-feature-panel'));return;}
   if(button.hasAttribute('data-admin-category-clear')){const form=$('#admin-category-form');form?.reset();if(form){form.elements.originalId.value='';form.elements.id.readOnly=false;form.elements.id.value='';}$('#admin-category-existing').value='';return;}
   if(button.hasAttribute('data-admin-category-toggle')){
    const id=button.dataset.id,category=CATEGORIES.find(item=>item.id===id);if(!category)return;
    const active=button.dataset.adminCategoryToggle==='restore';
    if(!active&&!confirm('Hide category '+category.name+'? Existing products keep their historical category and may need reassignment before it can be hidden.'))return;
    await call(active?'saveAdminCategory':'deleteAdminCategory',active?{...category,active:true}:{id});
    hydrateCategories([{...category,active}]);toast(active?'Category restored.':'Category hidden.');await renderAdminFeature('categories',$('#admin-feature-panel'));return;
   }
   if(button.hasAttribute('data-admin-category-edit')){
    const category=CATEGORIES.find(c=>c.id===button.dataset.adminCategoryEdit);if(!category)return;
    const form=$('#admin-category-form');if(!form)return;
    form.elements.originalId.value=category.id;form.elements.id.value=category.id;form.elements.id.readOnly=true;
    for(const key of ['name','short','icon','kicker','description','cardDescription','image'])form.elements[key].value=category[key]||'';
    form.elements.accent.value=category.palette?.accent||defaultPalette.accent;form.elements.deep.value=category.palette?.deep||defaultPalette.deep;form.elements.wash.value=category.palette?.wash||defaultPalette.wash;form.elements.active.value=category.active===false?'false':'true';
    $('#admin-category-existing').value=category.id;form.scrollIntoView({behavior:'smooth',block:'start'});return;
   }
   if(button.hasAttribute('data-admin-category-delete')){
    const id=button.dataset.adminCategoryDelete;if(!confirm('Hide category "'+id+'"?'))return;
    await call('deleteAdminCategory',{id});hydrateCategories([{...(CATEGORIES.find(x=>x.id===id)||{id}),active:false}]);toast('Category hidden.');await renderAdminFeature('categories',$('#admin-feature-panel'));return;
   }
   if(button.hasAttribute('data-admin-user-action')){
    const uid=button.dataset.id,action=button.dataset.adminUserAction;
    if(['suspend','ban'].includes(action)&&!confirm('Confirm '+action+' for this account? The account will be disabled.'))return;
    const reason=['suspend','ban'].includes(action)?(prompt('Reason for this account action:','Admin account review')||'Admin account review'):'';
    const result=await call('manageUserAccount',{uid,action,reason});
    if(action==='reset-password'){
      try{await navigator.clipboard.writeText(result.actionLink);}catch{}
      prompt('Password reset link generated for '+(result.email||'the account')+'. Send this link securely to the user:',result.actionLink);
      toast('Password reset link generated; it was not emailed automatically.');
    }else{
      toast('Account status changed to '+result.adminStatus+'.');
      await renderAdminFeature('users',$('#admin-feature-panel'));
    }
   }
  }catch(error){toast(error?.message||'Admin action failed.');}
 });
 document.addEventListener('input',event=>{
  if(event.target.id==='admin-user-search'){
   const q=event.target.value.toLowerCase().trim();
   document.querySelectorAll('[data-admin-user-row]').forEach(row=>row.hidden=!row.dataset.search.includes(q));
  }
  if(event.target.id==='admin-orders-search')applyOrderFilters();
 });
 document.addEventListener('change',event=>{if(event.target.id==='admin-order-status')applyOrderFilters();});
 document.addEventListener('change',event=>{
  if(event.target.id==='admin-category-existing'){
   const id=event.target.value,form=$('#admin-category-form');
   if(!id){if(form){form.reset();form.elements.originalId.value='';form.elements.id.readOnly=false;form.elements.id.value='';}return;}
   const category=CATEGORIES.find(c=>c.id===id);if(!category)return;
   if(form){form.elements.originalId.value=category.id;form.elements.id.value=category.id;form.elements.id.readOnly=true;for(const key of ['name','short','icon','kicker','description','cardDescription','image'])form.elements[key].value=category[key]||'';form.elements.accent.value=category.palette?.accent||defaultPalette.accent;form.elements.deep.value=category.palette?.deep||defaultPalette.deep;form.elements.wash.value=category.palette?.wash||defaultPalette.wash;form.elements.active.value=category.active===false?'false':'true';}
  }
 });
}

export async function saveAdminProductFromForm(form){
 const fd=new FormData(form);
 const payload={productId:String(fd.get('productId')||''),name:String(fd.get('name')||'').trim(),description:String(fd.get('description')||'').trim(),category:String(fd.get('category')||''),condition:String(fd.get('condition')||'New').trim(),unit:String(fd.get('unit')||'item'),price:Number(fd.get('price')),stock:Number(fd.get('stock')),location:String(fd.get('location')||'Nepal').trim(),image:String(fd.get('image')||'').trim(),retailerId:String(fd.get('retailerId')||'')};
 const response=await call('saveAdminProduct',payload);toast(response.created?'Product created and added to the moderation queue.':'Product changes saved.');return response;
}

export function renderAdminProductForm(product,retailers){
 const p=product||{};
 return '<div class="modal-inner"><div class="modal-head"><div><div class="eyebrow">Product management</div><h2>'+(p.id?'Edit product':'Create product')+'</h2><p>Products created here enter the moderation queue before publication.</p></div><button class="modal-close" data-action="close-modal" aria-label="Close">×</button></div><form id="admin-product-form"><input type="hidden" name="productId" value="'+esc(p.id||'')+'"><div class="field"><label>Product name</label><input name="name" required maxlength="120" value="'+esc(p.name||'')+'"></div><div class="field"><label>Description</label><textarea name="description" required maxlength="2500" rows="3">'+esc(p.description||'')+'</textarea></div><div class="field-grid"><div class="field"><label>Category</label><select name="category" required>'+CATEGORIES.filter(c=>c.active!==false).map(c=>'<option value="'+esc(c.id)+'" '+(c.id===(p.category||'livestock')?'selected':'')+'>'+esc(c.name)+'</option>').join('')+'</select></div><div class="field"><label>Condition</label><input name="condition" maxlength="80" value="'+esc(p.condition||'New')+'"></div></div><div class="field-grid"><div class="field"><label>Price (NPR)</label><input name="price" type="number" min="0.01" max="100000000" step="0.01" required value="'+(p.price??'')+'"></div><div class="field"><label>Stock</label><input name="stock" type="number" min="0" max="1000000" step="0.5" required value="'+(p.stock??0)+'"></div><div class="field"><label>Unit</label><select name="unit">'+['item','animal','kg','litre','pack','dozen','bag','tray'].map(u=>'<option '+(u===(p.unit||'item')?'selected':'')+'>'+u+'</option>').join('')+'</select></div></div><div class="field"><label>Location</label><input name="location" maxlength="220" required value="'+esc(p.location||'Nepal')+'"></div><div class="field"><label>Primary image URL (HTTPS)</label><input name="image" type="url" required maxlength="2048" value="'+esc(p.image||'')+'"></div><div class="field"><label>Assigned approved retailer</label><select name="retailerId" required>'+retailers.filter(r=>r.status==='approved').map(r=>'<option value="'+esc(r.ownerId||r.id)+'" '+((r.ownerId||r.id)===(p.retailerId||'')?'selected':'')+'>'+esc(r.storeName||r.contactName||r.id)+'</option>').join('')+'</select></div><button class="button button-primary" type="submit">Save product</button></form></div>';
}
