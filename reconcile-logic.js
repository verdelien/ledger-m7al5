// Account reconciliation: compare the app's balance with the bank's on a date and,
// when they differ, record one adjustment entry for the difference. Pure functions:
// each returns a new, validated ledger state.

import { digits, validDate } from './domain.js';
import { accountBalance, commitBatch, uid } from './model.js';

function reconcileFindAccount(s, accountId) {
  const account = s.accounts.find(a => a.id === accountId);
  if (!account) throw Error('Choose an account to reconcile.');
  return account;
}

/** '-1,234.50' → -123450n. Signed; commas are thousands separators; zero is allowed. */
function reconcileParseBalance(text, account) {
  const places = account.precision ?? digits(account.currency);
  const trimmed = String(text ?? '').trim();
  if (!trimmed) throw Error('Enter the balance shown by your bank.');
  const negative = /^[-−]/.test(trimmed);
  const body = trimmed.replace(/^[-−+]/, '').trim();
  const match = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/.exec(body);
  if (!match || (match[2] || '').length > places) {
    throw Error(`Enter the balance as a number with at most ${places} decimal places, for example ${places ? '1,234.50' : '1,234'}. Use a minus sign for card debt.`);
  }
  const minor = BigInt(match[1].replaceAll(',', '')) * 10n ** BigInt(places) + BigInt((match[2] || '').padEnd(places, '0') || '0');
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('That balance is outside the supported range.');
  return negative ? -minor : minor;
}

function reconcileCheckDate(account, date, today) {
  if (!validDate(date)) throw Error('Choose the date of the bank balance.');
  if (date < account.openingDate) throw Error(`Choose a date on or after ${account.openingDate}, when this account's opening balance was recorded.`);
  if (date > today) throw Error('Choose today or an earlier date. A future balance cannot be reconciled.');
}

/**
 * What a reconciliation would do, without changing anything:
 * { account, shown, actual, difference } in BigInt minor units of the account currency.
 */
export function reconcileDifference(s, { accountId, date, balanceText, today }) {
  const account = reconcileFindAccount(s, accountId);
  reconcileCheckDate(account, date, today);
  const actual = reconcileParseBalance(balanceText, account);
  const shown = accountBalance(s, account.id, date);
  return { account, shown, actual, difference: actual - shown };
}

/**
 * Reconcile an account to the bank's balance on `date`.
 * A difference becomes one posted adjustment entry; a match only stamps the date.
 * Returns { state, difference }.
 */
export function reconcileAccount(s, { accountId, date, balanceText, note = '', today }) {
  const { account, difference } = reconcileDifference(s, { accountId, date, balanceText, today });
  const operations = [];
  if (difference !== 0n) {
    const size = difference < 0n ? -difference : difference;
    if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('That adjustment is outside the supported range.');
    operations.push({
      table: 'entries',
      record: {
        id: uid(), date, kind: 'adjustment', direction: difference > 0n ? 'increase' : 'decrease', status: 'posted',
        account: account.id, minor: Number(size), currency: account.currency, precision: account.precision,
        category: '', pot: '', trip: '', tags: '', note: String(note || '').trim().slice(0, 500) || 'Manual reconciliation', ledger: 'active'
      }
    });
  }
  const lastReconciled = account.lastReconciled && account.lastReconciled > date ? account.lastReconciled : date;
  operations.push({ table: 'accounts', record: { ...account, lastReconciled } });
  return { state: commitBatch(s, operations), difference };
}

/** `date` plus whole months; a day past the month's end becomes its last day. */
function reconcileAddMonths(date, months) {
  const [year, month, day] = date.split('-').map(Number);
  const total = year * 12 + (month - 1) + months;
  const y = Math.floor(total / 12), m = total % 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return `${String(y).padStart(4, '0')}-${String(m + 1).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

/** Accounts whose reconciliation reminder has come due: [{ account, dueDate, lastReconciled }], oldest first. */
export function reconcileDue(s, today) {
  return s.accounts
    .filter(a => !a.archived && a.reminderMonths > 0)
    .map(account => ({
      account,
      dueDate: reconcileAddMonths(account.lastReconciled || account.openingDate, account.reminderMonths),
      lastReconciled: account.lastReconciled || ''
    }))
    .filter(item => item.dueDate <= today)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

/** Set how often to be reminded to reconcile an account, in months. 0 turns the reminder off. */
export function setReminder(s, accountId, months) {
  const account = reconcileFindAccount(s, accountId);
  if (!Number.isInteger(months) || months < 0 || months > 120) throw Error('Choose a reminder between 0 and 120 months.');
  if ((account.reminderMonths || 0) === months) return s;
  return commitBatch(s, [{ table: 'accounts', record: { ...account, reminderMonths: months } }]);
}

/** The adjustment entries of an account, newest first. */
export function adjustmentsOf(s, accountId) {
  return s.entries
    .map((entry, index) => ({ entry, index }))
    .filter(row => row.entry.kind === 'adjustment' && row.entry.account === accountId)
    .sort((a, b) => b.entry.date.localeCompare(a.entry.date) || b.index - a.index)
    .map(row => row.entry);
}
