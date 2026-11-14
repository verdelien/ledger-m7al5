// Credit-card repayments: what to pay, and the yes or no that records it.
// Pure functions over the ledger state; nothing here touches the page.
//
// A repayment rule is a schedule with `repayment: true` whose entry is a
// transfer from a bank account to the card (the shape the previous version
// also reads). Its amount is never fixed and never posted automatically:
//   - "last month's spending" (default): what was charged to the card in the
//     whole calendar month before the due date, never more than is owed today;
//   - "full balance" (`rule.repaymentBasis: 'balance'`): everything owed today.
// The user approves every repayment. Approving writes the posted transfer
// `scheduled:<ruleId>:<dueDate>`; skipping writes it as cancelled.

import { validDate } from './domain.js';
import { commit, commitBatch, uid, accountBalance, quarter } from './model.js';
import { occurrences } from './planning.js';

const REPAYMENT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const repaymentPad = n => String(n).padStart(2, '0');
const repaymentEntryId = (ruleId, date) => `scheduled:${ruleId}:${date}`;

function repaymentShiftDays(iso, count) {
  const dt = new Date(iso + 'T12:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + count);
  return dt.toISOString().slice(0, 10);
}

function repaymentRuleOf(s, ruleId) {
  const rule = s.schedules.find(r => r.id === ruleId);
  if (!rule || !rule.repayment) throw Error('That card repayment no longer exists.');
  return rule;
}

/** 'last-month' unless the rule says 'balance'. */
export function repaymentBasis(rule) {
  return rule?.repaymentBasis === 'balance' ? 'balance' : 'last-month';
}

/** The whole calendar month before the month `dueDate` falls in: { from, to }. */
export function statementPeriod(dueDate) {
  if (!validDate(dueDate)) throw Error('The due date is not valid.');
  const [year, month] = dueDate.split('-').map(Number);
  const y = month === 1 ? year - 1 : year, m = month === 1 ? 12 : month - 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${y}-${repaymentPad(m)}-01`, to: `${y}-${repaymentPad(m)}-${repaymentPad(last)}` };
}

/** "1–30 Nov" for a period inside one month. */
export function periodWords(period) {
  const [, month, first] = period.from.split('-').map(Number);
  return `${first}–${Number(period.to.slice(8))} ${REPAYMENT_MONTHS[month - 1]}`;
}

/** "last month's spending (1–30 Nov)" or "full balance". */
export function basisWords(basis, period) {
  if (basis === 'balance') return 'full balance';
  return period ? `last month's spending (${periodWords(period)})` : 'last month\'s spending';
}

/**
 * Net charges on a card between `from` and `to` (inclusive), in the card's
 * currency: spending less refunds. Money paid onto the card in the period
 * (repayments) does not reduce the figure. Never below zero.
 */
export function cardCharges(s, cardId, from, to) {
  const before = accountBalance(s, cardId, repaymentShiftDays(from, -1));
  const after = accountBalance(s, cardId, to);
  let paidIn = 0n;
  for (const e of s.entries) {
    if (e.kind === 'transfer' && e.toAccount === cardId && e.status === 'posted' && e.ledger === 'active' && e.date >= from && e.date <= to) {
      paidIn += BigInt(e.receivedMinor);
    }
  }
  const charges = before - after + paidIn;
  return charges > 0n ? charges : 0n;
}

/**
 * What a rule would pay for `dueDate`, seen from `today`:
 * { minor, basis, period, debt } with BigInt amounts in the card's currency.
 * `debt` is what the card owes today. "Last month's spending" is capped at it.
 */
export function repaymentEstimate(s, rule, dueDate, today) {
  const basis = repaymentBasis(rule);
  const period = statementPeriod(dueDate);
  const cardId = rule.entry?.toAccount;
  if (!s.accounts.some(a => a.id === cardId)) return { minor: 0n, basis, period, debt: 0n };
  const balance = accountBalance(s, cardId, today);
  const debt = balance < 0n ? -balance : 0n;
  if (basis === 'balance') return { minor: debt, basis, period, debt };
  const charges = cardCharges(s, cardId, period.from, period.to);
  return { minor: charges < debt ? charges : debt, basis, period, debt };
}

/**
 * Repayments waiting for approval: every due date from each rule's first
 * date up to `daysAhead` days after `today` that has not been paid or
 * skipped. Oldest first. Each item:
 *   { rule, date, id, existing, estimate, basis, period, from, card }
 * `existing` is a planned entry the previous version wrote, or null.
 * `estimate` is a number of minor units: the figure the user already
 * confirmed there, otherwise the estimate. Dates with nothing to pay are
 * left out. A card's open items together never ask for more than it owes:
 * each one is capped at the debt the earlier ones leave.
 */
export function upcomingRepayments(s, today, daysAhead = 7) {
  if (!validDate(today)) throw Error('Today\'s date is not valid.');
  const horizon = repaymentShiftDays(today, daysAhead);
  const deleted = new Set(s.trash.filter(t => t.table === 'entries' && t.record).map(t => t.record.id));
  const byId = new Map(s.entries.map(e => [e.id, e]));
  const remaining = new Map(); // card id → debt not yet claimed by an earlier item
  const items = [];
  for (const rule of s.schedules) {
    if (!rule.repayment || rule.archived || !rule.entry || rule.start > horizon) continue;
    const from = s.accounts.find(a => a.id === rule.entry.account);
    const card = s.accounts.find(a => a.id === rule.entry.toAccount);
    if (!from || !card) continue;
    for (const date of occurrences(rule, rule.start, horizon)) {
      const id = repaymentEntryId(rule.id, date);
      const found = byId.get(id);
      if (deleted.has(id) || (found && found.status !== 'planned')) continue;
      if (s.settings.closedQuarters?.includes(quarter(date))) continue;
      const existing = found || null;
      const { minor, basis, period, debt } = repaymentEstimate(s, rule, date, today);
      if (!remaining.has(card.id)) remaining.set(card.id, debt);
      const left = remaining.get(card.id);
      const confirmed = Boolean(existing?.amountConfirmed);
      const amount = confirmed ? BigInt(existing.minor) : (minor < left ? minor : left);
      if (amount <= 0n) continue;
      remaining.set(card.id, left > amount ? left - amount : 0n);
      items.push({ rule, date, id, existing, estimate: Number(amount), basis, period, from, card });
    }
  }
  return items.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

/** Accepts the entry ID `scheduled:<ruleId>:<date>` or { ruleId, date }. */
function repaymentRef(ref) {
  if (typeof ref === 'string') {
    const match = /^scheduled:(.+):(\d{4}-\d{2}-\d{2})$/.exec(ref);
    if (!match) throw Error('That card repayment no longer exists.');
    return { ruleId: match[1], date: match[2] };
  }
  return { ruleId: ref?.ruleId, date: ref?.date };
}

function repaymentTarget(s, ref) {
  const { ruleId, date: dueDate } = repaymentRef(ref);
  const rule = repaymentRuleOf(s, ruleId);
  if (!validDate(dueDate)) throw Error('The due date is not valid.');
  const from = s.accounts.find(a => a.id === rule.entry.account);
  const card = s.accounts.find(a => a.id === rule.entry.toAccount);
  if (!from || !card) throw Error('The accounts for this card repayment no longer exist. Edit it in Settings → Recurring.');
  const id = repaymentEntryId(rule.id, dueDate);
  const existing = s.entries.find(e => e.id === id);
  if (existing?.status === 'posted') throw Error('That repayment has already been recorded.');
  if (existing?.status === 'cancelled') throw Error('That repayment was skipped.');
  if (s.trash.some(t => t.table === 'entries' && t.record?.id === id)) throw Error('That repayment was deleted. Restore it first, or record a transfer instead.');
  return { rule, dueDate, from, card, id };
}

function repaymentEntry({ rule, from, card, id }, fields) {
  return {
    kind: 'transfer', currency: from.currency, precision: from.precision, account: from.id, toAccount: card.id,
    category: '', pot: '', trip: '', note: rule.entry.note || rule.name, tags: 'repayment', ledger: 'active',
    id, schedule: rule.id, ...fields
  };
}

/**
 * Approve a repayment: the transfer is posted for `minor` on `date` (today or
 * earlier; the due date when that has passed, otherwise today).
 */
export function confirmRepayment(s, ref, { minor, date, today } = {}) {
  const target = repaymentTarget(s, ref);
  if (!Number.isSafeInteger(minor) || minor <= 0) throw Error('Enter an amount above zero.');
  const day = date ?? (today && target.dueDate > today ? today : target.dueDate);
  if (!validDate(day)) throw Error('Choose the date it was paid.');
  if (today && day > today) throw Error('The date cannot be in the future.');
  if (day < target.card.openingDate) throw Error(`${target.card.name} was opened on ${target.card.openingDate}. Choose that date or later.`);
  return commit(s, 'entries', repaymentEntry(target, {
    status: 'posted', date: day, minor, receivedMinor: minor, amountConfirmed: true, valuationStatus: 'confirmed'
  }));
}

/** Say a repayment will not be made for this due date. It is never asked for again. */
export function skipRepayment(s, ruleId, dueDate) {
  const target = repaymentTarget(s, { ruleId, date: dueDate });
  const minor = Number.isSafeInteger(target.rule.entry.minor) && target.rule.entry.minor > 0 ? target.rule.entry.minor : 1;
  return commit(s, 'entries', repaymentEntry(target, {
    status: 'cancelled', cancelReason: 'skipped', date: dueDate, minor, receivedMinor: minor, amountConfirmed: false
  }));
}

/**
 * Add a card repayment, or change one (`fields.id` set):
 * { id?, card, from, start, basis }. Due monthly on the day of `start`.
 */
export function saveCardRepayment(s, fields, today) {
  const old = fields.id ? s.schedules.find(r => r.id === fields.id) : null;
  if (fields.id && (!old || !old.repayment)) throw Error('That card repayment no longer exists.');
  const card = s.accounts.find(a => a.id === fields.card);
  if (!card || card.type !== 'credit_card') throw Error('Choose the credit card to repay.');
  const from = s.accounts.find(a => a.id === fields.from);
  if (!from) throw Error('Choose the account the repayment is paid from.');
  if (from.id === card.id) throw Error('Choose a different account to pay from; a card cannot repay itself.');
  if (from.currency !== card.currency || from.precision !== card.precision) {
    throw Error(`${from.name} is in ${from.currency} but ${card.name} is in ${card.currency}. Choose an account in ${card.currency}.`);
  }
  const start = String(fields.start ?? '');
  if (!validDate(start)) throw Error('Choose the first due date.');
  const basis = fields.basis === 'balance' ? 'balance' : 'last-month';
  if (s.schedules.some(r => r.repayment && !r.archived && r.id !== old?.id && r.entry?.toAccount === card.id)) {
    throw Error(`${card.name} already has a repayment. Edit that one instead.`);
  }
  const name = `${card.name} repayment`;
  const accounts = { account: from.id, toAccount: card.id, currency: from.currency, precision: from.precision };
  let rule;
  if (old) {
    const sameCard = old.entry.toAccount === card.id;
    rule = {
      ...old, name: sameCard ? old.name : name, start, autoPost: false, repaymentBasis: basis,
      entry: { ...old.entry, ...accounts, date: start, note: sameCard ? old.entry.note : name }
    };
    if (old.end && old.end < start) rule.end = '';
    if (old.versions) rule.versions = old.versions.map(v => ({ ...v, entry: { ...v.entry, ...accounts } }));
  } else {
    rule = {
      id: uid(), name, repayment: true, repaymentBasis: basis, start, end: '', frequency: 'monthly', interval: 1, anchor: 'day',
      holidays: [], autoPost: false, archived: false,
      // The amount is worked out each month; 1 is only a placeholder the format requires.
      entry: {
        kind: 'transfer', status: 'planned', date: start, minor: 1, receivedMinor: 1, ...accounts,
        category: '', pot: '', trip: '', note: name, tags: 'repayment', ledger: 'active'
      }
    };
  }
  return commit(s, 'schedules', rule);
}

/** Pause or resume a card repayment. Pausing cancels entries still waiting; paid ones stay. */
export function setCardRepaymentPaused(s, ruleId, paused) {
  const rule = repaymentRuleOf(s, ruleId);
  if (Boolean(rule.archived) === Boolean(paused)) return s;
  const operations = [{ table: 'schedules', record: { ...rule, archived: Boolean(paused) } }];
  if (paused) {
    for (const e of s.entries) {
      if (e.schedule !== rule.id || e.status !== 'planned' || s.settings.closedQuarters?.includes(quarter(e.date))) continue;
      operations.push({ table: 'entries', record: { ...e, status: 'cancelled', amountConfirmed: false, cancelReason: 'paused' } });
    }
  }
  return commitBatch(s, operations);
}
