// Reconciliation in the interface: the sheet opened from Settings → Accounts,
// and the reminder shown on Today when an account is due.

import { el, todayIso, formatMoney, errorMessage, showToast } from './dom.js';
import { ledger, saveLedger } from './ledger.js';
import { openPopover, closePopover } from './popover.js';
import { reconcileAccount, reconcileDifference, reconcileDue, setReminder, adjustmentsOf } from '../reconcile-logic.js';

const REMINDER_CHOICES = [0, 3, 4, 6, 12];

/** '3 Mar 2026' for a YYYY-MM-DD date. */
export function formatFullDate(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Today: one line per account whose reconciliation reminder is due. Null when there are none. */
export function buildReconcileReminders(state, today) {
  const due = reconcileDue(state, today);
  if (!due.length) return null;
  return el('div', { class: 'reconcile-due' }, due.map(item => el('p', { class: 'note reconcile-note' },
    el('span', {
      text: `Time to reconcile ${item.account.name} (${item.lastReconciled ? `last done ${formatFullDate(item.lastReconciled)}` : 'not done yet'}). `
    }),
    el('a', { href: '#settings/accounts', text: 'Reconcile in Settings', 'aria-label': `Reconcile ${item.account.name} in Settings` }))));
}

/** The sheet: bank balance on a date, an optional note, and how often to be reminded. */
export function openReconcileSheet(anchor, accountId) {
  const today = todayIso();
  const account = ledger.state.accounts.find(a => a.id === accountId);
  if (!account) return;
  const money = (minor, options) => formatMoney(minor, account.currency, account.precision, options);
  const field = (id, label, control, hint) => el('div', { class: 'field' },
    el('label', { for: id, text: label }), control, hint && el('p', { class: 'hint', text: hint }));

  const date = el('input', { id: 'reconcile-date', type: 'date', min: account.openingDate, max: today, value: today });
  const balance = el('input', { id: 'reconcile-balance', type: 'text', inputMode: 'text', autocomplete: 'off' });
  const note = el('input', { id: 'reconcile-note', type: 'text', maxLength: 500, autocomplete: 'off' });
  const currentReminder = account.reminderMonths || 0;
  const reminder = el('select', { id: 'reconcile-reminder' },
    [...new Set([...REMINDER_CHOICES, currentReminder])].sort((a, b) => a - b).map(months =>
      el('option', { value: String(months), text: months === 0 ? 'Off' : `${months} months` })));
  reminder.value = String(currentReminder);

  const preview = el('p', { class: 'hint', 'aria-live': 'polite' });
  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });
  const showError = error => {
    errorBox.textContent = errorMessage(error);
    errorBox.hidden = false;
    if (!form.isConnected) showToast(errorMessage(error));
  };

  function updatePreview() {
    preview.textContent = '';
    if (!balance.value.trim()) return;
    try {
      const { shown, difference } = reconcileDifference(ledger.state, { accountId, date: date.value, balanceText: balance.value, today });
      preview.textContent = difference === 0n
        ? `The app shows ${money(shown)} on that date; the balances match, so no adjustment is needed.`
        : `The app shows ${money(shown)} on that date; this records an adjustment of ${money(difference, { signed: true })}.`;
    } catch { /* not a complete balance or date yet; Save explains what is wrong */ }
  }
  date.addEventListener('input', updatePreview);
  balance.addEventListener('input', updatePreview);

  const earlier = adjustmentsOf(ledger.state, accountId)[0];
  const form = el('form', {
    class: 'pot-sheet', novalidate: true,
    onsubmit: async event => {
      event.preventDefault();
      try {
        const months = Number(reminder.value);
        let next = ledger.state, message;
        if (balance.value.trim()) {
          const result = reconcileAccount(next, { accountId, date: date.value, balanceText: balance.value, note: note.value, today });
          next = result.state;
          message = result.difference === 0n
            ? 'Balance matches. Marked as reconciled.'
            : `Reconciled. Adjustment ${money(result.difference, { signed: true })}.`;
        } else if (months === currentReminder) {
          throw Error('Enter the balance shown by your bank.');
        } else {
          message = months ? `Reminder set for every ${months} months.` : 'Reminder turned off.';
        }
        next = setReminder(next, accountId, months);
        closePopover({ restoreFocus: false });
        await saveLedger(next);
        showToast(message);
      } catch (error) {
        showError(error);
      }
    }
  },
    field('reconcile-date', 'Actual balance on', date),
    field('reconcile-balance', `Balance shown by your bank (${account.currency})`, balance, 'Use a minus sign for card debt'),
    preview,
    field('reconcile-note', 'Note (optional)', note),
    field('reconcile-reminder', 'Remind me every', reminder, 'Leave the balance empty to change only the reminder.'),
    (account.lastReconciled || earlier) && el('p', { class: 'hint', text: [
      account.lastReconciled && `Last reconciled ${formatFullDate(account.lastReconciled)}.`,
      earlier && `Last adjustment ${money(earlier.direction === 'increase' ? earlier.minor : -earlier.minor, { signed: true })} on ${formatFullDate(earlier.date)}.`
    ].filter(Boolean).join(' ') }),
    errorBox,
    el('div', { class: 'entry-actions' },
      el('button', { type: 'submit', class: 'btn-primary btn-small', text: 'Save' })));

  openPopover({ anchor, label: `Reconcile ${account.name}`, role: 'dialog', content: form });
}
