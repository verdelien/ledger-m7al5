// Settings for the forecast: the payday rule, extra holiday dates, and the
// weekly estimates (regular spending counted before it is recorded).

import { digits, parseAmount, validDate } from '../domain.js';
import { categoryPath, uid } from '../model.js';
import { paydaySetting, nextPayday } from '../payday.js';
import { estimatesOf } from '../forecast-view.js';
import { el, todayIso, formatDay, formatMoney, plainAmount, errorMessage, showToast } from './dom.js';
import { ledger } from './ledger.js';
import { saveSettings } from './currencies.js';

// View state kept between re-renders: the estimate being edited.
const estimateView = { editingId: '' };

/** Save, and show a failure as a toast instead of losing it. */
async function saveQuietly(change, done) {
  try {
    await saveSettings(change);
    if (done) showToast(done);
  } catch (error) {
    showToast(errorMessage(error));
  }
}

// ---------------------------------------------------------------------------
// Payday
// ---------------------------------------------------------------------------

export function buildPaydaySettings() {
  const state = ledger.state;
  const today = todayIso();
  const payday = paydaySetting(state.settings);
  const holidays = [...(state.settings.holidays || [])].sort();

  const day = el('input', { id: 'payday-day', type: 'text', inputMode: 'numeric', autocomplete: 'off', value: String(payday.day) });
  const dayForm = el('form', {
    class: 'inline-form',
    onsubmit: event => {
      event.preventDefault();
      const chosen = Number(day.value);
      if (!Number.isInteger(chosen) || chosen < 1 || chosen > 31) return showToast('Choose a day from 1 to 31.');
      saveQuietly(settings => { settings.payday = { ...paydaySetting(settings), day: chosen }; }, 'Payday saved.');
    }
  },
    el('div', { class: 'field' }, el('label', { for: 'payday-day', text: 'Day of the month' }), day),
    el('button', { type: 'submit', class: 'btn-secondary btn-small', text: 'Save' }));

  const holidayDate = el('input', { id: 'holiday-date', type: 'date' });
  const holidayForm = el('form', {
    class: 'inline-form',
    onsubmit: event => {
      event.preventDefault();
      const date = holidayDate.value;
      if (!validDate(date)) return showToast('Choose a date.');
      if (holidays.includes(date)) return showToast('That date is already listed.');
      saveQuietly(settings => { settings.holidays = [...(settings.holidays || []), date].sort(); });
    }
  },
    el('div', { class: 'field' }, el('label', { for: 'holiday-date', text: 'Extra holiday' }), holidayDate),
    el('button', { type: 'submit', class: 'btn-secondary btn-small', text: 'Add' }));

  return el('div', {},
    el('p', { class: 'note', text: `Next payday: ${formatDay(nextPayday(today, state.settings))}. When the day falls on a weekend or a bank holiday (England and Wales), payday is the last working day before it.` }),
    dayForm,
    holidays.length > 0 && el('ul', { class: 'plain-list' }, holidays.map(date => el('li', { class: 'list-row' },
      el('span', { class: 'entry-title', text: formatDay(date) + ' ' + date.slice(0, 4) }),
      el('button', {
        type: 'button', class: 'btn-text', text: 'Remove', 'aria-label': `Remove the holiday on ${date}`, 'data-focus': `holiday:${date}`,
        onclick: () => saveQuietly(settings => { settings.holidays = (settings.holidays || []).filter(d => d !== date); })
      })))),
    holidayForm,
    el('p', { class: 'hint', text: 'Bank holidays are worked out for each year. Add a date here only when your employer or bank is closed on another day.' }));
}

// ---------------------------------------------------------------------------
// Estimates
// ---------------------------------------------------------------------------

export function buildEstimates(rerender) {
  const state = ledger.state;
  const estimates = estimatesOf(state);

  const list = estimates.length
    ? el('ul', { class: 'plain-list est-list' }, estimates.map(estimate => el('li', {},
        el('div', { class: 'list-row est-row' },
          el('span', { class: 'entry-title est-name', text: estimate.name }),
          el('span', { class: 'entry-meta est-category', text: categoryPath(state, estimate.category) || 'No category' }),
          el('span', { class: 'entry-amount est-amount', text: formatMoney(estimate.amountMinor, estimate.currency, digits(estimate.currency)) }),
          el('span', { class: 'est-per', text: '/ week' }),
          el('button', {
            type: 'button', class: 'btn-text est-action', text: 'Edit', 'aria-label': `Edit the estimate ${estimate.name}`,
            'aria-expanded': String(estimateView.editingId === estimate.id), 'data-focus': `estimate:${estimate.id}`,
            onclick: () => { estimateView.editingId = estimateView.editingId === estimate.id ? '' : estimate.id; rerender(); }
          })),
        estimateView.editingId === estimate.id && estimateForm(state, estimate, rerender))))
    : el('p', { class: 'empty', text: 'No estimates. The forecast then counts only planned items.' });

  return el('div', {},
    el('p', { class: 'note', text: 'Regular spending you expect each week. The forecast sets it aside before you record it, and marks it as an estimate.' }),
    list,
    el('details', { class: 'fold' },
      el('summary', { text: 'Add an estimate' }),
      estimateForm(state, null, rerender)));
}

/** The form for a new estimate (`estimate` null) or an existing one. */
function estimateForm(state, estimate, rerender) {
  const key = estimate ? estimate.id : 'new';
  const code = estimate?.currency || state.settings.reportingCurrency;
  const name = el('input', { id: `est-name-${key}`, type: 'text', maxLength: 150, value: estimate?.name || '' });
  const amount = el('input', {
    id: `est-amount-${key}`, type: 'text', inputMode: 'decimal', autocomplete: 'off',
    value: estimate ? plainAmount(estimate.amountMinor, digits(estimate.currency)) : ''
  });
  const codes = [...new Set([...state.settings.activeCurrencies, code])];
  const currencySelect = el('select', { id: `est-currency-${key}` }, codes.map(value => el('option', { value, text: value })));
  currencySelect.value = code;
  const categories = state.categories.filter(c => c.kind === 'expense' && (!c.archived || c.id === estimate?.category))
    .map(c => ({ id: c.id, path: categoryPath(state, c.id) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const category = el('select', { id: `est-category-${key}` },
    el('option', { value: '', text: 'No category' }),
    categories.map(c => el('option', { value: c.id, text: c.path })));
  category.value = estimate?.category || '';
  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });

  async function submit(event) {
    event.preventDefault();
    try {
      if (!name.value.trim()) throw Error('Give the estimate a name.');
      const record = {
        id: estimate?.id || 'estimate:' + uid(), name: name.value.trim(), category: category.value,
        amountMinor: parseAmount(amount.value.trim(), currencySelect.value), currency: currencySelect.value, every: 'week'
      };
      if (!(record.amountMinor > 0)) throw Error('Enter an amount above zero.');
      estimateView.editingId = '';
      // The first change turns the starting pair into the user's own saved list.
      await saveSettings(settings => {
        const next = estimatesOf(ledger.state).filter(e => e.id !== record.id);
        const at = estimate ? estimatesOf(ledger.state).findIndex(e => e.id === record.id) : next.length;
        next.splice(at < 0 ? next.length : at, 0, record);
        settings.estimates = next;
      });
      showToast(estimate ? 'Estimate saved.' : 'Estimate added.');
    } catch (error) {
      errorBox.textContent = errorMessage(error);
      errorBox.hidden = false;
    }
  }

  // The fields sit in the same columns as an estimate row: name, category, amount, then the currency.
  const field = (control, label, place) => el('div', { class: `field est-${place}` }, el('label', { for: control.id, text: label }), control);
  return el('form', { class: estimate ? 'ed-edit' : 'fold-body', onsubmit: submit, novalidate: true },
    el('div', { class: 'est-form' },
      field(name, 'Name', 'name'),
      field(category, 'Category', 'category'),
      field(amount, 'Each week', 'amount'),
      field(currencySelect, 'Currency', 'currency')),
    el('p', { class: 'hint', text: 'The category is used to compare last month\'s estimate with what you recorded, and to find the pot it draws on.' }),
    errorBox,
    el('div', { class: 'ed-edit-actions' },
      el('button', { type: 'submit', class: 'btn-primary btn-small', text: estimate ? 'Save' : 'Add estimate' }),
      estimate && el('button', { type: 'button', class: 'btn-text', text: 'Cancel', onclick: () => { estimateView.editingId = ''; rerender(); } }),
      estimate && el('button', {
        type: 'button', class: 'btn-text', text: 'Remove',
        onclick: () => {
          estimateView.editingId = '';
          saveQuietly(settings => { settings.estimates = estimatesOf(ledger.state).filter(e => e.id !== estimate.id); }, 'Estimate removed.');
        }
      })));
}
