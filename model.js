import {divideRounded,personalAmount,apportion,rateParts} from './money.js';
import {validateBackup, validDate, digits} from './domain.js';
import {DEFAULT_PAYDAY,validatePaydaySettings} from './payday.js';
export const TABLES=['accounts','categories','pots','entries','allocations','templates','schedules','trips','wishlist','friends','settlements','valuations','caps'];
// randomUUID needs a secure (https or localhost) page; plain-http previews fall back to getRandomValues.
export const uid=()=>{if(typeof crypto.randomUUID==='function')return crypto.randomUUID();const b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const h=[...b].map(x=>x.toString(16).padStart(2,'0')).join('');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;};
// ---------------------------------------------------------------------------
// Default pots and categories (UI rebuild decisions, 2026-11-12).
//
// Some IDs are older than their names. Records and tests refer to pots and
// categories by ID, so the IDs stay and only the display names changed:
//   pot 'Bills'         is shown as 'Fixed expenses'
//   pot 'Life regulars' is shown as 'Regulars'
//   pot 'Clothing'      is shown as 'Flexible'
//   category 'Shopping' is shown as 'Purchases'
// ---------------------------------------------------------------------------
const POT_FIXED='Bills',POT_REGULARS='Life regulars',POT_FLEXIBLE='Clothing',POT_TRAVEL='Travel',POT_SAVINGS='savings',POT_FLEXIBLE_SAVINGS='flexible-savings';
// The pots the forecast's "Left in pots" block shows until the user chooses (settings.forecastPots).
export const DEFAULT_FORECAST_POTS=[POT_FIXED,POT_REGULARS,POT_FLEXIBLE];

export function defaultPots(){
 const pot=(id,name,kind,extra={})=>({id,name,kind,currency:'GBP',precision:2,...extra,archived:false});
 return [
  pot(POT_FIXED,'Fixed expenses','budget'),
  pot(POT_REGULARS,'Regulars','budget'),
  pot(POT_FLEXIBLE,'Flexible','budget'),
  pot(POT_TRAVEL,'Travel','budget'),
  pot(POT_SAVINGS,'Savings','savings',{protected:true}),
  pot(POT_FLEXIBLE_SAVINGS,'Flexible savings','savings')
 ];
}

// Each node: {id?, name, pot?, children?}. A child is a plain name or a node.
// A node without its own pot uses its parent's pot.
const EXPENSE_TREE=[
 {id:'Bills',name:'Bills',pot:POT_FIXED,children:['Rent','Electricity','Internet','Phone','Water','Council tax']},
 {id:'Subscriptions',name:'Subscriptions',pot:POT_FIXED,children:['Gym','AI tools','Newspapers & newsletters','Work memberships','Other subscriptions']},
 {id:'Groceries',name:'Groceries',pot:POT_REGULARS},
 {id:'Eating out',name:'Eating out',pot:POT_FLEXIBLE,children:['Takeaway','Eating in','Social event']},
 {id:'Shopping',name:'Purchases',pot:POT_FLEXIBLE,children:['Hobby','Electronics','Books & stationery','Work clothing','Other clothing','Skincare & beauty','Lifestyle & home','Souvenirs','Cute things','Gifts','Fun buys','International shipping/transport fees']},
 {id:'Transport',name:'Transport',pot:POT_FLEXIBLE,children:[{name:'TfL',pot:POT_REGULARS},'Train','Taxi','Bike']},
 {id:'Health',name:'Health',pot:POT_FLEXIBLE,children:['Classes','Medication','Doctor visits','Supplements','Massage & spa','Counselling']},
 {id:'Personal development',name:'Personal development',pot:POT_FLEXIBLE,children:['Short courses','Work books','Coaching & consulting']},
 {id:'Entertainment',name:'Entertainment',pot:POT_FLEXIBLE,children:['Exhibitions & museums','Cinema','Shows & events','Novels']},
 {id:'Travel',name:'Travel',pot:POT_TRAVEL,children:[
  {name:'Pre-departure',children:['Visa','Insurance','Admin fees','Trip gear']},
  {name:'Accommodation',children:['Hotel','Airbnb','Local residence']},
  {name:'Transport',children:['Entry & exit','Local public transport','Local taxi','Rentals','Special local transport']},
  {name:'Experiences',children:['Entrance tickets','Special experiences','Day tours','Multi-day tours']},
  {name:'Food',children:['Snacks','Fast food & takeaway','Groceries','Restaurants']},
  {name:'Shopping',children:['Phone & SIM','Souvenirs','Clothing','Skincare','Basic supplies','Gifts','Tips']}
 ]}
];
const INCOME_TREE=[
 {id:'Salary',name:'Salary',pot:POT_SAVINGS},
 {id:'Other income',name:'Other income',pot:POT_SAVINGS},
 {id:'Side income',name:'Side income',pot:POT_SAVINGS,prefix:'side',children:[{id:'side:writing',name:'Writing'},'Overtime',{id:'side:shopping',name:'Personal shopping'}]},
 {id:'Windfalls',name:'Windfalls',pot:POT_SAVINGS}
];
// Default pixel icons for the top-level categories, by category ID. The IDs
// name drawings in ui/pixel-icons.js. Subcategories use SUB_ICONS below.
const TOP_ICONS={Bills:'receipt',Subscriptions:'repeat',Groceries:'cart','Eating out':'fork-knife',Shopping:'bag',Transport:'train',Health:'heart','Personal development':'book',Entertainment:'ticket',Travel:'plane',Salary:'coin','Other income':'star','Side income':'bolt',Windfalls:'gift'};
// Default pixel icons for subcategories, by name (the same name gets the same icon under any parent).
const SUB_ICONS={"Rent":"house","Electricity":"bolt","Internet":"wifi","Phone":"phone","Water":"droplet","Council tax":"bank","Gym":"dumbbell","AI tools":"robot","Newspapers & newsletters":"news","Work memberships":"badge","Other subscriptions":"repeat","Takeaway":"box","Eating in":"fork-knife","Social event":"people","Hobby":"palette","Electronics":"laptop","Books & stationery":"book","Work clothing":"shirt","Other clothing":"shirt","Skincare & beauty":"lipstick","Lifestyle & home":"house","Souvenirs":"star","Cute things":"heart","Gifts":"gift","Fun buys":"star","International shipping/transport fees":"box","TfL":"train","Train":"train","Taxi":"car","Bike":"bike","Classes":"dumbbell","Medication":"pill","Doctor visits":"cross","Supplements":"pill","Massage & spa":"leaf","Counselling":"chat","Short courses":"cap","Work books":"book","Coaching & consulting":"chat","Exhibitions & museums":"bank","Cinema":"film","Shows & events":"ticket","Novels":"book","Pre-departure":"passport","Visa":"passport","Insurance":"shield","Admin fees":"receipt","Trip gear":"suitcase","Accommodation":"bed","Hotel":"bed","Airbnb":"house","Local residence":"house","Transport":"bus","Entry & exit":"plane","Local public transport":"bus","Local taxi":"car","Rentals":"car","Special local transport":"bike","Experiences":"ticket","Entrance tickets":"ticket","Special experiences":"star","Day tours":"pin","Multi-day tours":"suitcase","Food":"fork-knife","Snacks":"cup","Fast food & takeaway":"box","Groceries":"cart","Restaurants":"fork-knife","Shopping":"bag","Phone & SIM":"phone","Clothing":"shirt","Skincare":"lipstick","Basic supplies":"box","Tips":"coin"};
function categorySlug(name){return name.toLowerCase().replace(/&/g,'and').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');}

// Flattens the trees, parents before children. ownPot marks a child whose pot
// differs from its parent's on purpose (TfL), so migration keeps that pot.
function categorySpecs(){
 const out=[];
 const walk=(nodes,kind,parent,prefix,inheritedPot)=>nodes.forEach((item,order)=>{
  const node=typeof item==='string'?{name:item}:item;
  const id=node.id||prefix+':'+categorySlug(node.name);
  const pot=node.pot||inheritedPot;
  const spec={id,name:node.name,kind,parent:parent,pot,order,archived:false,ownPot:!!parent&&!!node.pot};
  if(!parent&&TOP_ICONS[id])spec.icon={type:'pixel',value:TOP_ICONS[id]};else if(parent&&SUB_ICONS[node.name])spec.icon={type:'pixel',value:SUB_ICONS[node.name]};
  out.push(spec);
  if(node.children)walk(node.children,kind,id,parent?id:node.prefix||categorySlug(node.name),pot);
 });
 walk(EXPENSE_TREE,'expense','','','');
 walk(INCOME_TREE,'income','','','');
 return out;
}
export function defaultCategories(){return categorySpecs().map(({ownPot,...record})=>record);}
// Kept for callers that only want the non-top-level-expense defaults.
export function documentedCategories(){return defaultCategories().filter(c=>c.parent||c.kind==='income');}
export function categoryPath(s,id){const parts=[],seen=new Set();while(id&&!seen.has(id)){seen.add(id);const c=s.categories.find(c=>c.id===id);if(!c)break;parts.unshift(c.name);id=c.parent;}return parts.join(' / ');}
// Adds any default pots and categories a ledger does not have yet. Nothing is
// deleted. A record the user created with the same name is reused. A default
// that still carries its old seeded name (name equal to ID) gets the new name;
// anything the user renamed is left alone. Returns the same object when there
// is nothing to add. Default icons are added only where no icon was ever set.
export function ensureDocumentedCategories(s){
 const operations=[],same=(a,b)=>a.trim().toLowerCase()===b.trim().toLowerCase();
 const untouchedSeed=(existing,spec)=>existing.id===spec.id&&existing.name===spec.id&&spec.name!==spec.id;
 const pots=[...s.pots],potIds=new Map();
 for(const spec of defaultPots()){
  const existing=pots.find(p=>p.id===spec.id)||pots.find(p=>same(p.name,spec.name));
  if(!existing){pots.push(spec);potIds.set(spec.id,spec.id);operations.push({table:'pots',record:spec});continue;}
  potIds.set(spec.id,existing.id);
  if(untouchedSeed(existing,spec))operations.push({table:'pots',record:{...existing,name:spec.name}});
 }
 const all=[...s.categories],ids=new Map();
 for(const {ownPot,...spec} of categorySpecs()){
  const parent=spec.parent?ids.get(spec.parent):'';
  const existing=all.find(c=>c.id===spec.id)||all.find(c=>c.kind===spec.kind&&(c.parent||'')===parent&&same(c.name,spec.name));
  if(existing){
   ids.set(spec.id,existing.id);
   let record=existing;
   if(untouchedSeed(existing,spec))record={...record,name:spec.name};
   // A default icon only fills a gap. icon:null means the user chose "None".
   if(spec.icon&&existing.icon===undefined)record={...record,icon:structuredClone(spec.icon)};
   if(record!==existing)operations.push({table:'categories',record});
   continue;
  }
  const ancestor=all.find(c=>c.id===parent);
  const pot=ancestor&&!ownPot?ancestor.pot:potIds.get(spec.pot)||'';
  const record={...spec,parent,pot,archived:!!ancestor?.archived};
  ids.set(spec.id,record.id);all.push(record);operations.push({table:'categories',record});
 }
 return operations.length?commitBatch(s,operations):s;
}
// Weekly regulars the forecast uses until the user saves a list of their own (settings.estimates). Editable in Settings → Estimates.
export function seedEstimates(){return [{id:'estimate:groceries',name:'Groceries',category:'Groceries',amountMinor:5000,currency:'GBP',every:'week'},{id:'estimate:tfl',name:'TfL',category:'transport:tfl',amountMinor:5000,currency:'GBP',every:'week'}];}
export function initial(){return {version:2,revision:0,settings:{reportingCurrency:'GBP',activeCurrencies:['GBP','CNY','USD','EUR'],savingsPot:POT_SAVINGS,payday:{...DEFAULT_PAYDAY},holidays:[]},accounts:[],categories:defaultCategories(),pots:defaultPots(),entries:[],allocations:[],templates:[],schedules:[],trips:[],wishlist:[],friends:[],settlements:[],valuations:[],caps:[],trash:[],history:[],pending:[],serverRevision:0};}
// Version 1 previews had a 'Social' pot; it is now part of Flexible.
export function migrate(old,today){const s=initial();s.entries=validateBackup(old).map(e=>({...e,pot:e.pot==='Social'?POT_FLEXIBLE:e.pot,kind:'expense',status:e.date>today?'planned':'posted',account:'',tags:'',trip:'',ledger:'active'}));return validateState(s);}
export function integer(n,positive=false){if(!Number.isSafeInteger(n)||(positive&&n<=0))throw Error('An amount is outside the supported integer range.');}
function date(d){if(!validDate(d))throw Error('A record has an invalid calendar date.');}
function currency(c,p){if(!/^[A-Z]{3}$/.test(c)||!Number.isInteger(p)||p<0||p>6)throw Error('Invalid currency or precision.');}
// An icon is optional on categories and accounts: absent or null, {type:'emoji',value} or {type:'pixel',value:<icon ID>}.
function recordIcon(icon,what){
 if(icon==null)return;
 const ok=typeof icon==='object'&&!Array.isArray(icon)&&typeof icon.value==='string'&&(icon.type==='emoji'?icon.value.trim().length>0&&icon.value.length<=32&&!/[<>&]/.test(icon.value):icon.type==='pixel'&&/^[a-z0-9-]{1,40}$/.test(icon.value));
 if(!ok)throw Error(`Invalid ${what} icon.`);
}
// settings.defaultRates is optional: {CODE:'decimal string'}, a rough rate meaning 1 CODE = that many units of the reporting currency.
function defaultRates(rates){
 if(rates==null)return;
 if(typeof rates!=='object'||Array.isArray(rates))throw Error('Default exchange rates are invalid.');
 for(const [code,rate] of Object.entries(rates)){if(!/^[A-Z]{3}$/.test(code)||typeof rate!=='string')throw Error('Default exchange rates are invalid.');rateParts(rate);}
}
/**
 * settings.paydayFlow in its current shape. The earlier shape had one savings
 * rule (savingsMode 'fixed'|'percent' with savingsValue); it becomes
 * savings: { fixedMinor, percent, percentBase: 'total' }. Anything already in
 * the new shape is returned unchanged.
 */
export function migratePaydayFlow(flow){
 if(!flow||typeof flow!=='object'||Array.isArray(flow)||!('savingsMode' in flow||'savingsValue' in flow))return flow;
 const {savingsMode,savingsValue,...rest}=flow;
 if(rest.savings!=null)return rest;
 const value=Number.isSafeInteger(savingsValue)&&savingsValue>=0?savingsValue:0;
 return {...rest,savings:savingsMode==='percent'?{fixedMinor:0,percent:Math.min(value,10000),percentBase:'total'}:{fixedMinor:value,percent:0,percentBase:'total'}};
}
export function validateState(s){
 if(!s||s.version!==2||!Number.isSafeInteger(s.revision)||s.revision<0)throw Error('This backup version is not supported.');
 for(const table of [...TABLES,'trash','history','pending']){if(!Array.isArray(s[table]))throw Error(`Missing ${table} records.`);const seen=new Set();for(const r of s[table]){if(!r||typeof r.id!=='string'||!r.id||seen.has(r.id))throw Error(`Invalid or duplicate ID in ${table}.`);seen.add(r.id);}}
 if(!s.settings||!Array.isArray(s.settings.activeCurrencies)||!s.settings.activeCurrencies.includes(s.settings.reportingCurrency)||s.settings.activeCurrencies.some(c=>!/^[A-Z]{3}$/.test(c)))throw Error('The reporting currency must remain active.');
 for(const p of s.pots){currency(p.currency,p.precision);if(p.target!=null)integer(p.target,true);if(!['budget','savings'].includes(p.kind))throw Error('Invalid pot type.');}
 const find=(t,id)=>s[t].find(r=>r.id===id),ref=(t,id)=>{if(id&&!find(t,id))throw Error(`Missing ${t} reference: ${id}`);};
 ref('pots',s.settings.savingsPot);if(s.settings.savingsPot&&find('pots',s.settings.savingsPot).kind!=='savings')throw Error('Quarter-end destination must be a savings pot.');
 // Pots: an optional icon (as categories have) and an optional opt-in rollover {enabled, months, to}.
 // Unused funding older than `months` moves to the savings pot `to`; the pot itself must not be the target.
 for(const p of s.pots){
  recordIcon(p.icon,'pot');
  if(p.rollover==null)continue;
  const r=p.rollover;
  if(typeof r!=='object'||Array.isArray(r)||typeof r.enabled!=='boolean'||!Number.isInteger(r.months)||r.months<1||r.months>36||typeof r.to!=='string')throw Error('Invalid pot rollover setting.');
  ref('pots',r.to);
  if(r.enabled){
   const target=find('pots',r.to);
   if(!target||target.id===p.id||target.kind!=='savings'||target.currency!==p.currency||target.precision!==p.precision)throw Error('A pot rolls over into a different savings pot in the same currency.');
  }
 }
 for(const a of s.accounts){recordIcon(a.icon,'account');currency(a.currency,a.precision);integer(a.opening);if(a.initialContributions!=null)integer(a.initialContributions);date(a.openingDate);if(a.reminderMonths!=null&&(!Number.isInteger(a.reminderMonths)||a.reminderMonths<0||a.reminderMonths>120))throw Error('Reconciliation interval must be 0 to 120 months.');if(a.lastReconciled)date(a.lastReconciled);if(!['current','savings','credit_card','cash_wallet','investment'].includes(a.type))throw Error('Invalid account type.');}
 for(const c of s.categories){recordIcon(c.icon,'category');ref('pots',c.pot);ref('categories',c.parent);if(!['income','expense'].includes(c.kind))throw Error('Invalid category kind.');const seen=new Set([c.id]);let p=c.parent;while(p){if(seen.has(p))throw Error('Categories cannot form a parent cycle.');seen.add(p);p=find('categories',p)?.parent;}}
 for(const e of s.entries){date(e.date);currency(e.currency,e.precision);integer(e.minor,true);if(!['expense','income','transfer','refund','adjustment','settlement'].includes(e.kind)||!['planned','posted','cancelled'].includes(e.status))throw Error('Invalid entry kind or status.');for(const [t,id]of [['accounts',e.account],['categories',e.category],['pots',e.pot],['trips',e.trip]])ref(t,id);if(!['active','historical'].includes(e.ledger))throw Error('Invalid ledger.');if(typeof e.note!=='string'||e.note.length>500||typeof e.tags!=='string')throw Error('Invalid entry text.');
  if(['adjustment','settlement'].includes(e.kind)&&!['increase','decrease'].includes(e.direction))throw Error('Choose the direction of the account adjustment.');if(e.settledMinor!=null){integer(e.settledMinor);if(e.settledMinor<0)throw Error('Account amount cannot be negative.');currency(e.settledCurrency,e.settledPrecision);}
  if(e.account){const a=find('accounts',e.account);if(e.settledMinor!=null){integer(e.settledMinor);if(e.settledMinor<0)throw Error('Account debit cannot be negative.');if(e.settledCurrency!==a.currency||e.settledPrecision!==a.precision)throw Error('Settled amount must match the payment account.');}else if(a.currency!==e.currency||a.precision!==e.precision)throw Error('Enter the actual or estimated debit in the account currency.');if(e.status==='posted'&&e.ledger==='active'&&e.date<a.openingDate)throw Error('An entry cannot precede the account opening balance date.');}
  if(e.reportingMinor!=null){integer(e.reportingMinor);if(e.reportingMinor<0)throw Error('Reporting amount cannot be negative.');currency(e.reportingCurrency,e.reportingPrecision);}
  if(e.splits){if(!Array.isArray(e.splits)||!e.splits.length||e.kind!=='expense'||e.friend)throw Error('Invalid purchase split.');let sum=0n;for(const part of e.splits){integer(part.minor,true);ref('categories',part.category);ref('pots',part.pot);sum+=BigInt(part.minor);}if(sum!==BigInt(e.minor))throw Error('Split amounts must equal the original purchase.');}
  if(e.personalMinor!=null){integer(e.personalMinor);if(e.personalMinor<0||e.personalMinor>e.minor)throw Error('Personal share must be between zero and total paid.');}if(e.friend){ref('friends',e.friend);integer(e.friendDelta);if(e.kind==='expense'){if(e.personalMinor==null)throw Error('A shared purchase needs your personal share.');const friendPaid=e.paidBy==='friend'||e.friendDelta<0;if(friendPaid?(e.friendDelta!==-e.personalMinor||e.minor!==e.personalMinor||e.account):(e.friendDelta!==e.minor-e.personalMinor))throw Error('Shared payment and debt amounts do not match the recorded shares.');}}
  if(e.category&&find('categories',e.category).kind!==(e.kind==='income'?'income':'expense'))throw Error('Category does not match entry kind.');
  if(e.kind==='transfer'){ref('accounts',e.toAccount);if(!e.account||!e.toAccount||e.account===e.toAccount)throw Error('Choose two different accounts.');integer(e.receivedMinor,true);const destination=find('accounts',e.toAccount);if(e.status==='posted'&&e.ledger==='active'&&e.date<destination.openingDate)throw Error('Transfer precedes the destination account opening date.');}
  if(e.kind==='refund'){ref('entries',e.original);const original=find('entries',e.original);if(original?.friend){if(e.friend!==original.friend||e.personalMinor==null)throw Error('Shared refunds must preserve the friend and specify your refunded share.');const paidByFriend=original.paidBy==='friend'||original.friendDelta<0,expected=paidByFriend?e.personalMinor:-(e.minor-e.personalMinor);if(e.friendDelta!==expected)throw Error('Shared refund debt adjustment does not match the refunded shares.');}if(!original||original.kind!=='expense'||original.currency!==e.currency||original.precision!==e.precision||e.account!==original.account||e.pot!==original.pot||e.date<original.date)throw Error('Refund must match its purchase currency, account and pot, and follow its date.');}
 }
 for(const e of s.entries.filter(e=>e.kind==='expense')){const refunded=s.entries.filter(r=>r.kind==='refund'&&r.original===e.id).reduce((n,r)=>n+BigInt(r.minor),0n);if(refunded>BigInt(e.minor))throw Error('Refunds exceed the original purchase.');if(e.friend){const own=s.entries.filter(r=>r.kind==='refund'&&r.original===e.id).reduce((n,r)=>n+BigInt(r.personalMinor??r.minor),0n);if(own>BigInt(e.personalMinor))throw Error('Refunds exceed your original personal share.');if(e.sharedTotal!=null){const merchant=s.entries.filter(r=>r.kind==='refund'&&r.original===e.id).reduce((n,r)=>n+BigInt(r.merchantRefund??r.minor),0n);if(merchant>BigInt(e.sharedTotal))throw Error('Merchant refunds exceed the original shared payment.');}const theirs=refunded-own;if(theirs>BigInt(e.minor-e.personalMinor))throw Error('Refunds exceed the friend’s original share.');}}
 for(const e of s.entries){if(e.feeFor){ref('entries',e.feeFor);const transfer=find('entries',e.feeFor);if(transfer.kind!=='transfer'||e.group!==transfer.group||e.account!==transfer.account||e.currency!==transfer.currency||e.date!==transfer.date||e.status!==transfer.status)throw Error('A transfer fee must match its source transfer.');}if(e.kind==='transfer'&&e.totalDebit!=null){integer(e.totalDebit,true);const fees=s.entries.filter(f=>f.feeFor===e.id).reduce((n,f)=>n+BigInt(f.minor),0n);if(BigInt(e.minor)+fees!==BigInt(e.totalDebit))throw Error('Transfer principal and included fee must equal the total debit.');}}
 // A fee taken from what a transfer delivered (an ATM or exchange charge): an expense on the receiving account.
 for(const fee of s.entries.filter(e=>e.feeOnReceived)){
  const transfer=find('entries',fee.feeOnReceived),destination=transfer&&find('accounts',transfer.toAccount);
  if(!transfer||transfer.kind!=='transfer'||!destination||fee.kind!=='expense'||fee.group!==transfer.id||fee.account!==transfer.toAccount||fee.currency!==destination.currency||fee.precision!==destination.precision||fee.date!==transfer.date||fee.status!==transfer.status)throw Error('A fee taken from a transfer must match the receiving account and date.');
 }
 for(const a of s.allocations){date(a.date);if(a.salary){ref('entries',a.salary);const income=find('entries',a.salary);if(income.kind!=='income'||income.status!=='posted'||income.ledger!=='active')throw Error('Salary funding needs a posted income entry.');const allocated=s.allocations.filter(row=>row.salary===a.salary).reduce((n,row)=>n+BigInt(row.minor),0n);if(allocated>BigInt(income.minor))throw Error('Salary allocations exceed the recorded income.');}ref('pots',a.from);ref('pots',a.to);if(!a.to||a.from===a.to)throw Error('Choose a different destination pot.');integer(a.minor,true);const target=find('pots',a.to);if(a.from){const source=find('pots',a.from);if(source.currency!==target.currency||source.precision!==target.precision)throw Error('Pot moves currently require matching currencies.');}}
 for(const table of ['accounts','categories','pots','templates','schedules','trips','wishlist','friends','caps'])for(const r of s[table])if(typeof r.name!=='string'||!r.name.trim()||r.name.length>150)throw Error(`A ${table} record needs a name of at most 150 characters.`);
 for(const r of s.templates){ref('accounts',r.account);ref('categories',r.category);ref('pots',r.pot);}
 for(const r of s.schedules){date(r.start);if(r.interval!=null&&(!Number.isInteger(r.interval)||r.interval<1||r.interval>120))throw Error('Invalid schedule interval.');if(r.holidays)for(const h of r.holidays)date(h);if(r.end){date(r.end);if(r.end<r.start)throw Error('Schedule ends before it starts.');}if(!['once','weekly','monthly','yearly'].includes(r.frequency)||!r.entry)throw Error('Invalid recurring schedule.');for(const v of r.versions||[]){date(v.effectiveDate);if(!v.entry)throw Error('Schedule version has no entry.');currency(v.entry.currency,v.entry.precision);integer(v.entry.minor,true);}const e=r.entry;currency(e.currency,e.precision);integer(e.minor,true);ref('accounts',e.account);ref('categories',e.category);ref('pots',e.pot);if(!['income','expense','transfer'].includes(e.kind)||typeof e.note!=='string'||typeof e.tags!=='string')throw Error('Invalid recurring entry.');if(e.account){const account=find('accounts',e.account);if(account.currency!==e.currency||account.precision!==e.precision)throw Error('Recurring entries need an amount in the payment account currency.');}if(e.kind==='transfer'){ref('accounts',e.toAccount);integer(e.receivedMinor,true);if(!e.account||!e.toAccount||e.account===e.toAccount)throw Error('A recurring transfer needs two different accounts.');}}
 for(const r of s.trips){date(r.start);date(r.end);if(r.end<r.start)throw Error('Trip ends before it starts.');currency(r.currency,digits(r.currency));}
 for(const r of s.wishlist){currency(r.currency,digits(r.currency));if(r.deadline)date(r.deadline);if(r.nextReview)date(r.nextReview);if(r.nextRestock)date(r.nextRestock);if(r.restockMonths!=null&&(!Number.isInteger(r.restockMonths)||r.restockMonths<1||r.restockMonths>120))throw Error('Restock interval must be 1 to 120 months.');ref('pots',r.pot);}
 for(const r of s.settlements){ref('friends',r.friend);date(r.date);currency(r.currency,r.precision);integer(r.delta);}
 for(const r of s.valuations){ref('accounts',r.account);date(r.date);integer(r.minor);if(r.minor<0)throw Error('Valuation cannot be negative.');}
 for(const r of s.caps){ref('accounts',r.account);date(r.start);date(r.end);integer(r.minor,true);if(r.threshold!=null&&(!Number.isInteger(r.threshold)||r.threshold<1||r.threshold>100))throw Error('Alert threshold must be 1 to 100 percent.');if(r.end<r.start)throw Error('Cap period ends before it starts.');}
 if(s.settings.nextPayday)date(s.settings.nextPayday);ref('categories',s.settings.paydayCategory);ref('accounts',s.settings.defaultAccount);ref('categories',s.settings.defaultCategory);
 if(s.settings.salary){const salary=s.settings.salary;currency(salary.currency,digits(salary.currency));integer(salary.base,true);if(!Array.isArray(salary.rules))throw Error('Salary rules are missing.');const ids=new Set();for(const rule of salary.rules){ref('pots',rule.pot);integer(rule.value,true);if(!rule.id||ids.has(rule.id)||!['fixed_bill','essential','protected_savings','subscription','extra_savings','discretionary'].includes(rule.kind)||!['fixed','percent'].includes(rule.mode)||(rule.mode==='percent'&&rule.value>10000))throw Error('Invalid salary rule.');ids.add(rule.id);}}
 for(const rate of s.settings.referenceRates||[]){currency(rate.base,digits(rate.base));currency(rate.quote,digits(rate.quote));date(rate.date);rateParts(rate.rate);}
 defaultRates(s.settings.defaultRates);
 // Payday rule, the user's extra holiday dates and the weekly estimates used by the forecast.
 validatePaydaySettings(s.settings);
 if(s.settings.estimates!=null){
  if(!Array.isArray(s.settings.estimates))throw Error('Estimates must be a list.');
  const ids=new Set();
  for(const estimate of s.settings.estimates){
   if(!estimate||typeof estimate.id!=='string'||!estimate.id||ids.has(estimate.id))throw Error('Invalid or duplicate estimate.');
   ids.add(estimate.id);
   if(typeof estimate.name!=='string'||!estimate.name.trim()||estimate.name.length>150)throw Error('Give each estimate a name.');
   // The category may have been removed since; the estimate still counts, so it is not a hard reference.
   if(typeof estimate.category!=='string')throw Error('Invalid estimate category.');
   currency(estimate.currency,digits(estimate.currency));
   integer(estimate.amountMinor,true);
   if(estimate.every!=='week')throw Error('Estimates repeat weekly.');
  }
 }
 // Pots shown in the forecast. A pot may have been removed since, so the IDs are not hard references; the screen skips the missing ones.
 if(s.settings.forecastPots!=null){
  const chosen=s.settings.forecastPots;
  if(!Array.isArray(chosen)||chosen.length>100||chosen.some(id=>typeof id!=='string'||!id||id.length>150)||new Set(chosen).size!==chosen.length)throw Error('Invalid forecast pots.');
 }
 // The monthly payday flow. The savings portion is a fixed amount (minor units) plus a share of the salary
 // (hundredths of a percent) of either the whole salary ('total') or what Fixed expenses and Regulars leave ('disposable').
 // Every step names an existing pot. An older savingsMode/savingsValue pair is rewritten to the new shape here, on load.
 if(s.settings.paydayFlow!=null){
  if(typeof s.settings.paydayFlow!=='object'||Array.isArray(s.settings.paydayFlow))throw Error('Invalid payday flow.');
  const flow=s.settings.paydayFlow=migratePaydayFlow(s.settings.paydayFlow);
  for(const key of ['savingsPot','fixedPot','regularsPot','leftoverPot']){
   if(typeof flow[key]!=='string'||!flow[key])throw Error('Choose a pot for every payday step.');
   ref('pots',flow[key]);
  }
  if(flow.fixedPot===flow.regularsPot)throw Error('Fixed expenses and Regulars need different pots.');
  const savings=flow.savings;
  if(!savings||typeof savings!=='object'||Array.isArray(savings))throw Error('The savings portion is not a usable amount.');
  if(!Number.isSafeInteger(savings.fixedMinor)||savings.fixedMinor<0)throw Error('The savings portion is not a usable amount.');
  if(!Number.isSafeInteger(savings.percent)||savings.percent<0||savings.percent>10000)throw Error('The savings percentage is from 0 to 100.');
  if(!['total','disposable'].includes(savings.percentBase))throw Error('The savings percentage is of total or disposable income.');
 }
 if(s.settings.reportingDisplay?.mode==='oneoff')rateParts(s.settings.reportingDisplay.rate);
 for(const r of s.trash)if(!TABLES.includes(r.table)||!r.record||typeof r.record.id!=='string')throw Error('Invalid deleted record.');
 return s;
}
export function commit(s,table,record,action='save',id=uid(),check=true,mutating=false){
 if(action==='delete'&&!s[table]?.some(e=>e.id===record.id))throw Error('Record no longer exists.');if(!TABLES.includes(table))throw Error('Unknown record type.');const next=mutating?s:structuredClone(s),old=next[table].find(e=>e.id===record.id);
 if(['entries','allocations'].includes(table)){const dates=[old?.date,record.date].filter(Boolean);if(!(table==='entries'&&record.ledger==='historical')&&dates.some(d=>s.settings.closedQuarters?.includes(quarter(d))))throw Error('This budget quarter is closed. Reopen it on the Pots page before changing dated financial records.');}
 if(table==='entries'&&old?.ledger==='historical')throw Error('Historical entries are read-only.');
 if(action==='delete'){next[table]=next[table].filter(e=>e.id!==record.id);next.trash.push({id,table,record:old,deletedAt:new Date().toISOString()});}else{next[table]=next[table].filter(e=>e.id!==record.id).concat(structuredClone(record));}
 next.revision++;next.history.push({id,table,recordId:record.id,action,before:old?structuredClone(old):null,after:action==='delete'?null:structuredClone(record),at:new Date().toISOString()});next.pending.push({id,revision:next.revision,table,recordId:record.id});return check?validateState(next):next;
}
export function commitBatch(s,operations){let next=structuredClone(s);for(const op of operations)next=commit(next,op.table,op.record,op.action||'save',undefined,false,true);return validateState(next);}
export function restore(s,id){const item=s.trash.find(r=>r.id===id);if(!item)throw Error('Deleted record not found.');if(item.table==='allocations'&&item.record.id.startsWith('quarter:'))throw Error('Close the quarter again to regenerate its sweep; do not restore a reversed sweep individually.');const group=item.record.group,members=(group?s.trash.filter(r=>r.record?.group===group):[item]).sort((a,b)=>(a.record.kind==='transfer'?-1:0)-(b.record.kind==='transfer'?-1:0));let next=s;for(const row of members){if(next[row.table].some(r=>r.id===row.record.id))throw Error('A record with that ID already exists.');next=commit(next,row.table,row.record,'save',undefined,false);}const ids=new Set(members.map(r=>r.id));next.trash=next.trash.filter(r=>!ids.has(r.id));return validateState(next);}
export function amountFor(e,currency,precision){if(e.currency===currency&&e.precision===precision)return personalAmount(e);if(e.reportingCurrency===currency&&e.reportingPrecision===precision&&e.reportingMinor!=null)return e.personalMinor!=null?divideRounded(BigInt(e.reportingMinor)*BigInt(e.personalMinor),BigInt(e.minor)):BigInt(e.reportingMinor);return null;}
export function accountBalance(s,id,asOf){const a=s.accounts.find(a=>a.id===id);if(!a)throw Error('Account not found.');let n=BigInt(a.opening);for(const e of s.entries.filter(e=>e.ledger==='active'&&e.status==='posted'&&e.date<=asOf)){if(e.account===id){const amount=BigInt(e.settledMinor??e.minor);n+=e.kind==='income'||e.kind==='refund'?amount:['adjustment','settlement'].includes(e.kind)?(e.direction==='increase'?amount:-amount):-amount;}if(e.kind==='transfer'&&e.toAccount===id)n+=BigInt(e.receivedMinor);}return n;}
export function potBalance(s,id,asOf){const p=s.pots.find(p=>p.id===id);let n=0n,missing=0;for(const a of s.allocations.filter(a=>a.date<=asOf)){if(a.to===id)n+=BigInt(a.minor);if(a.from===id)n-=BigInt(a.minor);}for(const e of s.entries.filter(e=>e.ledger==='active'&&e.status==='posted'&&e.date<=asOf&&['expense','refund'].includes(e.kind))){const origin=e.kind==='refund'?s.entries.find(r=>r.id===e.original):e;const parts=origin?.splits||[{minor:origin?.minor||e.minor,pot:origin?.pot||e.pot}];if(!parts.some(part=>part.pot===id))continue;const v=amountFor(e,p.currency,p.precision);if(v===null){missing++;continue;}const portions=apportion(v,parts.map(part=>part.minor));for(let i=0;i<parts.length;i++)if(parts[i].pot===id)n+=e.kind==='refund'?portions[i]:-portions[i];}return {minor:n,missing};}
export function quarter(date){return date.slice(0,4)+'-Q'+(Math.floor((Number(date.slice(5,7))-1)/3)+1);}
export function closeQuarter(s,quarterId){
 if(s.settings.closedQuarters?.includes(quarterId))return s;if(!/^\d{4}-Q[1-4]$/.test(quarterId))throw Error('Choose a calendar quarter.');const[y,q]=quarterId.split('-Q').map(Number),end=new Date(Date.UTC(y,q*3,0)).toISOString().slice(0,10),nextDate=new Date(Date.UTC(y,q*3,1)).toISOString().slice(0,10);let next=structuredClone(s);
 const start=`${y}-${String((q-1)*3+1).padStart(2,'0')}-01`;if(next.entries.some(e=>e.ledger==='active'&&e.status==='planned'&&e.date>=start&&e.date<=end&&['expense','refund'].includes(e.kind)&&e.pot))throw Error('Review planned budget expenses and refunds in this quarter before closing it.');
 const target=next.pots.find(p=>p.id===s.settings.savingsPot&&p.kind==='savings'&&!p.archived);if(!target)throw Error('Choose an active default savings pot first.');
 for(const p of next.pots.filter(p=>p.kind==='budget')){const id=`quarter:${quarterId}:${p.id}`;if(next.allocations.some(a=>a.id===id))continue;const balance=potBalance(next,p.id,end);if(balance.missing)throw Error(`Reconcile missing valuations in ${p.name} before closing.`);if(balance.minor>0n){if(p.currency!==target.currency||p.precision!==target.precision)throw Error('Quarter closing needs a savings destination in the same currency.');integer(Number(balance.minor),true);next=commit(next,'allocations',{id,date:nextDate,from:p.id,to:target.id,minor:Number(balance.minor),note:`Unused budget from ${quarterId}`});}}
 next.settings.closedQuarters=[...(next.settings.closedQuarters||[]),quarterId];next.settings.openQuarterOverrides=(next.settings.openQuarterOverrides||[]).filter(q=>q!==quarterId);next.revision++;return next;
}
export function reopenQuarter(s,q){if(!s.settings.closedQuarters?.includes(q))throw Error('That quarter is not closed.');let next=structuredClone(s);next.settings.openQuarterOverrides=[...new Set([...(next.settings.openQuarterOverrides||[]),...next.settings.closedQuarters.filter(period=>period>=q)])];next.settings.closedQuarters=next.settings.closedQuarters.filter(period=>period<q);next.revision++;for(const a of [...next.allocations])if(a.id.startsWith('quarter:')&&a.id.split(':')[1]>=q)next=commit(next,'allocations',a,'delete');return validateState(next);}
export function autoCloseBudgets(s,asOf){const funding=s.allocations.filter(a=>!a.id.startsWith('quarter:')).map(a=>a.date).sort();if(!funding.length)return {state:s,issues:[]};let q=quarter(funding[0]),next=s,steps=0;const issues=[];while(q<quarter(asOf)){if(++steps>400){issues.push('Review the very old budget history before closing more quarters.');break;}if(next.settings.openQuarterOverrides?.includes(q)){issues.push(q+' is reopened for corrections. Close it when ready.');break;}try{next=closeQuarter(next,q);}catch(error){issues.push(q+': '+error.message);break;}const[year,n]=q.split('-Q').map(Number);q=(n===4?year+1:year)+'-Q'+(n===4?1:n+1);}return {state:next,issues};}
export function forecast(s,account,from,to,asOf=from){if(!validDate(from)||!validDate(to)||to<from)throw Error('Choose a valid forecast range.');const a=s.accounts.find(a=>a.id===account);if(!a)throw Error('Choose an account.');if(a.openingDate>from)throw Error('Account history begins on '+a.openingDate+'. Choose a period within the recorded history.');const past=from<asOf,previous=new Date(from+'T12:00:00Z');previous.setUTCDate(previous.getUTCDate()-1);let balance=accountBalance(s,account,past?previous.toISOString().slice(0,10):from),low=balance;const days=[];const events=s.entries.filter(e=>e.ledger==='active'&&e.date<=to&&((e.status==='planned'&&e.date>=from)||(e.status==='posted'&&(past?e.date>=from:e.date>from)))&&(e.account===account||e.toAccount===account)).sort((a,b)=>a.date.localeCompare(b.date));for(let d=from;d<=to;){const opening=balance,items=events.filter(e=>e.date===d);for(const e of items){if(e.account===account)balance+=['income','refund'].includes(e.kind)?BigInt(e.settledMinor??e.minor):['adjustment','settlement'].includes(e.kind)&&e.direction==='increase'?BigInt(e.settledMinor??e.minor):-BigInt(e.settledMinor??e.minor);if(e.kind==='transfer'&&e.toAccount===account)balance+=BigInt(e.receivedMinor);}if(balance<low)low=balance;days.push({date:d,opening,balance,entries:items});const dt=new Date(d+'T12:00:00Z');dt.setUTCDate(dt.getUTCDate()+1);d=dt.toISOString().slice(0,10);if(days.length>730)throw Error('Choose a forecast within two years.');}return {days,lowest:low,closing:balance};}
