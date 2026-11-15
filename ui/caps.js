// Settings → Accounts: spending targets ("spend £1,000 on this card by a
// date"), and the words Today uses when a save takes one past a line.

import { el, sectionTitle, todayIso, formatMoney, plainAmount, errorMessage, showToast } from './dom.js';
import { ledger, saveLedger } from './ledger.js';
import { saveCap, archiveCap, capRows, capCrossing } from '../caps-logic.js';
import { capUsed } from '../features.js';

// View state kept between re-renders: the target being edited.
const capView = { editingId: '' };

/** Money without a trailing ".00": "£1,000", "£640.50". */
function capMoney(minor, account) {
  return formatMoney(minor, account?.currency || '', account?.precision ?? 2).replace(/\.0+(?=\D|$)/, '');
}

/** The toast sentence when saving took `cap` past its heads-up or its amount, else ''. */
export function capCrossingText(before, after, cap) {
  const crossing = capCrossing(before, after, cap);
  if (crossing === 'reached') return `${cap.name} reached.`;
  if (crossing !== 'alert') return '';
  const account = after.accounts.find(a => a.id === cap.account);
  return `${cap.name}: ${cap.threshold ?? 80}% reached (${capMoney(capUsed(after, cap), account)} of ${capMoney(cap.minor, account)}).`;
}

function capDaysText(row, today) {
  if (today > row.cap.end) return 'ended';
  if (today < row.cap.start) return 'not started';
  return row.daysLeft === 0 ? 'last day' : `${row.daysLeft} ${row.daysLeft === 1 ? 'day' : 'days'} left`;
}

export function buildSpendingTargets(rerender) {
  const state = ledger.state;
  const today = todayIso();
  const rows = capRows(state, today);

  const items = rows.map(row => {
    const { cap, used, percent, status } = row;
    const account = state.accounts.find(a => a.id === cap.account);
    if (capView.editingId === cap.id) return el('li', {}, capForm(state, today, cap, rerender));

    let armed = false;
    const archive = el('button', { type: 'button', class: 'btn-text', text: 'Archive', 'aria-label': `Archive ${cap.name}`, 'data-focus': `cap-archive:${cap.id}` });
    archive.addEventListener('blur', () => { armed = false; archive.textContent = 'Archive'; archive.classList.remove('is-armed'); });
    archive.addEventListener('click', async () => {
      if (!armed) {
        armed = true;
        archive.textContent = 'Press again to archive';
        archive.classList.add('is-armed');
        return;
      }
      try {
        await saveLedger(archiveCap(ledger.state, cap.id));
        showToast(`${cap.name} archived.`);
      } catch (error) {
        showToast(errorMessage(error));
      }
    });
    const marked = status === 'alert' || status === 'reached';
    const when = status === 'reached' ? 'reached' : capDaysText(row, today);
    return el('li', {},
      el('div', { class: 'list-row' },
        el('span', { class: 'entry-text' },
          el('span', { class: 'entry-title', text: cap.name }),
          el('span', { class: 'entry-meta', text: `${account?.name || 'Account'} · ${capMoney(used, account)} of ${capMoney(cap.minor, account)} · ${when}` }),
          el('span', { class: `tv-meter cap-meter${marked ? ' is-over' : ''}`, 'aria-hidden': 'true' },
            el('span', { class: 'tv-meter-fill', style: `width:${percent}%` }))),
        el('button', {
          type: 'button', class: 'btn-text', text: 'Edit', 'aria-label': `Edit ${cap.name}`, 'data-focus': `cap-edit:${cap.id}`,
          onclick: () => { capView.editingId = cap.id; rerender(); document.getElementById('cap-name-edit')?.focus(); }
        }),
        archive));
  });

  return el('div', { class: 'cap-block' },
    sectionTitle('Spending targets'),
    el('p', { class: 'note', text: 'For a card offer such as "spend £1,000 by the end of the month". Expenses on the account count while "Counts towards" is ticked on Today; refunds of them are taken off.' }),
    items.length ? el('ul', { class: 'plain-list' }, items) : el('p', { class: 'empty', text: 'No spending targets.' }),
    state.accounts.some(a => !a.archived)
      ? el('details', { class: 'fold' }, el('summary', { text: 'Add a spending target' }), capForm(state, today, null, rerender))
      : null);
}

/** The form for a new target (`cap` null, inside the fold) or an existing one (inline). */
function capForm(state, today, cap, rerender) {
  const suffix = cap ? '-edit' : '';
  const accounts = state.accounts.filter(a => !a.archived || a.id === cap?.account);
  const name = el('input', { id: `cap-name${suffix}`, type: 'text', maxLength: 150, value: cap?.name || '' });
  const account = el('select', { id: `cap-account${suffix}` }, accounts.map(a => el('option', { value: a.id, text: `${a.name} (${a.currency})` })));
  if (cap) account.value = cap.account;
  const chosen = () => accounts.find(a => a.id === account.value);
  const amount = el('input', {
    id: `cap-amount${suffix}`, type: 'text', inputMode: 'decimal', autocomplete: 'off',
    value: cap ? plainAmount(cap.minor, chosen()?.precision ?? 2) : ''
  });
  const amountLabel = el('label', { for: `cap-amount${suffix}` });
  const showAmountLabel = () => { amountLabel.textContent = `Amount to spend (${chosen()?.currency || ''})`; };
  account.addEventListener('change', showAmountLabel);
  showAmountLabel();
  const start = el('input', { id: `cap-start${suffix}`, type: 'date', value: cap?.start || today });
  const end = el('input', { id: `cap-end${suffix}`, type: 'date', value: cap?.end || '' });
  const threshold = el('input', { id: `cap-threshold${suffix}`, type: 'text', inputMode: 'numeric', autocomplete: 'off', value: String(cap?.threshold ?? 80) });
  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });
  const field = (control, label) => el('div', { class: 'field' }, typeof label === 'string' ? el('label', { for: control.id, text: label }) : label, control);

  return el('form', {
    class: cap ? 'ed-edit' : 'fold-body', novalidate: true,
    onsubmit: async event => {
      event.preventDefault();
      try {
        const next = saveCap(ledger.state, {
          id: cap?.id, name: name.value, account: account.value, start: start.value, end: end.value,
          amount: amount.value, threshold: threshold.value
        });
        capView.editingId = '';
        await saveLedger(next);
        showToast(cap ? 'Spending target saved.' : 'Spending target added.');
      } catch (error) {
        errorBox.textContent = errorMessage(error);
        errorBox.hidden = false;
      }
    }
  },
    field(name, 'Name'),
    el('div', { class: 'field-pair' }, field(account, 'Account'), field(amount, amountLabel)),
    el('div', { class: 'field-pair' }, field(start, 'From'), field(end, 'Until')),
    field(threshold, 'Tell me at (percent)'),
    errorBox,
    el('div', { class: 'ed-edit-actions' },
      el('button', { type: 'submit', class: 'btn-primary btn-small', text: cap ? 'Save' : 'Add spending target' }),
      cap && el('button', { type: 'button', class: 'btn-text', text: 'Cancel', onclick: () => { capView.editingId = ''; rerender(); } })));
}
