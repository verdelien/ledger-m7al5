export function rateParts(value){const match=/^(\d+)(?:\.(\d{1,12}))?$/.exec(value);if(!match)throw Error('Use a positive rate with up to 12 decimal places.');const raw=(match[1]+(match[2]||'')).replace(/^0+/,'');if(raw.length>15||!raw)throw Error('Rate must be positive and have at most 15 significant digits.');return {numerator:BigInt(raw),denominator:10n**BigInt((match[2]||'').length)};}
export function divideRounded(n,d){if(d<=0n)throw Error('Invalid divisor.');const sign=n<0n?-1n:1n,x=n<0n?-n:n;return sign*(x/d+(x%d*2n>=d?1n:0n));}
export function convert(minor,sourcePrecision,targetPrecision,rate,reverse=false){const {numerator,denominator}=rateParts(rate);const top=BigInt(minor)*10n**BigInt(targetPrecision)*(reverse?denominator:numerator),bottom=10n**BigInt(sourcePrecision)*(reverse?numerator:denominator);const result=divideRounded(top,bottom);if(result>BigInt(Number.MAX_SAFE_INTEGER)||result<BigInt(Number.MIN_SAFE_INTEGER))throw Error('Converted amount exceeds the supported range.');return Number(result);}
export function personalAmount(e){return BigInt(e.personalMinor??e.minor);}
export function apportion(total,weights){const t=BigInt(total),w=weights.map(BigInt),sum=w.reduce((n,x)=>n+x,0n);if(t<0n||sum<=0n||w.some(x=>x<0n))throw Error('Invalid split weights.');const out=w.map(x=>t*x/sum);let rest=t-out.reduce((n,x)=>n+x,0n);const order=w.map((x,i)=>({i,remainder:t*x%sum})).sort((a,b)=>a.remainder===b.remainder?a.i-b.i:a.remainder>b.remainder?-1:1);for(const r of order){if(rest===0n)break;out[r.i]++;rest--;}return out;}
// A rough amount in the account's currency for a purchase made in another one, from settings.defaultRates
// (1 CODE = that many units of the reporting currency). `from` and `to` are {currency, precision}.
// Returns integer minor units, or null when a rate is missing or unusable. An estimate only: never evidence of the real debit.
export function estimateAccountAmount(minor,from,to,reportingCurrency,rates){
 const rateOf=code=>code===reportingCurrency?'1':rates?.[code];
 const fromRate=rateOf(from.currency),toRate=rateOf(to.currency);
 if(!fromRate||!toRate||!Number.isSafeInteger(minor)||minor<0)return null;
 let source,target;
 try{source=rateParts(fromRate);target=rateParts(toRate);}catch{return null;}
 const top=BigInt(minor)*source.numerator*target.denominator*10n**BigInt(to.precision);
 const bottom=source.denominator*target.numerator*10n**BigInt(from.precision);
 const result=divideRounded(top,bottom);
 return result>BigInt(Number.MAX_SAFE_INTEGER)?null:Number(result);
}
