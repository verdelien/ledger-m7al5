// Settings, one section at a time: accounts, currencies,
// categories, pots, payday, estimates, quick add, recurring, sync, and data (backup, export, restore, deleted records).
// Each section has its own address (#settings/estimates), so Back and a
// reload return to it.

import { digits, parseAmount, validDate } from '../domain.js';
import { commit, uid, accountBalance, restore } from '../model.js';
import { el, slip, sectionTitle, todayIso, formatMoney, errorMessage, showToast, LEGACY_URL } from './dom.js';
import { ledger, saveLedger } from './ledger.js';
import { themeChoices, getThemeChoice, setThemeChoice } from './theme.js';
import { buildCategoryEditor, iconField } from './category-editor.js';
import { buildCurrencies } from './currencies.js';
import { buildSpendingTargets } from './caps.js';
import { buildPaydaySettings, buildEstimates } from './forecast-settings.js';
import { buildQuickAddSettings } from './quick-add-settings.js';
import { buildRecurringSettings } from './recurring-settings.js';
import { buildPotsSettings, buildPaydayFlowSettings } from './pots-settings.js';
import { accountIconNode } from './pixel-icons.js';
import { buildSync } from './sync.js';
import { openReconcileSheet, formatFullDate } from './reconcile.js';
import { backupFile, readBackup, restoreBackup, backupSummary, entriesCsv, trashList } from '../backup-logic.js';
import { buildMoneyThingsImport } from './moneythings-import.js';
import { SYNC_CONNECTION_KEY } from '../sync-client.js';
import { historicalImport } from '../features.js';

const ACCOUNT_TYPES = [
  ['current', 'Current account'],
  ['savings', 'Savings account'],
  ['credit_card', 'Credit card'],
  ['cash_wallet', 'Cash wallet'],
  ['investment', 'Investment']
];

// View state kept between re-renders: the account whose icon is being changed.
const accountView = { iconFor: '' };

// The sections, in tab order. The first one opens for a bare '#settings'.
const SECTIONS = [
  { id: 'accounts', label: 'Accounts', build: rerender => [buildAccounts(rerender)] },
  { id: 'currencies', label: 'Currencies', build: rerender => [buildCurrencies(rerender)] },
  { id: 'categories', label: 'Categories', build: rerender => [buildCategoryEditor(rerender)] },
  { id: 'pots', label: 'Pots', build: rerender => [buildPotsSettings(rerender)] },
  { id: 'payday', label: 'Payday', build: () => [buildPaydaySettings(), sectionTitle('Payday flow'), buildPaydayFlowSettings()] },
  { id: 'estimates', label: 'Estimates', build: rerender => [buildEstimates(rerender)] },
  { id: 'quick-add', label: 'Quick add', build: rerender => [buildQuickAddSettings(rerender)] },
  { id: 'recurring', label: 'Recurring', title: 'Recurring payments', build: rerender => [buildRecurringSettings(rerender)] },
  { id: 'sync', label: 'Sync', title: 'Google Sheets sync', build: rerender => [buildSync(rerender)] },
  { id: 'data', label: 'Data', build: rerender => [buildDataSection(rerender)] }
];

/** Draw Settings with the section named in the address (`sectionId`) open. */
export function renderSettings(root, sectionId = '') {
  const section = SECTIONS.find(s => s.id === sectionId) || SECTIONS[0];
  const rerender = () => { root.replaceChildren(); renderSettings(root, section.id); };

  const tabs = el('nav', { class: 'set-tabs', 'aria-label': 'Settings sections' },
    SECTIONS.map(s => el('a', {
      class: 'set-tab', href: `#settings/${s.id}`, text: s.label,
      'aria-current': s.id === section.id ? 'page' : null, 'data-focus': `set-tab:${s.id}`
    })));

  root.append(slip({ label: 'Settings', kind: 'This device', wide: true },
    el('div', { class: 'set-layout' },
      tabs,
      el('div', { class: 'set-panel' }, sectionTitle(section.title || section.label), ...section.build(rerender)))));

  // Phone: bring the open tab into view inside the strip without moving the page.
  const current = tabs.querySelector('[aria-current="page"]');
  if (current && tabs.scrollWidth > tabs.clientWidth) tabs.scrollLeft = current.offsetLeft - (tabs.clientWidth - current.offsetWidth) / 2;
}

function buildAccounts(rerender) {
  const state = ledger.state;
  const today = todayIso();
  const accounts = state.accounts.filter(a => !a.archived);
  const typeLabel = Object.fromEntries(ACCOUNT_TYPES);

  const list = accounts.length
    ? el('ul', { class: 'plain-list' }, accounts.map(account => el('li', {},
        el('div', { class: 'list-row' },
          el('span', { class: 'entry-text' },
            el('span', { class: 'entry-title' }, accountIconNode(account), el('span', { text: account.name })),
            el('span', { class: 'entry-meta', text: [typeLabel[account.type] || account.type, account.currency, account.lastReconciled && `Last reconciled ${formatFullDate(account.lastReconciled)}`].filter(Boolean).join(' · ') })),
          el('span', { class: 'entry-amount', text: formatMoney(accountBalance(state, account.id, today), account.currency, account.precision) }),
          el('button', {
            type: 'button', class: 'btn-text', text: 'Reconcile', 'aria-label': `Reconcile ${account.name}`,
            'data-focus': `acct-reconcile:${account.id}`,
            onclick: event => openReconcileSheet(event.currentTarget, account.id)
          }),
          el('button', {
            type: 'button', class: 'btn-text', text: 'Icon', 'aria-label': `Change the icon of ${account.name}`,
            'aria-expanded': String(accountView.iconFor === account.id), 'data-focus': `acct-icon:${account.id}`,
            onclick: () => { accountView.iconFor = accountView.iconFor === account.id ? '' : account.id; rerender(); }
          })),
        accountView.iconFor === account.id && accountIconForm(account, rerender))))
    : el('p', { class: 'empty', text: 'No accounts yet. Add your main current account to see its balance here.' });

  return el('div', {}, list, buildAccountForm(state, today), buildSpendingTargets(rerender));
}

/** Inline form: an account's own icon, or back to the drawing for its type. */
function accountIconForm(account, rerender) {
  const icon = iconField(account, 'By type');
  return el('form', {
    class: 'ed-edit',
    onsubmit: async event => {
      event.preventDefault();
      try {
        const chosen = icon.getValue();
        accountView.iconFor = '';
        if (chosen === undefined) return rerender();
        await saveLedger(commit(ledger.state, 'accounts', { ...account, icon: chosen }));
      } catch (error) {
        showToast(errorMessage(error));
      }
    }
  },
    icon.element,
    el('div', { class: 'ed-edit-actions' },
      el('button', { type: 'submit', class: 'btn-primary btn-small', text: 'Save' }),
      el('button', { type: 'button', class: 'btn-text', text: 'Cancel', onclick: () => { accountView.iconFor = ''; rerender(); } })));
}

function buildAccountForm(state, today) {
  const name = el('input', { id: 'account-name', type: 'text', maxLength: 150 });
  const type = el('select', { id: 'account-type' }, ACCOUNT_TYPES.map(([value, label]) => el('option', { value, text: label })));
  const currencySelect = el('select', { id: 'account-currency' },
    state.settings.activeCurrencies.map(code => el('option', { value: code, text: code })));
  currencySelect.value = state.settings.activeCurrencies.includes('GBP') ? 'GBP' : state.settings.reportingCurrency;
  const opening = el('input', { id: 'account-opening', type: 'text', inputMode: 'decimal', value: '0', autocomplete: 'off' });
  const openingDate = el('input', { id: 'account-date', type: 'date', value: today });
  const icon = iconField({}, 'By type');
  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });

  async function submit(event) {
    event.preventDefault();
    try {
      if (!name.value.trim()) throw Error('Give the account a name.');
      if (!validDate(openingDate.value)) throw Error('Choose the date of the opening balance.');
      const code = currencySelect.value;
      const text = opening.value.trim() || '0';
      const negative = text.startsWith('-') || text.startsWith('−');
      const digitsOnly = text.replace(/^[-−+]/, '');
      const openingMinor = /^0*(?:[.,]0*)?$/.test(digitsOnly) ? 0 : parseAmount(digitsOnly, code) * (negative ? -1 : 1);

      const record = {
        id: uid(), name: name.value.trim(), type: type.value, currency: code, precision: digits(code),
        opening: openingMinor, openingDate: openingDate.value, archived: false
      };
      const chosenIcon = icon.getValue();
      if (chosenIcon) record.icon = chosenIcon;
      await saveLedger(commit(ledger.state, 'accounts', record));
      showToast('Account added.');
    } catch (error) {
      errorBox.textContent = errorMessage(error);
      errorBox.hidden = false;
    }
  }

  const field = (id, label, control) => el('div', { class: 'field' }, el('label', { for: id, text: label }), control);
  return el('details', { class: 'fold' },
    el('summary', { text: 'Add an account' }),
    el('form', { class: 'fold-body', onsubmit: submit, novalidate: true },
      field('account-name', 'Name', name),
      el('div', { class: 'field-pair' }, field('account-type', 'Type', type), field('account-currency', 'Currency', currencySelect)),
      el('div', { class: 'field-pair' }, field('account-opening', 'Opening balance', opening), field('account-date', 'Balance as of', openingDate)),
      icon.element,
      el('p', { class: 'hint', text: 'Entries dated before this day are not accepted for the account. Without an icon of its own, an account shows the drawing for its type.' }),
      errorBox,
      el('button', { type: 'submit', class: 'btn-primary', text: 'Add account' })));
}

// ---------------------------------------------------------------------------
// Data: backup, CSV export, restore from a backup, deleted records.

const BACKUP_MAX_BYTES = 10 * 1024 * 1024;
const TRASH_SHOWN = 50;

// Kept between re-renders: a backup that was read and validated and now waits for a yes or no.
const dataView = { incoming: null, fileName: '', error: '' };

const PAST_CSV_MAX_BYTES = 5 * 1024 * 1024;
// Kept between re-renders: a CSV of past expenses that was read and checked and now waits for a yes or no.
const pastView = { text: '', added: 0, fileName: '', error: '' };

/** Hand a file to the browser's own download. Nothing leaves the device. */
function downloadText(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = el('a', { href: url, download: name, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** True when this device holds a Google Sheets connection. Only its presence is checked; it is never read further. */
function hasSyncConnection() {
  try { return localStorage.getItem(SYNC_CONNECTION_KEY) != null; } catch { return false; }
}

function buildDataSection(rerender) {
  const today = todayIso();
  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: !dataView.error, text: dataView.error });
  const fail = error => { dataView.error = errorMessage(error); errorBox.textContent = dataView.error; errorBox.hidden = false; };

  const fileInput = el('input', {
    id: 'restore-file', type: 'file', accept: '.json,application/json',
    onchange: async () => {
      const file = fileInput.files[0];
      if (!file) return;
      dataView.incoming = null;
      dataView.error = '';
      try {
        if (file.size > BACKUP_MAX_BYTES) throw Error('Choose a backup smaller than 10 MB.');
        dataView.incoming = readBackup(await file.text(), today);
        dataView.fileName = file.name;
      } catch (error) {
        dataView.error = errorMessage(error);
      }
      rerender();
    }
  });

  const pastErrorBox = el('p', { class: 'form-error', role: 'alert', hidden: !pastView.error, text: pastView.error });
  const pastInput = el('input', {
    id: 'past-csv-file', type: 'file', accept: '.csv,text/csv',
    onchange: async () => {
      const file = pastInput.files[0];
      if (!file) return;
      pastView.text = '';
      pastView.added = 0;
      pastView.error = '';
      try {
        if (file.size > PAST_CSV_MAX_BYTES) throw Error('Choose a CSV file smaller than 5 MB.');
        const text = await file.text();
        const result = historicalImport(ledger.state, text);
        if (!result.added) throw Error('Nothing new to import: every row in this file is already in your past entries.');
        pastView.text = text;
        pastView.added = result.added;
        pastView.fileName = file.name;
      } catch (error) {
        pastView.error = errorMessage(error);
      }
      rerender();
    }
  });

  const downloads = el('div', { class: 'entry-actions data-actions' },
    el('button', {
      type: 'button', class: 'btn-secondary', text: 'Download backup',
      onclick: () => {
        try {
          const file = backupFile(ledger.state, today);
          downloadText(file.text, file.name, 'application/json');
        } catch (error) { showToast(errorMessage(error)); }
      }
    }),
    el('button', {
      type: 'button', class: 'btn-secondary', text: 'Download CSV of entries',
      onclick: () => {
        try {
          downloadText(entriesCsv(ledger.state), `expense-book-${today}.csv`, 'text/csv;charset=utf-8');
        } catch (error) { showToast(errorMessage(error)); }
      }
    }));

  return el('div', {},
    el('p', { class: 'note', text: 'A backup is one file holding everything in this app on this device. The CSV lists entries only, for a spreadsheet; it cannot be restored.' }),
    downloads,
    sectionTitle('Restore from backup'),
    dataView.incoming
      ? buildRestoreConfirm(rerender, fail)
      : el('div', { class: 'field' },
          el('label', { for: 'restore-file', text: 'Backup file (.json, up to 10 MB)' }),
          fileInput,
          el('p', { class: 'hint', text: 'The file is checked in full first. You are asked before anything is replaced.' })),
    errorBox,
    sectionTitle('Import past entries (CSV)'),
    pastView.text
      ? buildPastImportConfirm(rerender, pastErrorBox)
      : el('div', { class: 'field' },
          el('label', { for: 'past-csv-file', text: 'CSV file (.csv, up to 5 MB)' }),
          pastInput,
          el('p', { class: 'hint', text: 'Columns needed: date, amount, currency, category (optional: id, note, tags). Dates as YYYY-MM-DD, for example 2024-03-31.' })),
    pastErrorBox,
    sectionTitle('Import from MoneyThings'),
    buildMoneyThingsImport(rerender),
    sectionTitle('Deleted records'),
    buildTrash(),
    el('p', { class: 'note data-note' },
      el('span', { text: 'Your records stay in this browser on this device. They are sent only to your own Google Sheet, and only after you connect one under Sync. The ' }),
      el('a', { href: LEGACY_URL, text: 'previous version' }),
      el('span', { text: ' is still available and uses the same records.' })));
}

/** The yes-or-no step before a backup replaces the ledger on this device. */
function buildRestoreConfirm(rerender, fail) {
  const incoming = dataView.incoming;
  const summary = backupSummary(incoming);
  const count = (number, word) => `${number} ${number === 1 ? word : (word === 'entry' ? 'entries' : word + 's')}`;
  const range = summary.firstDate
    ? (summary.firstDate === summary.lastDate ? formatFullDate(summary.firstDate) : `${formatFullDate(summary.firstDate)} to ${formatFullDate(summary.lastDate)}`)
    : 'no entries';
  const cancel = () => { dataView.incoming = null; dataView.fileName = ''; dataView.error = ''; rerender(); };
  return el('div', { class: 'fold-body restore-confirm', role: 'group', 'aria-label': 'Replace with backup' },
    el('p', { class: 'entry-title', text: dataView.fileName || 'Backup' }),
    el('p', { class: 'note', text: `${count(summary.entries, 'entry')} · ${count(summary.accounts, 'account')} · ${count(summary.pots, 'pot')} · ${range}` }),
    el('p', { class: 'note', text: 'This replaces everything on this device. Download a backup of the current data first.' }),
    hasSyncConnection() && el('p', { class: 'note', text: 'This device is connected to Google Sheets: the sheet will be updated to match the backup on the next sync.' }),
    el('div', { class: 'ed-edit-actions' },
      el('button', {
        type: 'button', class: 'btn-primary btn-small', text: 'Replace with backup', 'data-focus': 'restore-replace',
        onclick: async () => {
          try {
            // Validated again here; the store refuses the write if another tab saved first.
            const next = restoreBackup(ledger.state, incoming);
            dataView.incoming = null;
            dataView.error = '';
            await saveLedger(next);
            dataView.fileName = '';
            showToast('Backup restored. This device now holds the records from the backup.');
          } catch (error) {
            dataView.incoming = incoming;
            fail(error);
            rerender();
          }
        }
      }),
      el('button', { type: 'button', class: 'btn-text', text: 'Cancel', onclick: cancel })));
}

/** The yes-or-no step before past expenses from a CSV are added to the read-only historical ledger. */
function buildPastImportConfirm(rerender, errorBox) {
  const { text, added } = pastView;
  const clear = () => { pastView.text = ''; pastView.added = 0; pastView.fileName = ''; pastView.error = ''; };
  return el('div', { class: 'fold-body restore-confirm', role: 'group', 'aria-label': 'Import past expenses' },
    el('p', { class: 'entry-title', text: pastView.fileName || 'CSV file' }),
    el('p', { class: 'note', text: `Import ${added} past ${added === 1 ? 'expense' : 'expenses'}? They are kept apart from current balances and pots.` }),
    el('div', { class: 'ed-edit-actions' },
      el('button', {
        type: 'button', class: 'btn-primary btn-small', text: 'Import', 'data-focus': 'past-import',
        onclick: async () => {
          try {
            // Run again on the ledger as it is now; the store refuses the write if another tab saved first.
            const result = historicalImport(ledger.state, text);
            clear();
            await saveLedger(result.state);
            showToast(`${result.added} past ${result.added === 1 ? 'expense' : 'expenses'} imported.`);
          } catch (error) {
            pastView.text = text;
            pastView.added = added;
            pastView.error = errorMessage(error);
            errorBox.textContent = pastView.error;
            errorBox.hidden = false;
            rerender();
          }
        }
      }),
      el('button', { type: 'button', class: 'btn-text', text: 'Cancel', onclick: () => { clear(); rerender(); } })));
}

/** 'Deleted 3 Mar 2026', in this device's own date. */
function deletedWords(deletedAt) {
  const when = new Date(deletedAt);
  return deletedAt && !isNaN(when) ? `Deleted ${when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : 'Deleted';
}

function buildTrash() {
  const all = trashList(ledger.state);
  if (!all.length) return el('p', { class: 'empty', text: 'Nothing has been deleted.' });
  const shown = all.slice(0, TRASH_SHOWN);
  return el('div', {},
    el('ul', { class: 'plain-list' }, shown.map(item => el('li', {},
      el('div', { class: 'list-row' },
        el('span', { class: 'entry-text' },
          el('span', { class: 'entry-title', text: item.label }),
          el('span', { class: 'entry-meta', text: deletedWords(item.deletedAt) })),
        el('button', {
          type: 'button', class: 'btn-text', text: 'Restore', 'aria-label': `Restore ${item.label}`,
          onclick: async () => {
            try {
              await saveLedger(restore(ledger.state, item.id));
              showToast('Restored.');
            } catch (error) {
              showToast(errorMessage(error));
            }
          }
        }))))),
    all.length > shown.length && el('p', { class: 'hint', text: `Showing the ${TRASH_SHOWN} most recently deleted of ${all.length}.` }));
}
