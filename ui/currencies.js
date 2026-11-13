// Settings → Currencies: the active list and its order, the reporting
// currency, and a rough default rate for each currency. Also the currency
// search that Today's "More currencies…" option shares.

import { digits, currencyName, searchCurrencies } from '../domain.js';
import { rateParts } from '../money.js';
import { el, errorMessage, showToast, todayIso } from './dom.js';
import { ledger, saveLedger } from './ledger.js';
import { dragHandle, moveItem } from './drag-sort.js';

// View state kept between re-renders.
const currencyView = { editingCode: '', adding: false };

/** Change the settings in one save. `change(settings)` edits a copy. */
export function saveSettings(change) {
  const next = structuredClone(ledger.state);
  change(next.settings);
  next.revision++;
  return saveLedger(next);
}

/** Switch a currency on, at the end of the user's list. */
export function addActiveCurrency(code) {
  digits(code); // throws a readable error for a code this device cannot format
  return saveSettings(settings => {
    if (!settings.activeCurrencies.includes(code)) settings.activeCurrencies.push(code);
  });
}

// Some catalogued codes (funds, metals) have no precision on this device.
const usableCodes = new Map();
function isUsableCurrency(code) {
  if (!usableCodes.has(code)) {
    try { digits(code); usableCodes.set(code, true); } catch { usableCodes.set(code, false); }
  }
  return usableCodes.get(code);
}

/**
 * A search box over the world's currencies. `exclude` hides codes that are
 * already active. `onPick(code)` gets the chosen code.
 */
export function buildCurrencySearch({ exclude = [], onPick, onCancel }) {
  const input = el('input', {
    type: 'text', inputMode: 'search', autocomplete: 'off', autocapitalize: 'off', spellcheck: false,
    class: 'cur-search-input', placeholder: 'Code or name, e.g. JPY or yen',
    'aria-label': 'Search currencies', 'data-focus': 'currency-search'
  });
  const results = el('ul', { class: 'cur-results', 'aria-label': 'Matching currencies' });
  const matches = () => searchCurrencies(input.value, exclude).filter(([code]) => isUsableCurrency(code));

  function render() {
    const rows = matches();
    results.replaceChildren(...rows.map(([code, name]) => el('li', {},
      el('button', { type: 'button', class: 'cur-result', onclick: () => onPick(code) },
        el('strong', { text: code }), el('span', { text: name })))));
    if (!rows.length) results.append(el('li', { class: 'empty', text: 'No currency matches that.' }));
  }
  input.addEventListener('input', render);
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault(); // never submit the form this sits in
      const first = matches()[0];
      if (first) onPick(first[0]);
    } else if (event.key === 'Escape') {
      onCancel();
    }
  });
  render();

  return el('div', { class: 'cur-search' },
    el('div', { class: 'cur-search-head' },
      input,
      el('button', { type: 'button', class: 'btn-text', text: 'Cancel', onclick: onCancel })),
    results);
}

/** Why a currency has to stay active, or '' when it can be removed. */
export function currencyInUse(state, code) {
  if (code === state.settings.reportingCurrency) return 'it is the reporting currency';
  if (state.accounts.some(a => a.currency === code)) return 'an account uses it';
  if (state.entries.some(e => e.currency === code || e.settledCurrency === code)) return 'entries use it';
  if (state.pots.some(p => p.currency === code)) return 'a pot uses it';
  if (state.trips.some(r => r.currency === code) || state.wishlist.some(r => r.currency === code)
    || state.schedules.some(r => r.entry?.currency === code) || state.settings.salary?.currency === code) {
    return 'a planned item uses it';
  }
  return '';
}

export function buildCurrencies(rerender) {
  const state = ledger.state;
  const { activeCurrencies: active, reportingCurrency: reporting } = state.settings;
  const rates = state.settings.defaultRates || {};
  const hasRates = Object.keys(rates).length > 0;
  const reorder = (from, to) => quietly(() => saveSettings(settings => {
    settings.activeCurrencies = moveItem(settings.activeCurrencies, from, to);
  }));

  const rows = active.map((code, index) => {
    if (currencyView.editingCode === code) {
      return el('li', { class: 'ed-item', 'data-drag-item': '' }, currencyForm(state, code, rerender));
    }
    const moveButton = (direction, symbol, word) => el('button', {
      type: 'button', class: 'icon-btn', text: symbol,
      'aria-label': `Move ${code} ${word}`, 'data-focus': `cur-${word}:${code}`,
      disabled: direction < 0 ? index === 0 : index === active.length - 1,
      onclick: () => reorder(index, index + direction)
    });
    const meta = code === reporting ? 'reporting'
      : rates[code] ? `1 ${code} ≈ ${rates[code]} ${reporting}` : '';

    return el('li', { class: 'ed-item', 'data-drag-item': '' },
      el('div', { class: 'ed-row' },
        active.length > 1 && dragHandle({ label: `Drag ${code} to reorder`, onDrop: reorder }),
        el('span', { class: 'ed-name' },
          el('span', { class: 'ed-name-text' }, el('strong', { text: code }), ` ${currencyName(code)}`),
          meta && el('span', { class: 'ed-meta', text: meta })),
        el('div', { class: 'ed-actions' },
          moveButton(-1, '↑', 'up'),
          moveButton(1, '↓', 'down'),
          el('button', {
            type: 'button', class: 'btn-text', text: 'Edit', 'aria-label': `Edit ${code}`, 'data-focus': `cur-edit:${code}`,
            onclick: () => { currencyView.editingCode = code; rerender(); document.getElementById('cur-rate')?.focus(); }
          }))));
  });

  const reportingSelect = el('select', {
    id: 'reporting-currency', 'data-focus': 'reporting-currency',
    onchange: () => quietly(async () => {
      const chosen = reportingSelect.value;
      await saveSettings(settings => {
        // Earlier entries keep their original amounts, as in the previous version.
        settings.reportingDisplay = { mode: 'retain', from: reporting, rate: '', date: todayIso() };
        settings.reportingCurrency = chosen;
        delete settings.defaultRates; // they were quoted in the old reporting currency
      });
      showToast(`Totals are now reported in ${chosen}.` + (hasRates ? ` Default rates were cleared: they were quoted in ${reporting}.` : ''));
    })
  }, active.map(code => el('option', { value: code, text: `${code} ${currencyName(code)}`.trim() })));
  reportingSelect.value = reporting;

  const adder = currencyView.adding
    ? buildCurrencySearch({
        exclude: active,
        onPick: code => quietly(async () => {
          currencyView.adding = false;
          await addActiveCurrency(code);
          showToast(`${code} added.`);
        }),
        onCancel: () => { currencyView.adding = false; rerender(); }
      })
    : el('button', {
        type: 'button', class: 'btn-secondary btn-small', text: 'Add a currency', 'data-focus': 'cur-add',
        onclick: () => { currencyView.adding = true; rerender(); document.querySelector('.cur-search-input')?.focus(); }
      });

  return el('div', { class: 'cur-editor' },
    el('p', { class: 'note', text: 'These are the currencies offered when you add an entry or an account, in this order. Drag the grip, or use the arrows, to reorder.' }),
    el('ul', { class: 'ed-list' }, rows),
    el('div', { class: 'cur-adder' }, adder),
    el('div', { class: 'field' },
      el('label', { for: 'reporting-currency', text: 'Reporting currency' }),
      reportingSelect,
      el('p', {
        class: 'hint',
        text: 'Totals and reports use this currency. To report in another one, add it to the list first.'
          + (hasRates ? ' Changing it clears the default rates, because they are quoted in it.' : '')
      })));
}

/** Inline form for one currency: its rough default rate, and removal. */
function currencyForm(state, code, rerender) {
  const reporting = state.settings.reportingCurrency;
  const isReporting = code === reporting;
  const reason = currencyInUse(state, code);
  const close = () => { currencyView.editingCode = ''; };

  const rate = el('input', {
    id: 'cur-rate', type: 'text', inputMode: 'decimal', autocomplete: 'off',
    value: state.settings.defaultRates?.[code] || '', placeholder: 'No default rate'
  });

  return el('form', {
    class: 'ed-edit',
    onsubmit: event => {
      event.preventDefault();
      quietly(() => {
        const text = rate.value.trim().replace(',', '.');
        if (text) rateParts(text); // a positive decimal, or a readable error
        close();
        if (isReporting || text === (state.settings.defaultRates?.[code] || '')) return rerender();
        return saveSettings(settings => {
          const next = { ...(settings.defaultRates || {}) };
          if (text) next[code] = text; else delete next[code];
          settings.defaultRates = next;
        });
      });
    }
  },
    el('p', { class: 'cur-form-title' }, el('strong', { text: code }), ` ${currencyName(code)}`),
    !isReporting && el('div', { class: 'field' },
      el('label', { for: 'cur-rate', text: `Rough default rate: 1 ${code} = how many ${reporting}?` }),
      rate,
      el('p', { class: 'hint', text: 'Optional. A starting estimate you can correct later; saved amounts are never changed by it.' })),
    el('p', {
      class: 'hint',
      text: reason ? `${code} stays in the list because ${reason}.` : `Removing ${code} only hides it from the lists. You can add it again at any time.`
    }),
    el('div', { class: 'ed-edit-actions' },
      !isReporting && el('button', { type: 'submit', class: 'btn-primary btn-small', text: 'Save' }),
      el('button', {
        type: 'button', class: 'btn-secondary btn-small', text: 'Remove', disabled: !!reason,
        onclick: () => quietly(async () => {
          close();
          await saveSettings(settings => {
            settings.activeCurrencies = settings.activeCurrencies.filter(c => c !== code);
            if (settings.defaultRates) delete settings.defaultRates[code];
          });
          showToast(`${code} removed from the list.`);
        })
      }),
      el('button', { type: 'button', class: 'btn-text', text: isReporting ? 'Close' : 'Cancel', onclick: () => { close(); rerender(); } })));
}

/** Run an action and show any problem calmly. */
async function quietly(action) {
  try {
    await action();
  } catch (error) {
    showToast(errorMessage(error));
  }
}
