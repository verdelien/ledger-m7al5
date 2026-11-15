// Settings → Data: import a MoneyThings CSV export into the current ledger.
// One step page inside the section: a summary, the accounts and categories to
// match, the rows that cannot be imported, and the Import button.

import { el, errorMessage, showToast } from './dom.js';
import { ledger, saveLedger } from './ledger.js';
import { formatFullDate } from './reconcile.js';
import {
  MT_LEAVE_OUT, parseMoneyThings, distinctAccounts, distinctCategories, importCategoryChoices,
  suggestMapping, buildImport, applyImport
} from '../moneythings-logic.js';

const MT_MAX_BYTES = 5 * 1024 * 1024;
const MT_PROBLEMS_SHOWN = 20;
const MT_NEW_ACCOUNT = '+new';
const MT_ACCOUNT_TYPE_LABELS = [
  ['current', 'Current account'],
  ['savings', 'Savings account'],
  ['credit_card', 'Credit card'],
  ['cash_wallet', 'Cash wallet'],
  ['investment', 'Investment']
];

// Kept between re-renders: the file that was read, the choices made so far, and the hint after an import.
const mtView = { rows: null, parseProblems: [], fileName: '', error: '', mapping: null, drafts: {}, keepStart: {}, done: false };

function mtClear() {
  mtView.rows = null; mtView.parseProblems = []; mtView.fileName = ''; mtView.error = ''; mtView.mapping = null; mtView.drafts = {}; mtView.keepStart = {};
}

/** The accounts to create: those set to "Create new account…". */
function mtNewAccounts() {
  const chosen = {};
  for (const [name, value] of Object.entries(mtView.mapping.accounts)) if (value === MT_NEW_ACCOUNT) chosen[name] = mtView.drafts[name];
  return chosen;
}

/** Existing accounts may start earlier unless their box was unticked. */
function mtBuild(rows) {
  const moveStart = {};
  for (const account of ledger.state.accounts) if (!mtView.keepStart[account.id]) moveStart[account.id] = true;
  return buildImport(ledger.state, rows, mtView.mapping, { newAccounts: mtNewAccounts(), moveStart });
}

/** The section body: the file input, or the step page once a file has been read. */
export function buildMoneyThingsImport(rerender) {
  if (mtView.rows) return mtStepPage(rerender);

  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: !mtView.error, text: mtView.error });
  const input = el('input', {
    id: 'moneythings-file', type: 'file', accept: '.csv,text/csv',
    onchange: async () => {
      const file = input.files[0];
      if (!file) return;
      mtClear();
      mtView.done = false;
      try {
        if (file.size > MT_MAX_BYTES) throw Error('Choose a CSV file smaller than 5 MB.');
        const { rows, problems } = parseMoneyThings(await file.text());
        if (!rows.length && !problems.length) throw Error('This export has no rows.');
        const state = ledger.state;
        const mapping = suggestMapping(state, rows);
        const active = state.settings.activeCurrencies;
        for (const account of distinctAccounts(rows)) {
          mtView.drafts[account.name] = {
            name: account.name.slice(0, 150), type: 'current',
            currency: active.includes(account.currency) ? account.currency : state.settings.reportingCurrency
          };
        }
        mtView.rows = rows; mtView.parseProblems = problems; mtView.mapping = mapping; mtView.fileName = file.name;
      } catch (error) {
        mtClear();
        mtView.error = errorMessage(error);
      }
      rerender();
    }
  });
  return el('div', {},
    el('div', { class: 'field' },
      el('label', { for: 'moneythings-file', text: 'MoneyThings export (.csv, up to 5 MB)' }),
      input,
      el('p', { class: 'hint', text: 'Entries go into your current ledger and count in balances and pots. You match accounts and categories first; rows already imported are skipped.' })),
    errorBox,
    mtView.done && el('p', { class: 'note', text: "Balances now include these entries. If an account doesn't match your bank, use Reconcile in Settings → Accounts." }));
}

function mtStepPage(rerender) {
  const state = ledger.state;
  const { rows, mapping } = mtView;
  const accounts = distinctAccounts(rows), categories = distinctCategories(rows);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const footer = el('div', { class: 'mt-footer' });

  // Summary
  const counts = { expense: 0, income: 0, transfer: 0 };
  let first = '', last = '';
  for (const row of rows) {
    counts[row.type]++;
    if (!first || row.date < first) first = row.date;
    if (row.date > last) last = row.date;
  }
  const range = !first ? '' : first === last ? formatFullDate(first) : `${formatFullDate(first)} to ${formatFullDate(last)}`;
  const summary = [plural(rows.length, 'row', 'rows') + `: ${plural(counts.expense, 'expense', 'expenses')}, ${counts.income} income, ${plural(counts.transfer, 'transfer', 'transfers')}`, range].filter(Boolean).join(' · ');

  // Accounts
  const liveAccounts = state.accounts.filter(a => !a.archived);
  const startRows = [];
  const startHint = el('p', { class: 'hint', hidden: true, text: 'Its balance will then include these rows. Afterwards use Reconcile in Settings → Accounts to match your bank.' });
  const accountRows = accounts.map((account, index) => {
    const draft = mtView.drafts[account.name];
    const select = el('select', { 'aria-label': `App account for ${account.name}` },
      el('option', { value: '', text: 'Choose…' }),
      liveAccounts.map(a => el('option', { value: a.id, text: `${a.name} (${a.currency})` })),
      el('option', { value: MT_NEW_ACCOUNT, text: 'Create new account…' }));
    select.value = mapping.accounts[account.name] || '';
    const nameInput = el('input', {
      id: `mt-new-name-${index}`, type: 'text', maxLength: 150, value: draft.name, autocomplete: 'off',
      oninput: () => { draft.name = nameInput.value; refresh(); }
    });
    const typeSelect = el('select', { id: `mt-new-type-${index}`, onchange: () => { draft.type = typeSelect.value; refresh(); } },
      MT_ACCOUNT_TYPE_LABELS.map(([value, label]) => el('option', { value, text: label })));
    typeSelect.value = draft.type;
    const currencySelect = el('select', { id: `mt-new-currency-${index}`, onchange: () => { draft.currency = currencySelect.value; refresh(); } },
      state.settings.activeCurrencies.map(code => el('option', { value: code, text: code })));
    currencySelect.value = draft.currency;
    const field = (id, label, control) => el('div', { class: 'field' }, el('label', { for: id, text: label }), control);
    const fresh = el('div', { class: 'mt-new', hidden: select.value !== MT_NEW_ACCOUNT },
      field(nameInput.id, 'Name', nameInput),
      el('div', { class: 'field-pair' }, field(typeSelect.id, 'Type', typeSelect), field(currencySelect.id, 'Currency', currencySelect)),
      el('p', { class: 'hint', text: `Opens with a balance of 0 on ${formatFullDate(account.firstDate)}, the day of its first row.` }));
    // Shown by refresh() when the matched account starts after this file's rows for it.
    const startBox = el('input', {
      id: `mt-start-${index}`, type: 'checkbox',
      onchange: () => { mtView.keepStart[mapping.accounts[account.name]] = !startBox.checked; refresh(); }
    });
    const startLabel = el('label', { for: startBox.id });
    const start = el('div', { class: 'mt-start', hidden: true }, startBox, startLabel);
    startRows.push({ account, start, startBox, startLabel });
    select.addEventListener('change', () => {
      mapping.accounts[account.name] = select.value;
      fresh.hidden = select.value !== MT_NEW_ACCOUNT;
      refresh();
    });
    return el('li', { class: 'mt-map-row' },
      el('span', { class: 'entry-text' },
        el('span', { class: 'entry-title', text: account.name }),
        el('span', { class: 'entry-meta', text: plural(account.count, 'row', 'rows') })),
      el('div', { class: 'mt-map-choice' }, select),
      fresh,
      start);
  });

  // Categories, expenses first
  const categoryGroup = kind => {
    const items = categories.filter(c => c.kind === kind);
    if (!items.length) return null;
    const choices = importCategoryChoices(state, kind);
    return [
      el('p', { class: 'entry-meta mt-group', text: kind === 'expense' ? 'Expenses' : 'Income' }),
      el('ul', { class: 'plain-list' }, items.map(item => {
        const label = item.key || '(no category)';
        const select = el('select', { 'aria-label': `App category for ${label}` },
          el('option', { value: '', text: 'Choose…' }),
          choices.map(c => el('option', { value: c.id, text: c.label })),
          el('option', { value: MT_LEAVE_OUT, text: 'Leave these rows out' }));
        select.value = mapping.categories[item.id] || '';
        select.addEventListener('change', () => { mapping.categories[item.id] = select.value; refresh(); });
        return el('li', { class: 'mt-map-row' },
          el('span', { class: 'entry-text' },
            el('span', { class: 'entry-title', text: label }),
            el('span', { class: 'entry-meta', text: plural(item.count, 'row', 'rows') })),
          el('div', { class: 'mt-map-choice' }, select));
      }))
    ];
  };

  // The part that follows the choices: what is still open, the problem rows and the buttons.
  function refresh() {
    const openAccounts = accounts.filter(a => {
      const value = mapping.accounts[a.name];
      return !value || (value === MT_NEW_ACCOUNT && !mtView.drafts[a.name].name.trim());
    }).length;
    const openCategories = categories.filter(c => !mapping.categories[c.id]).length;
    const ready = !openAccounts && !openCategories;
    let built = { entries: 0, skipped: 0, leftOut: 0, problems: [] }, failure = mtView.error;
    try {
      built = mtBuild(rows);
    } catch (error) {
      failure = errorMessage(error);
    }
    let anyStart = false;
    for (const { account, start, startBox, startLabel } of startRows) {
      const matched = ledger.state.accounts.find(a => a.id === mapping.accounts[account.name]);
      const date = matched && built.earlier?.[matched.id];
      start.hidden = !date;
      if (!date) continue;
      anyStart = true;
      startBox.checked = !mtView.keepStart[matched.id];
      startLabel.textContent = `Start ${matched.name} on ${formatFullDate(date)} so earlier rows can be imported`;
    }
    startHint.hidden = !anyStart;
    // Until everything is matched, "not matched" would be repeated for every row; show only what the file itself got wrong.
    const problems = [...mtView.parseProblems, ...(ready ? built.problems : [])].sort((a, b) => a.line - b.line);
    const shown = problems.slice(0, MT_PROBLEMS_SHOWN);
    const status = [
      built.skipped ? `${plural(built.skipped, 'row is', 'rows are')} already imported and will be skipped.` : '',
      built.leftOut ? `${plural(built.leftOut, 'row', 'rows')} left out by your category choices.` : ''
    ].filter(Boolean).join(' ');
    const open = [openAccounts && plural(openAccounts, 'account', 'accounts'), openCategories && plural(openCategories, 'category', 'categories')].filter(Boolean).join(' and ');

    footer.replaceChildren(...[
      status && el('p', { class: 'note', text: status }),
      problems.length > 0 && el('div', { class: 'mt-problems' },
        el('p', { class: 'entry-title', text: `${plural(problems.length, "row can't be imported and is", "rows can't be imported and are")} left out` }),
        el('ul', { class: 'mt-problem-list' }, shown.map(p => el('li', { class: 'hint', text: `Line ${p.line}: ${p.reason}` }))),
        problems.length > shown.length && el('p', { class: 'hint', text: `and ${problems.length - shown.length} more` })),
      !ready && el('p', { class: 'hint', text: `${open} still ${openAccounts + openCategories === 1 ? 'needs' : 'need'} a choice.` }),
      ready && !built.entries && !failure && el('p', { class: 'hint', text: 'Nothing new to import from this file.' }),
      el('p', { class: 'form-error', role: 'alert', hidden: !failure, text: failure }),
      el('div', { class: 'ed-edit-actions' },
        el('button', {
          type: 'button', class: 'btn-primary btn-small', 'data-focus': 'mt-import', disabled: !ready || !built.entries,
          text: ready && built.entries ? `Import ${plural(built.entries, 'entry', 'entries')}` : 'Import',
          onclick: runImport
        }),
        el('button', { type: 'button', class: 'btn-text', text: 'Cancel', onclick: () => { mtClear(); rerender(); } }))
    ].filter(Boolean));
  }

  async function runImport() {
    const kept = { ...mtView };
    try {
      // Built again on the ledger as it is now; the store refuses the write if another tab saved first.
      const built = mtBuild(rows);
      if (!built.entries) throw Error('Nothing new to import from this file.');
      const next = applyImport(ledger.state, built, mapping);
      mtClear();
      mtView.done = true;
      await saveLedger(next);
      showToast(`Imported ${plural(built.entries, 'entry', 'entries')} from MoneyThings.`);
    } catch (error) {
      Object.assign(mtView, kept, { done: false, error: errorMessage(error) });
      rerender();
    }
  }

  refresh();
  return el('div', { class: 'fold-body restore-confirm mt-import', role: 'group', 'aria-label': 'Import from MoneyThings' },
    el('p', { class: 'entry-title', text: mtView.fileName || 'MoneyThings export' }),
    el('p', { class: 'note', text: summary }),
    accounts.length > 0 && el('p', { class: 'entry-title mt-heading', text: 'Accounts' }),
    accounts.length > 0 && el('ul', { class: 'plain-list' }, accountRows),
    startHint,
    categories.length > 0 && el('p', { class: 'entry-title mt-heading', text: 'Categories' }),
    categoryGroup('expense'),
    categoryGroup('income'),
    footer);
}
