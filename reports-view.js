// Reports: the figures behind the Reports tab. Pure functions, no DOM.
//
// Money rules (see AGENTS.md):
//   - amounts are exact integer minor units (BigInt here);
//   - spending is net of refunds and counts only the user's own share;
//   - totals are in the reporting currency, and only for entries that carry a
//     value in it. Entries without one are never converted or mixed in: they
//     are counted in `missing` and listed per currency in `others`.

import { amountFor } from './model.js';
import { digits } from './domain.js';
import { convert, divideRounded, personalAmount } from './money.js';
import { spendingRows } from './features.js';
import { monthBounds, validateCustomRange } from './forecast-view.js';

export const REPORT_PERIODS = [
  { id: 'this-month', label: 'This month' },
  { id: 'last-month', label: 'Last month' },
  { id: 'last-3-months', label: 'Last 3 months' },
  { id: 'this-year', label: 'This year' },
  { id: 'custom', label: 'Custom' }
];
export const DEFAULT_REPORT_PERIOD = 'this-month';
export const REPORT_VIEWS = [
  { id: 'donut', label: 'Donut' },
  { id: 'bars', label: 'Bars' },
  { id: 'trend', label: 'Trend' },
  { id: 'treemap', label: 'Treemap' }
];
export const DEFAULT_REPORT_VIEW = 'donut';
export const REPORT_MONTHS = 12;
export const REPORT_COLOURS = 10;
export const UNCATEGORISED = 'uncategorised';
export const SMALL_SLICE_PERCENT = 3;
// Comparisons: `back` lists how many months earlier each compared period lies.
// More than one means their average.
export const REPORT_COMPARISONS = [
  { id: 'last-month', label: 'vs last month', short: 'last month', back: [1] },
  { id: 'average-3', label: 'vs average of last 3 months', short: '3-month average', back: [1, 2, 3] },
  { id: 'average-6', label: 'vs average of last 6 months', short: '6-month average', back: [1, 2, 3, 4, 5, 6] },
  { id: 'last-year', label: 'vs same month last year', short: 'last year', back: [12] }
];
// The two groups that can be hidden: the payday flow's Fixed expenses and Regulars pots.
const HIDE_GROUPS = [
  { key: 'fixed', title: 'Fixed expenses', potKey: 'fixedPot' },
  { key: 'regulars', title: 'Regulars', potKey: 'regularsPot' }
];
export const HIDE_NAMES_SHOWN = 3;

/**
 * The dates a period covers, both ends counted.
 * "Last 3 months" is this month and the two before it; "Custom" takes `custom` ({ from, to }).
 */
export function reportPeriod(id, today, custom) {
  if (id === 'custom') return validateCustomRange(custom?.from, custom?.to);
  if (id === 'last-month') return monthBounds(today, -1);
  if (id === 'last-3-months') return { from: monthBounds(today, -2).from, to: monthBounds(today).to };
  if (id === 'this-year') return { from: today.slice(0, 4) + '-01-01', to: today.slice(0, 4) + '-12-31' };
  return monthBounds(today);
}

/** The `count` months ending with the one that holds `today`, oldest first: ['2025-12', …, '2026-11']. */
export function reportMonths(today, count = REPORT_MONTHS) {
  const months = [];
  for (let back = count - 1; back >= 0; back--) months.push(monthBounds(today, -back).from.slice(0, 7));
  return months;
}

/**
 * A spending row's own-share value in the reporting currency, or null when it has none.
 * Follows reportingTotal() in features.js, including the one-off display policy.
 */
function reportValue(s, row, currency, precision) {
  const direct = amountFor(row, currency, precision);
  if (direct !== null) return direct;
  const policy = s.settings.reportingDisplay;
  if (policy?.mode === 'oneoff' && row.reportingCurrency === policy.from && row.reportingMinor != null) {
    const value = BigInt(convert(row.reportingMinor, row.reportingPrecision, precision, policy.rate));
    return row.personalMinor != null ? divideRounded(value * BigInt(row.personalMinor), BigInt(row.minor)) : value;
  }
  return null;
}

/** Top-level expense categories in their saved order: the order colours are given in. */
function topLevelOrder(s) {
  return s.categories
    .map((category, position) => ({ category, position }))
    .filter(({ category }) => !category.parent && category.kind === 'expense')
    .sort((a, b) => (a.category.order ?? 0) - (b.category.order ?? 0) || a.position - b.position)
    .map(({ category }) => category.id);
}

/** For a category ID: its top-level ancestor and the child of that ancestor it sits under (null when it is the top itself). */
function categoryPlace(s, id, memo) {
  if (memo.has(id)) return memo.get(id);
  const byId = memo.byId || (memo.byId = new Map(s.categories.map(c => [c.id, c])));
  const path = [];
  const seen = new Set();
  for (let c = byId.get(id); c && !seen.has(c.id); c = c.parent ? byId.get(c.parent) : null) {
    seen.add(c.id);
    path.push(c);
  }
  const place = path.length ? { top: path[path.length - 1], child: path.length > 1 ? path[path.length - 2] : null } : { top: null, child: null };
  memo.set(id, place);
  return place;
}

/** Where a subcategory sits among its siblings, for a steady colour within its parent. */
function siblingColour(s, child, memo) {
  const key = 'siblings:' + child.parent;
  if (!memo.has(key)) {
    memo.set(key, s.categories
      .map((category, position) => ({ category, position }))
      .filter(({ category }) => category.parent === child.parent)
      .sort((a, b) => (a.category.order ?? 0) - (b.category.order ?? 0) || a.position - b.position)
      .map(({ category }) => category.id));
  }
  return memo.get(key).indexOf(child.id) % REPORT_COLOURS;
}

const sortBySize = (a, b) => (a.minor === b.minor ? a.name.localeCompare(b.name) : a.minor > b.minor ? -1 : 1);

/**
 * Everything the Reports tab shows.
 *   period  → { from, to }, both counted
 *   filters → { account, pot, includeTravel } (travel is off unless asked for: trips have their own view)
 *   exclude → pot IDs to hide: spending in a category whose own pot is one of them is left out
 *             of the totals, the categories and the months, and summed apart in `hidden`.
 *             The category decides, not the pot the purchase was paid from, so what is hidden
 *             is exactly the categories named on the toggle (see reportHideGroups).
 *   today   → fixes the last 12 months (or `monthCount` months)
 *
 * Returns
 *   currency, precision      the reporting currency every total below is in
 *   total, categories        the period: top-level categories, largest first, each with
 *                            { id, name, icon, colour, minor, children: [{ id, name, icon, colour, minor }] }
 *   months                   the last 12 months: { month, total, byCategory: { id: minor }, missing }
 *   monthCategories          the categories that appear in `months`, in colour order
 *   budget                   { pots: [{ id, name, kind, currency, precision, months: [{ month, budget, actual, missing }] }],
 *                              all: the same summed over pots in the reporting currency, leftOut: other pots' names }
 *   missing, others          period entries with no reporting value: how many, and their own-currency
 *                            sums kept apart as [{ currency, precision, minor, count }]
 *   hidden                   one per excluded pot: { pot, name, minor, missing } for the period,
 *                            `missing` being hidden entries with no reporting value (never added in)
 *
 * The budget series is a pot's own story: every posted purchase paid from it, whatever the
 * account or travel filter says, against the allocations made to it that month (sweeps by
 * the rollover are left out, so a tidy-up does not look like a smaller budget).
 * An excluded pot keeps its own series but is left out of "All pots" (named in `all.hidden`).
 */
export function reportsView(s, { period, filters = {}, exclude = [], today, monthCount = REPORT_MONTHS }) {
  const currency = s.settings.reportingCurrency;
  const precision = digits(currency);
  const { account = '', pot = '', includeTravel = false } = filters;
  const months = reportMonths(today, monthCount);
  const excluded = new Set(exclude.filter(Boolean));
  const potOfCategory = new Map(s.categories.map(c => [c.id, c.pot]));
  const hidden = new Map([...excluded].map(id => [id, { pot: id, name: s.pots.find(p => p.id === id)?.name || id, minor: 0n, ids: new Set() }]));
  const monthIndex = new Map(months.map((month, index) => [month, index]));
  const order = topLevelOrder(s);
  const colourOf = id => {
    const index = order.indexOf(id);
    return index < 0 ? -1 : index % REPORT_COLOURS;
  };
  const memo = new Map();

  const tops = new Map(); // id → { id, name, icon, colour, minor, children: Map }
  const monthRows = months.map(month => ({ month, total: 0n, byCategory: {}, missing: 0 }));
  const others = new Map();
  const missingIds = new Set();
  const monthMissing = months.map(() => new Set());
  let total = 0n;

  const potSeries = s.pots.filter(p => !p.archived).map(p => ({
    id: p.id, name: p.name, kind: p.kind, currency: p.currency, precision: p.precision,
    months: months.map(month => ({ month, budget: 0n, actual: 0n, missing: 0 }))
  }));
  const seriesOf = new Map(potSeries.map(series => [series.id, series]));

  for (const a of s.allocations) {
    const index = monthIndex.get(a.date.slice(0, 7));
    if (index == null || a.id.startsWith('rollover:') || a.id.startsWith('quarter:')) continue;
    if (seriesOf.has(a.to)) seriesOf.get(a.to).months[index].budget += BigInt(a.minor);
    if (seriesOf.has(a.from)) seriesOf.get(a.from).months[index].budget -= BigInt(a.minor);
  }

  const posted = s.entries.filter(e => e.ledger === 'active' && e.status === 'posted' && ['expense', 'refund'].includes(e.kind));
  for (const row of spendingRows(s, posted)) {
    const sign = row.kind === 'refund' ? -1n : 1n;
    const index = monthIndex.get(row.date.slice(0, 7));
    const entryId = row.sourceId || row.id;

    // Budget against actual, in the pot's own currency.
    const series = seriesOf.get(row.pot);
    if (series && index != null) {
      const value = amountFor(row, series.currency, series.precision);
      if (value === null) series.months[index].missing++;
      else series.months[index].actual += sign * value;
    }

    if (row.trip && !includeTravel) continue;
    if (account && row.account !== account) continue;
    if (pot && row.pot !== pot) continue;

    const inPeriod = row.date >= period.from && row.date <= period.to;
    if (!inPeriod && index == null) continue;

    const value = reportValue(s, row, currency, precision);
    const hide = excluded.size ? hidden.get(potOfCategory.get(row.category)) : null;
    if (hide) {
      if (inPeriod && value === null) hide.ids.add(entryId);
      else if (inPeriod) hide.minor += sign * value;
      continue;
    }
    if (value === null) {
      if (index != null) monthMissing[index].add(entryId);
      if (inPeriod) {
        missingIds.add(entryId);
        const key = row.currency + ':' + row.precision;
        const other = others.get(key) || { currency: row.currency, precision: row.precision, minor: 0n, ids: new Set() };
        other.minor += sign * personalAmount(row);
        other.ids.add(entryId);
        others.set(key, other);
      }
      continue;
    }

    const place = categoryPlace(s, row.category, memo);
    const topId = place.top?.id || UNCATEGORISED;
    const signed = sign * value;

    if (index != null) {
      monthRows[index].total += signed;
      monthRows[index].byCategory[topId] = (monthRows[index].byCategory[topId] || 0n) + signed;
    }
    if (!inPeriod) continue;

    total += signed;
    if (!tops.has(topId)) {
      tops.set(topId, {
        id: topId, name: place.top?.name || 'Uncategorised', icon: place.top?.icon || null,
        colour: colourOf(topId), minor: 0n, children: new Map()
      });
    }
    const top = tops.get(topId);
    top.minor += signed;
    // Spending put straight on the parent is kept as its own line beside the subcategories.
    const childId = place.child?.id || topId + ':direct';
    if (!top.children.has(childId)) {
      top.children.set(childId, {
        id: childId, name: place.child?.name || `${top.name} (no subcategory)`, icon: place.child?.icon || null,
        colour: place.child ? siblingColour(s, place.child, memo) : -1, direct: !place.child, minor: 0n
      });
    }
    top.children.get(childId).minor += signed;
  }

  const categories = [...tops.values()].map(top => {
    const children = [...top.children.values()].sort(sortBySize);
    return { ...top, children: children.some(child => !child.direct) ? children : [] };
  }).sort(sortBySize);

  monthRows.forEach((row, index) => { row.missing = monthMissing[index].size; });
  const monthIds = new Set(monthRows.flatMap(row => Object.keys(row.byCategory)));
  const byId = new Map(s.categories.map(c => [c.id, c]));
  const monthCategories = [...order.filter(id => monthIds.has(id)), ...(monthIds.has(UNCATEGORISED) ? [UNCATEGORISED] : [])]
    .map(id => ({ id, name: byId.get(id)?.name || 'Uncategorised', icon: byId.get(id)?.icon || null, colour: colourOf(id) }));

  // "All pots": only pots kept in the reporting currency can be added together.
  const sameCurrency = series => series.currency === currency && series.precision === precision && !excluded.has(series.id);
  const all = {
    id: '', name: 'All pots', currency, precision,
    months: months.map((month, index) => potSeries.filter(sameCurrency).reduce((sum, series) => ({
      month,
      budget: sum.budget + series.months[index].budget,
      actual: sum.actual + series.months[index].actual,
      missing: sum.missing + series.months[index].missing
    }), { month, budget: 0n, actual: 0n, missing: 0 })),
    leftOut: potSeries.filter(series => !sameCurrency(series) && !excluded.has(series.id)).map(series => series.name),
    hidden: potSeries.filter(series => excluded.has(series.id)).map(series => series.name)
  };

  return {
    currency, precision, period, total, categories,
    months: monthRows, monthCategories,
    budget: { pots: potSeries, all },
    missing: missingIds.size,
    hidden: [...hidden.values()].map(({ ids, ...group }) => ({ ...group, missing: ids.size })),
    others: [...others.values()]
      .map(({ ids, ...other }) => ({ ...other, count: ids.size }))
      .sort((a, b) => a.currency.localeCompare(b.currency))
  };
}

// ---------------------------------------------------------------------------
// Hiding Fixed expenses and Regulars
// ---------------------------------------------------------------------------

/**
 * The two hide toggles: [{ key: 'fixed' | 'regulars', title, pot, names, label }].
 * The pot is settings.paydayFlow.fixedPot / regularsPot, or failing that the pot named
 * "Fixed expenses" / "Regulars"; a group with no such pot is left out.
 * `names` are the categories that belong to the pot, each branch named once at its highest
 * point: a top-level category when it is in the pot, otherwise the subcategory that is
 * ("TfL" under a Transport that is paid from elsewhere). The label shows at most three, then "…":
 *   "Hide Fixed expenses (Bills, Subscriptions)"
 */
export function reportHideGroups(s) {
  const flow = s.settings.paydayFlow || {};
  const ordered = parent => s.categories
    .map((category, position) => ({ category, position }))
    .filter(({ category }) => (category.parent || '') === parent && category.kind === 'expense' && !category.archived)
    .sort((a, b) => (a.category.order ?? 0) - (b.category.order ?? 0) || a.position - b.position)
    .map(({ category }) => category);
  const namesIn = (pot, parent, seen) => ordered(parent).flatMap(category => {
    if (seen.has(category.id)) return [];
    seen.add(category.id);
    return category.pot === pot ? [category.name] : namesIn(pot, category.id, seen);
  });
  return HIDE_GROUPS.flatMap(({ key, title, potKey }) => {
    const pot = s.pots.find(p => p.id === flow[potKey])
      || s.pots.find(p => p.name.trim().toLowerCase() === title.toLowerCase());
    if (!pot) return [];
    const names = namesIn(pot.id, '', new Set());
    const shown = names.length > HIDE_NAMES_SHOWN ? [...names.slice(0, HIDE_NAMES_SHOWN), '…'] : names;
    return [{ key, title, pot: pot.id, names, label: `Hide ${title}` + (shown.length ? ` (${shown.join(', ')})` : '') }];
  });
}

// ---------------------------------------------------------------------------
// Comparing with earlier months
// ---------------------------------------------------------------------------

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A date moved `back` months earlier. The day number is kept, or clamped to the length of
 * the earlier month (30 Mar → 28 Feb). With `stickToEnd`, a month's last day stays a last day
 * (28 Feb → 31 Jan), so whole months are compared with whole months.
 */
function monthsEarlier(iso, back, stickToEnd) {
  const target = monthBounds(iso, -back);
  const lastDay = Number(target.to.slice(8));
  const isEnd = iso === monthBounds(iso).to;
  const day = stickToEnd && isEnd ? lastDay : Math.min(Number(iso.slice(8)), lastDay);
  return target.from.slice(0, 8) + String(day).padStart(2, '0');
}

/** '1–12 Nov', '28 Oct – 3 Nov', with the year when asked. */
function rangeLabel({ from, to }, withYear) {
  const part = (iso, day, year) => [day && Number(iso.slice(8)), MONTH_NAMES[Number(iso.slice(5, 7)) - 1], year && iso.slice(0, 4)].filter(Boolean).join(' ');
  if (from.slice(0, 7) === to.slice(0, 7)) return `${Number(from.slice(8))}–${part(to, true, withYear)}`;
  return `${part(from, true, withYear)} – ${part(to, true, withYear)}`;
}

/**
 * What a period is compared with.
 *   mode   → an ID from REPORT_COMPARISONS
 *   period → { from, to } as shown
 *   today  → for month-to-date fairness
 *
 * Month to date: when the period holds today and runs on past it (This month before the
 * month's last day), only the days so far are compared: `current` ends today, and each
 * earlier period covers the same day numbers of its own month, clamped to that month's
 * length (1–30 Mar is compared with 1–28 Feb). Otherwise whole periods are compared, a
 * month's last day matching the earlier month's last day.
 *
 * Returns { mode, label, short, toDate, current: { from, to }, periods: [{ from, to }], note },
 * newest period first, or null for an unknown mode. `note` says it in words:
 * "1–12 Nov vs 1–12 Oct".
 */
export function comparisonPeriod(mode, period, today) {
  const comparison = REPORT_COMPARISONS.find(c => c.id === mode);
  if (!comparison || !period) return null;
  const toDate = period.from <= today && today < period.to;
  const current = toDate ? { from: period.from, to: today } : { from: period.from, to: period.to };
  const periods = comparison.back.map(back => ({
    from: monthsEarlier(current.from, back, false),
    to: monthsEarlier(current.to, back, !toDate)
  }));
  const withYear = new Set([current, ...periods].flatMap(p => [p.from.slice(0, 4), p.to.slice(0, 4)])).size > 1;
  const note = `${rangeLabel(current, withYear)} vs ` + (periods.length === 1
    ? rangeLabel(periods[0], withYear)
    : `the average of ${periods.length} months, ${rangeLabel(periods[periods.length - 1], withYear)} to ${rangeLabel(periods[0], withYear)}`);
  return { mode, label: comparison.label, short: comparison.short, toDate, current, periods, note };
}

/** A change as a whole percentage of the earlier amount (rounded half up), or null when there is nothing positive to compare with. */
export function changePercent(diff, previous) {
  return previous > 0n ? Number(divideRounded(diff * 100n, previous)) : null;
}

/**
 * The period's figures beside the comparison's.
 *   mode    → an ID from REPORT_COMPARISONS
 *   report  → the reportsView() result for the same period, filters and exclude, when the
 *             caller already has it
 *
 * Every comparison period goes through reportsView() with the same filters and `exclude`,
 * so hidden groups stay hidden on both sides and only reporting-currency values are counted:
 * entries with no reporting value are never converted or added in, only counted in `missing`.
 *
 * Averages are exact integers: the amounts of the 3 or 6 periods are summed in minor units
 * and divided by the number of periods, rounded half up (half away from zero when refunds
 * make the sum negative). A period with no spending counts as zero and still counts in the
 * divisor. Each line is rounded on its own, so averaged lines can differ from the averaged
 * total by a minor unit.
 *
 * The current side is the report as shown. With month to date that is the same thing unless
 * posted entries are dated after today.
 *
 * Returns the comparisonPeriod() fields, plus
 *   total       { minor, previous, diff, percent }
 *   categories  the report's top-level categories in the same order, each with
 *               { previous, diff, percent, isNew } and children carrying the same; categories
 *               found only in the comparison follow with minor 0n, largest earlier amount first.
 *               `isNew` means nothing was recorded for it in any comparison period.
 *   missing     comparison entries left out for want of a reporting value
 */
export function compareView(s, { period, filters = {}, exclude = [], today, mode, report = null }) {
  const comparison = comparisonPeriod(mode, period, today);
  if (!comparison) return null;
  const current = report || reportsView(s, { period, filters, exclude, today });
  const count = BigInt(comparison.periods.length);

  const earlier = new Map(); // id → { item, sum }
  const add = (item, minor, parent = null) => {
    const found = earlier.get(item.id) || { item, parent, sum: 0n };
    found.sum += minor;
    earlier.set(item.id, found);
  };
  let sum = 0n, missing = 0;
  for (const range of comparison.periods) {
    const past = reportsView(s, { period: range, filters, exclude, today, monthCount: 1 });
    sum += past.total;
    missing += past.missing;
    for (const top of past.categories) {
      add(top, top.minor);
      // A category with nothing but direct spending has no children listed: it is all "no subcategory".
      if (top.children.length) top.children.forEach(child => add(child, child.minor, top.id));
      else add({ id: top.id + ':direct', name: `${top.name} (no subcategory)`, icon: null, colour: -1, direct: true }, top.minor, top.id);
    }
  }
  const average = minor => (count > 1n ? divideRounded(minor, count) : minor);
  const line = item => {
    const found = earlier.get(item.id);
    const previous = found ? average(found.sum) : 0n;
    const diff = item.minor - previous;
    return { ...item, previous, diff, percent: changePercent(diff, previous), isNew: !found };
  };
  const onlyEarlier = (parent, have) => [...earlier.values()]
    .filter(found => found.parent === parent && !have.has(found.item.id))
    .map(found => line({ ...found.item, minor: 0n, children: parent ? undefined : [] }))
    .sort((a, b) => (a.previous === b.previous ? a.name.localeCompare(b.name) : a.previous > b.previous ? -1 : 1));

  const categories = current.categories.map(top => {
    const children = top.children.length
      ? [...top.children.map(line), ...onlyEarlier(top.id, new Set(top.children.map(child => child.id))).filter(child => child.previous !== 0n)]
      : [];
    return { ...line(top), children };
  });
  categories.push(...onlyEarlier(null, new Set(current.categories.map(top => top.id))));

  const previous = average(sum);
  const diff = current.total - previous;
  return {
    ...comparison, currency: current.currency, precision: current.precision,
    total: { minor: current.total, previous, diff, percent: changePercent(diff, previous) },
    categories, missing
  };
}

/**
 * The comparison as a reference line for the trend: for each of the last `count` months,
 * what was spent in the month(s) it would be compared with (the month before, the average of
 * the 3 or 6 before, or the same month a year earlier), from a longer run of months.
 *   points → [{ month, actual, budget, missing }], oldest first, long enough to look back
 * Whole months throughout. Returns [{ month, minor }]; minor is null where the run does not
 * reach back far enough or the records had not begun, so nothing is drawn there.
 * Averages are rounded as in compareView().
 */
export function trendReference(points, mode, count = REPORT_MONTHS) {
  const comparison = REPORT_COMPARISONS.find(c => c.id === mode);
  const first = points.findIndex(point => point.actual !== 0n || point.budget !== 0n || point.missing);
  return points.slice(-count).map((point, offset) => {
    const index = points.length - Math.min(count, points.length) + offset;
    const from = comparison ? comparison.back.map(back => index - back) : [];
    if (!from.length || first < 0 || from.some(i => i < first)) return { month: point.month, minor: null };
    const total = from.reduce((n, i) => n + points[i].actual, 0n);
    return { month: point.month, minor: from.length > 1 ? divideRounded(total, BigInt(from.length)) : total };
  });
}

/**
 * Slices for a donut: positive amounts only, and when two or more are each under
 * `percent` of the total they are gathered into one "Other" slice that keeps its members.
 * Returns { total, slices }.
 */
export function groupSmallSlices(items, percent = SMALL_SLICE_PERCENT) {
  const positive = items.filter(item => item.minor > 0n);
  const total = positive.reduce((sum, item) => sum + item.minor, 0n);
  const isSmall = item => item.minor * 100n < total * BigInt(percent);
  const small = positive.filter(isSmall);
  if (small.length < 2) return { total, slices: positive };
  return {
    total,
    slices: [...positive.filter(item => !isSmall(item)), {
      id: 'other', name: 'Other', icon: null, colour: -1, other: true,
      minor: small.reduce((sum, item) => sum + item.minor, 0n), members: small
    }]
  };
}

/** A share of a total as a percentage with one decimal ('12.5'), from exact integers. */
export function sharePercent(minor, total) {
  if (total <= 0n || minor <= 0n) return '0';
  const tenths = divideRounded(minor * 1000n, total);
  return tenths % 10n === 0n ? String(tenths / 10n) : `${tenths / 10n}.${tenths % 10n}`;
}

/**
 * Squarified treemap (Bruls, Huizing, van Wijk). `values` are plain numbers; the result has
 * one { x, y, w, h } per value, in the same order, tiling a width × height rectangle with
 * areas in proportion to the values. Values of zero or less get an empty rectangle.
 */
export function squarify(values, width, height) {
  const out = values.map(() => ({ x: 0, y: 0, w: 0, h: 0 }));
  const sum = values.reduce((n, value) => n + Math.max(0, value), 0);
  if (!(sum > 0) || !(width > 0) || !(height > 0)) return out;

  const scale = width * height / sum;
  const items = values
    .map((value, index) => ({ index, area: Math.max(0, value) * scale }))
    .filter(item => item.area > 0)
    .sort((a, b) => b.area - a.area);

  let x = 0, y = 0, w = width, h = height;
  let row = [], rowArea = 0;

  /** The worst aspect ratio in a row laid along a side of the given length. */
  const worst = (largest, smallest, area, side) =>
    Math.max(side * side * largest / (area * area), area * area / (side * side * smallest));

  function layRow() {
    const alongHeight = w >= h;
    const thickness = rowArea / (alongHeight ? h : w);
    let offset = 0;
    for (const item of row) {
      const length = item.area / thickness;
      out[item.index] = alongHeight
        ? { x, y: y + offset, w: thickness, h: length }
        : { x: x + offset, y, w: length, h: thickness };
      offset += length;
    }
    if (alongHeight) { x += thickness; w -= thickness; } else { y += thickness; h -= thickness; }
    row = [];
    rowArea = 0;
  }

  for (const item of items) {
    const side = Math.min(w, h);
    if (row.length && worst(row[0].area, item.area, rowArea + item.area, side) > worst(row[0].area, row[row.length - 1].area, rowArea, side)) layRow();
    row.push(item);
    rowArea += item.area;
  }
  if (row.length) layRow();
  return out;
}
