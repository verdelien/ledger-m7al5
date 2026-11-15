// Bills shared with friends: who owes whom, repayments and forgiveness.
//
// A shared purchase is an ordinary expense that also names a friend and carries
// `friendDelta`: how much more the friend owes me because of it (negative when I owe
// them). A settlement record moves the debt the other way: a repayment (which also moves
// money on one of my accounts) or a forgiveness (which does not). The net balance per
// friend and currency is `sharedBalance` in planning.js. Currencies are never added.
//
// The records are the same ones the previous version writes, so both read each other's.

import { commit, commitBatch, uid } from './model.js';
import { digits, validDate } from './domain.js';
import { divideRounded } from './money.js';
import { sharedBalance } from './planning.js';
import { canRefundHere } from './refund-logic.js';

/** Today's date on this device, as YYYY-MM-DD. */
function sharedToday() {
  const now = new Date();
  const pad = number => String(number).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** '£18.00' or '1,800 JPY'. Exact integers; for messages and labels. */
export function sharedMoney(minor, currency, precision) {
  let value = BigInt(minor);
  if (value < 0n) value = -value;
  const scale = 10n ** BigInt(precision);
  const whole = (value / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const text = whole + (precision ? '.' + (value % scale).toString().padStart(precision, '0') : '');
  return currency === 'GBP' ? `£${text}` : `${text} ${currency}`;
}

function sharedFriend(s, friendId) {
  const friend = s.friends.find(f => f.id === friendId);
  if (!friend) throw Error('Choose a friend.');
  return friend;
}

/** Entries that count towards a friend's balance. */
function sharedEntries(s, friendId) {
  return s.entries.filter(e => e.friend === friendId && e.status === 'posted' && e.ledger === 'active');
}

/** "Ana owes you £48.00", "You owe Ana £12.00" or "Settled with Ana". */
export function balancePhrase(name, balance) {
  if (!balance || balance.minor === 0n) return `Settled with ${name}`;
  const amount = sharedMoney(balance.minor, balance.currency, balance.precision);
  return balance.minor > 0n ? `${name} owes you ${amount}` : `You owe ${name} ${amount}`;
}

/** Add a friend, or rename one (`id` of an existing friend). Returns the new state. */
export function saveFriend(s, { id = '', name }) {
  const clean = String(name || '').trim();
  if (!clean) throw Error('Enter the friend’s name.');
  if (clean.length > 150) throw Error('A name can have at most 150 characters.');
  const existing = id ? s.friends.find(f => f.id === id) : null;
  if (s.friends.some(f => f.id !== existing?.id && f.name.trim().toLowerCase() === clean.toLowerCase())) {
    throw Error(`You already have a friend called ${clean}.`);
  }
  return commit(s, 'friends', { ...(existing || {}), id: existing?.id || id || uid(), name: clean });
}

/** Every currency a friend has records in, with its precision. */
function sharedCurrencies(s, friendId) {
  const found = new Map();
  for (const e of sharedEntries(s, friendId)) if (!found.has(e.currency)) found.set(e.currency, e.precision);
  for (const r of s.settlements) if (r.friend === friendId && !found.has(r.currency)) found.set(r.currency, r.precision);
  return found;
}

/** The non-zero balances with one friend, one per currency. Positive: they owe me. */
export function friendBalances(s, friendId) {
  return [...sharedCurrencies(s, friendId)]
    .map(([currency, precision]) => ({ currency, precision, minor: sharedBalance(s, friendId, currency) }))
    .filter(balance => balance.minor !== 0n);
}

/** Friends who have any shared record, each with their non-zero balances. */
export function allBalances(s) {
  return s.friends
    .filter(friend => sharedCurrencies(s, friend.id).size > 0)
    .map(friend => ({ friend, balances: friendBalances(s, friend.id) }));
}

const SETTLEMENT_LABELS = {
  receive: name => `${name} paid you back`,
  pay: name => `You paid ${name} back`,
  absorb: name => `You let ${name} off`,
  waived: name => `${name} let you off`
};

/**
 * Everything that changed the balance with one friend, oldest first. Each row:
 * { id, kind: 'purchase'|'refund'|'settlement', action?, date, label, delta, currency,
 *   precision, balance } where `balance` is the running balance in that row's currency.
 */
export function friendHistory(s, friendId) {
  const name = s.friends.find(f => f.id === friendId)?.name || 'Friend';
  const titleOf = entry => entry.note || s.categories.find(c => c.id === entry.category)?.name || 'Shared purchase';
  const rows = [];
  s.entries.forEach((entry, index) => {
    if (entry.friend !== friendId || entry.status !== 'posted' || entry.ledger !== 'active') return;
    const refund = entry.kind === 'refund';
    const origin = refund ? s.entries.find(e => e.id === entry.original) || entry : entry;
    const friendPaid = origin.paidBy === 'friend' || origin.friendDelta < 0;
    rows.push({
      id: entry.id, kind: refund ? 'refund' : 'purchase', date: entry.date, order: index,
      label: refund ? `Refund · ${titleOf(origin)}` : `${titleOf(entry)} · ${friendPaid ? `${name} paid` : 'you paid'}`,
      delta: BigInt(entry.friendDelta || 0), currency: entry.currency, precision: entry.precision
    });
  });
  s.settlements.forEach((record, index) => {
    if (record.friend !== friendId) return;
    rows.push({
      id: record.id, kind: 'settlement', action: record.action, date: record.date, order: s.entries.length + index,
      label: (SETTLEMENT_LABELS[record.action] || (() => 'Settlement'))(name),
      delta: BigInt(record.delta), currency: record.currency, precision: record.precision
    });
  });
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order);
  const running = new Map();
  return rows.map(({ order, ...row }) => {
    const balance = (running.get(row.currency) || 0n) + row.delta;
    running.set(row.currency, balance);
    return { ...row, balance };
  });
}

/**
 * Build the entry for a purchase shared with a friend. Returns the record; save it with
 * commit(state, 'entries', record). Throws a readable error when something is wrong.
 *   friend       the friend's id
 *   paidBy       'me' or 'friend'
 *   totalMinor   the whole bill
 *   ownMinor     my share of it (0 up to the total)
 *   currency, category, date, note
 *   account      my account when I paid ('' for none); ignored when the friend paid
 *   id           an existing expense to change (its other fields are kept), or the id for a new one
 *   settledMinor, settledEstimate   what my account was charged, when it is in another currency
 *   trip         optional
 *   today        when given, a later date is refused: a shared bill is recorded once paid
 */
export function sharedExpenseRecord(s, fields) {
  const { friend, paidBy, totalMinor, ownMinor, currency, category, date, note = '', id = '', trip, settledMinor, settledEstimate, today } = fields;
  const person = sharedFriend(s, friend);
  if (paidBy !== 'me' && paidBy !== 'friend') throw Error('Choose who paid.');
  const friendPaid = paidBy === 'friend';
  if (!Number.isSafeInteger(totalMinor) || totalMinor <= 0) throw Error('Enter the total amount of the bill.');
  if (!Number.isSafeInteger(ownMinor) || ownMinor < 0) throw Error('Enter your share of the bill.');
  if (ownMinor > totalMinor) throw Error('Your share cannot be more than the total.');
  if (friendPaid && ownMinor === 0) throw Error(`${person.name} paid and your share is zero, so there is nothing to record.`);
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw Error('Choose a currency.');
  const categoryRecord = s.categories.find(c => c.id === category && c.kind === 'expense');
  if (!categoryRecord) throw Error('Choose a category.');
  if (typeof date !== 'string' || !validDate(date)) throw Error('Choose a date.');
  if (today && date > today) throw Error('A shared bill is recorded once it is paid. Choose today or an earlier date.');

  const existing = id ? s.entries.find(e => e.id === id) : null;
  if (existing && existing.kind !== 'expense') throw Error('Only an expense can be shared with a friend.');
  if (existing?.splits) throw Error('A purchase split between categories cannot also be shared with a friend.');

  const accountId = friendPaid ? '' : fields.account || '';
  const account = accountId ? s.accounts.find(a => a.id === accountId) : null;
  if (accountId && !account) throw Error('Choose the account you paid from.');
  const precision = digits(currency);

  const record = {
    trip: '',
    ...(existing || {}),
    id: id || uid(),
    kind: 'expense', status: 'posted', ledger: 'active',
    date, currency, precision,
    minor: friendPaid ? ownMinor : totalMinor,
    personalMinor: ownMinor,
    sharedTotal: totalMinor,
    paidBy,
    friend: person.id,
    friendDelta: friendPaid ? -ownMinor : totalMinor - ownMinor,
    account: accountId,
    category: categoryRecord.id,
    // A bill being edited keeps the pot it was charged to unless its category changes.
    pot: existing && existing.category === categoryRecord.id ? existing.pot || '' : categoryRecord.pot || '',
    tags: existing?.tags || 'shared',
    note: String(note || '').trim()
  };
  if (trip !== undefined) record.trip = trip || '';

  for (const key of ['settledMinor', 'settledCurrency', 'settledPrecision', 'settledEstimate']) delete record[key];
  if (account && (account.currency !== currency || account.precision !== precision)) {
    if (!Number.isSafeInteger(settledMinor) || settledMinor < 0) {
      throw Error(`Enter what ${account.name} was charged in ${account.currency} (an estimate is fine), or choose "No account".`);
    }
    record.settledMinor = settledMinor;
    record.settledCurrency = account.currency;
    record.settledPrecision = account.precision;
    if (settledEstimate === true) record.settledEstimate = true;
  }
  // A changed amount makes an older reporting-currency value stale.
  if (existing && (existing.minor !== record.minor || existing.currency !== currency)) {
    for (const key of ['reportingMinor', 'reportingCurrency', 'reportingPrecision']) delete record[key];
  }
  return record;
}

/**
 * Record a repayment or a forgiveness. Returns the new, validated state.
 *   action   'receive'  they paid me back      (they owe me; money arrives on `account`)
 *            'pay'      I paid them back       (I owe them; money leaves `account`)
 *            'absorb'   I let them off         (they owe me; it becomes my own spending)
 *            'waived'   they let me off        (I owe them)
 *   amountMinor   at most the balance in `currency`
 *   account       for receive and pay: one of my accounts in that currency
 */
export function settle(s, { friend, action, amountMinor, currency, account = '', date, today = sharedToday() }) {
  const person = sharedFriend(s, friend);
  if (!SETTLEMENT_LABELS[action]) throw Error('Choose what happened.');
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw Error('Choose a currency.');
  const precision = sharedCurrencies(s, person.id).get(currency) ?? digits(currency);
  const balance = sharedBalance(s, person.id, currency);
  const reduces = action === 'receive' || action === 'absorb'; // lowers what they owe me
  const owed = sharedMoney(balance, currency, precision);

  if (balance === 0n) throw Error(`You and ${person.name} are settled in ${currency}; there is nothing to record.`);
  if (reduces && balance < 0n) {
    throw Error(`You owe ${person.name} ${owed}, so they have nothing to ${action === 'receive' ? 'pay back' : 'be let off'}. Record what you paid them instead.`);
  }
  if (!reduces && balance > 0n) {
    throw Error(`${person.name} owes you ${owed}, so you have nothing to ${action === 'pay' ? 'pay back' : 'be let off'}. Record what they paid you instead.`);
  }
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw Error('Enter an amount.');
  if (BigInt(amountMinor) > (balance < 0n ? -balance : balance)) {
    throw Error(balance > 0n
      ? `${person.name} owes you ${owed}; the most you can record is that.`
      : `You owe ${person.name} ${owed}; the most you can record is that.`);
  }
  if (typeof date !== 'string' || !validDate(date)) throw Error('Choose a date.');
  if (date > today) throw Error('The date cannot be in the future.');

  const id = uid();
  const operations = [{
    table: 'settlements',
    record: { id, date, friend: person.id, currency, precision, delta: reduces ? -amountMinor : amountMinor, action }
  }];
  const base = { date, status: 'posted', ledger: 'active', minor: amountMinor, currency, precision, pot: '', trip: '' };

  if (action === 'receive' || action === 'pay') {
    const paidWith = s.accounts.find(a => a.id === account);
    if (!paidWith || paidWith.currency !== currency || paidWith.precision !== precision) {
      throw Error(`Choose one of your ${currency} accounts for the payment.`);
    }
    if (date < paidWith.openingDate) throw Error(`${paidWith.name} starts on ${paidWith.openingDate}; choose that date or a later one.`);
    operations.push({ table: 'entries', record: {
      ...base, id: 'payment:' + id, kind: 'settlement', direction: action === 'receive' ? 'increase' : 'decrease',
      account: paidWith.id, category: '', tags: 'settlement', note: `Settlement with ${person.name}`
    } });
  } else if (action === 'absorb') {
    // What I let them off becomes my own spending (as the previous version records it):
    // an expense with no account and no pot, in the category of the latest bill I paid for them.
    const latest = sharedEntries(s, person.id)
      .filter(e => e.kind === 'expense' && e.currency === currency && e.friendDelta > 0 && e.category)
      .sort((a, b) => a.date.localeCompare(b.date)).pop();
    const category = latest?.category || s.categories.find(c => c.kind === 'expense')?.id;
    if (!category) throw Error('Add an expense category first.');
    operations.push({ table: 'entries', record: {
      ...base, id: 'forgiven:' + id, kind: 'expense', account: '', category, tags: 'forgiveness', note: `Absorbed share for ${person.name}`
    } });
  }
  return commitBatch(s, operations);
}

/** Undo one repayment or forgiveness, with the payment or expense written for it. */
export function deleteSettlement(s, id) {
  const record = s.settlements.find(r => r.id === id);
  if (!record) throw Error('That record was not found.');
  const linked = s.entries.filter(e => e.id === 'payment:' + id || e.id === 'forgiven:' + id);
  return commitBatch(s, [
    ...linked.map(entry => ({ table: 'entries', record: entry, action: 'delete' })),
    { table: 'settlements', record, action: 'delete' }
  ]);
}

/**
 * What can still be refunded on a shared purchase:
 * { friendPaid, total, own } in the purchase currency's minor units (BigInt).
 */
export function sharedRefundLeft(s, purchase) {
  const refunds = s.entries.filter(r => r.kind === 'refund' && r.original === purchase.id && r.status !== 'cancelled');
  const sum = pick => refunds.reduce((n, r) => n + BigInt(pick(r)), 0n);
  const friendPaid = purchase.paidBy === 'friend' || purchase.friendDelta < 0;
  const own = BigInt(purchase.personalMinor) - sum(r => r.personalMinor ?? r.minor);
  const total = BigInt(purchase.sharedTotal ?? purchase.minor) - sum(r => r.merchantRefund ?? r.minor);
  const theirs = BigInt(purchase.minor - purchase.personalMinor) - sum(r => r.minor - (r.personalMinor ?? r.minor));
  return { friendPaid, total, own, theirs: friendPaid ? total - own : theirs };
}

/**
 * Record a refund of a shared purchase. Returns the new, validated state.
 *   totalMinor    what the shop gave back in all
 *   ownMinor      my share of that; the rest is the friend's
 *   settledMinor  what my account was credited, for a purchase charged in another
 *                 currency; left out, it is estimated from the original charge
 * When I paid, the whole refund returns to my account and the friend owes me less.
 * When the friend paid, only my share is recorded and I owe them less.
 */
export function saveSharedRefund(s, { purchaseId, totalMinor, ownMinor, date, note = '', settledMinor, today = sharedToday() }) {
  const purchase = s.entries.find(e => e.id === purchaseId);
  if (!purchase) throw Error('The purchase for this refund was not found.');
  if (!purchase.friend || !canRefundHere(s, purchase)) throw Error('This purchase is not a shared bill that can be refunded.');
  const money = minor => sharedMoney(minor, purchase.currency, purchase.precision);

  if (!Number.isSafeInteger(totalMinor) || totalMinor <= 0) throw Error('Enter the total refunded by the shop.');
  if (!Number.isSafeInteger(ownMinor) || ownMinor < 0) throw Error('Enter your share of the refund.');
  if (ownMinor > totalMinor) throw Error('Your share cannot be more than the total refund.');
  const left = sharedRefundLeft(s, purchase);
  if (left.friendPaid && ownMinor === 0) throw Error('This refund does not change your spending or what you owe.');
  if (left.total <= 0n) throw Error('This purchase is already fully refunded.');
  if (BigInt(totalMinor) > left.total) throw Error(`The most left to refund is ${money(left.total)}.`);
  if (BigInt(ownMinor) > left.own) throw Error(`The most left to refund of your share is ${money(left.own)}.`);
  if (BigInt(totalMinor - ownMinor) > left.theirs) throw Error(`The most left to refund of your friend’s share is ${money(left.theirs)}.`);

  if (typeof date !== 'string' || !validDate(date)) throw Error('Choose the refund date.');
  if (date < purchase.date) throw Error('A refund cannot be dated before the purchase.');
  if (date > today) throw Error('A refund cannot be dated in the future.');

  const minor = left.friendPaid ? ownMinor : totalMinor;
  const share = amount => Number(divideRounded(BigInt(amount) * BigInt(minor), BigInt(purchase.minor)));
  const record = {
    ...purchase,
    id: uid(), kind: 'refund', original: purchase.id, date, status: 'posted',
    minor, personalMinor: ownMinor, merchantRefund: totalMinor,
    friendDelta: left.friendPaid ? ownMinor : -(totalMinor - ownMinor),
    note: String(note || '').trim()
  };
  for (const key of ['settledMinor', 'settledCurrency', 'settledPrecision', 'settledEstimate',
    'reportingMinor', 'reportingCurrency', 'reportingPrecision', 'splits', 'group', 'feeFor']) delete record[key];

  if (purchase.settledMinor != null && purchase.settledCurrency) {
    record.settledCurrency = purchase.settledCurrency;
    record.settledPrecision = purchase.settledPrecision;
    if (settledMinor == null) {
      record.settledMinor = share(purchase.settledMinor);
      record.settledEstimate = true;
    } else {
      if (!Number.isSafeInteger(settledMinor) || settledMinor <= 0) throw Error('Enter the amount credited to the account.');
      record.settledMinor = settledMinor;
    }
  }
  if (purchase.reportingMinor != null && purchase.reportingCurrency) {
    record.reportingMinor = share(purchase.reportingMinor);
    record.reportingCurrency = purchase.reportingCurrency;
    record.reportingPrecision = purchase.reportingPrecision;
  }
  return commitBatch(s, [{ table: 'entries', record }]);
}
