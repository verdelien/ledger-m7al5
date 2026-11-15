// Backup, restore, CSV export and the list of deleted records. Pure functions.
// A backup is the stored ledger as JSON; it is validated in full before it may replace anything.

import { validateState, migrate } from './model.js';

/** The file to download: { name, text }. */
export function backupFile(s, today) {
  return { name: `expense-book-${today}.json`, text: JSON.stringify(s, null, 2) };
}

/** Parse and fully validate a backup file's text. Returns the ledger state or throws a readable error. */
export function readBackup(text, today) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw Error('This file is not a backup from this app.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.entries)) {
    throw Error('This file is not a backup from this app.');
  }
  try {
    if (data.version === 1) return validateState(migrate(data, today));
    if (!Array.isArray(data.accounts)) throw Error('This file is not a backup from this app.');
    return validateState(data);
  } catch (error) {
    if (error.message === 'This file is not a backup from this app.') throw error;
    throw Error(`This backup cannot be used: ${error.message} Nothing was changed.`);
  }
}

/** The state to store when `incoming` replaces `current`: the backup, numbered so the store accepts it. */
export function restoreBackup(current, incoming) {
  validateState(incoming);
  const next = structuredClone(incoming);
  next.revision = current.revision + 1;
  return validateState(next);
}

/** Counts and date range of a ledger, for the confirmation before a restore. */
export function backupSummary(s) {
  const dates = s.entries.map(e => e.date).sort();
  return {
    entries: s.entries.length, accounts: s.accounts.length, pots: s.pots.length,
    firstDate: dates[0] || '', lastDate: dates[dates.length - 1] || ''
  };
}

function backupDecimal(minor, precision) {
  const value = BigInt(minor), negative = value < 0n, absolute = negative ? -value : value;
  const scale = 10n ** BigInt(precision);
  const fraction = precision ? '.' + (absolute % scale).toString().padStart(precision, '0') : '';
  return (negative ? '-' : '') + (absolute / scale).toString() + fraction;
}

/** 'Parent › Child' for a category id; '' when it is unknown. */
function backupCategoryPath(s, id) {
  const parts = [], seen = new Set();
  while (id && !seen.has(id)) {
    seen.add(id);
    const category = s.categories.find(c => c.id === id);
    if (!category) break;
    parts.unshift(category.name);
    id = category.parent;
  }
  return parts.join(' › ');
}

// Text typed by the user can start with = + - @, which a spreadsheet would run as a formula.
// A leading apostrophe keeps it as plain text. Amounts are not passed through this.
function backupSafeText(value) {
  const text = String(value ?? '');
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function backupCsvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

/** -1 for money out, +1 for money in, from the paying account's point of view. Transfers count as positive. */
function backupEntrySign(e) {
  if (e.kind === 'expense') return -1;
  if (e.kind === 'adjustment' || e.kind === 'settlement') return e.direction === 'increase' ? 1 : -1;
  return 1;
}

/** Every entry that is not cancelled, active and historical, as CSV text (RFC 4180, CRLF line ends). */
export function entriesCsv(s) {
  const name = (table, id) => (id && s[table].find(r => r.id === id)?.name) || '';
  const rows = [['id', 'date', 'kind', 'status', 'amount', 'currency', 'charged', 'charged_currency', 'category_path', 'account', 'to_account', 'pot', 'trip', 'note']];
  const entries = s.entries
    .map((entry, index) => ({ entry, index }))
    .filter(row => row.entry.status !== 'cancelled')
    .sort((a, b) => a.entry.date.localeCompare(b.entry.date) || a.index - b.index);
  for (const { entry: e } of entries) {
    const sign = backupEntrySign(e);
    const charged = e.settledMinor != null && e.settledCurrency;
    rows.push([
      e.id, e.date, e.kind, e.status,
      backupDecimal(BigInt(e.minor) * BigInt(sign), e.precision), e.currency,
      charged ? backupDecimal(BigInt(e.settledMinor) * BigInt(sign), e.settledPrecision) : '', charged ? e.settledCurrency : '',
      ...[backupCategoryPath(s, e.category),
        name('accounts', e.account), name('accounts', e.toAccount), name('pots', e.pot), name('trips', e.trip), e.note || ''].map(backupSafeText)
    ]);
  }
  return rows.map(row => row.map(backupCsvCell).join(',')).join('\r\n') + '\r\n';
}

const BACKUP_TABLE_WORDS = {
  accounts: 'Account', categories: 'Category', pots: 'Pot', entries: 'Entry', allocations: 'Pot funding', templates: 'Quick add',
  schedules: 'Recurring payment', trips: 'Trip', wishlist: 'Wish', friends: 'Friend', settlements: 'Settlement', valuations: 'Valuation', caps: 'Cap'
};

function backupTrashLabel(s, item) {
  const r = item.record || {};
  const kind = BACKUP_TABLE_WORDS[item.table] || 'Record';
  const amount = Number.isSafeInteger(r.minor) && r.currency && Number.isInteger(r.precision)
    ? `${backupDecimal(r.minor, r.precision)} ${r.currency}` : '';
  if (item.table === 'entries') {
    const what = backupCategoryPath(s, r.category) || r.note || r.kind || 'Entry';
    return [r.date, what, amount].filter(Boolean).join(' · ');
  }
  const title = r.name || r.note || [r.date, amount].filter(Boolean).join(' · ');
  return title ? `${kind}: ${title}` : kind;
}

/** Deleted records, newest first: [{ id, table, label, deletedAt }]. */
export function trashList(s) {
  return s.trash
    .map((item, index) => ({ item, index }))
    .sort((a, b) => String(b.item.deletedAt || '').localeCompare(String(a.item.deletedAt || '')) || b.index - a.index)
    .map(({ item }) => ({ id: item.id, table: item.table, label: backupTrashLabel(s, item), deletedAt: item.deletedAt || '' }));
}
