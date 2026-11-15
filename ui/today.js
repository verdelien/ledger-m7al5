// Today: quick add for an expense, an income or a transfer, and the recent entries with net amounts.

import { digits, parseAmount, currencyName } from '../domain.js';
import { commit, commitBatch, uid } from '../model.js';
import { personalAmount, estimateAccountAmount } from '../money.js';
import { el, slip, sectionTitle, todayIso, formatDay, formatMoney, plainAmount, errorMessage, showToast, LEGACY_URL } from './dom.js';
import { ledger, saveLedger } from './ledger.js';
import { wishPurchase, purchasedWish, wishPurchasePot } from '../wishlist-logic.js';
import { createCategoryPicker } from './categories.js';
import { createAccountPicker } from './accounts-picker.js';
import { addActiveCurrency, buildCurrencySearch } from './currencies.js';
import { openPopover, closePopover } from './popover.js';
import { negativePotCheck } from '../pots-logic.js';
import { opensPaydayFlow } from '../payday-flow.js';
import { askNegativePot, openPaydayPreview } from './pots.js';
import { accountIconNode } from './pixel-icons.js';
import { buildTransferForm } from './transfer.js';
import { transferParts, hasSourceFee } from '../transfer-logic.js';
import { activeTemplates, templatePrefill } from '../templates-logic.js';
import { templateAmountLabel } from './quick-add-settings.js';
import { buildDueToConfirm } from './recurring.js';
import { buildReconcileReminders } from './reconcile.js';
import { isTravelCategory, tripForDate } from '../travel-logic.js';
import { saveRefund, deleteRefund, refundedSoFar, canRefundHere, suggestedSettled } from '../refund-logic.js';
import { activeCaps, capCrossing } from '../caps-logic.js';
import { withReportingValue } from '../rates-logic.js';
import { capCrossingText } from './caps.js';
import { saveFriend, allBalances, balancePhrase, sharedExpenseRecord, saveSharedRefund, sharedRefundLeft } from '../shared-logic.js';

const RECENT_LIMIT = 40;
const MORE_CURRENCIES = '__more';
const NEW_FRIEND = '__new';

/** An amount that may be zero (a share of a bill); otherwise as parseAmount. */
function shareAmount(text, currency) {
  return /^0(?:[.,]0*)?$/.test(text.trim()) ? 0 : parseAmount(text, currency);
}

// Remembered while the page is open, so adding several entries is quick.
// `kept` holds a half-filled form across the redraw that follows adding a currency.
// `kind` is what the add form records: 'expense', 'income' or 'transfer'.
const todayDraft = { currency: '', account: null, editingId: '', kept: null, kind: 'expense' };

export function renderToday(root) {
  const state = ledger.state;
  const today = todayIso();
  takeWishPurchase(state, today);
  const editing = state.entries.find(e => e.id === todayDraft.editingId) || null;
  if (!editing) todayDraft.editingId = '';

  root.append(slip({ label: 'Today', kind: formatDay(today), wide: true },
    el('div', { class: 'today-layout' },
      editing?.kind === 'transfer' || (!editing && todayDraft.kind === 'transfer')
        ? buildTransferPanel(state, today, editing)
        : buildEntryForm(state, today, editing),
      buildRecentList(state, today))));
}

/**
 * "Record purchase" on the wishlist: start a new expense with the wish's name, price and
 * currency. The category is left for the user. The form remembers the wish (kept.fromWish),
 * and saving the expense closes it.
 */
function takeWishPurchase(state, today) {
  const id = wishPurchase.id;
  if (!id) return;
  wishPurchase.id = '';
  const wish = state.wishlist.find(w => w.id === id && (w.status === 'open' || w.status === 'saving'));
  if (!wish) return;
  // A currency no longer active: the form uses the usual one, so the price would mean something else.
  const active = state.settings.activeCurrencies.includes(wish.currency);
  const accounts = state.accounts.filter(a => !a.archived);
  const account = accounts.some(a => a.id === todayDraft.account) || todayDraft.account === '' ? todayDraft.account
    : accounts.some(a => a.id === state.settings.defaultAccount) ? state.settings.defaultAccount
    : accounts.find(a => a.type === 'current' && a.currency === 'GBP')?.id ?? '';
  todayDraft.editingId = '';
  todayDraft.kind = 'expense';
  if (active) todayDraft.currency = wish.currency;
  todayDraft.kept = {
    amount: active ? wish.amount : '', note: wish.name, date: today,
    settled: '', settledState: 'auto', category: '', account, trip: '', tripChosen: false,
    fromWish: wish.id
  };
}

// ---------------------------------------------------------------------------
// Quick add
// ---------------------------------------------------------------------------

const KINDS = [['expense', 'Expense'], ['income', 'Income'], ['transfer', 'Transfer']];

/** Expense | Income | Transfer. Switching redraws the form for the other kind. */
function buildKindSwitch(kind, beforeSwitch = () => {}) {
  return el('div', { class: 'segmented entry-kind', role: 'group', 'aria-label': 'Kind of entry' },
    KINDS.map(([value, label]) => el('button', {
      type: 'button', id: `entry-kind-${value}`,
      class: value === kind ? 'is-selected' : '',
      'aria-pressed': String(value === kind),
      text: label,
      onclick: () => {
        if (value === kind) return;
        beforeSwitch(value);
        todayDraft.kind = value;
        closePopover({ restoreFocus: false });
        rerenderToday();
        document.getElementById(`entry-kind-${value}`)?.focus();
      }
    })));
}

/** The transfer form, with the kind switch above it for a new transfer. */
function buildTransferPanel(state, today, editing) {
  const form = buildTransferForm(state, today, editing, {
    onSaved: () => {
      todayDraft.editingId = '';
      todayDraft.kind = 'expense'; // the form goes back to the common case
      todayDraft.kept = null;
      rerenderToday();
    },
    onCancel: () => { todayDraft.editingId = ''; rerenderToday(); }
  });
  if (!editing) form.prepend(buildKindSwitch('transfer'));
  return form;
}

function buildEntryForm(state, today, editing) {
  const currencies = [...new Set([...state.settings.activeCurrencies, editing?.currency].filter(Boolean))];
  const accounts = state.accounts.filter(a => !a.archived || a.id === editing?.account);

  const kept = todayDraft.kept;
  todayDraft.kept = null;

  // Plain expenses and incomes are edited here; the switch is for new entries.
  const kind = (editing ? editing.kind : todayDraft.kind) === 'income' ? 'income' : 'expense';
  const isIncome = kind === 'income';
  const paidLabel = isIncome ? 'Paid into' : 'Paid from';
  // The wishlist item this expense buys ("Record purchase"), if it is still on the list.
  const fromWish = !editing && !isIncome
    ? state.wishlist.find(w => w.id === kept?.fromWish && (w.status === 'open' || w.status === 'saving')) || null
    : null;
  // Money saved for the wish is what pays for it: the expense comes out of the wish's pot.
  const wishPot = fromWish ? wishPurchasePot(state, fromWish.id, today) : null;

  // A currency just added through "More currencies…" comes first, even while editing.
  const startCurrency = (kept && currencies.includes(todayDraft.currency) && todayDraft.currency)
    || editing?.currency
    || (currencies.includes(todayDraft.currency) && todayDraft.currency)
    || state.settings.reportingCurrency;
  const rememberedAccount = accounts.some(a => a.id === todayDraft.account) || todayDraft.account === ''
    ? todayDraft.account : null;
  const startAccount = kept ? kept.account
    : editing ? editing.account
    : rememberedAccount
      ?? (accounts.some(a => a.id === state.settings.defaultAccount) ? state.settings.defaultAccount : null)
      ?? accounts.find(a => a.type === 'current' && a.currency === 'GBP')?.id
      ?? '';

  // Fields
  const amount = el('input', {
    id: 'entry-amount', class: 'amount-input', type: 'text', inputMode: 'decimal',
    autocomplete: 'off', placeholder: '0.00',
    value: kept ? kept.amount : editing ? plainAmount(editing.friend ? editing.sharedTotal ?? editing.minor : editing.minor, editing.precision) : '',
    oninput: () => syncSplit()
  });
  const amountLabel = el('label', { for: 'entry-amount', text: 'Amount' });
  const dateInput = el('input', {
    id: 'entry-date', type: 'date', 'aria-label': 'Date', value: kept?.date || editing?.date || today
  });
  const note = el('input', { id: 'entry-note', type: 'text', maxLength: 500, value: kept ? kept.note : editing?.note || '' });
  const caret = () => el('span', { class: 'caret', 'aria-hidden': 'true', text: '▾' });

  // --- Currency: a compact button that opens the list of active currencies.
  let currentCurrency = startCurrency;
  let currencyPopover = null;
  const currencyButton = el('button', {
    type: 'button', id: 'entry-currency', class: 'cur-button',
    'aria-haspopup': 'listbox', 'aria-expanded': 'false',
    onclick: () => (currencyPopover ? closePopover() : openCurrencyList()),
    onkeydown: event => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      if (!currencyPopover) openCurrencyList();
    }
  });
  function showCurrency() {
    currencyButton.replaceChildren(el('span', { text: currentCurrency }), caret());
    currencyButton.setAttribute('aria-label', `Currency: ${currentCurrency}`);
  }
  showCurrency();

  /** The active currencies in the user's order, then the way to switch on another. */
  function openCurrencyList() {
    const choose = code => {
      if (code === MORE_CURRENCIES) return openCurrencySearch();
      currentCurrency = code;
      showCurrency();
      closePopover();
      syncSplit();
    };
    const option = (code, main, detail) => el('li', {
      role: 'option', tabIndex: -1, class: 'pop-option',
      'aria-selected': String(code === currentCurrency), 'data-value': code,
      onclick: () => choose(code)
    }, el('strong', { text: main }), detail && el('span', { class: 'pop-option-detail', text: detail }));

    const list = el('ul', { class: 'pop-list', role: 'listbox', 'aria-label': 'Currency' },
      currencies.map(code => option(code, code, currencyName(code))),
      option(MORE_CURRENCIES, 'More currencies…'));
    const items = [...list.children];

    list.addEventListener('keydown', event => {
      const at = items.indexOf(document.activeElement);
      let to = -1;
      if (event.key === 'ArrowDown') to = (at + 1) % items.length;
      else if (event.key === 'ArrowUp') to = (at - 1 + items.length) % items.length;
      else if (event.key === 'Home') to = 0;
      else if (event.key === 'End') to = items.length - 1;
      else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (at >= 0) choose(items[at].dataset.value);
        return;
      } else if (/^[a-z]$/i.test(event.key)) {
        // Typing a letter jumps to the next code that starts with it.
        const letter = event.key.toUpperCase();
        const order = [...items.slice(at + 1), ...items.slice(0, at + 1)];
        to = items.indexOf(order.find(item => item.dataset.value.startsWith(letter)));
      }
      if (to < 0) return;
      event.preventDefault();
      items[to].focus();
    });

    currencyPopover = openPopover({
      anchor: currencyButton, content: list, label: 'Currency',
      onClose: () => { currencyPopover = null; }
    });
    (items.find(item => item.dataset.value === currentCurrency) || items[0]).focus();
  }

  /** "More currencies…": search the full list and switch the chosen one on. */
  function openCurrencySearch() {
    const search = buildCurrencySearch({
      exclude: ledger.state.settings.activeCurrencies,
      onCancel: () => closePopover(),
      onPick: async code => {
        // Saving redraws the screen, so carry what was typed across it.
        const previousCurrency = todayDraft.currency;
        todayDraft.kept = keepForm();
        todayDraft.currency = code;
        closePopover({ restoreFocus: false });
        try {
          await addActiveCurrency(code);
          showToast(`${code} added to your currencies.`);
          document.getElementById('entry-amount')?.focus();
        } catch (error) {
          todayDraft.kept = null;
          todayDraft.currency = previousCurrency;
          showToast(errorMessage(error));
        }
      }
    });
    currencyPopover = openPopover({
      anchor: currencyButton, content: search, label: 'More currencies', role: 'dialog',
      onClose: () => { currencyPopover = null; }
    });
    search.querySelector('input')?.focus();
  }

  // --- Paid from (or Paid into, for income): one button that opens the account picker.
  // The account and the entry currency are independent: choosing one never changes the other.
  let accountPopover = null;
  const accountPicker = createAccountPicker({
    getState: () => ledger.state,
    getAccounts: current => current.accounts.filter(a => !a.archived || a.id === editing?.account),
    value: startAccount,
    currency: '', // the "All" tab
    today,
    onChange: () => { showAccount(); closePopover(); syncSettledField(); }
  });
  const selectedAccount = () => state.accounts.find(a => a.id === accountPicker.getValue());
  /** The account this entry moves money on: none when a friend paid the bill. */
  const payingAccount = () => (theyPaid() ? undefined : selectedAccount());
  const accountButton = el('button', {
    type: 'button', id: 'entry-account', class: 'paid-button',
    'aria-haspopup': 'dialog', 'aria-expanded': 'false',
    onclick: () => {
      if (accountPopover) return closePopover();
      accountPopover = openPopover({
        anchor: accountButton, content: accountPicker.element, label: paidLabel, role: 'dialog', wide: true,
        onClose: () => { accountPopover = null; }
      });
      (accountPicker.element.querySelector('[data-acct][aria-pressed="true"]')
        || accountPicker.element.querySelector('button'))?.focus();
    }
  });
  function showAccount() {
    const account = selectedAccount();
    accountButton.replaceChildren(...[
      account && accountIconNode(account),
      el('span', { class: 'paid-name', text: account ? account.name : 'No account' }),
      account && el('span', { class: 'paid-currency', text: account.currency }),
      caret()
    ].filter(Boolean));
  }
  showAccount();

  // --- Charged to account: only shown when the account's currency differs from the entry's.
  // 'auto'   a live estimate from the default rates, recalculated as the form changes
  // 'saved'  an estimate stored with the entry being edited; left alone until changed
  // 'manual' typed by the user
  let settledState = kept ? kept.settledState
    : editing?.settledMinor != null && editing.settledEstimate ? 'saved' : 'manual';
  let settledFor = null; // account currency the field holds; null until first shown
  const settled = el('input', {
    id: 'entry-settled', type: 'text', inputMode: 'decimal', autocomplete: 'off',
    value: kept ? kept.settled : editing?.settledMinor != null ? plainAmount(editing.settledMinor, editing.settledPrecision) : '',
    oninput: () => { settledState = 'manual'; estimateTag.hidden = true; }
  });
  const settledLabelText = el('span');
  const estimateTag = el('span', { class: 'tag-estimate', text: 'estimate', hidden: true });
  const settledField = el('div', { class: 'field', hidden: true },
    el('label', { for: 'entry-settled' }, settledLabelText, ' ', estimateTag),
    settled,
    el('p', { class: 'hint', text: isIncome
      ? 'What the account received in its own currency. An estimate is fine; you can correct it later.'
      : 'What the account was charged in its own currency. An estimate is fine; you can correct it later.' }));

  /** The estimate as text for the field, or '' without an amount or a rate. */
  function estimateSettled(account) {
    try {
      const { reportingCurrency, defaultRates } = ledger.state.settings;
      const minor = parseAmount(amount.value, currentCurrency);
      const estimate = estimateAccountAmount(minor,
        { currency: currentCurrency, precision: digits(currentCurrency) }, account, reportingCurrency, defaultRates);
      return estimate == null ? '' : plainAmount(estimate, account.precision);
    } catch {
      return ''; // no amount typed yet
    }
  }

  // --- Spending target: shown when the paying account has one that covers the entry date.
  const capToggle = el('input', {
    id: 'entry-cap', type: 'checkbox',
    checked: kept?.eligible ?? (editing ? editing.eligible === true : true)
  });
  const capLabelText = el('span');
  const capField = el('div', { class: 'field cap-field', hidden: true }, el('label', { class: 'check-row' }, capToggle, capLabelText));
  /** The targets this entry can count towards: an expense, on that account, on that date. */
  const entryCaps = () => (isIncome ? [] : activeCaps(ledger.state, payingAccount()?.id, dateInput.value));
  function syncCapField() {
    const caps = entryCaps();
    capField.hidden = !caps.length;
    capLabelText.textContent = `Counts towards ${caps.map(c => c.name).join(' and ')}`;
  }
  dateInput.addEventListener('change', syncCapField);

  function syncSettledField() {
    syncCapField();
    const account = payingAccount();
    const needed = !!account && account.currency !== currentCurrency;
    settledField.hidden = !needed;
    if (!needed) {
      settled.value = '';
      settledState = 'manual';
      settledFor = '';
      return;
    }
    settledLabelText.textContent = `${isIncome ? 'Received in account' : 'Charged to account'} (${account.currency})`;
    if (settledFor !== null && settledFor !== account.currency) {
      settled.value = ''; // it was an amount in another currency
      settledState = 'manual';
    }
    settledFor = account.currency;
    if (settledState === 'auto' || !settled.value.trim()) {
      settled.value = estimateSettled(account);
      settledState = settled.value ? 'auto' : 'manual';
    }
    estimateTag.hidden = settledState === 'manual';
  }

  // --- Split with a friend (expenses only). When on, Amount is the whole bill and
  // "My share" is what counts as my spending; the rest is owed one way or the other.
  const editingFriendPaid = Boolean(editing?.friend) && (editing.paidBy === 'friend' || editing.friendDelta < 0);
  const splitStart = kept?.split || (editing?.friend
    ? { on: true, friend: editing.friend, paidBy: editingFriendPaid ? 'friend' : 'me', share: plainAmount(editing.personalMinor, editing.precision), shareTouched: true, newName: '' }
    : { on: false, friend: state.friends[0]?.id || NEW_FRIEND, paidBy: 'me', share: '', shareTouched: false, newName: '' });
  let shareTouched = splitStart.shareTouched;
  const splitToggle = el('input', { id: 'entry-split', type: 'checkbox', checked: splitStart.on, onchange: () => syncSplit() });
  const friendSelect = el('select', { id: 'entry-friend', onchange: () => syncSplit() },
    state.friends.map(f => el('option', { value: f.id, text: f.name })),
    el('option', { value: NEW_FRIEND, text: 'New friend…' }));
  friendSelect.value = state.friends.some(f => f.id === splitStart.friend) ? splitStart.friend : NEW_FRIEND;
  const newFriendName = el('input', { id: 'entry-friend-name', type: 'text', maxLength: 150, autocomplete: 'off', value: splitStart.newName });
  const newFriendField = el('div', { class: 'field' }, el('label', { for: 'entry-friend-name', text: 'Friend’s name' }), newFriendName);
  const paidBySelect = el('select', { id: 'entry-paid-by', onchange: () => syncSplit() },
    el('option', { value: 'me', text: 'I paid' }), el('option', { value: 'friend', text: 'They paid' }));
  paidBySelect.value = splitStart.paidBy;
  const shareInput = el('input', {
    id: 'entry-share', type: 'text', inputMode: 'decimal', autocomplete: 'off', value: splitStart.share,
    oninput: () => { shareTouched = true; syncSplit(); }
  });
  const splitHint = el('p', { class: 'hint', role: 'status' });
  const splitBody = el('div', { class: 'fold-body split-body' },
    el('div', { class: 'field' }, el('label', { for: 'entry-friend', text: 'Friend' }), friendSelect),
    newFriendField,
    el('div', { class: 'field' }, el('label', { for: 'entry-paid-by', text: 'Who paid?' }), paidBySelect),
    el('div', { class: 'field' }, el('label', { for: 'entry-share', text: 'My share' }), shareInput, splitHint));
  const splitField = !isIncome && el('div', { class: 'field split-field' },
    el('label', { class: 'check-row' }, splitToggle, el('span', { text: 'Split with a friend' })),
    splitBody);
  const accountField = el('div', { class: 'field' }, el('label', { for: 'entry-account', text: paidLabel }), accountButton);
  const splitOn = () => !isIncome && splitToggle.checked;
  function theyPaid() { return splitOn() && paidBySelect.value === 'friend'; }

  function syncSplit() {
    const on = splitOn();
    splitBody.hidden = !on;
    newFriendField.hidden = friendSelect.value !== NEW_FRIEND;
    amountLabel.textContent = on ? 'Total amount' : 'Amount';
    accountField.hidden = theyPaid();
    if (on) {
      let total = null, own = null;
      try { total = parseAmount(amount.value, currentCurrency); } catch { /* amount not complete yet */ }
      // Until the share is typed, it is half of the bill.
      if (!shareTouched) shareInput.value = total == null ? '' : plainAmount(Math.floor(total / 2), digits(currentCurrency));
      try { own = shareAmount(shareInput.value, currentCurrency); } catch { /* share not complete yet */ }
      const money = minor => formatMoney(minor, currentCurrency, digits(currentCurrency));
      splitHint.textContent = total == null || own == null ? ''
        : own > total ? 'Your share is more than the total.'
        : theyPaid() ? `You owe them ${money(own)}`
        : `They owe you ${money(total - own)}`;
    }
    syncSettledField();
  }
  syncSplit();

  const picker = createCategoryPicker({
    getState: () => ledger.state,
    kind,
    value: kept?.category || editing?.category || (isIncome ? '' : state.settings.defaultCategory || ''),
    onChange: () => syncTripField()
  });

  // --- Trip: only for a Travel category. Until the user chooses, it follows the date.
  let tripChosen = kept ? Boolean(kept.tripChosen) : Boolean(editing);
  const tripSelect = el('select', { id: 'entry-trip', onchange: () => { tripChosen = true; } });
  const tripField = el('div', { class: 'field' },
    el('label', { for: 'entry-trip', text: 'Trip' }), tripSelect,
    el('a', { class: 'btn-text', href: '#trips', text: 'Add or edit trips' }));
  function syncTripField() {
    const current = ledger.state;
    const travel = !isIncome && isTravelCategory(current, picker.getValue());
    const wanted = tripChosen ? tripSelect.value : travel ? tripForDate(current, dateInput.value)?.id || '' : '';
    const trips = current.trips.filter(t => !t.archived || t.id === editing?.trip || t.id === wanted);
    tripSelect.replaceChildren(el('option', { value: '', text: 'No trip' }), ...trips.map(t => el('option', { value: t.id, text: t.name })));
    tripSelect.value = trips.some(t => t.id === wanted) ? wanted : '';
    // An entry that already has a trip keeps showing it, whatever its category.
    tripField.hidden = isIncome || !(travel || tripSelect.value);
  }
  tripSelect.append(el('option', { value: '', text: 'No trip' }),
    ...state.trips.map(t => el('option', { value: t.id, text: t.name })));
  tripSelect.value = kept ? kept.trip || '' : editing?.trip || '';
  dateInput.addEventListener('change', syncTripField);
  syncTripField();

  /** What is typed so far, to carry across a redraw of the form. */
  function keepForm() {
    return {
      amount: amount.value, note: note.value, date: dateInput.value,
      settled: settled.value, settledState, eligible: capToggle.checked,
      category: picker.getValue(), account: accountPicker.getValue(),
      trip: tripSelect.value, tripChosen,
      fromWish: fromWish?.id || '',
      split: {
        on: splitToggle.checked, friend: friendSelect.value, paidBy: paidBySelect.value,
        share: shareInput.value, shareTouched, newName: newFriendName.value
      }
    };
  }

  // --- Expense | Income | Transfer. What is typed is carried across the redraw.
  const kindSwitch = !editing && buildKindSwitch(kind, () => {
    todayDraft.kept = { ...keepForm(), category: '' }; // a category belongs to one kind
    todayDraft.currency = currentCurrency;
  });

  // --- Quick add: saved templates as chips. Tapping one fills the form and
  // redraws it; nothing is saved until Save, so every check still runs.
  const templates = !editing && !isIncome ? activeTemplates(state) : [];
  function useTemplate(template) {
    const fill = templatePrefill(ledger.state, template);
    // A currency no longer active: the form uses the usual one, so its amount would mean something else.
    if (!ledger.state.settings.activeCurrencies.includes(fill.currency)) fill.amount = '';
    todayDraft.kept = {
      ...keepForm(), date: today, amount: fill.amount, note: fill.note, category: fill.category,
      settled: '', settledState: 'auto', // re-estimated for the new amount and currency
      ...(fill.account === null ? {} : { account: fill.account })
    };
    todayDraft.currency = fill.currency;
    closePopover({ restoreFocus: false });
    rerenderToday();
    // Asked each time: go to the amount. Fixed: Save is the only step left.
    const target = fill.amount
      ? document.querySelector('.entry-form button[type="submit"]')
      : document.getElementById('entry-amount');
    target?.focus();
  }
  const quickAdd = templates.length > 0 && el('div', { class: 'quick-add', role: 'group', 'aria-label': 'Quick add' },
    el('span', { class: 'field-label quick-add-label', text: 'Quick add' }),
    el('div', { class: 'quick-add-row' },
      templates.map(template => {
        const fixed = templateAmountLabel(template);
        return el('button', { type: 'button', class: 'quick-chip', onclick: () => useTemplate(template) },
          el('span', { text: template.name }),
          fixed && el('span', { class: 'quick-chip-amount', text: fixed }));
      }),
      el('a', { class: 'quick-chip quick-chip-edit', href: '#settings/quick-add', text: 'Edit', 'aria-label': 'Edit quick add templates' })));

  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });
  const saveButton = el('button', { type: 'submit', class: 'btn-primary', text: editing ? 'Save changes' : isIncome ? 'Save income' : 'Save expense' });

  /**
   * Read a bill split with a friend. Returns the record and the state to save it into
   * (which already holds a friend added in the form).
   */
  function readSharedForm(total, category) {
    let base = ledger.state;
    let friendId = friendSelect.value;
    if (friendId === NEW_FRIEND) {
      friendId = uid();
      base = saveFriend(base, { id: friendId, name: newFriendName.value });
    }
    if (!shareInput.value.trim()) throw Error('Enter your share of the bill.');
    const account = payingAccount();
    const foreign = account && account.currency !== currentCurrency;
    if (foreign && !settled.value.trim()) {
      throw Error(`Enter what ${account.name} was charged in ${account.currency} (an estimate is fine), or choose "No account".`);
    }
    const record = sharedExpenseRecord(base, {
      id: editing?.id || '', friend: friendId, paidBy: paidBySelect.value,
      totalMinor: total, ownMinor: shareAmount(shareInput.value, currentCurrency),
      currency: currentCurrency, category: category.id, account: accountPicker.getValue(),
      date: dateInput.value, note: note.value, trip: tripField.hidden ? '' : tripSelect.value, today,
      ...(foreign ? { settledMinor: parseAmount(settled.value, account.currency), settledEstimate: settledState !== 'manual' } : {})
    });
    return { record, base };
  }

  /** Read the form into an entry record. Throws a readable error if something is missing. */
  function readForm() {
    const currencyCode = currentCurrency;
    if (!amount.value.trim()) throw Error('Enter an amount.');
    const minor = parseAmount(amount.value, currencyCode);
    if (!dateInput.value) throw Error('Choose a date.');
    const category = ledger.state.categories.find(c => c.id === picker.getValue());
    if (!category) throw Error('Choose a category.');
    if (splitOn()) return readSharedForm(minor, category);

    const record = {
      tags: '', trip: '',
      ...(editing || {}),
      id: editing?.id || uid(),
      kind,
      ledger: 'active',
      status: dateInput.value > today ? 'planned' : editing?.status || 'posted',
      date: dateInput.value,
      minor,
      currency: currencyCode,
      precision: digits(currencyCode),
      category: category.id,
      // Income is shared out between pots by the payday flow. An expense being edited keeps the pot
      // it was charged to (a wish's savings pot, say) unless its category changes.
      pot: isIncome ? '' : editing && editing.kind === kind && editing.category === category.id ? editing.pot || '' : category.pot || '',
      account: accountPicker.getValue(),
      note: note.value.trim(),
      trip: tripField.hidden ? '' : tripSelect.value
    };

    // The amount in the account's own currency, when it differs. The ledger
    // needs it to keep that account's balance, so an estimate is asked for.
    const account = selectedAccount();
    delete record.settledMinor; delete record.settledCurrency; delete record.settledPrecision;
    delete record.settledEstimate;
    if (account && account.currency !== currencyCode) {
      if (!settled.value.trim()) {
        throw Error(`Enter what ${account.name} ${isIncome ? 'received' : 'was charged'} in ${account.currency} (an estimate is fine), or choose "No account".`);
      }
      record.settledMinor = parseAmount(settled.value, account.currency);
      record.settledCurrency = account.currency;
      record.settledPrecision = account.precision;
      if (settledState !== 'manual') record.settledEstimate = true; // to be confirmed later
    }

    // A changed amount makes an older reporting-currency value stale. So does a changed
    // charge, when that charge was the value.
    const chargeWasValue = editing?.reportingMinor != null && editing.settledCurrency === editing.reportingCurrency
      && editing.settledMinor === editing.reportingMinor && record.settledMinor !== editing.settledMinor;
    if (editing && (editing.minor !== minor || editing.currency !== currencyCode || chargeWasValue)) {
      delete record.reportingMinor; delete record.reportingCurrency; delete record.reportingPrecision;
    }
    // The split was switched off: it is an ordinary expense again.
    if (editing?.friend) {
      if (ledger.state.entries.some(r => r.kind === 'refund' && r.original === editing.id)) {
        throw Error('This shared bill has refunds. Delete them before removing the split.');
      }
      for (const key of ['friend', 'friendDelta', 'personalMinor', 'sharedTotal', 'paidBy']) delete record[key];
      if (record.tags === 'shared') record.tags = '';
    }
    return { record, base: ledger.state };
  }

  let saving = false;
  async function submit(event) {
    event.preventDefault();
    if (saving) return;
    const previousEditing = todayDraft.editingId;
    try {
      const read = readForm();
      const base = read.base;
      // Counts towards a spending target only while one covers this account and date.
      const caps = entryCaps();
      const marked = { ...read.record };
      if (caps.length) marked.eligible = capToggle.checked; else delete marked.eligible;
      // The reporting-currency value, when what the account was charged or a rate saved for the date gives one.
      const record = withReportingValue(base, marked);
      if (wishPot && record.kind === 'expense' && !record.splits && record.currency === wishPot.currency) record.pot = wishPot.id;
      let next = commit(base, 'entries', record);

      // Would this expense take its pot below zero? Ask first; nothing moves unless the user chooses it.
      // Income never takes a pot down, so it is not checked.
      let moved = null;
      const warning = record.kind === 'expense' && record.status === 'posted'
        ? negativePotCheck(ledger.state, next, record.pot, today) : null;
      if (warning) {
        const answer = await askNegativePot(saveButton, warning, next, record.date);
        if (!answer) return; // closed without choosing: nothing saved, the form is kept
        next = answer.state;
        moved = answer.moved;
      }
      // Bought from the wishlist: the wish is closed (or its next restock set) in the same save.
      // A planned expense has not happened yet, so the wish stays as it is.
      let bought = null;
      if (fromWish && record.kind === 'expense' && record.status === 'posted') {
        bought = purchasedWish(next, fromWish.id, record.date);
        if (bought) next = commit(next, 'wishlist', bought);
      }
      saving = true;
      saveButton.disabled = true;
      todayDraft.currency = record.currency;
      if (record.paidBy !== 'friend') todayDraft.account = record.account;
      todayDraft.editingId = '';
      todayDraft.kind = 'expense'; // the form goes back to the common case
      const sharesOut = opensPaydayFlow(next, record);
      const capNews = caps.map(cap => capCrossingText(ledger.state, next, cap)).filter(Boolean).join(' ');
      await saveLedger(next); // re-renders the screen with an empty form
      if (sharesOut) {
        // A salary: open the payday preview for it straight away. Closing it changes nothing;
        // the salary stays listed under Pots → Distribute salary.
        showToast('Salary saved. Share it out now, or later from Pots.');
        const anchor = document.querySelector('.entry-form button[type="submit"]');
        if (anchor) openPaydayPreview(anchor, record);
        return;
      }
      showToast((bought && !moved && !warning && !record.friend
        ? (bought.status === 'purchased'
          ? `Saved. ${bought.name} is off the wishlist.`
          : `Saved. Next restock of ${bought.name}: ${formatDay(bought.nextRestock)}.`)
        : record.status === 'planned'
        ? `Saved as planned for ${formatDay(record.date)}.${fromWish ? ` ${fromWish.name} stays on the wishlist until it is bought.` : ''}`
        : moved ? `Saved. Moved ${formatMoney(moved.minor, moved.pot.currency, moved.pot.precision)} from ${moved.from} to ${moved.pot.name}.`
        : warning ? `Saved. ${warning.pot.name} is below zero until you cover it.`
        : record.friend ? `Saved. ${sharedSavedText(next, record)}`
        : capNews ? 'Saved.'
        : 'Saved on this device.') + (capNews ? ` ${capNews}` : ''));
    } catch (error) {
      // Keep everything the user typed.
      todayDraft.editingId = previousEditing;
      todayDraft.kind = kind;
      saving = false;
      saveButton.disabled = false;
      errorBox.textContent = errorMessage(error);
      errorBox.hidden = false;
    }
  }

  return el('form', { class: 'entry-form', onsubmit: submit, novalidate: true },
    kindSwitch,
    sectionTitle(editing ? (isIncome ? 'Edit income' : 'Edit expense') : isIncome ? 'Add income' : 'Add an expense'),
    quickAdd,
    fromWish && el('p', { class: 'note wl-buying' },
      el('span', { text: `Buying “${fromWish.name}” from your wishlist. Choose a category; saving closes the wish.${wishPot ? ` Paid from the ${wishPot.name} pot.` : ''}` }),
      el('button', {
        type: 'button', class: 'btn-text', text: 'Not this',
        onclick: () => {
          todayDraft.kept = { ...keepForm(), fromWish: '' };
          todayDraft.currency = currentCurrency;
          rerenderToday();
        }
      })),
    el('div', { class: 'field' },
      amountLabel,
      el('div', { class: 'amount-row' }, amount)),
    el('div', { class: 'entry-meta-row' }, currencyButton, dateInput),
    el('div', { class: 'field' }, el('span', { class: 'field-label', text: 'Category' }), picker.element),
    splitField,
    tripField,
    accountField,
    !accounts.length && el('p', { class: 'hint', text: 'No accounts yet. You can add one in Settings, or save without one.' }),
    settledField,
    capField,
    el('div', { class: 'field' }, el('label', { for: 'entry-note', text: 'Note (optional)' }), note),
    errorBox,
    el('div', { class: 'form-actions' },
      saveButton,
      editing && el('button', {
        type: 'button', class: 'btn-secondary', text: 'Cancel',
        onclick: () => { todayDraft.editingId = ''; rerenderToday(); }
      })));
}

/** "Ana owes you £48.00." after saving a shared bill: the balance in that bill's currency. */
function sharedSavedText(state, record) {
  const row = allBalances(state).find(item => item.friend.id === record.friend);
  if (!row) return 'Saved on this device.';
  const balance = row.balances.find(b => b.currency === record.currency) || { minor: 0n };
  return balancePhrase(row.friend.name, balance) + '.';
}

/** Redraw this screen without saving anything. */
function rerenderToday() {
  const root = document.getElementById('screen');
  root.replaceChildren();
  renderToday(root);
}

// ---------------------------------------------------------------------------
// Recent entries
// ---------------------------------------------------------------------------

/** Refunds recorded against a purchase, oldest first. */
function refundsOf(state, entry) {
  return state.entries
    .filter(r => r.kind === 'refund' && r.original === entry.id && r.status !== 'cancelled')
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The signed amount an entry contributes to "what I spent", in its own
 * currency. Expenses are your share minus refunds; transfers are neutral.
 */
function netAmount(state, entry) {
  if (entry.kind === 'expense') {
    const refunded = refundsOf(state, entry).reduce((sum, r) => sum + BigInt(r.personalMinor ?? r.minor), 0n);
    return -(personalAmount(entry) - refunded);
  }
  if (entry.kind === 'income') return BigInt(entry.minor);
  if (entry.kind === 'transfer') return 0n;
  return entry.direction === 'increase' ? BigInt(entry.minor) : -BigInt(entry.minor);
}

/** One compact line per friend with money outstanding, each a link to that friend. Nothing when all is settled. */
function buildOwedLines(state) {
  const owing = allBalances(state).filter(row => row.balances.length);
  if (!owing.length) return null;
  return el('ul', { class: 'plain-list owed-lines', 'aria-label': 'Shared bills' },
    owing.map(({ friend, balances }) => el('li', {},
      el('a', { class: 'owed-line', href: `#people/${encodeURIComponent(friend.id)}`, 'data-focus': `owed:${friend.id}` },
        el('span', { text: balances.map(b => balancePhrase(friend.name, b)).join(' · ') }),
        el('span', { class: 'tv-arrow', 'aria-hidden': 'true', text: '→' })))));
}

function buildRecentList(state, today) {
  // Recurring payments waiting for a yes or no come first.
  const wrap = el('div', { class: 'recent' }, buildReconcileReminders(state, today), buildDueToConfirm(state, today), buildOwedLines(state), sectionTitle('Today and recent'));

  // Newest first. Refunds are folded into their purchase, not listed alone.
  const rows = state.entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.ledger === 'active' && entry.status !== 'cancelled'
      && entry.kind !== 'refund' && !entry.feeOnReceived && entry.date <= today)
    .sort((a, b) => b.entry.date.localeCompare(a.entry.date) || b.index - a.index)
    .slice(0, RECENT_LIMIT)
    .map(row => row.entry);

  if (!rows.some(entry => entry.date === today)) {
    wrap.append(el('p', { class: 'empty', text: 'Nothing recorded today yet. Entries you save will appear here.' }));
  }

  const dates = [...new Set(rows.map(entry => entry.date))];
  for (const date of dates) {
    const dayRows = rows.filter(entry => entry.date === date);

    // Net spending per currency for the day. Currencies are never added together.
    const totals = new Map();
    // A fee taken from a transfer is spending too, though it is listed inside its transfer.
    const spending = dayRows.flatMap(e => e.kind === 'transfer' ? [transferParts(state, e).fee].filter(Boolean) : [e]);
    for (const entry of spending.filter(e => e.kind === 'expense')) {
      const key = `${entry.currency}:${entry.precision}`;
      totals.set(key, (totals.get(key) || 0n) + netAmount(state, entry));
    }
    const totalText = [...totals].map(([key, sum]) => {
      const [code, precision] = key.split(':');
      return formatMoney(sum, code, Number(precision));
    }).join(' · ');

    wrap.append(el('div', { class: 'day-group' },
      el('div', { class: 'day-head' },
        el('span', { text: date === today ? `Today · ${formatDay(date)}` : formatDay(date) }),
        el('span', { class: 'day-total', text: totalText })),
      dayRows.map(entry => entryRow(state, entry))));
  }

  wrap.append(el('p', { class: 'hint' }, el('a', { href: '#people', text: 'People and shared bills' })));
  if (rows.length === RECENT_LIMIT) {
    wrap.append(el('p', { class: 'hint' }, 'Showing the latest 40. Older entries are in the ',
      el('a', { href: LEGACY_URL, text: 'previous version' }), '.'));
  }
  return wrap;
}

function entryRow(state, entry) {
  const nameOf = (table, id) => state[table].find(r => r.id === id)?.name || '';
  const category = state.categories.find(c => c.id === entry.category);
  const parent = category && state.categories.find(c => c.id === category.parent);

  const title = entry.kind === 'transfer'
    ? `${nameOf('accounts', entry.account)} → ${nameOf('accounts', entry.toAccount)}`
    : category?.name || entry.kind;
  const receivedFee = entry.kind === 'transfer' ? transferParts(state, entry).fee : null;
  const meta = [
    parent?.name,
    entry.kind === 'transfer' ? 'Transfer' : nameOf('accounts', entry.account),
    receivedFee && `fee ${formatMoney(receivedFee.minor, receivedFee.currency, receivedFee.precision)}`,
    entry.status === 'planned' && 'Planned',
    entry.note
  ].filter(Boolean).join(' · ');

  const net = netAmount(state, entry);
  const shown = entry.kind === 'transfer' ? BigInt(entry.minor) : net;
  const amountClass = 'entry-amount' + (net > 0n ? ' is-income' : '');

  return el('details', { class: 'entry' },
    el('summary', { class: 'entry-summary' },
      el('span', { class: 'entry-text' },
        el('span', { class: 'entry-title', text: title }),
        meta && el('span', { class: 'entry-meta', text: meta })),
      el('span', { class: amountClass, text: formatMoney(shown, entry.currency, entry.precision, { signed: entry.kind !== 'transfer' }) })),
    entryDetail(state, entry, net));
}

/** The unfolded part: dated components, where it went, and actions. */
function entryDetail(state, entry, net) {
  const line = (label, value) => el('div', { class: 'detail-line' },
    el('span', { text: label }), el('span', { class: 'detail-value', text: value }));
  const money = (minor, signed = true) => formatMoney(minor, entry.currency, entry.precision, { signed });
  const lines = [];

  if (entry.kind === 'expense') {
    const refunds = refundsOf(state, entry);
    const friend = entry.friend && (state.friends.find(f => f.id === entry.friend)?.name || 'Friend');
    const friendPaid = Boolean(entry.friend) && (entry.paidBy === 'friend' || entry.friendDelta < 0);
    lines.push(friendPaid
      ? line(`${formatDay(entry.date)} · ${friend} paid`, money(-BigInt(entry.sharedTotal ?? entry.minor)))
      : line(`${formatDay(entry.date)} · Paid`, money(-BigInt(entry.minor))));
    if (entry.friend) {
      lines.push(line(friendPaid ? `Your share (you owe ${friend})` : `Your share (${friend} covers the rest)`, money(-personalAmount(entry))));
    }
    const refundable = canRefundHere(state, entry);
    for (const refund of refunds) {
      const label = `${formatDay(refund.date)} · Refund`;
      const value = money(BigInt(refund.personalMinor ?? refund.minor));
      // Refunds recorded here can be changed here: the label carries an Edit button.
      lines.push(refundable
        ? el('div', { class: 'detail-line' },
            el('span', {}, label + ' ', el('button', {
              type: 'button', class: 'btn-text', text: 'Edit', 'aria-label': `Edit refund of ${value}`,
              onclick: event => openRefundSheet(event.currentTarget, entry, refund)
            })),
            el('span', { class: 'detail-value', text: value }))
        : line(label, value));
    }
    if (refunds.length || entry.friend) lines.push(line('Net', money(net)));
    if (entry.splits) lines.push(line('Split', `${entry.splits.length} parts`));
  } else if (entry.kind === 'transfer') {
    // Sent in the from-account's currency; received, fee and arrived in the to-account's.
    const destination = state.accounts.find(a => a.id === entry.toAccount);
    const arrived = minor => formatMoney(minor, destination?.currency || entry.currency, destination?.precision ?? entry.precision);
    const { fee, receivedNet } = transferParts(state, entry);
    lines.push(line(`${formatDay(entry.date)} · Sent`, money(BigInt(entry.minor), false)));
    lines.push(line('Received', arrived(BigInt(entry.receivedMinor))));
    if (fee) {
      lines.push(line('Fee', arrived(BigInt(fee.minor))));
      lines.push(line('Arrived', arrived(receivedNet)));
    }
  } else {
    lines.push(line(formatDay(entry.date), money(net)));
  }

  if (entry.settledMinor != null && entry.settledCurrency !== entry.currency) {
    lines.push(line(entry.settledEstimate ? 'Charged to account (estimate)' : 'Charged to account', formatMoney(entry.settledMinor, entry.settledCurrency, entry.settledPrecision)));
  }
  const pot = state.pots.find(p => p.id === entry.pot);
  if (pot) lines.push(line('Pot', pot.name));

  // Plain expenses, incomes not yet shared out between pots, and transfers can be edited here.
  // Other kinds keep their own forms in the previous version.
  const simple = (entry.kind === 'expense' && !entry.splits && !entry.id.startsWith('forgiven:'))
    || (entry.kind === 'income' && !entry.friend && !state.allocations.some(a => a.salary === entry.id))
    || (entry.kind === 'transfer' && !hasSourceFee(state, entry));
  const firstField = entry.kind === 'transfer' ? 'transfer-amount' : 'entry-amount';
  const actions = el('div', { class: 'entry-actions' },
    simple
      ? el('button', {
          type: 'button', class: 'btn-text', text: 'Edit',
          onclick: () => { todayDraft.editingId = entry.id; rerenderToday(); document.getElementById(firstField)?.focus(); }
        })
      : entry.friend || entry.kind === 'settlement' || entry.id.startsWith('forgiven:')
        ? el('a', { class: 'btn-text', href: '#people', text: 'See under People' })
        : el('a', { class: 'btn-text', href: LEGACY_URL, text: 'Edit in previous version' }),
    entry.kind === 'expense' && canRefundHere(state, entry)
      && (entry.friend ? sharedRefundLeft(state, entry).own > 0n || sharedRefundLeft(state, entry).theirs > 0n : refundedSoFar(state, entry) < BigInt(entry.minor))
      && el('button', { type: 'button', class: 'btn-text', text: 'Add refund', onclick: event => openRefundSheet(event.currentTarget, entry) }),
    deleteButton(entry));

  return el('div', { class: 'entry-detail' }, lines, actions);
}

/**
 * The refund sheet for a purchase: a new refund, or `refund` to change or delete.
 * The rules (how much is left, which dates are allowed) live in refund-logic.js.
 */
function openRefundSheet(anchor, purchase, refund = null) {
  if (purchase.friend) return openSharedRefundSheet(anchor, purchase, refund);
  const state = ledger.state;
  const today = todayIso();
  const left = BigInt(purchase.minor) - refundedSoFar(state, purchase, refund?.id || '');
  const account = state.accounts.find(a => a.id === purchase.account);
  const foreign = purchase.settledMinor != null && Boolean(purchase.settledCurrency);
  const field = (id, label, control, hint) => el('div', { class: 'field' },
    el('label', { for: id, text: label }), control, hint && el('p', { class: 'hint', text: hint }));
  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });
  const showError = error => {
    errorBox.textContent = errorMessage(error);
    errorBox.hidden = false;
    if (!form.isConnected) showToast(errorMessage(error));
  };

  const amount = el('input', {
    id: 'refund-amount', type: 'text', inputMode: 'decimal', autocomplete: 'off',
    placeholder: `Up to ${formatMoney(left, purchase.currency, purchase.precision)}`,
    value: refund ? plainAmount(refund.minor, purchase.precision) : ''
  });
  const date = el('input', {
    id: 'refund-date', type: 'date', min: purchase.date, max: today, value: refund ? refund.date : today
  });
  const note = el('input', { id: 'refund-note', type: 'text', maxLength: 500, autocomplete: 'off', value: refund?.note || '' });

  // Paid in another currency: what the account got back. It follows the refund amount
  // as an estimate until the user types their own figure.
  let creditIsEstimate = !refund || refund.settledEstimate === true;
  const credited = foreign && el('input', {
    id: 'refund-credited', type: 'text', inputMode: 'decimal', autocomplete: 'off',
    value: refund?.settledMinor != null ? plainAmount(refund.settledMinor, purchase.settledPrecision) : '',
    oninput: () => { creditIsEstimate = false; }
  });
  const readAmount = () => parseAmount(amount.value, purchase.currency);
  if (foreign) {
    amount.addEventListener('input', () => {
      if (!creditIsEstimate) return;
      let suggestion = null;
      try { suggestion = suggestedSettled(purchase, readAmount()); } catch { /* amount not complete yet */ }
      credited.value = suggestion == null ? '' : plainAmount(suggestion, purchase.settledPrecision);
    });
  }

  let armed = false;
  const remove = refund && el('button', { type: 'button', class: 'btn-text', text: 'Delete refund' });
  if (remove) {
    remove.addEventListener('blur', () => { armed = false; remove.textContent = 'Delete refund'; remove.classList.remove('is-armed'); });
    remove.addEventListener('click', async () => {
      if (!armed) {
        armed = true;
        remove.textContent = 'Press again to delete';
        remove.classList.add('is-armed');
        return;
      }
      try {
        const next = deleteRefund(ledger.state, refund.id);
        closePopover({ restoreFocus: false });
        await saveLedger(next);
        showToast('Refund deleted.');
      } catch (error) {
        showError(error);
      }
    });
  }

  const form = el('form', {
    class: 'pot-sheet', novalidate: true,
    onsubmit: async event => {
      event.preventDefault();
      try {
        if (!amount.value.trim()) throw Error('Enter the refund amount.');
        const fields = { purchaseId: purchase.id, id: refund?.id || '', minor: readAmount(), date: date.value, note: note.value, today };
        if (foreign && credited.value.trim()) {
          fields.settledMinor = parseAmount(credited.value, purchase.settledCurrency);
          fields.settledEstimate = creditIsEstimate;
        }
        const next = saveRefund(ledger.state, fields);
        closePopover({ restoreFocus: false });
        await saveLedger(next);
        showToast('Refund saved.');
      } catch (error) {
        showError(error);
      }
    }
  },
    field('refund-amount', `Amount (${purchase.currency})`, amount),
    field('refund-date', 'Date', date),
    foreign && field('refund-credited', `Credited to ${account?.name || 'account'} (${purchase.settledCurrency})`, credited, 'Estimate from the original charge'),
    field('refund-note', 'Note (optional)', note),
    errorBox,
    el('div', { class: 'entry-actions' },
      el('button', { type: 'submit', class: 'btn-primary btn-small', text: 'Save refund' }),
      remove));

  openPopover({ anchor, label: refund ? 'Edit refund' : 'Refund', role: 'dialog', content: form });
}

/**
 * The refund sheet for a bill shared with a friend: what the shop gave back in all, and
 * my share of it. An existing shared refund is changed by deleting it and adding it again.
 */
function openSharedRefundSheet(anchor, purchase, refund = null) {
  const state = ledger.state;
  const today = todayIso();
  const friend = state.friends.find(f => f.id === purchase.friend)?.name || 'your friend';
  const left = sharedRefundLeft(state, purchase);
  const money = minor => formatMoney(minor, purchase.currency, purchase.precision);
  const field = (id, label, control, hint) => el('div', { class: 'field' },
    el('label', { for: id, text: label }), control, hint && el('p', { class: 'hint', text: hint }));
  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });
  const showError = error => {
    errorBox.textContent = errorMessage(error);
    errorBox.hidden = false;
    if (!form.isConnected) showToast(errorMessage(error));
  };
  let form;

  if (refund) {
    let armed = false;
    const remove = el('button', { type: 'button', class: 'btn-text', text: 'Delete refund' });
    remove.addEventListener('blur', () => { armed = false; remove.textContent = 'Delete refund'; remove.classList.remove('is-armed'); });
    remove.addEventListener('click', async () => {
      if (!armed) {
        armed = true;
        remove.textContent = 'Press again to delete';
        remove.classList.add('is-armed');
        return;
      }
      try {
        const next = deleteRefund(ledger.state, refund.id);
        closePopover({ restoreFocus: false });
        await saveLedger(next);
        showToast('Refund deleted.');
      } catch (error) {
        showError(error);
      }
    });
    form = el('div', { class: 'pot-sheet' },
      el('p', { class: 'note', text: `${formatDay(refund.date)}: the shop refunded ${money(refund.merchantRefund ?? refund.minor)}, of which ${money(refund.personalMinor ?? refund.minor)} was your share.` }),
      el('p', { class: 'hint', text: 'To change it, delete this refund and add it again.' }),
      errorBox,
      el('div', { class: 'entry-actions' }, remove));
    openPopover({ anchor, label: 'Shared refund', role: 'dialog', content: form });
    return;
  }

  const foreign = !left.friendPaid && purchase.settledMinor != null && Boolean(purchase.settledCurrency);
  const account = state.accounts.find(a => a.id === purchase.account);
  const billTotal = BigInt(purchase.sharedTotal ?? purchase.minor);
  const total = el('input', { id: 'refund-total', type: 'text', inputMode: 'decimal', autocomplete: 'off', placeholder: `Up to ${money(left.total)}` });
  const own = el('input', { id: 'refund-own', type: 'text', inputMode: 'decimal', autocomplete: 'off' });
  const credited = foreign && el('input', { id: 'refund-credited', type: 'text', inputMode: 'decimal', autocomplete: 'off' });
  const date = el('input', { id: 'refund-date', type: 'date', min: purchase.date, max: today, value: today });
  const note = el('input', { id: 'refund-note', type: 'text', maxLength: 500, autocomplete: 'off' });
  // Until typed, my share of the refund is the same part as my share of the bill.
  let ownTouched = false, creditTouched = false;
  own.addEventListener('input', () => { ownTouched = true; });
  if (credited) credited.addEventListener('input', () => { creditTouched = true; });
  total.addEventListener('input', () => {
    let refunded = null;
    try { refunded = parseAmount(total.value, purchase.currency); } catch { /* amount not complete yet */ }
    if (!ownTouched) {
      let part = refunded == null || billTotal <= 0n ? null : (BigInt(refunded) * BigInt(purchase.personalMinor) * 2n + billTotal) / (billTotal * 2n);
      if (part != null && part > left.own) part = left.own;
      own.value = part == null ? '' : plainAmount(part, purchase.precision);
    }
    if (credited && !creditTouched) {
      const suggestion = refunded == null ? null : suggestedSettled(purchase, refunded);
      credited.value = suggestion == null ? '' : plainAmount(suggestion, purchase.settledPrecision);
    }
  });

  form = el('form', {
    class: 'pot-sheet', novalidate: true,
    onsubmit: async event => {
      event.preventDefault();
      try {
        if (!total.value.trim()) throw Error('Enter the total refunded by the shop.');
        if (!own.value.trim()) throw Error('Enter your share of the refund.');
        const fields = {
          purchaseId: purchase.id, totalMinor: parseAmount(total.value, purchase.currency),
          ownMinor: shareAmount(own.value, purchase.currency), date: date.value, note: note.value, today
        };
        if (credited && creditTouched && credited.value.trim()) fields.settledMinor = parseAmount(credited.value, purchase.settledCurrency);
        const next = saveSharedRefund(ledger.state, fields);
        closePopover({ restoreFocus: false });
        await saveLedger(next);
        showToast(`Refund saved. ${sharedSavedText(next, purchase)}`);
      } catch (error) {
        showError(error);
      }
    }
  },
    field('refund-total', `Total refunded by the shop (${purchase.currency})`, total),
    field('refund-own', 'Your share of it', own, left.friendPaid
      ? `${friend} paid, so only your share is recorded: you owe them that much less.`
      : `The rest is ${friend}’s share: they owe you that much less.`),
    field('refund-date', 'Date', date),
    foreign && field('refund-credited', `Credited to ${account?.name || 'account'} (${purchase.settledCurrency})`, credited, 'Estimate from the original charge'),
    field('refund-note', 'Note (optional)', note),
    errorBox,
    el('div', { class: 'entry-actions' },
      el('button', { type: 'submit', class: 'btn-primary btn-small', text: 'Save refund' })));

  openPopover({ anchor, label: 'Shared refund', role: 'dialog', content: form });
}

/** Two presses: the first asks, the second deletes. Deleted records can be restored. */
function deleteButton(entry) {
  let armed = false;
  const button = el('button', { type: 'button', class: 'btn-text', text: 'Delete' });
  button.addEventListener('blur', () => { armed = false; button.textContent = 'Delete'; button.classList.remove('is-armed'); });
  button.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      button.textContent = 'Press again to delete';
      button.classList.add('is-armed');
      return;
    }
    try {
      const state = ledger.state;
      if (entry.kind === 'settlement' || entry.id.startsWith('forgiven:')) throw Error('This record belongs to a shared bill. Remove it from the friend’s history under People.');
      if (state.allocations.some(a => a.salary === entry.id)) throw Error('This income has pot allocations. Reverse them in the previous version first.');
      // Linked records go together: a transfer with its fee, a purchase with its refunds.
      const linked = state.entries.filter(r => r.id === entry.id
        || (entry.group && r.group === entry.group)
        || (r.kind === 'refund' && r.original === entry.id));
      const ordered = [...linked.filter(r => r.kind === 'refund' || r.feeFor), ...linked.filter(r => r.kind !== 'refund' && !r.feeFor)];
      await saveLedger(commitBatch(state, ordered.map(record => ({ table: 'entries', record, action: 'delete' }))));
      showToast(`Moved ${ordered.length === 1 ? 'the entry' : ordered.length + ' linked records'} to deleted records. You can restore from the previous version.`);
    } catch (error) {
      showToast(errorMessage(error));
    }
  });
  return button;
}
