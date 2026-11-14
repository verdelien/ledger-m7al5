// Settings → Recurring: rent, bills, subscriptions and regular income.

import { categoryPath } from '../model.js';
import {
  versionOn, saveSchedule, pauseSchedule, resumeSchedule, postDueSchedules, nextDue, frequencyWords
} from '../recurring-logic.js';
import {
  repaymentEstimate, repaymentBasis, basisWords, saveCardRepayment, setCardRepaymentPaused
} from '../card-repayment-logic.js';
import { el, todayIso, formatDay, formatMoney, plainAmount, errorMessage, showToast } from './dom.js';
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
  const repayments = state.schedules.filter(r => r.repayment).sort(byName);
  const hasCard = state.accounts.some(a => a.type === 'credit_card' && !a.archived);

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

  /** Pause or resume a card repayment. */
  async function toggleRepayment(rule) {
    try {
      const next = setCardRepaymentPaused(ledger.state, rule.id, !rule.archived);
      if (recurringView.editingId === rule.id) recurringView.editingId = '';
      await saveLedger(next);
      rerender();
      showToast(rule.archived ? 'Resumed.' : 'Paused. No repayment is asked for until you resume it.');
    } catch (error) {
      showToast(errorMessage(error));
    }
  }

  const repaymentRow = rule => {
    const editing = recurringView.editingId === rule.id;
    const from = state.accounts.find(a => a.id === rule.entry.account);
    const next = nextDue(state, rule, today);
    let estimate = null;
    if (next && from) {
      const minor = repaymentEstimate(state, rule, next, today).minor;
      estimate = minor > 0n ? `about ${formatMoney(minor, from.currency, from.precision)}` : 'nothing to pay yet';
    }
    const meta = [
      `from ${from?.name || 'an account that no longer exists'}, due ${frequencyWords(rule)}, ${basisWords(repaymentBasis(rule))}`,
      rule.archived ? null : next ? `next ${formatDay(next)}, ${estimate || 'amount not known'}` : 'no more dates'
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
            onclick: () => toggleRepayment(rule)
          }))),
      editing && cardRepaymentForm(state, rule, rerender));
  };

  return el('div', {},
    el('p', { class: 'note', text: 'Payments and income that repeat. When one falls due it is recorded the next time you open the app, or waits on Today for you to confirm.' }),
    rules.length
      ? el('ul', { class: 'plain-list ed-list' }, rules.map(row))
      : el('p', { class: 'empty', text: 'No recurring payments. Add rent, a bill or a subscription below.' }),
    el('details', { class: 'fold' },
      el('summary', { text: 'Add a recurring payment' }),
      recurringForm(state, null, rerender)),
    el('p', { class: 'note', text: 'Card repayments. The amount is worked out each month and always waits on Today for you to confirm.' }),
    repayments.length > 0 && el('ul', { class: 'plain-list ed-list' }, repayments.map(repaymentRow)),
    hasCard
      ? el('details', { class: 'fold' },
        el('summary', { text: 'Add card repayment' }),
        cardRepaymentForm(state, null, rerender))
      : el('p', { class: 'hint', text: 'Add a credit card account in Settings → Accounts first.' })
  );
}

/** The form for a new card repayment (`rule` null) or an existing one. */
function cardRepaymentForm(state, rule, rerender) {
  const today = todayIso();
  const key = rule ? rule.id.replace(/[^a-z0-9-]/gi, '-') : 'new';
  const select = (name, options, value) => {
    const control = el('select', { id: `rep-${name}-${key}` }, options.map(([v, text]) => el('option', { value: v, text })));
    control.value = value;
    return control;
  };
  const accountOptions = (keep, test) => state.accounts
    .filter(a => a.id === keep || (!a.archived && test(a))).map(a => [a.id, `${a.name} (${a.currency})`]);
  const cards = accountOptions(rule?.entry.toAccount, a => a.type === 'credit_card');
  const sources = accountOptions(rule?.entry.account, a => a.type !== 'credit_card');
  const card = select('card', cards, rule?.entry.toAccount || cards[0]?.[0] || '');
  const from = select('from', [['', 'Choose an account'], ...sources], rule?.entry.account || '');
  const start = el('input', { id: `rep-start-${key}`, type: 'date', value: rule?.start || today });
  const basis = select('basis', [['last-month', 'Last month\'s spending'], ['balance', 'Full balance']], rule ? repaymentBasis(rule) : 'last-month');
  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });
  const field = (control, label, hint) => el('div', { class: 'field' },
    el('label', { for: control.id, text: label }), control, hint && el('p', { class: 'hint', text: hint }));

  async function submit(event) {
    event.preventDefault();
    try {
      const next = saveCardRepayment(ledger.state, {
        id: rule?.id, card: card.value, from: from.value, start: start.value, basis: basis.value
      }, today);
      recurringView.editingId = '';
      await saveLedger(next);
      rerender();
      showToast(rule ? 'Card repayment saved.' : 'Card repayment added. It will wait on Today for you to confirm.');
    } catch (error) {
      errorBox.textContent = errorMessage(error);
      errorBox.hidden = false;
    }
  }

  return el('form', { class: rule ? 'ed-edit' : 'fold-body', onsubmit: submit, novalidate: true },
    field(card, 'Card'),
    field(from, 'Pay from', 'An account in the same currency as the card.'),
    field(start, 'First due date', 'Due every month on this day.'),
    field(basis, 'Amount to pay', 'Last month\'s spending is what was charged to the card in the calendar month before the due date.'),
    errorBox,
    el('div', { class: 'ed-edit-actions' },
      el('button', { type: 'submit', class: 'btn-primary btn-small', text: rule ? 'Save' : 'Add card repayment' }),
      rule && el('button', { type: 'button', class: 'btn-text', text: 'Cancel', onclick: () => { recurringView.editingId = ''; rerender(); } })));
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
