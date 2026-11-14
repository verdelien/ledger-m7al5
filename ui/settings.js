// Settings, one section at a time: accounts, currencies,
// categories, pots, payday, estimates, quick add, recurring, sync, and the way back to the previous version.
// Each section has its own address (#settings/estimates), so Back and a
// reload return to it.

import { digits, parseAmount, validDate } from '../domain.js';
import { commit, uid, accountBalance } from '../model.js';
import { el, slip, sectionTitle, todayIso, formatMoney, errorMessage, showToast, LEGACY_URL } from './dom.js';
import { ledger, saveLedger } from './ledger.js';
import { themeChoices, getThemeChoice, setThemeChoice } from './theme.js';
import { buildCategoryEditor, iconField } from './category-editor.js';
import { buildCurrencies } from './currencies.js';
import { buildPaydaySettings, buildEstimates } from './forecast-settings.js';
import { buildQuickAddSettings } from './quick-add-settings.js';
import { buildRecurringSettings } from './recurring-settings.js';
import { buildPotsSettings, buildPaydayFlowSettings } from './pots-settings.js';
import { accountIconNode } from './pixel-icons.js';
import { buildSync } from './sync.js';

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
  {
    id: 'data', label: 'Data', title: 'Previous version', build: () => [
      el('p', { class: 'note', text: 'Card repayments and backups still live in the previous version while this one is rebuilt. Both use the same records.' }),
      el('a', { class: 'btn-secondary', href: LEGACY_URL, text: 'Open previous version' }),
      el('p', { class: 'note data-note', text: 'Your records stay in this browser on this device. They are sent only to your own Google Sheet, and only after you connect one under Sync.' })
    ]
  }
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
            el('span', { class: 'entry-meta', text: `${typeLabel[account.type] || account.type} · ${account.currency}` })),
          el('span', { class: 'entry-amount', text: formatMoney(accountBalance(state, account.id, today), account.currency, account.precision) }),
          el('button', {
            type: 'button', class: 'btn-text', text: 'Icon', 'aria-label': `Change the icon of ${account.name}`,
            'aria-expanded': String(accountView.iconFor === account.id), 'data-focus': `acct-icon:${account.id}`,
            onclick: () => { accountView.iconFor = accountView.iconFor === account.id ? '' : account.id; rerender(); }
          })),
        accountView.iconFor === account.id && accountIconForm(account, rerender))))
    : el('p', { class: 'empty', text: 'No accounts yet. Add your main current account to see its balance here.' });

  return el('div', {}, list, buildAccountForm(state, today));
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
