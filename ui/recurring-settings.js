// Settings → Recurring: rent, bills, subscriptions and regular income.

import { categoryPath } from '../model.js';
import {
  versionOn, saveSchedule, pauseSchedule, resumeSchedule, postDueSchedules, nextDue, frequencyWords
} from '../recurring-logic.js';
import { el, todayIso, formatDay, formatMoney, plainAmount, errorMessage, showToast, LEGACY_URL } from './dom.js';
import { ledger, saveLedger } from './ledger.js';
import { recurringPostedText } from './recurring.js';

// View state kept between re-renders: the rule being edited.
const recurringView = { editingId: '' };

/** "£950.00 monthly on the 1st" for the terms in force today. */
function recurringSummary(rule, today) {
  const entry = versionOn(rule, today);
  return `${formatMoney(entry.minor, entry.currency, entry.precision)} ${frequencyWords(rule)}`;
}

export function buildRecurringSettings(rerender) {
  const state = ledger.state;
  const today = todayIso();
  const byName = (a, b) => Number(Boolean(a.archived)) - Number(Boolean(b.archived)) || a.name.localeCompare(b.name);
  const rules = state.schedules.filter(r => !r.repayment).sort(byName);
  const repayments = state.schedules.filter(r => r.repayment && !r.archived).sort(byName);

  /** Pause or resume, then record anything that is now due. */
  async function toggle(rule) {
    try {
      const changed = rule.archived ? resumeSchedule(ledger.state, rule.id) : pauseSchedule(ledger.state, rule.id);
      const { state: next, posted } = postDueSchedules(changed, today);
      if (recurringView.editingId === rule.id) recurringView.editingId = '';
      await saveLedger(next);
      rerender();
      showToast(rule.archived
        ? ['Resumed.', recurringPostedText(next, posted, today)].filter(Boolean).join(' ')
        : 'Paused. Nothing more is recorded until you resume it.');
    } catch (error) {
      showToast(errorMessage(error));
    }
  }

  const row = rule => {
    const editing = recurringView.editingId === rule.id;
    const next = nextDue(state, rule, today);
    const meta = [
      recurringSummary(rule, today),
      rule.archived ? null : next ? `next ${formatDay(next)}` : 'no more dates',
      rule.autoPost ? 'posts automatically' : 'asks to confirm'
    ].filter(Boolean).join(' · ');
    return el('li', { class: 'ed-item' },
      el('div', { class: 'ed-row' },
        el('span', { class: 'ed-name' },
          el('span', { class: 'ed-name-text' }, el('strong', { text: rule.name }), rule.archived && ' ', rule.archived && el('span', { class: 'tag-fixed', text: 'Paused' })),
          el('span', { class: 'ed-meta', text: meta })),
        el('div', { class: 'ed-actions' },
          el('button', {
            type: 'button', class: 'btn-text', text: 'Edit', 'aria-label': `Edit ${rule.name}`,
            'aria-expanded': String(editing), 'data-focus': `rec-edit:${rule.id}`,
            onclick: () => { recurringView.editingId = editing ? '' : rule.id; rerender(); }
          }),
          el('button', {
            type: 'button', class: 'btn-text', text: rule.archived ? 'Resume' : 'Pause',
            'aria-label': `${rule.archived ? 'Resume' : 'Pause'} ${rule.name}`, 'data-focus': `rec-pause:${rule.id}`,
            onclick: () => toggle(rule)
          }))),
      editing && recurringForm(state, rule, rerender));
  };

  return el('div', {},
    el('p', { class: 'note', text: 'Payments and income that repeat. When one falls due it is recorded the next time you open the app, or waits on Today for you to confirm.' }),
    rules.length
      ? el('ul', { class: 'plain-list ed-list' }, rules.map(row))
      : el('p', { class: 'empty', text: 'No recurring payments. Add rent, a bill or a subscription below.' }),
    el('details', { class: 'fold' },
      el('summary', { text: 'Add a recurring payment' }),
      recurringForm(state, null, rerender)),
    repayments.length > 0 && el('div', {},
      el('p', { class: 'note', text: 'Card repayments' }),
      el('ul', { class: 'plain-list ed-list' }, repayments.map(rule => el('li', { class: 'ed-item' },
        el('div', { class: 'ed-row' },
          el('span', { class: 'ed-name' },
            el('span', { class: 'ed-name-text' }, el('strong', { text: rule.name })),
            el('span', { class: 'ed-meta', text: `${frequencyWords(rule)} · Managed in the previous version` })),
          el('div', { class: 'ed-actions' },
            el('a', { class: 'btn-text', href: LEGACY_URL, text: 'Open', 'aria-label': `Open the previous version to change ${rule.name}` })))))))
  );
}

/** The form for a new rule (`rule` null) or an existing one. */
function recurringForm(state, rule, rerender) {
  const today = todayIso();
  const old = rule?.entry;
  const key = rule ? rule.id.replace(/[^a-z0-9-]/gi, '-') : 'new';
  const option = (value, text) => el('option', { value, text });
  const select = (name, options, value) => {
    const control = el('select', { id: `rec-${name}-${key}` }, options.map(([v, text]) => option(v, text)));
    control.value = value;
    return control;
  };
  const input = (name, props) => el('input', { id: `rec-${name}-${key}`, ...props });

  const name = input('name', { type: 'text', maxLength: 150, value: rule?.name || '' });
  const kind = select('kind', [['expense', 'Expense'], ['income', 'Income']], old?.kind === 'income' ? 'income' : 'expense');
  const amount = input('amount', { type: 'text', inputMode: 'decimal', autocomplete: 'off', value: old ? plainAmount(old.minor, old.precision) : '' });
  const code = old?.currency || state.settings.reportingCurrency;
  const currency = select('currency', [...new Set([...state.settings.activeCurrencies, code])].map(c => [c, c]), code);

  const category = el('select', { id: `rec-category-${key}` });
  const fillCategories = chosen => {
    const list = state.categories.filter(c => c.kind === kind.value && (!c.archived || c.id === old?.category))
      .map(c => ({ id: c.id, path: categoryPath(state, c.id).replaceAll(' / ', ' › ') }))
      .sort((a, b) => a.path.localeCompare(b.path));
    category.replaceChildren(option('', 'Choose a category'), ...list.map(c => option(c.id, c.path)));
    category.value = list.some(c => c.id === chosen) ? chosen : '';
  };
  fillCategories(old?.category || '');

  const accountLabel = el('label', { for: `rec-account-${key}` });
  const account = select('account',
    [['', 'Not set'], ...state.accounts.filter(a => !a.archived || a.id === old?.account).map(a => [a.id, `${a.name} (${a.currency})`])],
    old?.account || '');

  const frequency = select('frequency', [['once', 'Once'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['yearly', 'Yearly']], rule?.frequency || 'monthly');
  const interval = input('interval', { type: 'number', inputMode: 'numeric', min: 1, max: 120, step: 1, value: String(rule?.interval || 1) });
  const anchor = select('anchor', [['day', 'Same day each time'], ['last_working_day', 'Last working day'], ['first_monday', 'First Monday']], rule?.anchor || 'day');
  const start = input('start', { type: 'date', value: rule?.start || today });
  const end = input('end', { type: 'date', value: rule?.end || '' });
  const autoPost = select('autopost', [['yes', 'Post automatically'], ['no', 'Ask me to confirm']], rule?.autoPost === false ? 'no' : 'yes');
  const effective = rule && input('effective', { type: 'date', value: today });
  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });

  const field = (control, label, hint) => el('div', { class: 'field' },
    typeof label === 'string' ? el('label', { for: control.id, text: label }) : label,
    control, hint && el('p', { class: 'hint', text: hint }));
  const intervalField = field(interval, 'Every');
  const anchorField = field(anchor, 'On');
  const unitHint = el('p', { class: 'hint' });
  intervalField.append(unitHint);

  /** Show only what applies to the chosen kind and rhythm. */
  function sync() {
    accountLabel.textContent = kind.value === 'income' ? 'Paid into (optional)' : 'Paid from (optional)';
    intervalField.hidden = frequency.value === 'once';
    anchorField.hidden = !['monthly', 'yearly'].includes(frequency.value);
    unitHint.textContent = { weekly: 'weeks', monthly: 'months', yearly: 'years' }[frequency.value] || '';
  }
  kind.addEventListener('change', () => { fillCategories(category.value); sync(); });
  frequency.addEventListener('change', sync);
  sync();

  async function submit(event) {
    event.preventDefault();
    try {
      const saved = saveSchedule(ledger.state, {
        id: rule?.id, name: name.value, kind: kind.value, amount: amount.value, currency: currency.value,
        category: category.value, account: account.value, frequency: frequency.value,
        interval: frequency.value === 'once' ? 1 : Number(interval.value), anchor: anchor.value,
        start: start.value, end: end.value, autoPost: autoPost.value === 'yes',
        effectiveDate: effective ? effective.value || today : start.value
      }, today);
      // Anything already due under the new terms is recorded straight away.
      const { state: next, posted } = postDueSchedules(saved, today);
      recurringView.editingId = '';
      await saveLedger(next);
      rerender();
      showToast([rule ? 'Recurring payment saved.' : 'Recurring payment added.', recurringPostedText(next, posted, today)].filter(Boolean).join(' '), null, 10000);
    } catch (error) {
      errorBox.textContent = errorMessage(error);
      errorBox.hidden = false;
    }
  }

  return el('form', { class: rule ? 'ed-edit' : 'fold-body', onsubmit: submit, novalidate: true },
    field(name, 'Name'),
    field(kind, 'Kind'),
    field(amount, 'Amount'),
    field(currency, 'Currency'),
    field(category, 'Category'),
    field(account, accountLabel),
    field(frequency, 'Repeats'),
    intervalField,
    anchorField,
    field(start, 'First date', rule ? null : 'Dates from here up to today are recorded when you add it.'),
    field(end, 'Last date (optional)'),
    field(autoPost, 'When due'),
    effective && field(effective, 'New amount applies from', 'Past payments keep their amount.'),
    errorBox,
    el('div', { class: 'ed-edit-actions' },
      el('button', { type: 'submit', class: 'btn-primary btn-small', text: rule ? 'Save' : 'Add recurring payment' }),
      rule && el('button', { type: 'button', class: 'btn-text', text: 'Cancel', onclick: () => { recurringView.editingId = ''; rerender(); } })));
}
