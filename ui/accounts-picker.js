// The account picker: currency tabs over a grid of account tiles, built like
// the category picker. Each tile shows an icon, the name and the balance.

import { accountBalance } from '../model.js';
import { el, formatMoney } from './dom.js';
import { accountIconNode } from './pixel-icons.js';

/** Currencies of the given accounts: the user's active order first, then any others. */
export function accountCurrencies(state, accounts) {
  const used = new Set(accounts.map(account => account.currency));
  const ordered = state.settings.activeCurrencies.filter(code => used.has(code));
  return [...ordered, ...[...used].filter(code => !ordered.includes(code)).sort()];
}

/**
 * Build a picker.
 *   getState()         → current ledger state
 *   getAccounts(state) → the accounts to offer
 *   value              → selected account ID, or '' for no account
 *   currency           → the entry currency; its tab is shown first
 *   today              → balances are shown as of this day
 *   onChange(id)
 * Returns { element, getValue(), showCurrency(code) }.
 */
export function createAccountPicker({ getState, getAccounts, value = '', currency = '', today, onChange = () => {} }) {
  let selected = value;
  let tab = currency; // '' is the "All" tab
  const element = el('div', { class: 'acct-picker' });

  function render(focusSelector) {
    const state = getState();
    const accounts = getAccounts(state);
    const codes = accountCurrencies(state, accounts);
    if (!codes.includes(tab)) tab = '';

    // With a single currency there is nothing to switch between.
    const tabs = codes.length > 1 && el('div', { class: 'segmented acct-tabs', role: 'group', 'aria-label': 'Show accounts in' },
      [...codes.map(code => [code, code]), ['', 'All']].map(([code, label]) => el('button', {
        type: 'button', text: label,
        class: tab === code ? 'is-selected' : '',
        'aria-pressed': String(tab === code),
        'data-acct-tab': code,
        onclick: () => { tab = code; render(`[data-acct-tab="${code}"]`); }
      })));

    const tile = (id, label, icon, balance) => el('button', {
      type: 'button',
      class: 'cat-tile acct-tile' + (selected === id ? ' is-selected' : ''),
      'aria-pressed': String(selected === id),
      'data-acct': id,
      onclick: () => { selected = id; onChange(id); render(`[data-acct="${CSS.escape(id)}"]`); }
    }, icon, el('span', { class: 'cat-tile-label', text: label }),
      balance && el('span', { class: 'acct-balance', text: balance }));

    const shown = accounts.filter(account => !tab || account.currency === tab);
    const grid = el('div', { class: 'cat-grid acct-grid' },
      shown.map(account => tile(account.id, account.name, accountIconNode(account),
        formatMoney(accountBalance(state, account.id, today), account.currency, account.precision))),
      tile('', 'No account', null, ''));

    const chosen = accounts.find(account => account.id === selected);
    element.replaceChildren(...[tabs, grid, el('p', { class: 'cat-chosen' },
      chosen ? ['Paid from ', el('strong', { text: `${chosen.name} · ${chosen.currency}` })] : 'No account chosen.')].filter(Boolean));

    if (focusSelector) element.querySelector(focusSelector)?.focus();
  }

  render();
  return {
    element,
    getValue: () => selected,
    /** Turn to a currency's tab, when there is one. */
    showCurrency(code) {
      if (code === tab || !accountCurrencies(getState(), getAccounts(getState())).includes(code)) return;
      tab = code;
      render();
    }
  };
}
