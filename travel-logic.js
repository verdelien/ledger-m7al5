// Travel: trips, and the travel budget for a calendar year.
// Pure functions over the ledger state; nothing here touches the page.
//
// A trip record: { id, name, start, end, currency, account, pot, archived }.
// An entry belongs to a trip through `entry.trip`. A refund copies the trip
// and category of its purchase, so it is found the same way.
//
// Currencies are never added together. A total in the budget or reporting
// currency only counts entries that are in that currency or carry a recorded
// value in it (`amountFor`). Everything else is listed per original currency
// as "unvalued", and is never converted here.

import { digits, parseAmount, validDate } from './domain.js';
import { amountFor, commit, uid } from './model.js';
import { personalAmount } from './money.js';

const TRAVEL_ROOT = 'Travel';            // the top-level travel category
const TRAVEL_POT = 'Travel';             // the pot trips are paid from, when it exists
const TRAVEL_DEFAULT_BUDGET = '5000';    // a year's budget until the user sets one

/**
 * Where a category sits under Travel: null when it is not a travel category,
 * 'other' for Travel itself, else the ID of the child of Travel it falls under.
 */
function travelGroupOf(s, categoryId) {
  const seen = new Set();
  let id = categoryId, child = 'other';
  while (id && !seen.has(id)) {
    if (id === TRAVEL_ROOT) return child;
    seen.add(id);
    child = id;
    id = s.categories.find(c => c.id === id)?.parent || '';
  }
  return null;
}

/** True when the category is Travel or sits anywhere under it. */
export function isTravelCategory(s, categoryId) {
  return travelGroupOf(s, categoryId) !== null;
}

/** True when the entry belongs to a trip, or its category is Travel or under it. */
export function isTravelEntry(s, e) {
  return Boolean(e.trip) || isTravelCategory(s, e.category);
}

/** Posted purchases and refunds in the active ledger that count as travel. */
function travelPosted(s) {
  return s.entries.filter(e => e.ledger === 'active' && e.status === 'posted'
    && (e.kind === 'expense' || e.kind === 'refund') && isTravelEntry(s, e));
}

/** A purchase counts up, a refund counts down. */
const travelSign = e => (e.kind === 'refund' ? -1n : 1n);

/**
 * Add entries up in one currency. Returns the total of those with a value in
 * it, and the rest per original currency (own share, net of refunds).
 */
function travelSum(entries, currency, precision) {
  let total = 0n;
  const rest = new Map();
  for (const e of entries) {
    const value = amountFor(e, currency, precision);
    if (value !== null) { total += travelSign(e) * value; continue; }
    const line = rest.get(e.currency) || { currency: e.currency, precision: e.precision, minor: 0n, count: 0 };
    line.minor += travelSign(e) * personalAmount(e);
    line.count++;
    rest.set(e.currency, line);
  }
  return { total, unvalued: [...rest.values()].sort((a, b) => a.currency.localeCompare(b.currency)) };
}

/** The year's travel budget: { minor, currency, precision }. About 5,000 until it is set. */
export function travelBudget(s) {
  const saved = s.settings.travelBudget;
  if (saved && Number.isSafeInteger(saved.minor) && saved.minor > 0 && saved.currency) {
    return { minor: saved.minor, currency: saved.currency, precision: saved.precision };
  }
  const currency = s.settings.reportingCurrency;
  return { minor: parseAmount(TRAVEL_DEFAULT_BUDGET, currency), currency, precision: digits(currency) };
}

/** Set the yearly travel budget, in the reporting currency. Returns the next state. */
export function saveTravelBudget(s, { amountText }) {
  const currency = s.settings.reportingCurrency;
  let minor;
  try { minor = parseAmount(String(amountText ?? '').trim(), currency); } catch {
    throw Error(`Enter a budget above zero in ${currency}.`);
  }
  if (!(minor > 0)) throw Error(`Enter a budget above zero in ${currency}.`);
  // A settings change is saved as a new revision (as ui/currencies.js saveSettings does).
  const next = structuredClone(s);
  next.settings.travelBudget = { minor, currency, precision: digits(currency) };
  next.revision++;
  return next;
}

/**
 * Travel spending in one calendar year against the budget.
 * `spent`, `left`, `byTrip[].minor` and `outsideTrips` are BigInt in the budget currency.
 * A refund counts in the year it was received.
 */
export function travelYear(s, year) {
  const budget = travelBudget(s);
  const prefix = String(year) + '-';
  const entries = travelPosted(s).filter(e => e.date.startsWith(prefix));
  const { total: spent, unvalued } = travelSum(entries, budget.currency, budget.precision);
  const tripIds = [...new Set(entries.map(e => e.trip).filter(Boolean))];
  const byTrip = tripIds.map(id => {
    const trip = s.trips.find(t => t.id === id);
    return { tripId: id, name: trip?.name || 'A trip that no longer exists', minor: travelSum(entries.filter(e => e.trip === id), budget.currency, budget.precision).total };
  }).sort((a, b) => (b.minor > a.minor ? 1 : b.minor < a.minor ? -1 : a.name.localeCompare(b.name)));
  const outsideTrips = travelSum(entries.filter(e => !e.trip), budget.currency, budget.precision).total;
  return { year: Number(year), budget, spent, left: BigInt(budget.minor) - spent, unvalued, byTrip, outsideTrips };
}

/** Days from `start` to `end`, both counted. */
function travelDays(start, end) {
  const at = iso => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  return Math.round((at(end) - at(start)) / 86400000) + 1;
}

/**
 * Everything about one trip. Amounts are own share, net of refunds.
 *   entries        → purchases, oldest first: { entry, refunded, net (original currency), reporting (or null) }
 *   totalReporting → BigInt in the reporting currency, entries with a value in it only
 *   unvalued       → the rest, per original currency
 *   byCurrency     → totals in the currencies actually paid
 *   byGroup        → reporting totals per child of Travel ('other' for anything else), largest first
 *   perDay         → totalReporting ÷ days, rounded down
 */
export function tripSummary(s, tripId) {
  const trip = s.trips.find(t => t.id === tripId);
  if (!trip) throw Error('That trip no longer exists.');
  const currency = s.settings.reportingCurrency, precision = digits(currency);
  const all = travelPosted(s).filter(e => e.trip === tripId);
  const { total: totalReporting, unvalued } = travelSum(all, currency, precision);

  const purchases = all.filter(e => e.kind === 'expense')
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const entries = purchases.map(entry => {
    const refunds = all.filter(e => e.kind === 'refund' && e.original === entry.id);
    const refunded = refunds.reduce((sum, r) => sum + personalAmount(r), 0n);
    const own = amountFor(entry, currency, precision);
    const back = refunds.map(r => amountFor(r, currency, precision));
    const reporting = own === null || back.includes(null) ? null : back.reduce((sum, v) => sum - v, own);
    return { entry, refunded, net: personalAmount(entry) - refunded, reporting };
  });

  const paid = new Map(), groups = new Map();
  for (const e of all) {
    const line = paid.get(e.currency) || { currency: e.currency, precision: e.precision, minor: 0n };
    line.minor += travelSign(e) * personalAmount(e);
    paid.set(e.currency, line);
    const value = amountFor(e, currency, precision);
    if (value === null) continue;
    const id = travelGroupOf(s, e.category) || 'other';
    groups.set(id, (groups.get(id) || 0n) + travelSign(e) * value);
  }
  const byGroup = [...groups].map(([categoryId, minor]) => ({
    categoryId, minor, name: categoryId === 'other' ? 'Other' : s.categories.find(c => c.id === categoryId)?.name || 'Other'
  })).sort((a, b) => (b.minor > a.minor ? 1 : b.minor < a.minor ? -1 : a.name.localeCompare(b.name)));

  const days = travelDays(trip.start, trip.end);
  return {
    trip, entries, totalReporting, unvalued, reportingCurrency: currency, reportingPrecision: precision,
    byCurrency: [...paid.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    byGroup, days, perDay: totalReporting / BigInt(days)
  };
}

/**
 * Add a trip, or change one (`fields.id` set). Throws a readable error when
 * something is missing. Returns the next state.
 */
export function saveTrip(s, fields) {
  const old = fields.id ? s.trips.find(t => t.id === fields.id) : null;
  if (fields.id && !old) throw Error('That trip no longer exists.');
  const name = String(fields.name ?? '').trim();
  if (!name) throw Error('Give the trip a name.');
  if (name.length > 150) throw Error('Use a name of at most 150 characters.');
  const start = String(fields.start ?? ''), end = String(fields.end ?? '');
  if (!validDate(start) || !validDate(end)) throw Error('Choose the first and last day of the trip.');
  if (end < start) throw Error('The trip cannot end before it starts.');
  const currency = String(fields.currency ?? '');
  if (!s.settings.activeCurrencies.includes(currency) && currency !== old?.currency) throw Error('Choose one of your active currencies.');
  const account = fields.account || '';
  if (account && !s.accounts.some(a => a.id === account)) throw Error('Choose an account, or leave it as "Not set".');
  const pot = old ? old.pot || '' : s.pots.some(p => p.id === TRAVEL_POT) ? TRAVEL_POT : '';
  return commit(s, 'trips', { ...(old || {}), id: old?.id || uid(), name, start, end, currency, account, pot, archived: old?.archived || false });
}

/** Hide a trip from the lists. The record and its entries are kept. */
export function archiveTrip(s, id) {
  const trip = s.trips.find(t => t.id === id);
  if (!trip) throw Error('That trip no longer exists.');
  return commit(s, 'trips', { ...trip, archived: true });
}

/** The trip in use whose dates include `date`; the latest start wins when two overlap. Else null. */
export function tripForDate(s, date) {
  return s.trips.filter(t => !t.archived && t.start <= date && date <= t.end)
    .sort((a, b) => b.start.localeCompare(a.start) || a.name.localeCompare(b.name))[0] || null;
}

/** Trips in use: current and upcoming first (soonest first), then past ones (latest first). */
export function listTrips(s, today) {
  const live = s.trips.filter(t => !t.archived);
  return [
    ...live.filter(t => t.end >= today).sort((a, b) => a.start.localeCompare(b.start) || a.name.localeCompare(b.name)),
    ...live.filter(t => t.end < today).sort((a, b) => b.start.localeCompare(a.start) || a.name.localeCompare(b.name))
  ];
}
