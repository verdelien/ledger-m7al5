// Recurring payments: rent, bills, subscriptions and regular income.
// Pure functions over the ledger state; nothing here touches the page.
//
// A rule (`state.schedules`, the shape the previous version also reads):
//   { id, name, start, end, frequency, interval, anchor, holidays, autoPost, archived, entry, versions }
// `versions` is the price history: [{ effectiveDate, entry }]. The version in
// force on a date is the latest one whose effectiveDate is on or before it.
// An entry written for a due date has the ID `scheduled:<ruleId>:<date>` and
// `schedule: ruleId`. It is posted straight away when the rule posts
// automatically, otherwise planned until the user confirms or skips it.
//
// Card-repayment rules (`rule.repayment`) work out their amount from the card
// balance. They are left to the previous version: never posted or changed here.

import { digits, parseAmount, validDate } from './domain.js';
import { commit, commitBatch, uid, quarter } from './model.js';
import { occurrences, addMonths } from './planning.js';

const RECURRING_FREQUENCIES = ['once', 'weekly', 'monthly', 'yearly'];
const RECURRING_ANCHORS = ['day', 'first_monday', 'last_working_day'];

const isRepaymentRule = rule => Boolean(rule?.repayment);
const scheduledEntryId = (rule, date) => `scheduled:${rule.id}:${date}`;
const inClosedQuarter = (s, date) => Boolean(s.settings.closedQuarters?.includes(quarter(date)));

/** The entry template in force on `date`: the latest version on or before it, else `rule.entry`. */
export function versionOn(rule, date) {
  const version = (rule.versions || [])
    .filter(v => v.effectiveDate <= date)
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))
    .at(-1);
  return version?.entry || rule.entry;
}

/**
 * Cancel operations for a rule's planned entries that should no longer happen:
 * all of them when the rule is paused, otherwise those whose date the rule no
 * longer falls on. Posted entries are never touched.
 */
function staleScheduleOperations(s, rule, today) {
  const planned = s.entries.filter(e => e.schedule === rule.id && e.status === 'planned' && !inClosedQuarter(s, e.date));
  if (!planned.length) return [];
  let allowed = new Set();
  if (!rule.archived) {
    const horizon = planned.reduce((last, e) => (e.date > last ? e.date : last), today);
    allowed = new Set(horizon >= rule.start ? occurrences(rule, rule.start, horizon) : []);
  }
  return planned
    // An entry confirmed onto another day keeps its original due date in its ID.
    .filter(e => !allowed.has(e.date) && !allowed.has(e.id.slice(scheduledEntryId(rule, '').length)))
    .map(e => ({
      table: 'entries',
      record: { ...e, status: 'cancelled', amountConfirmed: false, cancelReason: rule.archived ? 'paused' : 'rule_changed' }
    }));
}

/**
 * Write the entries that have fallen due, up to and including `today`.
 * Returns { state, posted, planned }: the IDs written as posted (rules that
 * post automatically) and as planned (rules that ask first). A date that
 * already has an entry of any status, or whose entry the user deleted, is
 * left alone. Returns the same state object when nothing changes.
 */
export function postDueSchedules(s, today) {
  if (!validDate(today)) throw Error('Today\'s date is not valid.');
  const operations = [], posted = [], planned = [];
  const existing = new Set(s.entries.map(e => e.id));
  const deleted = new Set(s.trash.filter(t => t.table === 'entries' && t.record).map(t => t.record.id));
  for (const rule of s.schedules) {
    if (isRepaymentRule(rule)) continue;
    operations.push(...staleScheduleOperations(s, rule, today));
    if (rule.archived || rule.start > today) continue;
    for (const date of occurrences(rule, rule.start, today)) {
      const id = scheduledEntryId(rule, date);
      // A closed budget quarter cannot take new entries; that date is passed over.
      if (existing.has(id) || deleted.has(id) || inClosedQuarter(s, date)) continue;
      const status = rule.autoPost ? 'posted' : 'planned';
      operations.push({ table: 'entries', record: { ...versionOn(rule, date), id, date, status, schedule: rule.id } });
      (rule.autoPost ? posted : planned).push(id);
    }
  }
  if (!operations.length) return { state: s, posted, planned };
  return { state: commitBatch(s, operations), posted, planned };
}

/**
 * Add a recurring payment, or change one (`fields.id` set). Throws a readable
 * error when something is missing. A change applies from `effectiveDate`:
 * entries already posted keep their amount; planned entries from that date on
 * are brought up to date so a confirmation shows the new figure.
 */
export function saveSchedule(s, fields, today) {
  const old = fields.id ? s.schedules.find(r => r.id === fields.id) : null;
  if (fields.id && !old) throw Error('That recurring payment no longer exists.');
  if (isRepaymentRule(old)) throw Error('Card repayments are managed in the previous version.');
  const name = String(fields.name ?? '').trim();
  if (!name) throw Error('Give the recurring payment a name.');
  if (name.length > 150) throw Error('Use a name of at most 150 characters.');
  const kind = fields.kind === 'income' ? 'income' : 'expense';
  const category = s.categories.find(c => c.id === fields.category);
  if (!category || category.kind !== kind || (category.archived && old?.entry.category !== category.id)) {
    throw Error(kind === 'income' ? 'Choose an income category.' : 'Choose an expense category.');
  }
  const currency = String(fields.currency ?? '');
  if (!s.settings.activeCurrencies.includes(currency)) throw Error('Choose one of your active currencies.');
  const precision = digits(currency);
  let minor;
  try { minor = parseAmount(String(fields.amount ?? ''), currency); } catch {
    throw Error(`Enter an amount above zero with at most ${precision} decimal places.`);
  }
  const accountId = fields.account || '';
  const account = accountId ? s.accounts.find(a => a.id === accountId) : null;
  if (accountId && !account) throw Error('Choose an account, or leave it unset.');
  if (account && (account.currency !== currency || account.precision !== precision)) {
    throw Error(`${account.name} is in ${account.currency}. Use that currency, or choose another account.`);
  }
  const frequency = String(fields.frequency ?? '');
  if (!RECURRING_FREQUENCIES.includes(frequency)) throw Error('Choose how often it repeats.');
  const interval = Number(fields.interval ?? 1);
  if (!Number.isInteger(interval) || interval < 1 || interval > 120) throw Error('Repeat every 1 to 120 periods.');
  // "Last working day" and "First Monday" only mean something for months and years.
  const anchor = ['monthly', 'yearly'].includes(frequency) && RECURRING_ANCHORS.includes(fields.anchor) ? fields.anchor : 'day';
  const start = String(fields.start ?? '');
  if (!validDate(start)) throw Error('Choose the first date.');
  const end = String(fields.end ?? '');
  if (end && !validDate(end)) throw Error('Choose a last date, or leave it empty.');
  if (end && end < start) throw Error('The last date cannot be before the first date.');
  const effectiveDate = old ? String(fields.effectiveDate || today) : start;
  if (!validDate(effectiveDate)) throw Error('Choose the date the new amount applies from.');

  const entry = {
    kind, status: 'planned', date: start, minor, currency, precision, category: category.id,
    pot: category.pot || '', account: accountId, trip: '', tags: '', note: name, ledger: 'active'
  };
  const versions = old
    ? [...(old.versions || [{ effectiveDate: old.start, entry: old.entry }]).filter(v => v.effectiveDate !== effectiveDate), { effectiveDate, entry }]
    : [{ effectiveDate: start, entry }];
  const rule = {
    ...(old || {}),
    id: old?.id || uid(), name, start, end, frequency, interval, anchor, holidays: old?.holidays || [],
    autoPost: fields.autoPost !== false, archived: old?.archived || false, entry, versions
  };
  const operations = [{ table: 'schedules', record: rule }];
  if (old) {
    // Planned entries from the change date on take the terms now in force on their date.
    for (const e of s.entries) {
      if (e.schedule !== rule.id || e.status !== 'planned' || e.date < effectiveDate || inClosedQuarter(s, e.date)) continue;
      const v = versionOn(rule, e.date);
      const updated = {
        ...e, kind: v.kind, minor: v.minor, currency: v.currency, precision: v.precision,
        category: v.category, pot: v.pot, account: v.account, note: v.note
      };
      if (JSON.stringify(updated) !== JSON.stringify(e)) operations.push({ table: 'entries', record: updated });
    }
  }
  return commitBatch(s, operations);
}

function setScheduleArchived(s, id, archived) {
  const rule = s.schedules.find(r => r.id === id);
  if (!rule) throw Error('That recurring payment no longer exists.');
  if (isRepaymentRule(rule)) throw Error('Card repayments are managed in the previous version.');
  if (Boolean(rule.archived) === archived) return s;
  const next = { ...rule, archived };
  return commitBatch(s, [{ table: 'schedules', record: next }, ...(archived ? staleScheduleOperations(s, next, rule.start) : [])]);
}

/** Stop a rule. Its waiting (planned) entries are cancelled; posted ones stay. */
export function pauseSchedule(s, id) { return setScheduleArchived(s, id, true); }

/** Start a paused rule again. Dates cancelled while it was paused stay cancelled. */
export function resumeSchedule(s, id) { return setScheduleArchived(s, id, false); }

/** Entries waiting for a yes or no: planned, from a recurring rule, due today or earlier. Oldest first. */
export function dueToConfirm(s, today) {
  return s.entries
    .filter(e => e.schedule && e.status === 'planned' && e.ledger === 'active' && e.date <= today
      && !isRepaymentRule(s.schedules.find(r => r.id === e.schedule)))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

function waitingScheduledEntry(s, id) {
  const entry = s.entries.find(e => e.id === id);
  if (!entry || !entry.schedule || entry.status !== 'planned') throw Error('That payment is no longer waiting to be confirmed.');
  const rule = s.schedules.find(r => r.id === entry.schedule);
  if (isRepaymentRule(rule)) throw Error('Card repayments are managed in the previous version.');
  return { entry, rule };
}

/**
 * Post a waiting entry. `minor` changes the amount (same currency); `date`
 * moves it, no later than `today` and no earlier than the rule's first date.
 */
export function confirmDue(s, id, { minor, date, today } = {}) {
  const { entry, rule } = waitingScheduledEntry(s, id);
  const amount = minor ?? entry.minor;
  if (!Number.isSafeInteger(amount) || amount <= 0) throw Error('Enter an amount above zero.');
  const day = date ?? entry.date;
  if (!validDate(day)) throw Error('Choose the date it was paid.');
  if (today && day > today) throw Error('The date cannot be in the future.');
  if (rule && day < rule.start) throw Error('The date cannot be before the first date of this recurring payment.');
  return commit(s, 'entries', { ...entry, minor: amount, date: day, status: 'posted' });
}

/** Say a waiting entry did not happen. It is cancelled and never written again. */
export function skipDue(s, id) {
  const { entry } = waitingScheduledEntry(s, id);
  return commit(s, 'entries', { ...entry, status: 'cancelled', cancelReason: 'skipped' });
}

/** The next date a rule falls due on or after `today`, or null (paused, ended, or a one-off already past). */
export function nextDue(s, rule, today) {
  if (rule.archived) return null;
  const from = today > rule.start ? today : rule.start;
  const interval = rule.interval || 1;
  // Far enough ahead to hold at least one more date, whatever the rhythm.
  const horizon = rule.frequency === 'weekly'
    ? addMonths(from, Math.ceil(interval / 4) + 1)
    : addMonths(from, interval * (rule.frequency === 'yearly' ? 12 : 1) + 1);
  return occurrences(rule, from, horizon)[0] || null;
}

const recurringOrdinal = n => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
const RECURRING_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const RECURRING_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A rule's rhythm in words: "monthly on the 1st", "every 2 weeks on Fridays", "monthly on the last working day". */
export function frequencyWords(rule) {
  const [, month, day] = rule.start.split('-').map(Number);
  const n = rule.interval || 1;
  if (rule.frequency === 'once') return `once on ${day} ${RECURRING_MONTHS[month - 1]} ${rule.start.slice(0, 4)}`;
  const unit = { weekly: 'week', monthly: 'month', yearly: 'year' }[rule.frequency];
  const rhythm = n === 1 ? rule.frequency : `every ${n} ${unit}s`;
  if (rule.frequency === 'weekly') return `${rhythm} on ${RECURRING_WEEKDAYS[new Date(rule.start + 'T12:00:00Z').getUTCDay()]}s`;
  const inMonth = rule.frequency === 'yearly' ? ` of ${RECURRING_MONTHS[month - 1]}` : '';
  if (rule.anchor === 'last_working_day') return `${rhythm} on the last working day${inMonth}`;
  if (rule.anchor === 'first_monday') return `${rhythm} on the first Monday${inMonth}`;
  return rule.frequency === 'yearly' ? `${rhythm} on ${day} ${RECURRING_MONTHS[month - 1]}` : `${rhythm} on the ${recurringOrdinal(day)}`;
}
