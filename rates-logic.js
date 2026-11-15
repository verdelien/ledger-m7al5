// Dated exchange rates: rates the user saved for a day, and the reporting-
// currency value they give an entry. Pure functions over the ledger state.
//
// `settings.referenceRates` (the shape the previous version also reads):
//   [{ base, quote, rate, date }]   rate is decimal text: 1 base = rate quote
//
// Currencies are never combined without evidence. A rate saved for a date is
// evidence; `settings.defaultRates` (rough estimates) are not, and are never
// read here. A value is written onto an entry once and then left alone: past
// entries are never revalued behind the user's back.

import { digits, validDate } from './domain.js';
import { convert, rateParts } from './money.js';
import { commitBatch, quarter } from './model.js';

const savedRates = s => s.settings.referenceRates || [];
const withRates = (s, referenceRates) => ({ ...s, settings: { ...s.settings, referenceRates }, revision: s.revision + 1 });
const sameRate = (a, b) => a.base === b.base && a.quote === b.quote && a.date === b.date;

/** Save a rate for a day: 1 `base` = `rateText` `quote`. Replaces the rate already saved for that pair and day. */
export function saveRate(s, { base, quote, rateText, date }) {
  for (const code of [base, quote]) {
    if (!s.settings.activeCurrencies.includes(code)) digits(String(code ?? '')); // throws for a code that is not a currency
  }
  if (base === quote) throw Error('Choose two different currencies.');
  const rate = String(rateText ?? '').trim().replace(',', '.');
  if (!rate) throw Error(`Enter the rate: 1 ${base} = how many ${quote}?`);
  rateParts(rate); // a positive decimal, or a readable error
  if (!validDate(String(date ?? ''))) throw Error('Choose the date the rate applies to.');
  const record = { base, quote, rate, date };
  return withRates(s, [...savedRates(s).filter(r => !sameRate(r, record)), record]);
}

/** Remove the rate saved for that pair and day. Values already written onto entries stay. */
export function deleteRate(s, { base, quote, date }) {
  const rest = savedRates(s).filter(r => !sameRate(r, { base, quote, date }));
  return rest.length === savedRates(s).length ? s : withRates(s, rest);
}

/**
 * The latest saved rate on or before `date` that converts `from` into `to`:
 * { rate, reverse, date }. `rate` is the saved text; `reverse` is true when it
 * was saved the other way round (1 to = rate from), so the amount is divided
 * by it. A rate saved in the asked direction wins on the same day. Null
 * without one.
 */
export function rateOn(s, from, to, date) {
  let best = null;
  for (const r of savedRates(s)) {
    if (r.date > date) continue;
    const direct = r.base === from && r.quote === to;
    if (!direct && !(r.base === to && r.quote === from)) continue;
    if (!best || r.date > best.date || (r.date === best.date && direct && best.reverse)) {
      best = { rate: r.rate, reverse: !direct, date: r.date };
    }
  }
  return best;
}

/**
 * What an entry is worth in the reporting currency by the rate saved for its
 * date: { minor, precision }, in exact integer maths. Null when the entry is
 * already in the reporting currency or no rate covers its date.
 */
export function reportingValue(s, entry) {
  const reporting = s.settings.reportingCurrency;
  if (entry.currency === reporting) return null;
  const found = rateOn(s, entry.currency, reporting, entry.date);
  if (!found) return null;
  const precision = digits(reporting);
  try {
    return { minor: convert(entry.minor, entry.precision, precision, found.rate, found.reverse), precision };
  } catch {
    return null; // outside the supported range
  }
}

/**
 * The value an entry without one would get, or null. What the account was
 * really charged in the reporting currency comes first; an estimated charge
 * gives way to a rate saved for the date.
 */
function evidencedValue(s, entry) {
  const reporting = s.settings.reportingCurrency;
  if (entry.currency === reporting || entry.reportingMinor != null) return null;
  const dated = reportingValue(s, entry);
  const settled = entry.settledMinor != null && entry.settledCurrency === reporting && entry.settledMinor >= 0;
  if (settled && !(entry.settledEstimate && dated)) return { minor: entry.settledMinor, precision: entry.settledPrecision };
  return dated;
}

/**
 * The record with its reporting-currency value filled in, when there is
 * evidence for one and it has none yet. Otherwise the same record.
 */
export function withReportingValue(s, record) {
  const value = evidencedValue(s, record);
  if (!value) return record;
  return { ...record, reportingMinor: value.minor, reportingCurrency: s.settings.reportingCurrency, reportingPrecision: value.precision };
}

/**
 * Past entries a saved rate could value: posted expenses, refunds and incomes
 * in another currency, with no reporting value yet. Oldest first, each as
 * { entry, minor, precision }: the value it would get.
 */
export function unvaluedEntries(s) {
  if (!savedRates(s).length) return [];
  return s.entries
    .filter(e => e.ledger === 'active' && e.status === 'posted' && ['expense', 'refund', 'income'].includes(e.kind)
      && e.reportingMinor == null && e.currency !== s.settings.reportingCurrency
      // A closed budget quarter is not changed; reopen it first.
      && !s.settings.closedQuarters?.includes(quarter(e.date)) && reportingValue(s, e))
    .map(entry => ({ entry, ...evidencedValue(s, entry) }))
    .sort((a, b) => a.entry.date.localeCompare(b.entry.date) || a.entry.id.localeCompare(b.entry.id));
}

/**
 * Write the reporting value onto the entries in `ids`. Only entries that
 * `unvaluedEntries` lists are touched: one that already has a value keeps it.
 * Returns the same state when there is nothing to do.
 */
export function valueEntries(s, ids) {
  const wanted = new Set(ids);
  const operations = unvaluedEntries(s).filter(row => wanted.has(row.entry.id))
    .map(row => ({ table: 'entries', record: withReportingValue(s, row.entry) }));
  return operations.length ? commitBatch(s, operations) : s;
}
