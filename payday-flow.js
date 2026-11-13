// The monthly payday flow. Pure functions over the ledger state: nothing here
// saves, reads the clock or touches the page.
//
// On payday the salary is shared out between pots, in this order:
//   1. savings    a fixed amount plus a percentage of the salary
//   2. fixed      fill "Fixed expenses" up to what is due before the next payday
//   3. regulars   fill "Regulars" up to the weekly estimates until the next payday
//   4. leftover   whatever is left goes to "Flexible savings"
// When the percentage is of disposable income (the salary less the fixed and
// regulars steps), savings come third instead: fixed, regulars, savings, leftover.
//
// Pots are a plan, not bank cash: every line is an allocation from outside
// into a pot, linked to the salary entry. No money leaves an account, and
// nothing is ever taken out of a pot (savings included) to cover a shortfall.
// Money is integer minor units (BigInt while summing), one currency only.

import { amountFor, potBalance, commitBatch, migratePaydayFlow } from './model.js';
import { divideRounded } from './money.js';
import { spendingRows, withinCategory } from './features.js';
import { forecastRange, estimatesOf, estimateLines, plannedItems } from './forecast-view.js';

/** The income category that starts the flow. */
export const SALARY_CATEGORY = 'Salary';

/** The steps, in the order they are filled. */
export const PAYDAY_FLOW_STEPS = [
  { id: 'savings', potKey: 'savingsPot', label: 'Savings' },
  { id: 'fixed', potKey: 'fixedPot', label: 'Fixed expenses' },
  { id: 'regulars', potKey: 'regularsPot', label: 'Regulars' },
  { id: 'leftover', potKey: 'leftoverPot', label: 'What is left' }
];

/** Used until the user saves their own in Settings → Payday. The savings portion starts at nothing. */
export const DEFAULT_PAYDAY_FLOW = Object.freeze({
  savingsPot: 'savings',
  savings: Object.freeze({ fixedMinor: 0, percent: 0, percentBase: 'total' }),
  fixedPot: 'Bills', regularsPot: 'Life regulars', leftoverPot: 'flexible-savings'
});

/**
 * settings.paydayFlow with defaults filled in. The savings portion is both parts added together:
 *   savings.fixedMinor   an amount in minor units
 *   savings.percent      hundredths of a percent (1250 = 12.5%)
 *   savings.percentBase  'total'       the percentage is of the salary
 *                        'disposable'  of the salary less the fixed and regulars steps
 * A setting still in the earlier savingsMode/savingsValue shape is read as the new one.
 */
export function paydayFlowSetting(s) {
  const saved = migratePaydayFlow(s.settings.paydayFlow) || {};
  return { ...DEFAULT_PAYDAY_FLOW, ...saved, savings: { ...DEFAULT_PAYDAY_FLOW.savings, ...(saved.savings || {}) } };
}

/** The steps in the order they are filled: savings first, or third when the percentage is of disposable income. */
export function paydayFlowOrder(flow) {
  const ids = flow.savings?.percentBase === 'disposable'
    ? ['fixed', 'regulars', 'savings', 'leftover']
    : ['savings', 'fixed', 'regulars', 'leftover'];
  return ids.map(id => PAYDAY_FLOW_STEPS.find(step => step.id === id));
}

/**
 * The savings portion for a salary. `deducted` is what the fixed and regulars
 * steps took; it only matters for the 'disposable' base.
 * Returns { base, fixedPart, percentPart, requested }, all BigInt minor units.
 */
export function savingsPortion(savings, salaryMinor, deducted = 0n) {
  const salary = BigInt(salaryMinor);
  const rest = salary - BigInt(deducted);
  const base = savings.percentBase === 'disposable' ? (rest > 0n ? rest : 0n) : salary;
  const fixedPart = BigInt(savings.fixedMinor);
  const percentPart = divideRounded(base * BigInt(savings.percent), 10000n);
  return { base, fixedPart, percentPart, requested: fixedPart + percentPart };
}

/** True when saving this entry should offer the payday flow: a posted salary that has not been shared out. */
export function opensPaydayFlow(s, entry) {
  const recorded = s.entries.find(e => e.id === entry?.id);
  return isSalaryEntry(s, recorded) && !salaryAlreadyAllocated(s, recorded.id);
}

/** True for a posted income entry in the Salary category (or under it). */
export function isSalaryEntry(s, entry) {
  return Boolean(entry) && entry.kind === 'income' && entry.status === 'posted' && entry.ledger === 'active'
    && Boolean(entry.category) && withinCategory(s, entry.category, SALARY_CATEGORY);
}

/** The same guard the earlier salary allocation used: one distribution per income entry. */
export function salaryAlreadyAllocated(s, entryId) {
  return s.allocations.some(a => a.salary === entryId);
}

/** Salary entries that have not been distributed yet, newest first. */
export function unallocatedSalaries(s) {
  return s.entries
    .filter(e => isSalaryEntry(s, e) && !salaryAlreadyAllocated(s, e.id))
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}

/** The recorded entry and the pots of each step; throws a readable error when the flow cannot run. */
function paydayFlowContext(s, entry) {
  const recorded = s.entries.find(e => e.id === entry?.id);
  if (!recorded || recorded.minor !== entry.minor || recorded.currency !== entry.currency || recorded.date !== entry.date) {
    throw Error('Record the income first, or preview again if it changed.');
  }
  if (recorded.kind !== 'income' || recorded.status !== 'posted' || recorded.ledger !== 'active') {
    throw Error('Choose a posted income entry.');
  }
  if (salaryAlreadyAllocated(s, recorded.id)) throw Error('This income has already been allocated.');

  const flow = paydayFlowSetting(s);
  const pots = {};
  for (const step of PAYDAY_FLOW_STEPS) {
    const pot = s.pots.find(p => p.id === flow[step.potKey]);
    if (!pot || pot.archived) throw Error(`Choose a pot for "${step.label}" in Settings → Payday.`);
    // Never mix currencies: a pot in another currency would need a valuation.
    if (pot.currency !== recorded.currency || pot.precision !== recorded.precision) {
      throw Error(`${pot.name} is in ${pot.currency}, and this salary is in ${recorded.currency}. Choose pots in the salary's currency.`);
    }
    pots[step.id] = pot;
  }
  if (pots.fixed.id === pots.regulars.id) throw Error('Fixed expenses and Regulars need different pots.');
  return { recorded, flow, pots };
}

/**
 * What is due from a pot between `from` and `to`: planned entries and
 * schedule dates with no entry yet (rent, bills, subscriptions).
 * `missing` counts items with no value in the pot's currency; they are left out.
 */
export function fixedDue(s, pot, from, to) {
  let minor = 0n;
  let missing = 0;
  const items = [];
  if (to < from) return { minor, missing, items };
  for (const row of spendingRows(s, plannedItems(s, from, to, from)).filter(r => r.pot === pot.id)) {
    const value = amountFor(row, pot.currency, pot.precision);
    if (value === null) { missing++; continue; }
    minor += row.kind === 'refund' ? -value : value;
    items.push({ id: row.id, label: row.label, date: row.date, minor: value, estimated: Boolean(row.estimated) });
  }
  return { minor: minor < 0n ? 0n : minor, missing, items };
}

/**
 * The weekly estimates that draw on a pot, from `from` to `to`: the weekly
 * amount for each week, and a share by days for a part week (as the forecast does).
 */
export function regularsDue(s, pot, from, to) {
  let minor = 0n;
  let missing = 0;
  if (to < from) return { minor, missing };
  for (const estimate of estimatesOf(s)) {
    if (estimate.every !== 'week' || s.categories.find(c => c.id === estimate.category)?.pot !== pot.id) continue;
    if (estimate.currency !== pot.currency) { missing++; continue; }
    for (const line of estimateLines(estimate, from, to)) minor += line.minor;
  }
  return { minor, missing };
}

/**
 * The preview for one salary entry. `today` matters when the salary is shared
 * out some days after it arrived: balances and what is still due are taken
 * from that day on.
 *
 * Returns { entry, salary, period: { from, to }, savings, lines, short, remaining }.
 * `savings` is the rule used, with the base the percentage was taken of.
 * Lines come in the order they are filled (see paydayFlowOrder).
 * Each line: { step, label, pot, potName, target, balance, requested, funded, shortfall, missing }
 *   target     what the pot should hold (fixed and regulars only)
 *   requested  what the step asks for; funded what the salary covers, in order
 *   missing    amounts that could not be valued in the pot's currency (left out)
 * `short` lists the steps the salary did not cover.
 */
export function paydayFlowPreview(s, entry, today = entry?.date) {
  const { recorded, flow, pots } = paydayFlowContext(s, entry);
  const salary = BigInt(recorded.minor);
  const asOf = today > recorded.date ? today : recorded.date;
  const to = forecastRange('before-payday', recorded.date, s.settings).to;

  // Fixed and regulars: top the pot up to what it needs, counting what it already holds.
  const topUp = (pot, due) => {
    const balance = potBalance(s, pot.id, asOf);
    const gap = due.minor - balance.minor;
    return { target: due.minor, balance: balance.minor, requested: gap > 0n ? gap : 0n, missing: due.missing + balance.missing };
  };
  const wanted = {
    fixed: topUp(pots.fixed, fixedDue(s, pots.fixed, asOf, to)),
    regulars: topUp(pots.regulars, regularsDue(s, pots.regulars, asOf, to))
  };

  let available = salary;
  let portion = null;
  const lines = [];
  for (const step of paydayFlowOrder(flow)) {
    const pot = pots[step.id];
    let want = wanted[step.id];
    if (step.id === 'savings') {
      // With the 'disposable' base this runs third, so the salary less what fixed and regulars took is known.
      portion = savingsPortion(flow.savings, salary, salary - available);
      want = { requested: portion.requested };
    }
    // The last step takes whatever the first three left.
    if (step.id === 'leftover') want = { requested: available };
    const funded = available < want.requested ? available : want.requested;
    available -= funded;
    lines.push({
      step: step.id, label: step.label, pot: pot.id, potName: pot.name,
      target: want.target ?? null, balance: want.balance ?? null, missing: want.missing || 0,
      requested: want.requested, funded, shortfall: want.requested - funded
    });
  }
  return {
    entry: recorded, salary, period: { from: asOf, to }, savings: { ...flow.savings, ...portion }, lines,
    short: lines.filter(line => line.shortfall > 0n).map(line => line.step),
    remaining: available
  };
}

/**
 * The allocations for the amounts the user confirmed, one per step with an
 * amount. `amounts` is { savings, fixed, regulars, leftover } in minor units.
 * IDs are fixed per salary entry and step, so saving twice cannot add twice.
 */
export function paydayFlowOperations(s, entry, amounts) {
  const { recorded, flow, pots } = paydayFlowContext(s, entry);
  let total = 0n;
  const operations = [];
  for (const step of paydayFlowOrder(flow)) {
    const minor = BigInt(amounts?.[step.id] ?? 0);
    if (minor < 0n) throw Error('An amount cannot be below zero.');
    if (minor === 0n) continue;
    if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('An amount is outside the supported integer range.');
    total += minor;
    operations.push({
      table: 'allocations',
      record: {
        id: `salary:${recorded.id}:${step.id}`, date: recorded.date, from: '', to: pots[step.id].id,
        minor: Number(minor), salary: recorded.id, note: `Payday: ${step.label.toLowerCase()}`
      }
    });
  }
  if (total > BigInt(recorded.minor)) throw Error('These amounts add up to more than the salary.');
  if (!operations.length) throw Error('Enter at least one amount to distribute.');
  return operations;
}

/** Write the confirmed allocations in one batch. A second attempt for the same salary is refused. */
export function confirmPaydayFlow(s, entry, amounts) {
  return commitBatch(s, paydayFlowOperations(s, entry, amounts));
}

/**
 * A worked example of a savings rule against the latest salary, for Settings.
 * Returns null without a salary, or { entry, salary, base, fixedPart, percentPart, requested }.
 * For the 'disposable' base it uses what the fixed and regulars steps were
 * given if that salary was shared out, and what they would ask for otherwise.
 */
export function savingsExample(s, savings) {
  const entry = s.entries.filter(e => isSalaryEntry(s, e))
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))[0];
  if (!entry) return null;
  const salary = BigInt(entry.minor);
  let deducted = 0n;
  if (savings.percentBase === 'disposable') {
    if (salaryAlreadyAllocated(s, entry.id)) {
      for (const step of ['fixed', 'regulars']) {
        deducted += BigInt(s.allocations.find(a => a.id === `salary:${entry.id}:${step}`)?.minor ?? 0);
      }
    } else {
      try {
        const lines = paydayFlowPreview({ ...s, settings: { ...s.settings, paydayFlow: { ...paydayFlowSetting(s), savings } } }, entry).lines;
        deducted = lines.filter(line => line.step === 'fixed' || line.step === 'regulars').reduce((sum, line) => sum + line.funded, 0n);
      } catch {
        return null; // the flow cannot run yet (a pot is missing or in another currency)
      }
    }
  }
  return { entry, salary, ...savingsPortion(savings, salary, deducted) };
}
