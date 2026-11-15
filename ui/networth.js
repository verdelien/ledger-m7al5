// Net worth and investments. Reached from the Pots tab ('#networth'); it is not a tab.
// One total per currency (currencies are never added together), then each investment
// account: its latest recorded value, what was paid in, and the gain or loss.
// The rules live in networth-logic.js.

import {
  saveValuation, deleteValuation, setInitialContributions, investmentRows, netWorth
} from '../networth-logic.js';
import { el, slip, sectionTitle, todayIso, formatDay, formatMoney, plainAmount, errorMessage, showToast } from './dom.js';
import { ledger, saveLedger } from './ledger.js';
import { openPopover, closePopover } from './popover.js';

export function renderNetWorth(root) {
  const state = ledger.state;
  const today = todayIso();
  const totals = netWorth(state, today);
  const rows = investmentRows(state, today);

  root.append(slip({ label: 'Net worth', kind: formatDay(today), wide: true },
    el('a', { class: 'btn-text', href: '#pots', text: '‹ Pots' }),
    el('p', { class: 'note', text: 'Everything you have, less what you owe, in each currency. Currencies are never added together.' }),
    totals.length
      ? el('ul', { class: 'plain-list nw-totals' }, totals.map(networthTotal))
      : el('p', { class: 'empty', text: 'Nothing to count yet. Add an account in Settings.' }),
    sectionTitle('Investments'),
    rows.length
      ? el('ul', { class: 'plain-list nw-accounts' }, rows.map(row => networthInvestment(row, today)))
      : el('p', { class: 'empty', text: 'No investment accounts yet. Add one in Settings and choose the type "Investment".' }),
    el('p', { class: 'hint', text: 'An investment counts at its latest recorded value. Record a new value whenever you check it.' })));
}

/** One currency: the big figure, with its parts in a fold. */
function networthTotal(total) {
  const money = minor => formatMoney(minor, total.currency, total.precision);
  const negative = total.minor < 0n;
  return el('li', { class: 'nw-total' },
    el('p', { class: 'nw-currency', text: total.currency }),
    el('p', { class: 'nw-figure' + (negative ? ' is-negative' : ''), text: money(total.minor) }),
    el('details', { class: 'fold nw-fold' },
      el('summary', { text: total.parts.length === 1 ? 'What this is' : `The ${total.parts.length} parts` }),
      el('ul', { class: 'plain-list fold-body' }, total.parts.map(part => el('li', { class: 'nw-part' },
        el('span', { class: 'entry-text' },
          el('span', { class: 'nw-part-name', text: part.label }),
          el('span', { class: 'entry-meta nw-wrap', text: networthPartNote(part) })),
        el('span', { class: 'nw-part-amount' + (part.minor < 0n ? ' is-negative' : ''), text: money(part.minor) }))))));
}

function networthPartNote(part) {
  if (part.kind === 'friends') return part.minor < 0n ? 'You owe them' : 'Owes you';
  if (part.kind === 'investment') return part.estimated ? 'Investment · no value recorded, counted at its balance' : `Investment · value on ${formatDay(part.date)}`;
  return part.minor < 0n ? 'You owe this' : 'Account';
}

/** One investment account: value, paid in, gain or loss, and its recorded values. */
function networthInvestment(row, today) {
  const { account, valuation, contributions, growth, complete, history } = row;
  const money = (minor, options) => formatMoney(minor, account.currency, account.precision, options);
  const fact = (label, value) => el('div', { class: 'pot-fact' }, el('dt', { text: label }), el('dd', { text: value }));

  const record = el('button', {
    type: 'button', class: 'btn-secondary btn-small', text: 'Record value',
    'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'data-focus': `nw-record:${account.id}`,
    'aria-label': `Record value of ${account.name}`,
    onclick: () => openRecordValue(record, account, today)
  });

  let gain = null;
  if (complete && growth !== null) {
    const up = growth > 0n, down = growth < 0n;
    gain = el('p', { class: 'nw-gain' + (up ? ' is-up' : down ? ' is-down' : '') },
      el('span', { text: up ? `▲ ${money(growth, { signed: true })}` : down ? `▼ ${money(growth)}` : money(0n) }),
      el('span', { class: 'nw-gain-word', text: up ? ' gain' : down ? ' loss' : ' no gain or loss' }));
  } else if (!complete) {
    gain = el('p', { class: 'nw-gain', text: 'Gain or loss: unknown — add what you had paid in before' });
  }

  const known = account.initialContributions != null;
  const before = networthPaidInForm(account);

  return el('li', { class: 'nw-account' },
    el('div', { class: 'nw-account-head' },
      el('h3', { class: 'nw-name', text: account.name }),
      record),
    el('p', { class: 'nw-value', text: valuation ? money(valuation.minor) : 'No value recorded' }),
    valuation && el('p', { class: 'entry-meta nw-wrap', text: `Value on ${formatDay(valuation.date)}` }),
    el('dl', { class: 'pot-facts' }, fact(complete ? 'Paid in' : 'Paid in since tracking began', money(contributions))),
    gain,
    complete
      ? el('details', { class: 'fold nw-fold' },
          el('summary', { text: known ? `Paid in before tracking: ${money(account.initialContributions)}` : 'Paid in before tracking' }),
          el('div', { class: 'fold-body' }, before))
      : before,
    history.length > 0 && el('details', { class: 'fold nw-fold' },
      el('summary', { text: history.length === 1 ? '1 recorded value' : `${history.length} recorded values` }),
      el('ul', { class: 'plain-list fold-body' }, history.map(item => el('li', { class: 'nw-part' },
        el('span', { class: 'entry-text' },
          el('span', { class: 'nw-part-name', text: money(item.minor) }),
          el('span', { class: 'entry-meta', text: formatDay(item.date) })),
        networthDeleteButton(item, account))))));
}

/** The inline field for what was paid in before the app started tracking the account. */
function networthPaidInForm(account) {
  const id = `nw-before-${account.id}`;
  const known = account.initialContributions != null;
  const input = el('input', {
    id, type: 'text', inputMode: 'decimal', autocomplete: 'off', 'data-focus': id,
    value: known ? plainAmount(account.initialContributions, account.precision) : ''
  });
  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });
  return el('form', {
    class: 'nw-before', novalidate: true,
    onsubmit: async event => {
      event.preventDefault();
      try {
        if (!known && !input.value.trim()) throw Error('Enter what you had paid in. Use 0 if nothing.');
        const next = setInitialContributions(ledger.state, account.id, input.value);
        await saveLedger(next);
        showToast(input.value.trim() ? 'Saved what you had paid in.' : 'Cleared. Gain or loss is unknown again.');
      } catch (error) {
        errorBox.textContent = errorMessage(error);
        errorBox.hidden = false;
      }
    }
  },
    el('div', { class: 'field' },
      el('label', { for: id, text: `Paid in before ${formatDay(account.openingDate)} (${account.currency})` }),
      el('div', { class: 'nw-before-row' },
        input,
        el('button', { type: 'submit', class: 'btn-secondary btn-small', text: 'Save' })),
      el('p', { class: 'hint', text: known ? 'Your own money only, not growth. Leave empty and save to clear.' : 'Your own money only, not growth. Transfers since then are counted for you.' })),
    errorBox);
}

/** Delete a recorded value: the first press arms the button, the second deletes. */
function networthDeleteButton(item, account) {
  let armed = false;
  const button = el('button', {
    type: 'button', class: 'btn-text', text: 'Delete',
    'aria-label': `Delete the value of ${account.name} on ${formatDay(item.date)}`
  });
  button.addEventListener('blur', () => { armed = false; button.textContent = 'Delete'; button.classList.remove('is-armed'); });
  button.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      button.textContent = 'Press again to delete';
      button.classList.add('is-armed');
      return;
    }
    try {
      await saveLedger(deleteValuation(ledger.state, item.id));
      showToast('Value deleted.');
    } catch (error) {
      showToast(errorMessage(error));
    }
  });
  return button;
}

/** The "Record value" sheet: a date and what the account was worth. */
function openRecordValue(anchor, account, today) {
  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });
  const date = el('input', { id: 'nw-value-date', type: 'date', min: account.openingDate, max: today, value: today });
  const amount = el('input', { id: 'nw-value-amount', type: 'text', inputMode: 'decimal', autocomplete: 'off' });
  const field = (id, label, control, hint) => el('div', { class: 'field' },
    el('label', { for: id, text: label }), control, hint && el('p', { class: 'hint', text: hint }));

  const form = el('form', {
    class: 'pot-sheet', novalidate: true,
    onsubmit: async event => {
      event.preventDefault();
      try {
        const next = saveValuation(ledger.state, { accountId: account.id, date: date.value, amountText: amount.value, today: todayIso() });
        closePopover({ restoreFocus: false });
        await saveLedger(next);
        showToast('Value recorded.');
      } catch (error) {
        errorBox.textContent = errorMessage(error);
        errorBox.hidden = false;
        if (!form.isConnected) showToast(errorMessage(error));
      }
    }
  },
    field('nw-value-date', 'Date', date, 'A value already recorded for this date is replaced.'),
    field('nw-value-amount', `Value (${account.currency})`, amount, 'What the provider shows as the total value.'),
    errorBox,
    el('div', { class: 'entry-actions' },
      el('button', { type: 'submit', class: 'btn-primary btn-small', text: 'Save value' })));

  openPopover({ anchor, label: `${account.name} value`, role: 'dialog', content: form });
  amount.focus();
}
