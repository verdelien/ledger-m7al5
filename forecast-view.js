// Everything the Calendar and Forecast screens calculate. Pure functions over
// the ledger state: nothing here saves, reads the clock or touches the page.
//
// Money is integer minor units (BigInt while summing). Currencies are never
// added together: an amount with no evidence of its value in the wanted
// currency is kept apart and reported as "not counted".

import { digits, validDate } from './domain.js';
import { amountFor, accountBalance, potBalance, seedEstimates, DEFAULT_FORECAST_POTS } from './model.js';
import { divideRounded, rateParts } from './money.js';
import { occurrences } from './planning.js';
import { spendingRows, withinCategory } from './features.js';
import { nextPayday } from './payday.js';

export const FORECAST_RANGES = [
  { id: 'month', label: 'This month' },
  { id: 'next30', label: 'Next 30 days' },
  { id: 'before-payday', label: 'Before payday' },
  { id: 'custom', label: 'Custom' }
];
export const MAX_CUSTOM_RANGE_DAYS = 366;
export const DEFAULT_FORECAST_RANGE = 'before-payday';
export const ALL_ACCOUNTS = 'all';

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** `iso` moved by a number of days (negative goes back). */
export function shiftDays(iso, count) {
  const date = new Date(iso + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

/** Days from `from` to `to`, counting both ends. */
export function daysInclusive(from, to) {
  return Math.round((Date.parse(to + 'T12:00:00Z') - Date.parse(from + 'T12:00:00Z')) / 86400000) + 1;
}

/** First and last day of the month `offset` months away from the one holding `iso`. */
export function monthBounds(iso, offset = 0) {
  const [year, month] = iso.split('-').map(Number);
  const first = new Date(Date.UTC(year, month - 1 + offset, 1));
  const last = new Date(Date.UTC(year, month + offset, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

/** A custom range the user typed: both dates valid, From on or before To, and at most 366 days, both ends counted. Throws a readable error otherwise. */
export function validateCustomRange(from, to) {
  if (!validDate(from) || !validDate(to)) throw Error('Choose both dates.');
  if (from > to) throw Error('From must be on or before To.');
  if (daysInclusive(from, to) > MAX_CUSTOM_RANGE_DAYS) throw Error(`Choose a range of at most ${MAX_CUSTOM_RANGE_DAYS} days.`);
  return { from, to };
}

/**
 * The dates a forecast range covers.
 *   from/to → what the range is called (This month runs from the 1st)
 *   start   → where the sum of upcoming items begins: today
 *   days    → days from today to the end, both counted (0 or less: the range has ended)
 * "Before payday" ends the day before the next payday after today.
 * "Custom" takes its dates from `custom` ({ from, to }).
 */
export function forecastRange(id, today, settings, custom) {
  if (!validDate(today)) throw Error('Choose a valid date.');
  const month = monthBounds(today);
  let from = today;
  let to;
  if (id === 'month') { from = month.from; to = month.to; }
  else if (id === 'next30') to = shiftDays(today, 29);
  else if (id === 'before-payday') to = shiftDays(nextPayday(shiftDays(today, 1), settings), -1);
  else if (id === 'custom') ({ from, to } = validateCustomRange(custom?.from, custom?.to));
  else throw Error('Unknown forecast range.');
  return { id, from, to, start: today, days: daysInclusive(today, to) };
}

// ---------------------------------------------------------------------------
// Estimates (regular weekly spending the user has not recorded yet)
// ---------------------------------------------------------------------------

/**
 * The user's estimates. Until a list has been saved, the seeded pair
 * (Groceries and TfL, £50 a week each) is used, matched to this ledger's
 * categories by ID and then by name.
 */
export function estimatesOf(s) {
  if (Array.isArray(s.settings.estimates)) return s.settings.estimates;
  return seedEstimates().map(seed => {
    const category = s.categories.find(c => c.id === seed.category)
      || s.categories.find(c => c.kind === 'expense' && c.name.trim().toLowerCase() === seed.name.toLowerCase());
    return { ...seed, category: category?.id || '' };
  });
}

/**
 * One line per week (or part of a week) of an estimate between `from` and
 * `to`. A part week costs amount × days ÷ 7, rounded to the nearest minor unit.
 */
export function estimateLines(estimate, from, to) {
  const lines = [];
  for (let date = from; date <= to; date = shiftDays(date, 7)) {
    const days = Math.min(7, daysInclusive(date, to));
    const minor = days === 7 ? BigInt(estimate.amountMinor) : divideRounded(BigInt(estimate.amountMinor) * BigInt(days), 7n);
    lines.push({
      id: `${estimate.id}:${date}`, estimate: estimate.id, tag: 'estimate', name: estimate.name, category: estimate.category,
      date, days, minor, currency: estimate.currency, precision: digits(estimate.currency)
    });
  }
  return lines;
}

/**
 * Trust aid: for each estimate, what it would have come to last calendar
 * month and what was actually recorded in its category (subcategories
 * included, refunds taken off, own share only). Entries in another currency
 * without evidence of their value are counted in `missing`, not in `actual`.
 */
export function estimateTrust(s, today) {
  const { from, to } = monthBounds(today, -1);
  const posted = s.entries.filter(e => e.ledger === 'active' && e.status === 'posted' && e.date >= from && e.date <= to);
  const rows = spendingRows(s, posted);
  return estimatesOf(s).map(estimate => {
    const precision = digits(estimate.currency);
    let actual = 0n;
    let missing = 0;
    if (estimate.category) {
      for (const row of rows.filter(r => withinCategory(s, r.category, estimate.category))) {
        const value = amountFor(row, estimate.currency, precision);
        if (value === null) missing++;
        else actual += row.kind === 'refund' ? -value : value;
      }
    }
    return {
      estimate, from, to, currency: estimate.currency, precision,
      estimated: divideRounded(BigInt(estimate.amountMinor) * BigInt(daysInclusive(from, to)), 7n),
      actual, missing
    };
  });
}

// ---------------------------------------------------------------------------
// Planned items (fixed: schedules and planned entries)
// ---------------------------------------------------------------------------

/**
 * Planned entries between `from` and `to`, plus the schedule dates from
 * `asOf` onwards that have no entry yet. Nothing is written: a schedule date
 * is returned as an entry-shaped item with `virtual: true`.
 * A card repayment that has no entry yet is estimated from the card's debt
 * on `asOf` (`estimated: true`), once per schedule, as the model does.
 * Each item carries `label`, a readable name.
 */
export function plannedItems(s, from, to, asOf) {
  if (!validDate(from) || !validDate(to) || !validDate(asOf)) throw Error('Choose valid dates.');
  const items = [];
  if (to < from) return items;
  const scheduleName = id => s.schedules.find(r => r.id === id)?.name;
  const categoryName = id => s.categories.find(c => c.id === id)?.name;
  const label = e => scheduleName(e.schedule) || e.note || categoryName(e.category) || (e.kind === 'transfer' ? 'Transfer' : e.kind);

  for (const e of s.entries) {
    if (e.ledger === 'active' && e.status === 'planned' && e.date >= from && e.date <= to) {
      items.push({ ...e, label: label(e), estimated: e.valuationStatus === 'estimated' });
    }
  }

  const start = from > asOf ? from : asOf;
  if (start <= to) {
    const known = new Set(s.entries.map(e => e.id));
    for (const t of s.trash) if (t.table === 'entries') known.add(t.record.id);
    for (const rule of s.schedules) {
      if (rule.archived || !rule.entry) continue;
      // The model keeps one open repayment per card; do the same here.
      if (rule.repayment && s.entries.some(e => e.schedule === rule.id && e.status === 'planned')) continue;
      for (const date of occurrences(rule, start, to)) {
        const id = `scheduled:${rule.id}:${date}`;
        if (known.has(id)) continue;
        const version = (rule.versions || []).filter(v => v.effectiveDate <= date)
          .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate)).at(-1);
        let entry = version?.entry || rule.entry;
        let estimated = false;
        if (rule.repayment) {
          const debt = s.accounts.some(a => a.id === entry.toAccount) ? -accountBalance(s, entry.toAccount, asOf) : 0n;
          if (debt <= 0n) break;
          entry = { ...entry, minor: Number(debt), receivedMinor: Number(debt) };
          estimated = true;
        }
        items.push({ ...entry, id, date, status: 'planned', schedule: rule.id, ledger: 'active', virtual: true, estimated, label: rule.name || label(entry) });
        if (rule.repayment) break;
      }
    }
  }
  return items.sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------
// Calendar day totals
// ---------------------------------------------------------------------------

/** Add an entry's own-share amount to per-currency buckets: the reporting currency when its value there is known, otherwise its own. */
function addToBuckets(buckets, s, entry, sign) {
  const reporting = s.settings.reportingCurrency;
  const reportingValue = amountFor(entry, reporting, digits(reporting));
  const code = reportingValue === null ? entry.currency : reporting;
  const value = reportingValue === null ? amountFor(entry, entry.currency, entry.precision) : reportingValue;
  const bucket = buckets.get(code) || { currency: code, precision: reportingValue === null ? entry.precision : digits(reporting), minor: 0n };
  bucket.minor += sign * value;
  buckets.set(code, bucket);
}

/**
 * Money per day between `from` and `to`:
 *   spent   → posted expenses less refunds (own share), by currency
 *   planned → planned money going out (expenses and transfers such as the card repayment), by currency
 *   posted / items → the records behind them, and every other record that day, for the day sheet
 * Returns a Map keyed by date; days with nothing are absent.
 */
export function calendarDays(s, from, to, asOf) {
  const days = new Map();
  const day = date => {
    if (!days.has(date)) days.set(date, { date, spent: new Map(), planned: new Map(), posted: [], items: [] });
    return days.get(date);
  };
  for (const e of s.entries) {
    if (e.ledger !== 'active' || e.status !== 'posted' || e.date < from || e.date > to) continue;
    const cell = day(e.date);
    cell.posted.push(e);
    if (e.kind === 'expense') addToBuckets(cell.spent, s, e, 1n);
    else if (e.kind === 'refund') addToBuckets(cell.spent, s, e, -1n);
  }
  for (const item of plannedItems(s, from, to, asOf)) {
    const cell = day(item.date);
    cell.items.push(item);
    if (item.kind === 'expense' || item.kind === 'transfer') addToBuckets(cell.planned, s, item, 1n);
  }
  return days;
}

/** A rough size in the reporting currency, used only to rank currencies. Never shown and never summed. */
function roughSize(bucket, settings) {
  const size = bucket.minor < 0n ? -bucket.minor : bucket.minor;
  let rate = { numerator: 1n, denominator: 1n };
  if (bucket.currency !== settings.reportingCurrency) {
    try { rate = rateParts(settings.defaultRates?.[bucket.currency] || '1'); } catch { /* keep 1 */ }
  }
  return size * rate.numerator * 10n ** 12n / (rate.denominator * 10n ** BigInt(bucket.precision));
}

/**
 * The one amount a calendar cell shows for a set of currency buckets.
 * One currency: that total. Several (conversion evidence is missing for
 * some): the largest, with `more: true` so the cell can add a "+".
 * Returns null when there is nothing to show.
 */
export function cellAmount(buckets, settings) {
  const live = [...buckets.values()].filter(b => b.minor !== 0n);
  if (!live.length) return null;
  live.sort((a, b) => {
    const [sizeA, sizeB] = [roughSize(a, settings), roughSize(b, settings)];
    return sizeA === sizeB ? a.currency.localeCompare(b.currency) : sizeA > sizeB ? -1 : 1;
  });
  return { ...live[0], more: live.length > 1 };
}

/** A short amount for a narrow cell, in whole major units: 12, 950, 1.2k, 18k, 1.2m. Rounded; the day sheet has the exact figure. */
export function compactAmount(minor, precision) {
  const value = BigInt(minor);
  const size = value < 0n ? -value : value;
  const sign = value < 0n ? '−' : '';
  const whole = divideRounded(size, 10n ** BigInt(precision));
  if (whole < 1000n) return sign + whole;
  const scaled = (unit, letter) => {
    const tenths = divideRounded(size, 10n ** BigInt(precision) * unit / 10n);
    if (tenths >= 100n) return sign + divideRounded(tenths, 10n) + letter;
    return sign + (tenths / 10n) + (tenths % 10n ? '.' + (tenths % 10n) : '') + letter;
  };
  return divideRounded(size, 10n ** BigInt(precision) * 1000n) >= 1000n ? scaled(1000000n, 'm') : scaled(1000n, 'k');
}

// ---------------------------------------------------------------------------
// Forecast
// ---------------------------------------------------------------------------

/** Accounts a forecast can cover: not archived and not investments. */
export function forecastAccounts(s) {
  return s.accounts.filter(a => !a.archived && a.type !== 'investment');
}

/**
 * The account choice a forecast opens with: the default account when one is
 * set, else the first GBP current account, else the first current account in
 * the reporting currency, else every account in the reporting currency.
 */
export function defaultForecastAccount(s) {
  const accounts = forecastAccounts(s);
  const pick = accounts.find(a => a.id === s.settings.defaultAccount)
    || accounts.find(a => a.type === 'current' && a.currency === 'GBP')
    || accounts.find(a => a.type === 'current' && a.currency === s.settings.reportingCurrency);
  return pick ? pick.id : ALL_ACCOUNTS;
}

/**
 * The pots the "Left in pots" block shows, in the user's order: the saved
 * choice (settings.forecastPots), or Fixed expenses, Regulars and Flexible
 * until one is saved. Pots that are archived or gone are left out.
 */
export function forecastPotsOf(s) {
  const wanted = Array.isArray(s.settings.forecastPots) ? s.settings.forecastPots : DEFAULT_FORECAST_POTS;
  return wanted.filter(id => s.pots.some(p => p.id === id && !p.archived));
}

/** What one planned item does to an account, in that account's currency. null: it does not touch it. 'unknown': it does, by an amount in another currency with no settled value. */
function effectOnAccount(item, account, assumeUnassigned) {
  let effect = null;
  const unassigned = !item.account && assumeUnassigned && ['expense', 'income', 'refund'].includes(item.kind);
  if (item.account === account.id || unassigned) {
    if (item.settledMinor == null && (item.currency !== account.currency || item.precision !== account.precision)) return 'unknown';
    const amount = BigInt(item.settledMinor ?? item.minor);
    const adds = ['income', 'refund'].includes(item.kind)
      || (['adjustment', 'settlement'].includes(item.kind) && item.direction === 'increase');
    effect = adds ? amount : -amount;
  }
  if (item.kind === 'transfer' && item.toAccount === account.id) effect = (effect || 0n) + BigInt(item.receivedMinor ?? item.minor);
  return effect;
}

/**
 * The forecast for a range.
 *   account → an account ID, or ALL_ACCOUNTS for every account held in the reporting currency
 *   pots    → the pot IDs to report on (see forecastPotsOf); none by default
 *
 * left = balance today + planned items up to the end of the range − estimates.
 * Planned items and estimates count from `today` to `range.to`, both included.
 * A planned expense or income with no account is taken to go through the
 * chosen account(s). Anything whose amount is not known in the forecast
 * currency is listed with `counted: false` and left out of the sums.
 * `pots` has one line per pot asked for: its balance today and what is left
 * in it at the end of the range.
 */
export function forecastSummary(s, { range, today, account = ALL_ACCOUNTS, pots = [] }) {
  const all = forecastAccounts(s);
  const chosen = account === ALL_ACCOUNTS
    ? all.filter(a => a.currency === s.settings.reportingCurrency)
    : all.filter(a => a.id === account);
  if (!chosen.length) return null;
  const { currency, precision } = chosen[0];
  if (chosen.some(a => a.currency !== currency || a.precision !== precision)) throw Error('A forecast covers one currency at a time.');

  let balance = 0n;
  for (const a of chosen) balance += accountBalance(s, a.id, today);

  const planned = plannedItems(s, today, range.to, today);
  const fixed = [];
  let fixedTotal = 0n; // signed: money out is negative
  for (const item of planned) {
    let effect = null;
    let unknown = false;
    chosen.forEach((a, index) => {
      const one = effectOnAccount(item, a, index === 0);
      if (one === 'unknown') unknown = true;
      else if (one !== null) effect = (effect ?? 0n) + one;
    });
    if (effect === null && !unknown) continue; // another account's business
    const counted = !unknown;
    if (counted) fixedTotal += effect;
    fixed.push({
      id: item.id, tag: 'fixed', name: item.label, date: item.date, kind: item.kind, category: item.category || '',
      estimated: !!item.estimated, counted,
      minor: counted ? effect : BigInt(item.minor), currency: counted ? currency : item.currency, precision: counted ? precision : item.precision
    });
  }

  const estimates = [];
  let estimateTotal = 0n;
  for (const estimate of estimatesOf(s)) {
    if (estimate.every !== 'week') continue;
    for (const line of estimateLines(estimate, today, range.to)) {
      const counted = line.currency === currency && line.precision === precision;
      if (counted) estimateTotal += line.minor;
      estimates.push({ ...line, counted });
    }
  }
  estimates.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));

  const left = balance + fixedTotal - estimateTotal;
  const uncounted = fixed.filter(line => !line.counted).length + estimates.filter(line => !line.counted).length;

  return {
    currency, precision, accounts: chosen.map(a => a.id),
    balance, fixedTotal, estimateTotal, left, uncounted,
    fixed, estimates,
    pots: pots.map(id => potForecast(s, id, planned, today, range.to)).filter(Boolean)
  };
}

/** A pot's balance today less the planned spending and the estimates that draw on it, up to `to`. `missing` counts amounts with no value in the pot's currency. */
function potForecast(s, potId, planned, today, to) {
  const pot = s.pots.find(p => p.id === potId);
  if (!pot) return null;
  const now = potBalance(s, potId, today);
  let minor = now.minor;
  let missing = now.missing;
  for (const row of spendingRows(s, planned).filter(r => r.pot === potId)) {
    const value = amountFor(row, pot.currency, pot.precision);
    if (value === null) missing++;
    else minor += row.kind === 'refund' ? value : -value;
  }
  for (const estimate of estimatesOf(s)) {
    if (estimate.every !== 'week' || s.categories.find(c => c.id === estimate.category)?.pot !== potId) continue;
    if (estimate.currency !== pot.currency || digits(estimate.currency) !== pot.precision) { missing++; continue; }
    for (const line of estimateLines(estimate, today, to)) minor -= line.minor;
  }
  return { id: potId, name: pot.name, icon: pot.icon || null, currency: pot.currency, precision: pot.precision, balance: now.minor, left: minor, missing };
}
