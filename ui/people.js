// People: bills shared with friends. Who owes whom per currency, each friend's history,
// repayments and forgiveness. Reached from Today ('#people', and '#people/<id>' for one
// friend); it is not a tab. The rules live in shared-logic.js.

import { parseAmount } from '../domain.js';
import {
  saveFriend, friendBalances, friendHistory, settle, deleteSettlement, balancePhrase
} from '../shared-logic.js';
import { el, slip, sectionTitle, todayIso, formatDay, formatMoney, plainAmount, errorMessage, showToast } from './dom.js';
import { ledger, saveLedger } from './ledger.js';
import { openPopover, closePopover } from './popover.js';

// View state kept between re-renders: whether the friend's name is being edited.
const peopleView = { renaming: false };

function peopleRerender() {
  const root = document.getElementById('screen');
  root.replaceChildren();
  renderPeople(root, location.hash.replace('#', '').split('/')[1] || '');
}

export function renderPeople(root, section) {
  const state = ledger.state;
  const friend = section && state.friends.find(f => f.id === decodeURIComponent(section));
  if (section && !friend) {
    root.append(slip({ label: 'People', kind: 'Friend' },
      el('a', { class: 'btn-text', href: '#people', text: '‹ People' }),
      el('p', { class: 'empty', text: 'That friend no longer exists.' })));
    return;
  }
  if (!friend) peopleView.renaming = false;
  root.append(friend ? buildFriendDetail(state, friend) : buildPeopleOverview(state));
}

/** The form that adds a friend (`friend` null) or renames one. */
function buildFriendForm(friend) {
  const key = friend ? 'edit' : 'new';
  const name = el('input', { id: `pp-name-${key}`, type: 'text', maxLength: 150, autocomplete: 'off', value: friend?.name || '' });
  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });
  return el('form', {
    class: friend ? 'ed-edit' : 'fold-body', novalidate: true,
    onsubmit: async event => {
      event.preventDefault();
      try {
        const next = saveFriend(ledger.state, { id: friend?.id, name: name.value });
        peopleView.renaming = false;
        await saveLedger(next);
        showToast(friend ? 'Name saved.' : 'Friend added. Choose them on Today under "Split with a friend".');
      } catch (error) {
        errorBox.textContent = errorMessage(error);
        errorBox.hidden = false;
      }
    }
  },
    el('div', { class: 'field' }, el('label', { for: name.id, text: 'Name' }), name),
    errorBox,
    el('div', { class: 'ed-edit-actions' },
      el('button', { type: 'submit', class: 'btn-primary btn-small', text: friend ? 'Save' : 'Add friend' }),
      friend && el('button', { type: 'button', class: 'btn-text', text: 'Cancel', onclick: () => { peopleView.renaming = false; peopleRerender(); } })));
}

// ---------------------------------------------------------------------------
// '#people': every friend with what is outstanding
// ---------------------------------------------------------------------------

function buildPeopleOverview(state) {
  const friends = [...state.friends].sort((a, b) => a.name.localeCompare(b.name));
  const row = friend => {
    const balances = friendBalances(state, friend.id);
    return el('li', { class: 'list-row' },
      el('a', { class: 'tv-trip-link', href: `#people/${encodeURIComponent(friend.id)}`, 'data-focus': `pp-friend:${friend.id}` },
        el('span', { class: 'entry-text' },
          el('span', { class: 'entry-title', text: friend.name }),
          // One line per currency; currencies are never added together.
          balances.length
            ? balances.map(balance => el('span', { class: 'entry-meta' + (balance.minor < 0n ? ' pp-owing' : ''), text: balancePhrase(friend.name, balance) }))
            : el('span', { class: 'entry-meta', text: 'Settled' })),
        el('span', { class: 'tv-arrow', 'aria-hidden': 'true', text: '→' })));
  };

  return slip({ label: 'People', kind: 'Shared bills', wide: true },
    el('a', { class: 'btn-text', href: '#today', text: '‹ Today' }),
    el('p', { class: 'note', text: 'To share a bill, add an expense on Today and switch on "Split with a friend". Only your share counts as your spending.' }),
    sectionTitle('Friends'),
    friends.length
      ? el('ul', { class: 'plain-list' }, friends.map(row))
      : el('p', { class: 'empty', text: 'No friends yet. Add one below, or while you record a shared bill on Today.' }),
    el('details', { class: 'fold' },
      el('summary', { text: 'Add a friend' }),
      buildFriendForm(null)));
}

// ---------------------------------------------------------------------------
// '#people/<id>': one friend
// ---------------------------------------------------------------------------

function buildFriendDetail(state, friend) {
  const balances = friendBalances(state, friend.id);
  const history = friendHistory(state, friend.id);
  const theyOwe = balances.filter(b => b.minor > 0n);
  const iOwe = balances.filter(b => b.minor < 0n);

  const action = (text, actions, list, key) => list.length > 0 && el('button', {
    type: 'button', class: 'btn-secondary btn-small', text, 'aria-haspopup': 'dialog', 'data-focus': `pp-${key}`,
    onclick: event => openSettleSheet(event.currentTarget, friend, actions, list)
  });
  const rename = el('button', {
    type: 'button', class: 'btn-text', text: 'Rename', 'aria-expanded': String(peopleView.renaming), 'data-focus': 'pp-rename',
    onclick: () => { peopleView.renaming = !peopleView.renaming; peopleRerender(); }
  });

  const historyRow = row => {
    const money = (minor, signed) => formatMoney(minor, row.currency, row.precision, { signed });
    const after = row.balance === 0n ? 'settled'
      : row.balance > 0n ? `${friend.name} owes ${money(row.balance)}` : `you owe ${money(-row.balance)}`;
    return el('li', { class: 'list-row' },
      el('span', { class: 'entry-text' },
        el('span', { class: 'entry-title', text: row.label }),
        el('span', { class: 'entry-meta', text: `${formatDay(row.date)} · then ${after}` })),
      el('span', { class: 'entry-amount', text: money(row.delta, true) }),
      row.kind === 'settlement' && settlementDeleteButton(row));
  };

  return slip({ label: 'People', kind: 'Friend', wide: true },
    el('a', { class: 'btn-text', href: '#people', text: '‹ People' }),
    el('h2', { class: 'tv-name', text: friend.name }),
    balances.length
      ? balances.map(balance => el('p', { class: 'tv-total' + (balance.minor < 0n ? ' pp-owing' : ''), text: balancePhrase(friend.name, balance) }))
      : el('p', { class: 'tv-total', text: history.length ? 'Settled' : 'Nothing shared yet' }),
    el('div', { class: 'entry-actions pp-actions' },
      action('They paid me back', ['receive'], theyOwe, 'receive'),
      action('I paid them back', ['pay'], iOwe, 'pay'),
      action('Forgive', ['absorb', 'waived'], balances, 'forgive'),
      rename),
    peopleView.renaming && buildFriendForm(friend),
    sectionTitle('History'),
    history.length
      ? el('ul', { class: 'plain-list pp-history' }, [...history].reverse().map(historyRow))
      : el('p', { class: 'empty', text: 'No shared bills yet. Add an expense on Today and switch on "Split with a friend".' }),
    history.length > 0 && el('p', { class: 'hint', text: 'Newest first. A plus means they owe you more; a minus means they owe you less or you owe them. Shared bills and their refunds are changed on Today.' }));
}

/** Two presses remove a repayment or a forgiveness, with the payment written for it. */
function settlementDeleteButton(row) {
  let armed = false;
  const button = el('button', { type: 'button', class: 'btn-text', text: 'Delete', 'aria-label': `Delete: ${row.label}` });
  button.addEventListener('blur', () => { armed = false; button.textContent = 'Delete'; button.classList.remove('is-armed'); });
  button.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      button.textContent = 'Press again';
      button.classList.add('is-armed');
      return;
    }
    try {
      await saveLedger(deleteSettlement(ledger.state, row.id));
      showToast('Removed. The balance is as it was before.');
    } catch (error) {
      showToast(errorMessage(error));
    }
  });
  return button;
}

const PEOPLE_SHEETS = {
  receive: { title: 'They paid me back', amount: 'Amount received', account: 'Paid into', done: 'Repayment saved.' },
  pay: { title: 'I paid them back', amount: 'Amount paid', account: 'Paid from', done: 'Repayment saved.' },
  absorb: { title: 'Forgive', amount: 'Amount to let off', done: 'Saved. It now counts as your own spending.' },
  waived: { title: 'Forgive', amount: 'Amount let off', done: 'Saved.' }
};

/**
 * The sheet for a repayment (`actions` is ['receive'] or ['pay']) or a forgiveness
 * (['absorb', 'waived']: which one applies follows from who owes in the chosen currency).
 * `balances` are the balances the sheet can act on; the amount starts as the whole balance.
 */
function openSettleSheet(anchor, friend, actions, balances) {
  const state = ledger.state;
  const today = todayIso();
  const forgiving = actions.includes('absorb');
  const currency = el('select', { id: 'pp-settle-currency' },
    balances.map(b => el('option', { value: b.currency, text: b.currency })));
  const amount = el('input', { id: 'pp-settle-amount', type: 'text', inputMode: 'decimal', autocomplete: 'off' });
  const amountLabel = el('label', { for: amount.id });
  const account = el('select', { id: 'pp-settle-account' });
  const date = el('input', { id: 'pp-settle-date', type: 'date', max: today, value: today });
  const who = el('p', { class: 'note', role: 'status' });
  const accountHint = el('p', { class: 'hint' });
  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });

  const balance = () => balances.find(b => b.currency === currency.value);
  const actionNow = () => (forgiving ? (balance().minor > 0n ? 'absorb' : 'waived') : actions[0]);
  function syncSheet() {
    const b = balance();
    const copy = PEOPLE_SHEETS[actionNow()];
    amountLabel.textContent = `${copy.amount} (${b.currency})`;
    amount.value = plainAmount(b.minor < 0n ? -b.minor : b.minor, b.precision);
    who.textContent = forgiving
      ? `${balancePhrase(friend.name, b)}. ${b.minor > 0n ? 'I let them off' : 'They let me off'}: no money moves.`
      : `${balancePhrase(friend.name, b)}.`;
    if (!forgiving) {
      const usable = state.accounts.filter(a => !a.archived && a.currency === b.currency && a.precision === b.precision);
      account.replaceChildren(...usable.map(a => el('option', { value: a.id, text: a.name })));
      const usual = usable.find(a => a.id === state.settings.defaultAccount) || usable.find(a => a.type === 'current');
      if (usual) account.value = usual.id;
      accountHint.textContent = usable.length ? '' : `You have no ${b.currency} account. Add one in Settings → Accounts first.`;
    }
  }
  currency.addEventListener('change', syncSheet);
  syncSheet();

  const field = (control, label, hint) => el('div', { class: 'field' },
    typeof label === 'string' ? el('label', { for: control.id, text: label }) : label, control, hint);
  const form = el('form', {
    class: 'pot-sheet', novalidate: true,
    onsubmit: async event => {
      event.preventDefault();
      try {
        if (!amount.value.trim()) throw Error('Enter an amount.');
        const action = actionNow();
        const next = settle(ledger.state, {
          friend: friend.id, action, amountMinor: parseAmount(amount.value, currency.value),
          currency: currency.value, account: forgiving ? '' : account.value, date: date.value, today
        });
        closePopover({ restoreFocus: false });
        await saveLedger(next);
        const left = friendBalances(next, friend.id).find(b => b.currency === currency.value);
        showToast(`${PEOPLE_SHEETS[action].done} ${balancePhrase(friend.name, left)}.`);
      } catch (error) {
        errorBox.textContent = errorMessage(error);
        errorBox.hidden = false;
      }
    }
  },
    who,
    balances.length > 1 && field(currency, 'Currency'),
    field(amount, amountLabel),
    !forgiving && field(account, PEOPLE_SHEETS[actions[0]].account, accountHint),
    field(date, 'Date'),
    errorBox,
    el('button', { type: 'submit', class: 'btn-primary btn-small', text: 'Save' }));
  openPopover({ anchor, label: PEOPLE_SHEETS[actions[0]].title, role: 'dialog', content: form });
  amount.focus();
  amount.select();
}
