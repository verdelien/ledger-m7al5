// Refunds against a purchase.
//
// A refund is its own record that points at the purchase (`original`). It copies the
// purchase's currency, account, category and pot, so the money returns to the same
// account and the same pot. A purchase can have several part refunds; together they can
// never be more than the purchase.
//
// A purchase shared with a friend is refunded through saveSharedRefund in
// shared-logic.js, which keeps both shares straight. Fees that belong to a transfer
// are still refunded in the previous version.

import { commitBatch, uid } from './model.js';
import { divideRounded } from './money.js';
import { validDate } from './domain.js';

/** Today's date on this device, as YYYY-MM-DD. */
function localToday() {
  const now = new Date();
  const pad = number => String(number).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** '85.00' for 8500 at precision 2. Plain fixed decimals, for messages. */
function fixedAmount(minor, precision) {
  const digits = BigInt(minor).toString().padStart(precision + 1, '0');
  return precision ? `${digits.slice(0, -precision)}.${digits.slice(-precision)}` : digits;
}

/** `part` of `whole`, applied to `amount`, rounded half away from zero. */
function proportion(amount, part, whole) {
  return Number(divideRounded(BigInt(amount) * BigInt(part), BigInt(whole)));
}

/**
 * How much of a purchase has been refunded already, in the purchase currency's minor
 * units. `exceptId` leaves one refund out: the one being edited.
 */
export function refundedSoFar(state, purchase, exceptId = '') {
  return state.entries
    .filter(entry => entry.kind === 'refund' && entry.original === purchase.id
      && entry.status !== 'cancelled' && entry.id !== exceptId)
    .reduce((sum, entry) => sum + BigInt(entry.minor), 0n);
}

/** True when this purchase's refunds can be recorded in this version. */
export function canRefundHere(state, purchase) {
  return Boolean(purchase)
    && purchase.kind === 'expense'
    && purchase.status === 'posted'
    && purchase.ledger === 'active'
    && !purchase.feeOnReceived
    && !purchase.feeFor;
}

/**
 * The likely amount credited to the account for a refund of `minor`, when the account
 * is in a different currency from the purchase: the same share of the original charge.
 * Null when the purchase was paid in the account's own currency.
 */
export function suggestedSettled(purchase, minor) {
  if (purchase.settledMinor == null) return null;
  if (!Number.isSafeInteger(minor) || minor <= 0 || !(purchase.minor > 0)) return null;
  return proportion(purchase.settledMinor, minor, purchase.minor);
}

/**
 * Add a refund, or change an existing one. Returns the new, validated state.
 *   purchaseId       the purchase being refunded
 *   id               the refund to change; empty for a new refund
 *   minor            the refund, in the purchase currency's minor units
 *   date             YYYY-MM-DD; from the purchase date up to today
 *   note             optional text
 *   settledMinor     what the account was credited, in the account currency's minor
 *                    units. Only for a purchase in another currency; left out, it is
 *                    estimated from the original charge.
 *   settledEstimate  true when a given settledMinor is itself an estimate
 *   today            the latest date allowed; defaults to today on this device
 */
export function saveRefund(state, { purchaseId, id = '', minor, date, note = '', settledMinor, settledEstimate, today = localToday() }) {
  const purchase = state.entries.find(entry => entry.id === purchaseId);
  if (!purchase) throw Error('The purchase for this refund was not found.');
  if (!canRefundHere(state, purchase)) throw Error('Refunds for this purchase are recorded in the previous version.');
  if (purchase.friend) throw Error('This purchase is shared with a friend. Record the total refund and your share of it.');
  if (id && !state.entries.some(entry => entry.id === id && entry.kind === 'refund' && entry.original === purchase.id)) {
    throw Error('That refund was not found.');
  }

  if (!Number.isSafeInteger(minor) || minor <= 0) throw Error('Enter the refund amount.');
  const left = BigInt(purchase.minor) - refundedSoFar(state, purchase, id);
  if (left <= 0n) throw Error('This purchase is already fully refunded.');
  if (BigInt(minor) > left) {
    throw Error(`The most left to refund is ${fixedAmount(left, purchase.precision)} ${purchase.currency}.`);
  }

  if (typeof date !== 'string' || !validDate(date)) throw Error('Choose the refund date.');
  if (date < purchase.date) throw Error('A refund cannot be dated before the purchase.');
  if (date > today) throw Error('A refund cannot be dated in the future.');

  // Start from the purchase so the currency, account, category, pot, trip and tags match,
  // then remove what belongs to the purchase alone.
  const record = {
    ...purchase,
    id: id || uid(),
    kind: 'refund',
    original: purchase.id,
    minor,
    date,
    status: 'posted',
    note: String(note || '').trim()
  };
  for (const key of ['settledMinor', 'settledCurrency', 'settledPrecision', 'settledEstimate',
    'reportingMinor', 'reportingCurrency', 'reportingPrecision', 'splits', 'group', 'feeFor']) {
    delete record[key];
  }

  // The account is in another currency: record what it was credited.
  if (purchase.settledMinor != null && purchase.settledCurrency) {
    record.settledCurrency = purchase.settledCurrency;
    record.settledPrecision = purchase.settledPrecision;
    if (settledMinor == null) {
      record.settledMinor = proportion(purchase.settledMinor, minor, purchase.minor);
      record.settledEstimate = true;
    } else {
      if (!Number.isSafeInteger(settledMinor) || settledMinor <= 0) throw Error('Enter the amount credited to the account.');
      record.settledMinor = settledMinor;
      if (settledEstimate === true) record.settledEstimate = true;
    }
  }

  // Keep the same share of the purchase's reporting value, so reports show the net.
  if (purchase.reportingMinor != null && purchase.reportingCurrency) {
    record.reportingMinor = proportion(purchase.reportingMinor, minor, purchase.minor);
    record.reportingCurrency = purchase.reportingCurrency;
    record.reportingPrecision = purchase.reportingPrecision;
  }

  return commitBatch(state, [{ table: 'entries', record }]);
}

/** Remove one refund. Returns the new, validated state. */
export function deleteRefund(state, id) {
  const record = state.entries.find(entry => entry.id === id);
  if (!record || record.kind !== 'refund') throw Error('That refund was not found.');
  return commitBatch(state, [{ table: 'entries', record, action: 'delete' }]);
}
