// Settings → Quick add: the templates shown as chips above the Today form.

import { digits, parseAmount } from '../domain.js';
import { categoryPath } from '../model.js';
import { activeTemplates, saveTemplate, archiveTemplate, moveTemplate } from '../templates-logic.js';
import { el, formatMoney, errorMessage, showToast } from './dom.js';
import { ledger, saveLedger } from './ledger.js';

// View state kept between re-renders: the template being edited.
const quickAddView = { editingId: '' };

/** A template's fixed amount as money ("£50.00"), or '' when it is asked for each time. */
export function templateAmountLabel(template) {
  if (!template.amount) return '';
  try {
    return formatMoney(parseAmount(template.amount, template.currency), template.currency, digits(template.currency));
  } catch {
    return `${template.amount} ${template.currency}`;
  }
}

export function buildQuickAddSettings(rerender) {
  const state = ledger.state;
  const templates = activeTemplates(state);

  /** Save, redraw, and show a failure as a toast instead of losing it. */
  async function apply(next, done) {
    try {
      await saveLedger(next);
      rerender();
      if (done) showToast(done);
    } catch (error) {
      showToast(errorMessage(error));
    }
  }

  /** Two presses: the first asks, the second archives. */
  function archiveButton(template) {
    let armed = false;
    const button = el('button', { type: 'button', class: 'btn-text', text: 'Archive', 'aria-label': `Archive the template ${template.name}` });
    button.addEventListener('blur', () => { armed = false; button.textContent = 'Archive'; button.classList.remove('is-armed'); });
    button.addEventListener('click', () => {
      if (!armed) {
        armed = true;
        button.textContent = 'Press again to archive';
        button.classList.add('is-armed');
        return;
      }
      if (quickAddView.editingId === template.id) quickAddView.editingId = '';
      apply(archiveTemplate(ledger.state, template.id), 'Template archived.');
    });
    return button;
  }

  const list = templates.length
    ? el('ul', { class: 'plain-list ed-list' }, templates.map((template, index) => {
        const moveButton = (direction, symbol, word) => el('button', {
          type: 'button', class: 'icon-btn', text: symbol,
          'aria-label': `Move ${template.name} ${word}`, 'data-focus': `qa-${word}:${template.id}`,
          disabled: direction < 0 ? index === 0 : index === templates.length - 1,
          onclick: () => apply(moveTemplate(ledger.state, template.id, direction))
        });
        const editing = quickAddView.editingId === template.id;
        return el('li', { class: 'ed-item' },
          el('div', { class: 'ed-row' },
            el('span', { class: 'ed-name' },
              el('span', { class: 'ed-name-text' }, el('strong', { text: template.name })),
              el('span', { class: 'ed-meta', text: `${categoryPath(state, template.category).replaceAll(' / ', ' › ') || 'No category'} · ${templateAmountLabel(template) || 'asks each time'}` })),
            el('div', { class: 'ed-actions' },
              moveButton(-1, '↑', 'up'),
              moveButton(1, '↓', 'down'),
              el('button', {
                type: 'button', class: 'btn-text', text: 'Edit', 'aria-label': `Edit the template ${template.name}`,
                'aria-expanded': String(editing), 'data-focus': `qa-edit:${template.id}`,
                onclick: () => { quickAddView.editingId = editing ? '' : template.id; rerender(); }
              }),
              archiveButton(template))),
          editing && quickAddForm(state, template, rerender));
      }))
    : el('p', { class: 'empty', text: 'No templates. Add one below to record a regular purchase in two taps.' });

  return el('div', {},
    el('p', { class: 'note', text: 'Shortcuts shown above the amount on Today. Tapping one fills the form; nothing is saved until you press Save.' }),
    list,
    el('details', { class: 'fold' },
      el('summary', { text: 'Add a template' }),
      quickAddForm(state, null, rerender)));
}

/** The form for a new template (`template` null) or an existing one. */
function quickAddForm(state, template, rerender) {
  const key = template ? template.id.replace(/[^a-z0-9-]/gi, '-') : 'new';
  const name = el('input', { id: `qa-name-${key}`, type: 'text', maxLength: 150, value: template?.name || '' });
  const amount = el('input', {
    id: `qa-amount-${key}`, type: 'text', inputMode: 'decimal', autocomplete: 'off', value: template?.amount || ''
  });
  const code = template?.currency || state.settings.reportingCurrency;
  const currencySelect = el('select', { id: `qa-currency-${key}` },
    [...new Set([...state.settings.activeCurrencies, code])].map(value => el('option', { value, text: value })));
  currencySelect.value = code;
  const categories = state.categories.filter(c => c.kind === 'expense' && (!c.archived || c.id === template?.category))
    .map(c => ({ id: c.id, path: categoryPath(state, c.id).replaceAll(' / ', ' › ') }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const category = el('select', { id: `qa-category-${key}` },
    el('option', { value: '', text: 'Choose a category' }),
    categories.map(c => el('option', { value: c.id, text: c.path })));
  category.value = template?.category || '';
  const account = el('select', { id: `qa-account-${key}` },
    el('option', { value: '', text: 'Use the usual account' }),
    state.accounts.filter(a => !a.archived || a.id === template?.account)
      .map(a => el('option', { value: a.id, text: `${a.name} (${a.currency})` })));
  account.value = template?.account || '';
  const note = el('input', { id: `qa-note-${key}`, type: 'text', maxLength: 500, value: template?.note || '' });
  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });

  async function submit(event) {
    event.preventDefault();
    try {
      const next = saveTemplate(ledger.state, {
        id: template?.id, name: name.value, category: category.value, amount: amount.value,
        currency: currencySelect.value, account: account.value, note: note.value
      });
      quickAddView.editingId = '';
      await saveLedger(next);
      rerender();
      showToast(template ? 'Template saved.' : 'Template added.');
    } catch (error) {
      errorBox.textContent = errorMessage(error);
      errorBox.hidden = false;
    }
  }

  // Name, category, amount and currency sit in the same columns as the Estimates form.
  const field = (control, label, place, hint) => el('div', { class: `field${place ? ' est-' + place : ''}` },
    el('label', { for: control.id, text: label }), control, hint && el('p', { class: 'hint', text: hint }));
  return el('form', { class: template ? 'ed-edit' : 'fold-body', onsubmit: submit, novalidate: true },
    el('div', { class: 'est-form' },
      field(name, 'Name', 'name'),
      field(category, 'Category', 'category'),
      field(amount, 'Amount', 'amount'),
      field(currencySelect, 'Currency', 'currency')),
    el('p', { class: 'hint', text: 'Leave the amount blank to type it each time.' }),
    field(account, 'Paid from (optional)'),
    field(note, 'Note (optional)'),
    el('p', { class: 'hint', text: 'Change the amount here when a price goes up; past entries keep their price.' }),
    errorBox,
    el('div', { class: 'ed-edit-actions' },
      el('button', { type: 'submit', class: 'btn-primary btn-small', text: template ? 'Save' : 'Add template' }),
      template && el('button', { type: 'button', class: 'btn-text', text: 'Cancel', onclick: () => { quickAddView.editingId = ''; rerender(); } })));
}
