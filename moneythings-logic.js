// Import of a MoneyThings CSV export into the current ledger.
// Parsing, the account and category mapping, and building the records are kept
// apart from the interface so that they can be tested. Amounts are read from
// their decimal text straight into integer minor units; no floats are used.

import { digits, validDate } from './domain.js';
import { commitBatch, uid, validateState, quarter } from './model.js';

const MT_HEADER = '场景,交易类型,转出账户,转出子账户,转出金额,转入账户,转入子账户,转入金额,大类,中类,小类,交易货币,交易金额,交易时间,标签,备注,成员';
const MT_TYPES = { '支出': 'expense', '收入': 'income', '转移': 'transfer' };
const MT_ACCOUNT_TYPES = ['current', 'savings', 'credit_card', 'cash_wallet', 'investment'];
const MT_SEPARATOR = ' › ';

/** Mapping value for a category whose rows the user chose to leave out. */
export const MT_LEAVE_OUT = '-';

/** RFC-4180 records, each with the line it starts on. */
function mtCsvRecords(text) {
  const records = [];
  let fields = [], field = '', quoted = false, line = 1, startLine = 1, any = false;
  const endRecord = () => {
    fields.push(field);
    if (any || fields.length > 1) records.push({ line: startLine, fields });
    fields = []; field = ''; any = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') { quoted = true; any = true; }
    else if (ch === ',') { fields.push(field); field = ''; any = true; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRecord();
      line++;
      startLine = line;
    } else { field += ch; any = true; }
  }
  if (any || fields.length) endRecord();
  return records;
}

/** '-1,234.50' → '-1234.5'; '' stays ''; null when it is not a number. */
function mtDecimal(text) {
  const value = text.trim().replace(/^−/, '-');
  if (!value) return '';
  const match = /^([-+]?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d*))?$/.exec(value);
  if (!match) return null;
  const whole = match[2].replaceAll(',', '').replace(/^0+(?=\d)/, '');
  const fraction = (match[3] || '').replace(/0+$/, '');
  const zero = /^0+$/.test(whole) && !fraction;
  return (match[1] === '-' && !zero ? '-' : '') + whole + (fraction ? '.' + fraction : '');
}

/** The size of a normalised decimal in minor units; throws when it has more decimals than the currency. */
function mtMinor(decimal, precision, currency) {
  const [whole, fraction = ''] = decimal.replace('-', '').split('.');
  if (fraction.length > precision) throw Error(`${decimal} has more decimal places than ${currency} allows.`);
  const minor = BigInt(whole) * 10n ** BigInt(precision) + BigInt(fraction.padEnd(precision, '0') || '0');
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('An amount is outside the supported range.');
  return Number(minor);
}

/**
 * Read a MoneyThings export.
 * Returns { rows, problems }. Each row: { line, type ('expense'|'income'|'transfer'), from, fromAmount, to, toAmount,
 * path, currency, amount, date, time, tags, note }. Amounts are normalised decimal text with their sign.
 */
export function parseMoneyThings(text) {
  const records = mtCsvRecords(String(text ?? '').replace(/^﻿/, ''));
  if (!records.length || records[0].fields.map(f => f.trim()).join(',') !== MT_HEADER) {
    throw Error("This is not a MoneyThings export (the columns don't match).");
  }
  const rows = [], problems = [];
  for (const { line, fields } of records.slice(1)) {
    const problem = reason => problems.push({ line, reason });
    if (fields.length !== 17) { problem('This row does not have the 17 expected columns.'); continue; }
    const f = fields.map(value => value.trim());
    const type = MT_TYPES[f[1]];
    if (!type) { problem(`Transaction type "${f[1]}" is not supported.`); continue; }
    const fromAmount = mtDecimal(f[4]), toAmount = mtDecimal(f[7]), amount = mtDecimal(f[12]);
    if (fromAmount === null || toAmount === null || amount === null) { problem('An amount is not a number.'); continue; }
    const time = f[13], date = time.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(time) || !validDate(date)) { problem('The date is not valid.'); continue; }
    if (type !== 'income' && (!f[2] || !fromAmount)) { problem('The account or amount the money left is missing.'); continue; }
    if (type !== 'expense' && (!f[5] || !toAmount)) { problem('The account or amount the money arrived in is missing.'); continue; }
    if (type !== 'transfer' && !amount) { problem('The transaction amount is missing.'); continue; }
    if (type !== 'transfer' && !/^[A-Z]{3}$/.test(f[11])) { problem('The transaction currency is missing.'); continue; }
    const note = f[15].length > 500 ? f[15].slice(0, 499) + '…' : f[15];
    rows.push({
      line, type,
      from: type === 'income' ? '' : f[2], fromAmount: type === 'income' ? '' : fromAmount,
      to: type === 'expense' ? '' : f[5], toAmount: type === 'expense' ? '' : toAmount,
      path: type === 'transfer' ? [] : [f[8], f[9], f[10]].filter(Boolean),
      currency: f[11], amount, date, time, tags: f[14], note
    });
  }
  return { rows, problems };
}

/** The mapping key of a row's category: its kind and its path, e.g. 'expense:美食 › 外卖'. '' for a transfer. */
export function categoryKey(row) {
  return row.type === 'transfer' ? '' : row.type + ':' + row.path.join(MT_SEPARATOR);
}

/**
 * Every MoneyThings account in the rows: [{ name, count, firstDate, currency }], most used first.
 * `currency` is a guess (the transaction currency of rows whose account amount equals the transaction amount).
 */
export function distinctAccounts(rows) {
  const found = new Map();
  const note = (name, row, accountAmount) => {
    let item = found.get(name);
    if (!item) found.set(name, item = { name, count: 0, firstDate: row.date, votes: {} });
    item.count++;
    if (row.date < item.firstDate) item.firstDate = row.date;
    if (row.currency && accountAmount.replace('-', '') === row.amount.replace('-', '')) item.votes[row.currency] = (item.votes[row.currency] || 0) + 1;
  };
  for (const row of rows) {
    if (row.from) note(row.from, row, row.fromAmount);
    if (row.to) note(row.to, row, row.toAmount);
  }
  return [...found.values()]
    .map(({ votes, ...item }) => ({ ...item, currency: Object.entries(votes).sort((a, b) => b[1] - a[1])[0]?.[0] || '' }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Every category path in the rows: [{ id (mapping key), key (path joined with ' › '), path, kind, count }]. */
export function distinctCategories(rows) {
  const found = new Map();
  for (const row of rows) {
    if (row.type === 'transfer') continue;
    const id = categoryKey(row);
    let item = found.get(id);
    if (!item) found.set(id, item = { id, key: row.path.join(MT_SEPARATOR), path: [...row.path], kind: row.type, count: 0 });
    item.count++;
  }
  return [...found.values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'expense' ? -1 : 1) || b.count - a.count || a.key.localeCompare(b.key));
}

/** App categories an imported row can use: [{ id, kind, name, parent, label }], each 'Parent' followed by its 'Parent › Child' ones. */
export function importCategoryChoices(state, kind) {
  const live = state.categories.filter(c => c.kind === kind && !c.archived);
  const ids = new Set(live.map(c => c.id));
  const choices = [];
  const add = (c, prefix, seen) => {
    if (seen.has(c.id)) return;
    const label = prefix ? prefix + MT_SEPARATOR + c.name : c.name;
    choices.push({ id: c.id, kind, name: c.name, parent: c.parent || '', label });
    for (const child of live) if (child.parent === c.id) add(child, label, new Set([...seen, c.id]));
  };
  // A category whose parent is archived or missing is listed on its own.
  for (const c of live) if (!c.parent || !ids.has(c.parent)) add(c, '', new Set());
  return choices;
}

/**
 * A first mapping: { accounts: { mtName: accountId | '' }, categories: { categoryKey: categoryId | MT_LEAVE_OUT | '' } }.
 * A saved choice wins while what it points at still exists; otherwise an exact name match, ignoring case.
 */
export function suggestMapping(state, rows, saved = state.settings.importMap?.moneythings) {
  const fold = text => String(text).trim().toLowerCase();
  const accounts = {}, categories = {};
  const liveAccounts = state.accounts.filter(a => !a.archived);
  for (const { name } of distinctAccounts(rows)) {
    const kept = saved?.accounts?.[name];
    accounts[name] = kept && state.accounts.some(a => a.id === kept) ? kept
      : liveAccounts.find(a => fold(a.name) === fold(name))?.id || '';
  }
  const choices = { expense: importCategoryChoices(state, 'expense'), income: importCategoryChoices(state, 'income') };
  for (const item of distinctCategories(rows)) {
    const kept = saved?.categories?.[item.id];
    if (kept === MT_LEAVE_OUT || (kept && state.categories.some(c => c.id === kept && c.kind === item.kind))) { categories[item.id] = kept; continue; }
    let match = '';
    // The deepest level first; at one level a subcategory is preferred to a top-level category of the same name.
    for (let level = item.path.length - 1; level >= 0 && !match; level--) {
      const named = choices[item.kind].filter(c => fold(c.name) === fold(item.path[level]));
      match = (level > 0 ? named.find(c => c.parent) || named[0] : named.find(c => !c.parent) || named[0])?.id || '';
    }
    categories[item.id] = match;
  }
  return { accounts, categories };
}

/** A stable ID for a row: the same transaction gets the same ID from any export file. */
export function rowId(row) {
  const text = [row.type, row.from, row.fromAmount, row.to, row.toAmount, row.path.join('\u001e'), row.currency, row.amount, row.time || row.date, row.tags, row.note].join('\u001f');
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return 'mt:' + hash.toString(16).padStart(16, '0');
}

/**
 * Turn rows into records for the current ledger.
 *   mapping      { accounts: { mtName: accountId }, categories: { categoryKey: categoryId | MT_LEAVE_OUT } }
 *   newAccounts  { mtName: { name, type, currency } } for accounts to create (these win over the mapping)
 *   moveStart    { accountId: true } for existing accounts whose opening date may move back to their earliest imported row
 * Returns { records (commitBatch operations: new accounts, then entries), entries (count), skipped (already imported,
 * also when since deleted), leftOut (rows of categories left out), problems: [{ line, reason }], accountIds (mtName → id),
 * earlier ({ accountId: earliest row date } for existing accounts with rows before their opening date) }.
 */
export function buildImport(state, rows, mapping, { newAccounts = {}, moveStart = {} } = {}) {
  const present = new Set([...state.entries.map(e => e.id), ...state.trash.filter(t => t.table === 'entries').map(t => t.record.id)]);
  const active = new Set(state.settings.activeCurrencies);
  const closed = new Set(state.settings.closedQuarters || []);
  const problems = [], entries = [], created = new Map(), seen = new Map();
  const earlier = {};
  let skipped = 0, leftOut = 0;

  const resolveAccount = name => {
    const fresh = newAccounts[name];
    if (fresh) {
      if (created.has(name)) return created.get(name);
      const label = String(fresh.name ?? '').trim();
      if (!label || label.length > 150) throw Error(`Give the new account for "${name}" a name.`);
      if (!MT_ACCOUNT_TYPES.includes(fresh.type)) throw Error(`Choose a type for the new account "${label}".`);
      if (!active.has(fresh.currency)) throw Error(`Choose an active currency for the new account "${label}".`);
      const account = { id: uid(), name: label, type: fresh.type, currency: fresh.currency, precision: digits(fresh.currency), opening: 0, openingDate: '', archived: false, isNew: true };
      created.set(name, account);
      return account;
    }
    const account = state.accounts.find(a => a.id === mapping?.accounts?.[name]);
    if (!account) throw Error(`Account "${name}" is not matched to an account in the app.`);
    return account;
  };
  const checkDate = (account, date) => {
    if (account.isNew || date >= account.openingDate) return;
    if (!earlier[account.id] || date < earlier[account.id]) earlier[account.id] = date;
    if (!moveStart?.[account.id]) throw Error(`Dated before the opening balance of ${account.name} (${account.openingDate}).`);
  };

  for (const row of rows) {
    // Identical rows inside one file are separate transactions: the second gets ':2', and so on.
    const base = rowId(row), nth = (seen.get(base) || 0) + 1;
    seen.set(base, nth);
    const id = nth > 1 ? `${base}:${nth}` : base;
    if (present.has(id)) { skipped++; continue; }
    try {
      if (closed.has(quarter(row.date))) throw Error('This budget quarter is closed. Reopen it on the Pots page first.');
      const record = { id, kind: row.type, status: 'posted', ledger: 'active', date: row.date };
      const text = { trip: '', tags: row.tags, note: row.note };

      if (row.type === 'transfer') {
        if (!row.fromAmount.startsWith('-') || row.toAmount.startsWith('-')) throw Error('A transfer needs a negative amount leaving and a positive amount arriving.');
        const from = resolveAccount(row.from), to = resolveAccount(row.to);
        if (from.id === to.id) throw Error('Both sides of this transfer are matched to the same account.');
        checkDate(from, row.date); checkDate(to, row.date);
        const minor = mtMinor(row.fromAmount, from.precision, from.currency), receivedMinor = mtMinor(row.toAmount, to.precision, to.currency);
        if (!minor || !receivedMinor) throw Error('The amount is zero.');
        if (from.currency === to.currency && minor !== receivedMinor) throw Error('The amount sent and the amount received differ between two accounts in the same currency.');
        entries.push({ ...record, minor, currency: from.currency, precision: from.precision, account: from.id, toAccount: to.id, receivedMinor, category: '', pot: '', ...text, uses: [from, to] });
        continue;
      }

      const expense = row.type === 'expense';
      const key = categoryKey(row), chosen = mapping?.categories?.[key];
      if (chosen === MT_LEAVE_OUT) { leftOut++; continue; }
      const accountAmount = expense ? row.fromAmount : row.toAmount;
      const negative = [row.amount, accountAmount].map(value => value.startsWith('-'));
      if (negative[0] !== expense || negative[1] !== expense) {
        if (row.amount === '0' || accountAmount === '0') throw Error('The amount is zero.');
        throw Error('Looks like a refund; record it on Today instead.');
      }
      const category = state.categories.find(c => c.id === chosen);
      if (!category) throw Error(`Category "${row.path.join(MT_SEPARATOR) || '(none)'}" is not matched to a category in the app.`);
      if (category.kind !== row.type) throw Error(`Category "${category.name}" is not ${expense ? 'an expense' : 'an income'} category.`);
      if (!active.has(row.currency)) throw Error(`Currency ${row.currency} is not active. Add it in Settings → Currencies first.`);
      const account = resolveAccount(expense ? row.from : row.to);
      checkDate(account, row.date);
      const precision = digits(row.currency);
      const minor = mtMinor(row.amount, precision, row.currency);
      const settled = mtMinor(accountAmount, account.precision, account.currency);
      if (!minor) throw Error('The amount is zero.');
      const entry = { ...record, minor, currency: row.currency, precision, account: account.id, category: category.id, pot: expense ? category.pot || '' : '', ...text, uses: [account] };
      if (account.currency === row.currency) {
        if (settled !== minor) throw Error(`The account amount (${accountAmount.replace('-', '')}) and the transaction amount (${row.amount.replace('-', '')}) differ although both are in ${row.currency}.`);
      } else {
        entry.settledMinor = settled; entry.settledCurrency = account.currency; entry.settledPrecision = account.precision;
      }
      entries.push(entry);
    } catch (error) {
      problems.push({ line: row.line, reason: error.message });
    }
  }

  // A new account opens, with nothing in it, on the day of its earliest imported entry.
  const accountIds = {};
  for (const name of Object.keys(mapping?.accounts || {})) if (!newAccounts[name] && mapping.accounts[name]) accountIds[name] = mapping.accounts[name];
  const records = [], moved = new Map();
  for (const entry of entries) {
    for (const account of entry.uses) {
      if (account.isNew) { if (!account.openingDate || entry.date < account.openingDate) account.openingDate = entry.date; }
      else if (entry.date < (moved.get(account.id)?.openingDate || account.openingDate)) moved.set(account.id, { ...account, openingDate: entry.date });
    }
    delete entry.uses;
  }
  // An existing account allowed to start earlier keeps its opening amount; only the date moves.
  for (const record of moved.values()) records.push({ table: 'accounts', record });
  for (const [name, account] of created) {
    if (!account.openingDate) continue; // none of its rows could be imported
    const { isNew, ...record } = account;
    records.push({ table: 'accounts', record });
    accountIds[name] = account.id;
  }
  for (const entry of entries) records.push({ table: 'entries', record: entry });
  return { records, entries: entries.length, skipped, leftOut, problems, accountIds, earlier };
}

/** Save everything `buildImport` produced as one change and remember the mapping for the next file. */
export function applyImport(state, built, mapping) {
  const next = built.records.length ? commitBatch(state, built.records) : structuredClone(state);
  const saved = next.settings.importMap?.moneythings || {};
  const accounts = { ...saved.accounts }, categories = { ...saved.categories };
  for (const [name, id] of Object.entries(built.accountIds || {})) if (id) accounts[name] = id;
  for (const [key, id] of Object.entries(mapping?.categories || {})) if (id) categories[key] = id;
  // A settings change is saved as a new revision (as saveTravelBudget does).
  next.settings.importMap = { ...next.settings.importMap, moneythings: { accounts, categories } };
  next.revision++;
  return validateState(next);
}
