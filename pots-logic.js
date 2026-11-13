// Pot rules for the new interface. Pure functions over the ledger state:
// nothing here saves, reads the clock or touches the page.
//
//   - a pot's month at a glance (funding, spending, what is coming up)
//   - the warning when an expense would take a pot below zero
//   - a move between two pots (only ever when the user asks)
//   - the opt-in three-month rollover of unused funding into savings
//
// Pots are a plan, not bank cash: a move is one allocation and no account
// changes. Money is integer minor units (BigInt while summing). A pot move
// needs both pots in the same currency; nothing is converted.

import { amountFor, potBalance, commitBatch } from './model.js';
import { addMonths } from './planning.js';
import { spendingRows } from './features.js';
import { monthBounds, forecastRange, plannedItems } from './forecast-view.js';

// ---------------------------------------------------------------------------
// A pot's month
// ---------------------------------------------------------------------------

/**
 * This calendar month for one pot, up to `today`:
 *   funded    allocations into the pot
 *   movedOut  allocations out of it
 *   spent     posted expenses less refunds
 *   missing   spending with no value in the pot's currency (left out)
 */
export function potMonthSummary(s, potId, today) {
  const pot = s.pots.find(p => p.id === potId);
  if (!pot) throw Error('Pot not found.');
  const { from } = monthBounds(today);
  const inMonth = record => record.date >= from && record.date <= today;

  let funded = 0n;
  let movedOut = 0n;
  for (const a of s.allocations.filter(inMonth)) {
    if (a.to === potId) funded += BigInt(a.minor);
    if (a.from === potId) movedOut += BigInt(a.minor);
  }

  let spent = 0n;
  let missing = 0;
  const posted = s.entries.filter(e => e.ledger === 'active' && e.status === 'posted' && inMonth(e));
  for (const row of spendingRows(s, posted)) {
    if (row.pot !== potId) continue; // a refund carries the pot of its purchase
    const value = amountFor(row, pot.currency, pot.precision);
    if (value === null) missing++;
    else spent += row.kind === 'refund' ? -value : value;
  }
  return { from, to: today, funded, movedOut, spent, missing };
}

/** Planned items that will draw on a pot from `today` until the day before the next payday. */
export function potUpcoming(s, potId, today) {
  const pot = s.pots.find(p => p.id === potId);
  if (!pot) throw Error('Pot not found.');
  const { to } = forecastRange('before-payday', today, s.settings);
  return spendingRows(s, plannedItems(s, today, to, today))
    .filter(row => row.pot === potId && row.kind === 'expense')
    .map(row => ({ id: row.id, label: row.label, date: row.date, minor: BigInt(row.minor), currency: row.currency, precision: row.precision, estimated: Boolean(row.estimated) }));
}

// ---------------------------------------------------------------------------
// Below zero
// ---------------------------------------------------------------------------

/**
 * Would a save take a pot below zero? Compare the ledger `before` and `after`
 * the save. Returns null when there is nothing to say, or
 * { pot, balance, shortfall } (balance is negative; shortfall is what would cover it).
 *
 * It stays quiet when the save does not make the pot worse (for example,
 * lowering an expense in a pot that is already red), and for a pot that has
 * never been funded: pots are not in use there yet.
 */
export function negativePotCheck(before, after, potId, asOf) {
  const pot = after.pots.find(p => p.id === potId);
  if (!pot) return null;
  if (!after.allocations.some(a => a.to === potId)) return null;
  const was = potBalance(before, potId, asOf).minor;
  const now = potBalance(after, potId, asOf).minor;
  if (now >= 0n || now >= was) return null;
  return { pot, balance: now, shortfall: -now };
}

/**
 * One allocation moving `minor` from pot `from` to pot `to` on `date`.
 * Returns the operation for commitBatch. The source must hold that much:
 * a move never turns another pot red.
 */
export function potMoveOperation(s, { id, from, to, minor, date, note = '' }) {
  const source = s.pots.find(p => p.id === from);
  const target = s.pots.find(p => p.id === to);
  if (!source || !target) throw Error('Choose the pot to move from.');
  if (source.id === target.id) throw Error('Choose a different pot to move from.');
  if (source.currency !== target.currency || source.precision !== target.precision) {
    throw Error(`${source.name} and ${target.name} are in different currencies. Nothing is converted between pots.`);
  }
  if (!Number.isSafeInteger(minor) || minor <= 0) throw Error('Enter an amount to move.');
  const held = potBalance(s, source.id, date);
  if (held.minor < BigInt(minor)) throw Error(`${source.name} does not hold that much.`);
  return { table: 'allocations', record: { id, date, from: source.id, to: target.id, minor, note } };
}

// ---------------------------------------------------------------------------
// Three-month rollover (opt-in per pot)
// ---------------------------------------------------------------------------

export const DEFAULT_ROLLOVER_MONTHS = 3;

/** A pot's rollover setting with defaults filled in. Off unless the user switched it on. */
export function rolloverSetting(pot) {
  return { enabled: false, months: DEFAULT_ROLLOVER_MONTHS, to: '', ...(pot?.rollover || {}) };
}

/** The ID of the sweep of one pot's funding from one month ('2026-07'). One per pot and month, ever. */
export function rolloverId(potId, month) {
  return `rollover:${potId}:${month}`;
}

/**
 * What the rollover would move on `today`. Nothing is written.
 *
 * Each pot's funding is aged first in, first out: everything that left the
 * pot (spending less refunds, moves out, earlier sweeps) uses up the oldest
 * funding first. Funding is grouped by the calendar month it arrived in; a
 * month is due once all of its funding is at least `months` old. What is
 * left of a due month moves to the target pot.
 *
 * A month is swept once: if its sweep exists, or was undone (it is then
 * among the deleted records), it is not swept again.
 *
 * Returns { moves, skipped }.
 *   moves    [{ id, pot, potName, to, toName, month, minor, date, currency, precision }]
 *   skipped  [{ pot, reason }] for pots that could not be checked safely
 */
export function rolloverPlan(s, today) {
  const moves = [];
  const skipped = [];
  const done = new Set(s.allocations.map(a => a.id));
  for (const item of s.trash) if (item.table === 'allocations') done.add(item.record.id);

  for (const pot of s.pots) {
    const setting = rolloverSetting(pot);
    if (pot.archived || !setting.enabled) continue;
    const target = s.pots.find(p => p.id === setting.to);
    if (!target || target.archived || target.id === pot.id || target.currency !== pot.currency || target.precision !== pot.precision) {
      skipped.push({ pot: pot.id, reason: 'Choose a savings pot in the same currency for the rollover.' });
      continue;
    }
    const balance = potBalance(s, pot.id, today);
    if (balance.missing) {
      skipped.push({ pot: pot.id, reason: 'Some spending has no value in the pot currency yet.' });
      continue;
    }
    if (balance.minor <= 0n) continue;

    // Funding, oldest first.
    const lots = s.allocations
      .filter(a => a.to === pot.id && a.date <= today)
      .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
      .map(a => ({ date: a.date, month: a.date.slice(0, 7), left: BigInt(a.minor) }));
    const fundedTotal = lots.reduce((sum, lot) => sum + lot.left, 0n);

    // Everything that left the pot uses up the oldest funding first.
    let used = fundedTotal - balance.minor;
    for (const lot of lots) {
      if (used <= 0n) break;
      const take = used < lot.left ? used : lot.left;
      lot.left -= take;
      used -= take;
    }

    // Group by month. A month is due when its newest funding is old enough.
    const months = new Map();
    for (const lot of lots) {
      const group = months.get(lot.month) || { left: 0n, newest: lot.date };
      group.left += lot.left;
      if (lot.date > group.newest) group.newest = lot.date;
      months.set(lot.month, group);
    }
    for (const [month, group] of months) {
      if (group.left <= 0n || addMonths(group.newest, setting.months) > today) continue;
      const id = rolloverId(pot.id, month);
      if (done.has(id)) continue;
      moves.push({
        id, pot: pot.id, potName: pot.name, to: target.id, toName: target.name, month,
        minor: group.left, date: today, currency: pot.currency, precision: pot.precision
      });
    }
  }
  return { moves, skipped };
}

/**
 * Write the due sweeps as dated allocations, in one batch.
 * Returns { state, moved, skipped }; `state` is the same object when nothing was due.
 * Running it again changes nothing.
 */
export function applyRollover(s, today) {
  const { moves, skipped } = rolloverPlan(s, today);
  if (!moves.length) return { state: s, moved: [], skipped };
  const state = commitBatch(s, moves.map(move => ({
    table: 'allocations',
    record: {
      id: move.id, date: move.date, from: move.pot, to: move.to, minor: Number(move.minor),
      note: `Unused since ${move.month}`
    }
  })));
  return { state, moved: moves, skipped };
}

/**
 * Undo sweeps by ID: the allocations are removed (kept among the deleted
 * records), so the money is back in its pot and those months stay there.
 */
export function undoRollover(s, ids) {
  const operations = s.allocations
    .filter(a => ids.includes(a.id) && a.id.startsWith('rollover:'))
    .map(record => ({ table: 'allocations', record, action: 'delete' }));
  return operations.length ? commitBatch(s, operations) : s;
}
