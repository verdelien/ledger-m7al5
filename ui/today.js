// Today: quick add for an expense or an income, and the recent entries with net amounts.

import { digits, parseAmount, currencyName } from '../domain.js';
import { commit, commitBatch, uid } from '../model.js';
import { personalAmount, estimateAccountAmount } from '../money.js';
import { el, slip, sectionTitle, todayIso, formatDay, formatMoney, plainAmount, errorMessage, showToast, LEGACY_URL } from './dom.js';
import { ledger, saveLedger } from './ledger.js';
import { createCategoryPicker } from './categories.js';
import { createAccountPicker } from './accounts-picker.js';
import { addActiveCurrency, buildCurrencySearch } from './currencies.js';
import { openPopover, closePopover } from './popover.js';
import { negativePotCheck } from '../pots-logic.js';
import { opensPaydayFlow } from '../payday-flow.js';
import { askNegativePot, openPaydayPreview } from './pots.js';
import { accountIconNode } from './pixel-icons.js';

const RECENT_LIMIT = 40;
const MORE_CURRENCIES = '__more';

// Remembered while the page is open, so adding several entries is quick.
// `kept` holds a half-filled form across the redraw that follows adding a currency.
// `kind` is what the add form records: 'expense' or 'income'.
const todayDraft = { currency: '', account: null, editingId: '', kept: null, kind: 'expense' };

export function renderToday(root) {
  const state = ledger.state;
  const today = todayIso();
  const editing = state.entries.find(e => e.id === todayDraft.editingId) || null;
  if (!editing) todayDraft.editingId = '';

  root.append(slip({ label: 'Today', kind: formatDay(today), wide: true },
    el('div', { class: 'today-layout' },
      buildEntryForm(state, today, editing),
      buildRecentList(state, today))));
}

// ---------------------------------------------------------------------------
// Quick add
// ---------------------------------------------------------------------------

function buildEntryForm(state, today, editing) {
  const currencies = [...new Set([...state.settings.activeCurrencies, editing?.currency].filter(Boolean))];
  const accounts = state.accounts.filter(a => !a.archived || a.id === editing?.account);

  const kept = todayDraft.kept;
  todayDraft.kept = null;

  // Only plain expenses are edited here, so the switch is for new entries.
  const kind = editing ? 'expense' : todayDraft.kind;
  const isIncome = kind === 'income';
  const paidLabel = isIncome ? 'Paid into' : 'Paid from';

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
    value: kept ? kept.amount : editing ? plainAmount(editing.minor, editing.precision) : '',
    oninput: () => syncSettledField()
  });
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
      syncSettledField();
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

  function syncSettledField() {
    const account = selectedAccount();
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
  syncSettledField();

  const picker = createCategoryPicker({
    getState: () => ledger.state,
    kind,
    value: kept?.category || (isIncome ? '' : editing?.category || state.settings.defaultCategory || '')
  });

  /** What is typed so far, to carry across a redraw of the form. */
  function keepForm() {
    return {
      amount: amount.value, note: note.value, date: dateInput.value,
      settled: settled.value, settledState,
      category: picker.getValue(), account: accountPicker.getValue()
    };
  }

  // --- Expense | Income. Switching redraws the form with the other kind's categories.
  const kindSwitch = !editing && el('div', { class: 'segmented entry-kind', role: 'group', 'aria-label': 'Kind of entry' },
    [['expense', 'Expense'], ['income', 'Income']].map(([value, label]) => el('button', {
      type: 'button', id: `entry-kind-${value}`,
      class: value === kind ? 'is-selected' : '',
      'aria-pressed': String(value === kind),
      text: label,
      onclick: () => {
        if (value === kind) return;
        todayDraft.kept = { ...keepForm(), category: '' }; // a category belongs to one kind
        todayDraft.currency = currentCurrency;
        todayDraft.kind = value;
        closePopover({ restoreFocus: false });
        rerenderToday();
        document.getElementById(`entry-kind-${value}`)?.focus();
      }
    })));

  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });
  const saveButton = el('button', { type: 'submit', class: 'btn-primary', text: editing ? 'Save changes' : isIncome ? 'Save income' : 'Save expense' });

  /** Read the form into an entry record. Throws a readable error if something is missing. */
  function readForm() {
    const currencyCode = currentCurrency;
    if (!amount.value.trim()) throw Error('Enter an amount.');
    const minor = parseAmount(amount.value, currencyCode);
    if (!dateInput.value) throw Error('Choose a date.');
    const category = ledger.state.categories.find(c => c.id === picker.getValue());
    if (!category) throw Error('Choose a category.');

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
      pot: isIncome ? '' : category.pot || '', // income is shared out between pots by the payday flow
      account: accountPicker.getValue(),
      note: note.value.trim()
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

    // A changed amount makes an older reporting-currency value stale.
    if (editing && (editing.minor !== minor || editing.currency !== currencyCode)) {
      delete record.reportingMinor; delete record.reportingCurrency; delete record.reportingPrecision;
    }
    return record;
  }

  let saving = false;
  async function submit(event) {
    event.preventDefault();
    if (saving) return;
    const previousEditing = todayDraft.editingId;
    try {
      const record = readForm();
      let next = commit(ledger.state, 'entries', record);

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
      saving = true;
      saveButton.disabled = true;
      todayDraft.currency = record.currency;
      todayDraft.account = record.account;
      todayDraft.editingId = '';
      todayDraft.kind = 'expense'; // the form goes back to the common case
      const sharesOut = opensPaydayFlow(next, record);
      await saveLedger(next); // re-renders the screen with an empty form
      if (sharesOut) {
        // A salary: open the payday preview for it straight away. Closing it changes nothing;
        // the salary stays listed under Pots → Distribute salary.
        showToast('Salary saved. Share it out now, or later from Pots.');
        const anchor = document.querySelector('.entry-form button[type="submit"]');
        if (anchor) openPaydayPreview(anchor, record);
        return;
      }
      showToast(record.status === 'planned'
        ? `Saved as planned for ${formatDay(record.date)}.`
        : moved ? `Saved. Moved ${formatMoney(moved.minor, moved.pot.currency, moved.pot.precision)} from ${moved.from} to ${moved.pot.name}.`
        : warning ? `Saved. ${warning.pot.name} is below zero until you cover it.`
        : 'Saved on this device.');
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
    sectionTitle(editing ? 'Edit expense' : isIncome ? 'Add income' : 'Add an expense'),
    el('div', { class: 'field' },
      el('label', { for: 'entry-amount', text: 'Amount' }),
      el('div', { class: 'amount-row' }, amount)),
    el('div', { class: 'entry-meta-row' }, currencyButton, dateInput),
    el('div', { class: 'field' }, el('span', { class: 'field-label', text: 'Category' }), picker.element),
    el('div', { class: 'field' }, el('label', { for: 'entry-account', text: paidLabel }), accountButton),
    !accounts.length && el('p', { class: 'hint', text: 'No accounts yet. You can add one in Settings, or save without one.' }),
    settledField,
    el('div', { class: 'field' }, el('label', { for: 'entry-note', text: 'Note (optional)' }), note),
    errorBox,
    el('div', { class: 'form-actions' },
      saveButton,
      editing && el('button', {
        type: 'button', class: 'btn-secondary', text: 'Cancel',
        onclick: () => { todayDraft.editingId = ''; rerenderToday(); }
      })));
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

function buildRecentList(state, today) {
  const wrap = el('div', { class: 'recent' }, sectionTitle('Today and recent'));

  // Newest first. Refunds are folded into their purchase, not listed alone.
  const rows = state.entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.ledger === 'active' && entry.status !== 'cancelled'
      && entry.kind !== 'refund' && entry.date <= today)
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
    for (const entry of dayRows.filter(e => e.kind === 'expense')) {
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
  const meta = [
    parent?.name,
    entry.kind === 'transfer' ? 'Transfer' : nameOf('accounts', entry.account),
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
      el('span', { class: amountClass, text: formatMoney(shown, entry.currency, entry.precision, { signed: true }) })),
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
    lines.push(line(`${formatDay(entry.date)} · Paid`, money(-BigInt(entry.minor))));
    if (entry.friend) {
      const friend = state.friends.find(f => f.id === entry.friend)?.name || 'Friend';
      lines.push(line(`Your share (${friend} covers the rest)`, money(-personalAmount(entry))));
    }
    for (const refund of refunds) {
      lines.push(line(`${formatDay(refund.date)} · Refund`, money(BigInt(refund.personalMinor ?? refund.minor))));
    }
    if (refunds.length || entry.friend) lines.push(line('Net', money(net)));
    if (entry.splits) lines.push(line('Split', `${entry.splits.length} parts`));
  } else {
    lines.push(line(formatDay(entry.date), money(entry.kind === 'transfer' ? BigInt(entry.minor) : net, entry.kind !== 'transfer')));
  }

  if (entry.settledMinor != null && entry.settledCurrency !== entry.currency) {
    lines.push(line(entry.settledEstimate ? 'Charged to account (estimate)' : 'Charged to account', formatMoney(entry.settledMinor, entry.settledCurrency, entry.settledPrecision)));
  }
  const pot = state.pots.find(p => p.id === entry.pot);
  if (pot) lines.push(line('Pot', pot.name));

  // Plain expenses can be edited here. Other kinds keep their own forms in the previous version.
  const simple = entry.kind === 'expense' && !entry.splits && !entry.friend;
  const actions = el('div', { class: 'entry-actions' },
    simple
      ? el('button', {
          type: 'button', class: 'btn-text', text: 'Edit',
          onclick: () => { todayDraft.editingId = entry.id; rerenderToday(); document.getElementById('entry-amount')?.focus(); }
        })
      : el('a', { class: 'btn-text', href: LEGACY_URL, text: 'Edit in previous version' }),
    deleteButton(entry));

  return el('div', { class: 'entry-detail' }, lines, actions);
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
      if (entry.kind === 'settlement') throw Error('This payment is linked to a shared debt. Record a correcting settlement in the previous version instead.');
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
