// Quick-add templates: saved shortcuts that fill the Today form.
// Pure functions over the ledger state; nothing here touches the page.
//
// A template record (the shape the previous version also reads):
//   { id, name, amount, currency, category, account, pot, note, order, modes, archived }
// `amount` is decimal text such as '50.00'. Empty text means "ask each time".
// `account` is an account ID, or '' for "whatever the form would use".
// `modes` says the same thing in the older form's words, and is derived on save.

import { digits, parseAmount } from './domain.js';
import { commit, commitBatch, uid } from './model.js';

const templateModes = (amount, account) => ({
  amount: amount ? 'fixed' : 'prompt', currency: 'fixed', category: 'fixed',
  account: account ? 'fixed' : 'inherit', pot: 'inherit'
});

// The starting pair. The IDs are fixed so two synced devices do not add them twice.
export const DEFAULT_TEMPLATES = [
  { id: 'tpl:tfl', name: 'TfL top-up', amount: '50.00', currency: 'GBP', category: 'transport:tfl', account: '', pot: '', note: '', order: 0, modes: templateModes('50.00', ''), archived: false },
  { id: 'tpl:groceries', name: 'Groceries', amount: '', currency: 'GBP', category: 'Groceries', account: '', pot: '', note: '', order: 1, modes: templateModes('', ''), archived: false }
];

/**
 * Add the starting templates once per ledger. A default whose category is
 * missing is skipped. `settings.templatesSeeded` records that this ran, so a
 * default the user archived or deleted never comes back.
 * Returns the same object when there is nothing to do.
 */
export function ensureDefaultTemplates(s) {
  if (s.settings.templatesSeeded === true) return s;
  const operations = DEFAULT_TEMPLATES
    .filter(t => !s.templates.some(r => r.id === t.id) && s.categories.some(c => c.id === t.category))
    .map(t => ({ table: 'templates', record: structuredClone(t) }));
  // commitBatch returns a fresh copy, so the flag can be set on it directly.
  // A settings change is saved as a new revision (as ui/currencies.js saveSettings does).
  const next = commitBatch(s, operations);
  next.settings.templatesSeeded = true;
  if (!operations.length) next.revision++;
  return next;
}

const templateOrder = t => (Number.isInteger(t.order) ? t.order : Number.MAX_SAFE_INTEGER);

/** Templates in use, in the user's order (then by name). */
export function activeTemplates(s) {
  return s.templates.filter(t => !t.archived)
    .sort((a, b) => templateOrder(a) - templateOrder(b) || a.name.localeCompare(b.name));
}

/** Minor units as plain decimal text: 5000 → '50.00'. */
function templateAmountText(minor, precision) {
  const text = String(minor).padStart(precision + 1, '0');
  return precision ? `${text.slice(0, -precision)}.${text.slice(-precision)}` : text;
}

/**
 * Add a template, or change one (`fields.id` set). Throws a readable error
 * when something is missing. Returns the next state.
 */
export function saveTemplate(s, fields) {
  const old = fields.id ? s.templates.find(t => t.id === fields.id) : null;
  if (fields.id && !old) throw Error('That template no longer exists.');
  const name = String(fields.name ?? '').trim();
  if (!name) throw Error('Give the template a name.');
  if (name.length > 150) throw Error('Use a name of at most 150 characters.');
  const category = s.categories.find(c => c.id === fields.category);
  if (!category || category.archived || category.kind !== 'expense') throw Error('Choose an expense category.');
  const currency = String(fields.currency ?? '');
  if (!s.settings.activeCurrencies.includes(currency)) throw Error('Choose one of your active currencies.');
  const typed = String(fields.amount ?? '').trim();
  let amount = '';
  if (typed) {
    let minor;
    try { minor = parseAmount(typed, currency); } catch {
      const places = digits(currency);
      throw Error(`Enter an amount above zero with at most ${places} decimal places, or leave it blank to type it each time.`);
    }
    amount = templateAmountText(minor, digits(currency));
  }
  const account = fields.account || '';
  if (account && !s.accounts.some(a => a.id === account)) throw Error('Choose an account, or "Use the usual account".');
  const note = String(fields.note ?? '').trim();
  if (note.length > 500) throw Error('Use a note of at most 500 characters.');
  const record = {
    ...(old || {}),
    id: old?.id || uid(), name, amount, currency, category: category.id, account, pot: old?.pot || '', note,
    order: Number.isInteger(old?.order) ? old.order : s.templates.reduce((max, t) => Math.max(max, Number.isInteger(t.order) ? t.order : -1), -1) + 1,
    modes: { ...templateModes(amount, account), pot: old?.modes?.pot || 'inherit' },
    archived: old?.archived || false
  };
  return commit(s, 'templates', record);
}

/** Hide a template from Quick add. The record is kept. */
export function archiveTemplate(s, id) {
  const template = s.templates.find(t => t.id === id);
  if (!template) throw Error('That template no longer exists.');
  return commit(s, 'templates', { ...template, archived: true });
}

/**
 * Move a template up (`delta` -1) or down (+1) among the active ones, then
 * number them 0..n. Returns the same object when it cannot move.
 */
export function moveTemplate(s, id, delta) {
  const list = activeTemplates(s);
  const from = list.findIndex(t => t.id === id), to = from + delta;
  if (from < 0 || to < 0 || to >= list.length || !delta) return s;
  list.splice(to, 0, list.splice(from, 1)[0]);
  const operations = list
    .map((t, index) => (t.order === index ? null : { table: 'templates', record: { ...t, order: index } }))
    .filter(Boolean);
  return operations.length ? commitBatch(s, operations) : s;
}

/**
 * What a template puts in the Today form. `amount` is '' when it is asked for
 * each time; `account` is null when the form's own choice should stay.
 */
export function templatePrefill(s, t) {
  const fixed = t.amount && t.modes?.amount !== 'prompt';
  return {
    category: s.categories.some(c => c.id === t.category) ? t.category : '',
    currency: t.currency,
    amount: fixed ? t.amount : '',
    account: t.account && s.accounts.some(a => a.id === t.account) ? t.account : null,
    note: t.note || ''
  };
}
