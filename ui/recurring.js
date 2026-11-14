// Recurring payments on open, and the "Due to confirm" block on Today.

import { parseAmount } from '../domain.js';
import { postDueSchedules, dueToConfirm, confirmDue, skipDue } from '../recurring-logic.js';
import { upcomingRepayments, confirmRepayment, skipRepayment, basisWords } from '../card-repayment-logic.js';
import { el, sectionTitle, todayIso, formatDay, formatMoney, plainAmount, errorMessage, showToast } from './dom.js';
import { ledger, saveLedger } from './ledger.js';
import { openPopover, closePopover } from './popover.js';

/** "Posted 2 recurring payments: Rent (Sun 1 Nov) £950.00, Phone (Thu 5 Nov) £12.00." At most three are named. */
export function recurringPostedText(state, posted, today) {
  const parts = [];
  if (posted.length) {
    const entries = posted.map(id => state.entries.find(e => e.id === id)).filter(Boolean);
    const named = entries.slice(0, 3).map(e => `${e.note || 'Payment'} (${formatDay(e.date)}) ${formatMoney(e.minor, e.currency, e.precision)}`);
    const more = entries.length - named.length;
    parts.push(`Posted ${entries.length} recurring payment${entries.length === 1 ? '' : 's'}: ${named.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`);
  }
  const waiting = dueToConfirm(state, today).length + upcomingRepayments(state, today).length;
  if (waiting) parts.push(`${waiting} to confirm on Today.`);
  return parts.join(' ');
}

/**
 * Write the recurring payments that have fallen due since the last visit.
 * A failure is shown as a toast and never blocks the ledger.
 */
export async function runRecurringOnOpen() {
  try {
    const today = todayIso();
    const { state, posted, planned } = postDueSchedules(ledger.state, today);
    if (state === ledger.state) return;
    await saveLedger(state);
    if (posted.length || planned.length) showToast(recurringPostedText(state, posted, today), null, 10000);
  } catch (error) {
    showToast(errorMessage(error));
  }
}

/** Today: recurring payments and card repayments waiting for a yes or no. Null when there are none. */
export function buildDueToConfirm(state, today) {
  const due = dueToConfirm(state, today);
  const repayments = upcomingRepayments(state, today);
  if (!due.length && !repayments.length) return null;
  return el('div', { class: 'due' },
    sectionTitle('Due to confirm'),
    repayments.map(item => {
      const name = `${item.card.name} repayment`;
      const meta = `Due ${formatDay(item.date)} · from ${item.from.name} · ${basisWords(item.basis, item.period)}`;
      return el('div', { class: 'due-item' },
        el('div', { class: 'list-row' },
          el('span', { class: 'entry-text' },
            el('span', { class: 'entry-title', text: name }),
            el('span', { class: 'entry-meta', text: meta })),
          el('span', { class: 'entry-amount', text: formatMoney(-item.estimate, item.from.currency, item.from.precision, { signed: true }) })),
        el('div', { class: 'entry-actions' },
          el('button', {
            type: 'button', class: 'btn-primary btn-small', text: 'Confirm', 'aria-label': `Confirm ${name}, due ${formatDay(item.date)}`,
            onclick: event => openConfirmRepaymentSheet(event.currentTarget, item, name)
          }),
          skipDueButton({ date: item.date }, name, () => skipRepayment(ledger.state, item.rule.id, item.date))));
    }),
    due.map(entry => {
      const rule = state.schedules.find(r => r.id === entry.schedule);
      const name = rule?.name || entry.note || 'Recurring payment';
      const account = state.accounts.find(a => a.id === entry.account)?.name;
      const signed = entry.kind === 'income' ? entry.minor : -entry.minor;
      return el('div', { class: 'due-item' },
        el('div', { class: 'list-row' },
          el('span', { class: 'entry-text' },
            el('span', { class: 'entry-title', text: name }),
            el('span', { class: 'entry-meta', text: [formatDay(entry.date), account].filter(Boolean).join(' · ') })),
          el('span', {
            class: 'entry-amount' + (entry.kind === 'income' ? ' is-income' : ''),
            text: formatMoney(signed, entry.currency, entry.precision, { signed: true })
          })),
        el('div', { class: 'entry-actions' },
          el('button', {
            type: 'button', class: 'btn-primary btn-small', text: 'Confirm', 'aria-label': `Confirm ${name}, ${formatDay(entry.date)}`,
            onclick: event => openConfirmDueSheet(event.currentTarget, entry, name, rule)
          }),
          skipDueButton(entry, name)));
    }));
}

/** Two presses: the first asks, the second skips this date. */
function skipDueButton(entry, name, skip = () => skipDue(ledger.state, entry.id)) {
  let armed = false;
  const button = el('button', { type: 'button', class: 'btn-text', text: 'Skip', 'aria-label': `Skip ${name}, ${formatDay(entry.date)}` });
  button.addEventListener('blur', () => { armed = false; button.textContent = 'Skip'; button.classList.remove('is-armed'); });
  button.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      button.textContent = 'Press again to skip';
      button.classList.add('is-armed');
      return;
    }
    try {
      await saveLedger(skip());
      showToast(`${name} skipped for ${formatDay(entry.date)}.`);
    } catch (error) {
      showToast(errorMessage(error));
    }
  });
  return button;
}

/** The small sheet behind Confirm: amount and date, both ready to accept as they are. */
function openConfirmDueSheet(anchor, entry, name, rule) {
  const today = todayIso();
  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });
  const amount = el('input', {
    id: 'due-amount', type: 'text', inputMode: 'decimal', autocomplete: 'off', value: plainAmount(entry.minor, entry.precision)
  });
  const date = el('input', { id: 'due-date', type: 'date', min: rule?.start || null, max: today, value: entry.date });
  const dueField = (control, label) => el('div', { class: 'field' }, el('label', { for: control.id, text: label }), control);

  const form = el('form', {
    class: 'pot-sheet', novalidate: true,
    onsubmit: async event => {
      event.preventDefault();
      try {
        if (!amount.value.trim()) throw Error('Enter the amount.');
        const next = confirmDue(ledger.state, entry.id, { minor: parseAmount(amount.value, entry.currency), date: date.value, today });
        closePopover({ restoreFocus: false });
        await saveLedger(next);
        showToast(`${name} recorded.`);
      } catch (error) {
        errorBox.textContent = errorMessage(error);
        errorBox.hidden = false;
        if (!form.isConnected) showToast(errorMessage(error));
      }
    }
  },
    dueField(amount, `Amount (${entry.currency})`),
    dueField(date, entry.kind === 'income' ? 'Date received' : 'Date paid'),
    errorBox,
    el('div', { class: 'entry-actions' },
      el('button', { type: 'submit', class: 'btn-primary btn-small', text: 'Confirm' })));

  openPopover({ anchor, label: `Confirm ${name}`, role: 'dialog', content: form });
}

/** The sheet behind Confirm for a card repayment: the worked-out amount, open to change, and the day it was paid. */
function openConfirmRepaymentSheet(anchor, item, name) {
  const today = todayIso();
  const { currency, precision } = item.from;
  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });
  const amount = el('input', {
    id: 'repay-amount', type: 'text', inputMode: 'decimal', autocomplete: 'off', value: plainAmount(item.estimate, precision)
  });
  const date = el('input', {
    id: 'repay-date', type: 'date', min: item.card.openingDate || null, max: today, value: item.date <= today ? item.date : today
  });
  const field = (control, label, hint) => el('div', { class: 'field' },
    el('label', { for: control.id, text: label }), control, hint && el('p', { class: 'hint', text: hint }));
  const basis = item.existing?.amountConfirmed ? 'The amount you set earlier.' : `Worked out from: ${basisWords(item.basis, item.period)}.`;

  const form = el('form', {
    class: 'pot-sheet', novalidate: true,
    onsubmit: async event => {
      event.preventDefault();
      try {
        if (!amount.value.trim()) throw Error('Enter the amount.');
        const next = confirmRepayment(ledger.state, item.id, { minor: parseAmount(amount.value, currency), date: date.value, today });
        closePopover({ restoreFocus: false });
        await saveLedger(next);
        showToast(`${name} recorded.`);
      } catch (error) {
        errorBox.textContent = errorMessage(error);
        errorBox.hidden = false;
        if (!form.isConnected) showToast(errorMessage(error));
      }
    }
  },
    field(amount, `Amount (${currency})`, basis),
    field(date, 'Paid on', item.date > today ? `Due ${formatDay(item.date)}. Confirming now records it as paid on the date above.` : null),
    errorBox,
    el('div', { class: 'entry-actions' },
      el('button', { type: 'submit', class: 'btn-primary btn-small', text: 'Confirm' })));

  openPopover({ anchor, label: `Confirm ${name}`, role: 'dialog', content: form });
}
