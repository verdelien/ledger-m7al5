// Shared sync rules, used by the page and bundled into backend/Code.gs.
// Pure functions only: no network, no browser or Google APIs, no secrets.
// Top-level names are prefixed so they stay unique in the bundled files.

/** Protocol version. The page and the script must agree. */
export const SYNC_SCHEMA = 2;

/** Ledger tables that sync, one row per record. Settings sync one row per key. */
export const SYNC_TABLES = ['accounts', 'categories', 'pots', 'entries', 'allocations', 'templates', 'schedules', 'trips', 'wishlist', 'friends', 'settlements', 'valuations', 'caps', 'trash'];
export const SYNC_SETTINGS = 'settings';

/** The largest record the sheet accepts (a cell holds 50,000 characters). */
export const SYNC_MAX_RECORD = 45000;

/** Technical columns at the far right of every tab. `json` is the source of truth. */
export const SYNC_TECH = ['id', 'revision', 'updatedAt', 'deleted', 'changedAt', 'table', 'json'];

/**
 * The readable tabs. `amounts` are the 1-based columns holding decimal amounts;
 * `names` marks tabs whose readable cells show names from other tabs.
 */
export const SHEET_TABS = [
  {
    name: 'Entries', tables: ['entries'], amounts: [3, 11], names: true,
    columns: ['Date', 'Type', 'Amount', 'Currency', 'Category', 'Pot', 'Account', 'Note', 'Tags', 'Status', 'Charged to account', 'Account currency', 'Trip']
  },
  { name: 'Accounts', tables: ['accounts'], amounts: [4], columns: ['Name', 'Type', 'Currency', 'Opening balance', 'Opening date', 'Archived'] },
  { name: 'Pots', tables: ['pots'], amounts: [4], names: true, columns: ['Name', 'Type', 'Currency', 'Target', 'Rolls over', 'Archived'] },
  { name: 'Categories', tables: ['categories'], names: true, columns: ['Category', 'Type', 'Pot', 'Archived'] },
  { name: 'Allocations', tables: ['allocations'], amounts: [4], names: true, columns: ['Date', 'From pot', 'To pot', 'Amount', 'Currency', 'Note'] },
  { name: 'Settings', tables: [SYNC_SETTINGS], columns: ['Setting', 'Value'] },
  {
    name: 'Other', tables: ['templates', 'schedules', 'trips', 'wishlist', 'friends', 'settlements', 'valuations', 'caps', 'trash'],
    columns: ['Kind', 'Name', 'Details']
  }
];

/** Tables whose names appear in the readable cells of other rows. */
export const SYNC_NAME_TABLES = ['accounts', 'pots', 'categories', 'trips'];

export function syncTabFor(table) {
  return SHEET_TABS.find(tab => tab.tables.includes(table)) || null;
}

/** JSON with sorted keys, so two copies of one record compare equal. */
export function canonicalJson(value) {
  if (value === undefined || value === null) return 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object') {
    return '{' + Object.keys(value).filter(key => value[key] !== undefined).sort()
      .map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function syncClone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** The part of a ledger that syncs: settings and the record tables. */
export function syncView(state) {
  const view = { settings: state.settings || null };
  for (const table of SYNC_TABLES) view[table] = state[table] || [];
  return syncClone(view);
}

export function emptyView() {
  const view = { settings: null };
  for (const table of SYNC_TABLES) view[table] = [];
  return view;
}

/** A table's records. Settings become one `{ id: key, value }` record per key. */
export function syncRecords(view, table) {
  if (table !== SYNC_SETTINGS) return view[table] || [];
  const settings = view.settings || {};
  return Object.keys(settings).filter(key => settings[key] !== undefined).map(key => ({ id: key, value: settings[key] }));
}

export function syncRecord(view, table, id) {
  if (table === SYNC_SETTINGS) {
    const settings = view.settings || {};
    return Object.prototype.hasOwnProperty.call(settings, id) && settings[id] !== undefined ? { id, value: settings[id] } : null;
  }
  return (view[table] || []).find(record => record.id === id) || null;
}

/** Put a record into a view, or remove it when `record` is null. Changes `view`. */
export function syncPutRecord(view, table, id, record) {
  if (table === SYNC_SETTINGS) {
    if (!view.settings) view.settings = {};
    if (record) view.settings[id] = syncClone(record.value);
    else delete view.settings[id];
    return view;
  }
  view[table] = (view[table] || []).filter(row => row.id !== id);
  if (record) view[table].push(syncClone(record));
  return view;
}

export function syncKey(table, id) {
  return table + '\n' + id;
}

/** Refuse a malformed change before anything is stored. Returns the record's JSON. */
export function syncCheckChange(change) {
  if (!change || (change.table !== SYNC_SETTINGS && !SYNC_TABLES.includes(change.table))) throw Error('Unknown sync table.');
  const record = change.record;
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw Error('A sync change needs its record.');
  if (typeof record.id !== 'string' || !record.id || record.id.length > 300) throw Error('Invalid sync ID.');
  if (change.table === SYNC_SETTINGS && !change.deleted && record.value === undefined) throw Error('A setting needs a value.');
  const json = JSON.stringify(record);
  if (json.length > SYNC_MAX_RECORD) throw Error('The record ' + record.id + ' is too large for one sheet cell.');
  return json;
}

/**
 * What changed between two views, as push changes:
 * `{ table, record, deleted }`. A deletion carries the last known record,
 * so the sheet keeps a readable tombstone row.
 */
export function syncDiff(base, current) {
  const changes = [];
  for (const table of [SYNC_SETTINGS].concat(SYNC_TABLES)) {
    const before = new Map(syncRecords(base, table).map(record => [record.id, record]));
    const after = new Map(syncRecords(current, table).map(record => [record.id, record]));
    for (const [id, record] of after) {
      if (!before.has(id) || canonicalJson(before.get(id)) !== canonicalJson(record)) changes.push({ table, record, deleted: false });
    }
    for (const [id, record] of before) {
      if (!after.has(id)) changes.push({ table, record, deleted: true });
    }
  }
  return changes;
}

// ---- Readable cells -------------------------------------------------------

/** Integer minor units as an exact decimal string: (-1250, 2) → "-12.50". */
export function syncDecimal(minor, precision, negative) {
  if (minor === null || minor === undefined || !Number.isSafeInteger(minor)) return '';
  const places = Number.isInteger(precision) && precision >= 0 && precision <= 8 ? precision : 2;
  const digitsOnly = String(Math.abs(minor)).padStart(places + 1, '0');
  const whole = places ? digitsOnly.slice(0, -places) : digitsOnly;
  const sign = (minor < 0) !== !!negative && minor !== 0 ? '-' : '';
  return sign + whole + (places ? '.' + digitsOnly.slice(-places) : '');
}

function syncLabel(text) {
  const words = String(text || '').replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function syncNameOf(view, table, id) {
  if (!id) return '';
  const row = (view[table] || []).find(record => record.id === id);
  return row && row.name ? row.name : String(id);
}

/** "Eating out › Takeaway". */
export function syncCategoryPath(view, id) {
  const parts = [];
  const seen = {};
  let current = id;
  while (current && !seen[current]) {
    seen[current] = true;
    const category = (view.categories || []).find(record => record.id === current);
    if (!category) { if (!parts.length) parts.unshift(String(current)); break; }
    parts.unshift(category.name);
    current = category.parent;
  }
  return parts.join(' › ');
}

function syncYes(value) {
  return value ? 'yes' : '';
}

/**
 * The readable cells of one record, in the column order of its tab.
 * `view` supplies the names of categories, pots, accounts and trips.
 * These cells are for people; the app only ever reads the `json` column.
 */
export function syncReadableRow(table, record, view) {
  const r = record || {};
  if (table === 'entries') {
    const outgoing = r.kind === 'expense' || ((r.kind === 'adjustment' || r.kind === 'settlement') && r.direction !== 'increase');
    const account = r.kind === 'transfer'
      ? syncNameOf(view, 'accounts', r.account) + ' → ' + syncNameOf(view, 'accounts', r.toAccount)
      : syncNameOf(view, 'accounts', r.account);
    const charged = r.settledMinor === null || r.settledMinor === undefined;
    return [
      r.date || '', syncLabel(r.kind), syncDecimal(r.minor, r.precision, outgoing), r.currency || '',
      syncCategoryPath(view, r.category), syncNameOf(view, 'pots', r.pot), account, r.note || '', r.tags || '', syncLabel(r.status),
      charged ? '' : syncDecimal(r.settledMinor, r.settledPrecision, outgoing), charged ? '' : r.settledCurrency || '',
      syncNameOf(view, 'trips', r.trip)
    ];
  }
  if (table === 'accounts') {
    return [r.name || '', syncLabel(r.type), r.currency || '', syncDecimal(r.opening, r.precision), r.openingDate || '', syncYes(r.archived)];
  }
  if (table === 'pots') {
    const rollover = r.rollover && r.rollover.enabled
      ? 'After ' + r.rollover.months + (r.rollover.months === 1 ? ' month' : ' months') + ' → ' + syncNameOf(view, 'pots', r.rollover.to)
      : '';
    return [r.name || '', syncLabel(r.kind), r.currency || '', r.target == null ? '' : syncDecimal(r.target, r.precision), rollover, syncYes(r.archived)];
  }
  if (table === 'categories') {
    return [syncCategoryPath(view, r.id), syncLabel(r.kind), syncNameOf(view, 'pots', r.pot), syncYes(r.archived)];
  }
  if (table === 'allocations') {
    const pot = (view.pots || []).find(p => p.id === r.to) || (view.pots || []).find(p => p.id === r.from) || {};
    return [
      r.date || '', r.from ? syncNameOf(view, 'pots', r.from) : 'New budget', syncNameOf(view, 'pots', r.to),
      syncDecimal(r.minor, pot.precision), pot.currency || '', r.note || ''
    ];
  }
  if (table === SYNC_SETTINGS) {
    const value = JSON.stringify(r.value === undefined ? null : r.value);
    return [r.id || '', value.length > 2000 ? value.slice(0, 2000) + '…' : value];
  }
  const inner = table === 'trash' && r.record ? r.record : r;
  const details = [table === 'trash' ? 'Deleted from ' + (r.table || 'the ledger') : '', inner.date || inner.start || '', inner.note || '']
    .filter(Boolean).join(' · ');
  return [syncLabel(table), inner.name || '', details];
}
