export const categories = {'Groceries':'Life regulars','Transport':'Life regulars','Eating out':'Social','Shopping':'Clothing','Bills':'Bills','Travel':'Travel'};
export function digits(currency) {
 if(!/^[A-Z]{3}$/.test(currency)|| (Intl.supportedValuesOf&&!Intl.supportedValuesOf('currency').includes(currency))) throw Error('Choose a three-letter currency code.');
 return new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits;
}
// ISO 4217 codes and names, as 'CODE Name' separated by '|'. Covers the
// current national currencies, the fund codes, special drawing rights and the
// precious metals. Precision is not stored here: digits() supplies it.
const CURRENCY_LIST='AED UAE dirham|AFN Afghan afghani|ALL Albanian lek|AMD Armenian dram|ANG Netherlands Antillean guilder|AOA Angolan kwanza|ARS Argentine peso|AUD Australian dollar|AWG Aruban florin|AZN Azerbaijani manat|BAM Bosnia and Herzegovina convertible mark|BBD Barbadian dollar|BDT Bangladeshi taka|BGN Bulgarian lev|BHD Bahraini dinar|BIF Burundian franc|BMD Bermudian dollar|BND Brunei dollar|BOB Bolivian boliviano|BOV Bolivian mvdol|BRL Brazilian real|BSD Bahamian dollar|BTN Bhutanese ngultrum|BWP Botswana pula|BYN Belarusian rouble|BZD Belize dollar|CAD Canadian dollar|CDF Congolese franc|CHE WIR euro|CHF Swiss franc|CHW WIR franc|CLF Chilean unit of account (UF)|CLP Chilean peso|CNY Chinese yuan renminbi|COP Colombian peso|COU Colombian real value unit|CRC Costa Rican colón|CUP Cuban peso|CVE Cape Verdean escudo|CZK Czech koruna|DJF Djiboutian franc|DKK Danish krone|DOP Dominican peso|DZD Algerian dinar|EGP Egyptian pound|ERN Eritrean nakfa|ETB Ethiopian birr|EUR Euro|FJD Fijian dollar|FKP Falkland Islands pound|GBP Pound sterling|GEL Georgian lari|GHS Ghanaian cedi|GIP Gibraltar pound|GMD Gambian dalasi|GNF Guinean franc|GTQ Guatemalan quetzal|GYD Guyanese dollar|HKD Hong Kong dollar|HNL Honduran lempira|HTG Haitian gourde|HUF Hungarian forint|IDR Indonesian rupiah|ILS Israeli new shekel|INR Indian rupee|IQD Iraqi dinar|IRR Iranian rial|ISK Icelandic króna|JMD Jamaican dollar|JOD Jordanian dinar|JPY Japanese yen|KES Kenyan shilling|KGS Kyrgyzstani som|KHR Cambodian riel|KMF Comorian franc|KPW North Korean won|KRW South Korean won|KWD Kuwaiti dinar|KYD Cayman Islands dollar|KZT Kazakhstani tenge|LAK Lao kip|LBP Lebanese pound|LKR Sri Lankan rupee|LRD Liberian dollar|LSL Lesotho loti|LYD Libyan dinar|MAD Moroccan dirham|MDL Moldovan leu|MGA Malagasy ariary|MKD Macedonian denar|MMK Myanmar kyat|MNT Mongolian tögrög|MOP Macanese pataca|MRU Mauritanian ouguiya|MUR Mauritian rupee|MVR Maldivian rufiyaa|MWK Malawian kwacha|MXN Mexican peso|MXV Mexican investment unit (UDI)|MYR Malaysian ringgit|MZN Mozambican metical|NAD Namibian dollar|NGN Nigerian naira|NIO Nicaraguan córdoba|NOK Norwegian krone|NPR Nepalese rupee|NZD New Zealand dollar|OMR Omani rial|PAB Panamanian balboa|PEN Peruvian sol|PGK Papua New Guinean kina|PHP Philippine peso|PKR Pakistani rupee|PLN Polish złoty|PYG Paraguayan guaraní|QAR Qatari riyal|RON Romanian leu|RSD Serbian dinar|RUB Russian rouble|RWF Rwandan franc|SAR Saudi riyal|SBD Solomon Islands dollar|SCR Seychellois rupee|SDG Sudanese pound|SEK Swedish krona|SGD Singapore dollar|SHP Saint Helena pound|SLE Sierra Leonean leone|SOS Somali shilling|SRD Surinamese dollar|SSP South Sudanese pound|STN São Tomé and Príncipe dobra|SVC Salvadoran colón|SYP Syrian pound|SZL Swazi lilangeni|THB Thai baht|TJS Tajikistani somoni|TMT Turkmenistani manat|TND Tunisian dinar|TOP Tongan paʻanga|TRY Turkish lira|TTD Trinidad and Tobago dollar|TWD New Taiwan dollar|TZS Tanzanian shilling|UAH Ukrainian hryvnia|UGX Ugandan shilling|USD US dollar|USN US dollar (next day)|UYI Uruguayan peso in indexed units|UYU Uruguayan peso|UYW Uruguayan nominal wage index unit|UZS Uzbekistani sum|VED Venezuelan digital bolívar|VES Venezuelan sovereign bolívar|VND Vietnamese đồng|VUV Vanuatu vatu|WST Samoan tālā|XAF Central African CFA franc|XAG Silver (troy ounce)|XAU Gold (troy ounce)|XCD East Caribbean dollar|XCG Caribbean guilder|XDR IMF special drawing rights|XOF West African CFA franc|XPD Palladium (troy ounce)|XPF CFP franc|XPT Platinum (troy ounce)|XSU Sucre|XUA ADB unit of account|YER Yemeni rial|ZAR South African rand|ZMW Zambian kwacha|ZWG Zimbabwe gold';
/** Every catalogued currency as [code, name], in code order. */
export function currencyCatalogue(){return CURRENCY_LIST.split('|').map(row=>[row.slice(0,3),row.slice(4)]);}
/** The English name of a currency code, or '' when it is not catalogued. */
export function currencyName(code){return currencyCatalogue().find(row=>row[0]===code)?.[1]||'';}
/** Catalogue rows whose code or name contains the query; codes that start with it come first. */
export function searchCurrencies(query,exclude=[]){
 const q=String(query).trim().toLowerCase(),rows=currencyCatalogue().filter(([code,name])=>!exclude.includes(code)&&(code.toLowerCase().includes(q)||name.toLowerCase().includes(q)));
 return q?rows.sort((a,b)=>Number(b[0].toLowerCase().startsWith(q))-Number(a[0].toLowerCase().startsWith(q))):rows;
}
export function parseAmount(value,currency) {
 const d=digits(currency), match=/^(\d+)(?:[.,](\d+))?$/.exec(value.trim());
 if(!match || (match[2]||'').length>d) throw Error(`Enter a positive amount with at most ${d} decimal places, without thousands separators.`);
 const minor=BigInt(match[1])*10n**BigInt(d)+BigInt((match[2]||'').padEnd(d,'0')||'0');
 if(minor<=0n || minor>BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Amount must be positive and within the supported range.');
 return Number(minor);
}
export function validDate(date) {
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
 const dt=new Date(date+'T12:00:00Z'); return !isNaN(dt) && dt.toISOString().slice(0,10)===date;
}
export function validateEntry(e) {
 if(!e || typeof e.id!=='string'||!e.id || !validDate(e.date)||!Object.hasOwn(categories,e.category)||!Number.isSafeInteger(e.minor)||e.minor<=0) throw Error('An expense has invalid fields.');
 if(!Number.isInteger(e.precision)||e.precision<0||e.precision>6||!/^[A-Z]{3}$/.test(e.currency)) throw Error('An expense has invalid currency information.');
 if(!['',...new Set(Object.values(categories))].includes(e.pot)||typeof e.note!=='string'||e.note.length>500) throw Error('An expense has an invalid pot or note.');
 return {id:e.id,date:e.date,category:e.category,minor:e.minor,currency:e.currency,precision:e.precision,pot:e.pot,note:e.note};
}
export function validateBackup(data) {
 if(data?.version!==1||!Array.isArray(data.entries)) throw Error('Choose a version 1 expense backup.');
 const ids=new Set(); return data.entries.map(e=>{const row=validateEntry(e); if(ids.has(row.id)) throw Error('The backup contains duplicate expense IDs.'); ids.add(row.id);return row;});
}
export function totalByCurrency(entries) {
 const totals=new Map(); for(const e of entries){const key=e.currency+':'+e.precision;totals.set(key,(totals.get(key)||0n)+BigInt(e.minor));} return totals;
}
export function money(minor,currency,precision) {
 const value=BigInt(minor),n=value<0n?-value:value,scale=10n**BigInt(precision),fraction=precision?'.'+(n%scale).toString().padStart(precision,'0'):'';
 return `${currency} ${value<0n?'-':''}${(n/scale).toLocaleString('en-GB')}${fraction}`;
}
export function monthCells(year,month) {
 const first=new Date(Date.UTC(year,month,1)); const offset=(first.getUTCDay()+6)%7;
 const count=new Date(Date.UTC(year,month+1,0)).getUTCDate();
 return Array.from({length:Math.ceil((offset+count)/7)*7},(_,i)=>i<offset||i>=offset+count?null:`${year}-${String(month+1).padStart(2,'0')}-${String(i-offset+1).padStart(2,'0')}`);
}
