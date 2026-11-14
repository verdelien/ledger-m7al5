// Transfers between two accounts, with an optional fee taken from the amount received
// (an ATM or exchange charge that reduced what arrived).
//
// The transfer records the amount sent (in the from-account's currency) and the gross
// amount received (in the to-account's currency, before the fee). The fee is a linked
// expense on the receiving account, so the account's balance goes up by the net amount,
// the fee appears in reports, and nothing is counted twice.

import { commitBatch } from './model.js';

const SOURCE_FEE_MESSAGE = 'This transfer has a fee taken from the amount sent. Edit it in the previous version.';

/** True when the transfer has the older kind of fee, charged on top at the source. */
export function hasSourceFee(state, transfer) {
  return transfer.totalDebit != null || state.entries.some(entry => entry.feeFor === transfer.id);
}

/** The fee taken from the amount received (or null) and what actually arrived. */
export function transferParts(state, transfer) {
  const fee = state.entries.find(entry => entry.feeOnReceived === transfer.id) || null;
  return { fee, receivedNet: BigInt(transfer.receivedMinor) - BigInt(fee ? fee.minor : 0) };
}

/**
 * Save a transfer and its fee as one change. Returns the new, validated state.
 *   transfer     the transfer record (id, account, toAccount, minor, date, status, note…)
 *   receivedNet  what actually arrived, in the destination currency's minor units
 *   fee          the fee taken from the amount received, same units; 0 for none
 *   feeCategory  the expense category for the fee; needed only when there is a fee
 */
export function saveTransfer(state, { transfer, receivedNet, fee = 0, feeCategory = '' }) {
  if (!Number.isSafeInteger(fee) || fee < 0) throw Error('The fee cannot be negative.');
  if (!Number.isSafeInteger(receivedNet) || receivedNet <= 0) throw Error('Enter the amount received.');
  if (!Number.isSafeInteger(receivedNet + fee)) throw Error('Amount must be within the supported range.');

  const from = state.accounts.find(account => account.id === transfer.account);
  const to = state.accounts.find(account => account.id === transfer.toAccount);
  if (!transfer.account || !transfer.toAccount || !from || !to) {
    throw Error('Choose the account the money leaves and the account it arrives in.');
  }
  if (from.id === to.id) throw Error('Choose two different accounts.');
  if (hasSourceFee(state, transfer)) throw Error(SOURCE_FEE_MESSAGE);

  const id = transfer.id;
  const old = state.entries.find(entry => entry.id === id);
  const oldFee = state.entries.find(entry => entry.feeOnReceived === id);

  const record = {
    ...transfer,
    kind: 'transfer',
    currency: from.currency,
    precision: from.precision,
    receivedMinor: receivedNet + fee
  };
  // The amount sent is always in the from-account's own currency.
  delete record.settledMinor; delete record.settledCurrency; delete record.settledPrecision;
  delete record.settledEstimate;
  // A changed amount makes an older reporting-currency value stale.
  if (old && (old.minor !== record.minor || old.currency !== record.currency)) {
    delete record.reportingMinor; delete record.reportingCurrency; delete record.reportingPrecision;
  }
  if (fee > 0) record.group = id;
  else if (record.group === id) delete record.group;

  const operations = [{ table: 'entries', record }];
  if (fee > 0) {
    const category = state.categories.find(c => c.id === feeCategory && c.kind === 'expense');
    if (!category) throw Error('Choose an expense category for the fee.');
    operations.push({
      table: 'entries',
      record: {
        id: oldFee?.id || 'rfee:' + id,
        kind: 'expense',
        feeOnReceived: id,
        group: id,
        status: record.status,
        date: record.date,
        minor: fee,
        currency: to.currency,
        precision: to.precision,
        account: to.id,
        category: category.id,
        pot: category.pot || '',
        trip: '',
        tags: 'fee',
        note: 'Fee taken from the amount received',
        ledger: 'active'
      }
    });
  } else if (oldFee) {
    operations.push({ table: 'entries', record: oldFee, action: 'delete' });
  }
  return commitBatch(state, operations);
}
