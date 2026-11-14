// Move money between two accounts, with an optional fee taken from what arrived
// (an ATM or exchange charge).

import { parseAmount } from '../domain.js';
import { uid } from '../model.js';
import { estimateAccountAmount } from '../money.js';
import { saveTransfer, transferParts } from '../transfer-logic.js';
import { el, sectionTitle, formatDay, plainAmount, errorMessage, showToast } from './dom.js';
import { ledger, saveLedger } from './ledger.js';
import { createAccountPicker } from './accounts-picker.js';
import { openPopover, closePopover } from './popover.js';
import { accountIconNode } from './pixel-icons.js';

const FEE_CATEGORY_KEY = 'expense-book.fee-category';
const FEE_HINT = 'Use this for an ATM or exchange charge that reduced what arrived. What you type in Amount received is what actually arrived.';

// Remembered while the page is open, so repeating a transfer is quick.
const lastUsed = { from: null, to: null };

function rememberedFeeCategory() {
  try { return localStorage.getItem(FEE_CATEGORY_KEY) || ''; } catch { return ''; }
}
function rememberFeeCategory(id) {
  try { localStorage.setItem(FEE_CATEGORY_KEY, id); } catch { /* private window: nothing to remember */ }
}

/** A typed fee as minor units; an empty field or zero means no fee. */
function parseFee(text, currency) {
  const typed = text.trim();
  if (!typed || /^0+(?:[.,]0*)?$/.test(typed)) return 0;
  if (typed.startsWith('-')) throw Error('The fee cannot be negative.');
  return parseAmount(typed, currency);
}

/**
 * The transfer form. `editing` is the transfer being changed, or null for a new one.
 *   onSaved(record)  called after the transfer is saved
 *   onCancel()       called by Cancel while editing
 */
export function buildTransferForm(state, today, editing, { onSaved = () => {}, onCancel = () => {} } = {}) {
  const offered = current => current.accounts.filter(a => !a.archived || a.id === editing?.account || a.id === editing?.toAccount);
  const accounts = offered(state);
  const has = id => accounts.some(a => a.id === id);
  const parts = editing ? transferParts(state, editing) : null;

  const startFrom = editing ? editing.account
    : (has(lastUsed.from) && lastUsed.from)
      || (has(state.settings.defaultAccount) && state.settings.defaultAccount)
      || accounts.find(a => a.type === 'current' && a.currency === 'GBP')?.id
      || accounts[0]?.id
      || '';
  const startTo = editing ? editing.toAccount
    : (has(lastUsed.to) && lastUsed.to !== startFrom && lastUsed.to)
      || accounts.find(a => a.id !== startFrom)?.id
      || '';

  const caret = () => el('span', { class: 'caret', 'aria-hidden': 'true', text: '▾' });
  const accountOf = id => ledger.state.accounts.find(a => a.id === id);

  // --- From and To: each a button that opens the account picker.
  function accountField(id, label, value) {
    let popover = null;
    const picker = createAccountPicker({
      getState: () => ledger.state,
      getAccounts: offered,
      value,
      currency: '', // the "All" tab
      today,
      chosenLabel: label,
      onChange: () => { show(); closePopover(); syncFields(); }
    });
    const button = el('button', {
      type: 'button', id, class: 'paid-button',
      'aria-haspopup': 'dialog', 'aria-expanded': 'false',
      onclick: () => {
        if (popover) return closePopover();
        popover = openPopover({
          anchor: button, content: picker.element, label, role: 'dialog', wide: true,
          onClose: () => { popover = null; }
        });
        (picker.element.querySelector('[data-acct][aria-pressed="true"]')
          || picker.element.querySelector('button'))?.focus();
      }
    });
    function show() {
      const account = accountOf(picker.getValue());
      button.replaceChildren(...[
        account && accountIconNode(account),
        el('span', { class: 'paid-name', text: account ? account.name : 'Choose an account' }),
        account && el('span', { class: 'paid-currency', text: account.currency }),
        caret()
      ].filter(Boolean));
    }
    show();
    return {
      account: () => accountOf(picker.getValue()),
      field: el('div', { class: 'field' }, el('label', { for: id, text: label }), button)
    };
  }
  const from = accountField('transfer-from', 'From', startFrom);
  const to = accountField('transfer-to', 'To', startTo);

  // --- Amounts
  const sent = el('input', {
    id: 'transfer-amount', class: 'amount-input', type: 'text', inputMode: 'decimal',
    autocomplete: 'off', placeholder: '0.00',
    value: editing ? plainAmount(editing.minor, editing.precision) : '',
    oninput: () => syncFields()
  });
  const sentLabel = el('label', { for: 'transfer-amount' });
  const dateInput = el('input', { id: 'transfer-date', type: 'date', 'aria-label': 'Date', value: editing?.date || today });

  // Amount received: only shown when the two accounts hold different currencies.
  // 'auto'   a live estimate from the default rates, recalculated as the form changes
  // 'manual' typed by the user, or the amount saved with the transfer being edited
  const editingDestination = editing && state.accounts.find(a => a.id === editing.toAccount);
  let receivedState = editing ? 'manual' : 'auto';
  let receivedFor = null; // the currency the field holds; null until first shown
  const received = el('input', {
    id: 'transfer-received', type: 'text', inputMode: 'decimal', autocomplete: 'off',
    value: parts && editingDestination ? plainAmount(parts.receivedNet, editingDestination.precision) : '',
    oninput: () => { receivedState = 'manual'; estimateTag.hidden = true; }
  });
  const receivedLabelText = el('span');
  const estimateTag = el('span', { class: 'tag-estimate', text: 'estimate', hidden: true });
  const receivedField = el('div', { class: 'field', hidden: true },
    el('label', { for: 'transfer-received' }, receivedLabelText, ' ', estimateTag),
    received);

  // --- Fee taken from the amount received, and the category it is reported under.
  const fee = el('input', {
    id: 'transfer-fee', type: 'text', inputMode: 'decimal', autocomplete: 'off',
    value: parts?.fee && editingDestination ? plainAmount(parts.fee.minor, editingDestination.precision) : '',
    oninput: () => syncFields()
  });
  const feeLabel = el('label', { for: 'transfer-fee' });

  const expenseCategories = state.categories.filter(c => c.kind === 'expense' && (!c.archived || c.id === parts?.fee?.category));
  const categoryLabel = category => {
    const parent = category.parent && state.categories.find(c => c.id === category.parent);
    return parent ? `${parent.name} › ${category.name}` : category.name;
  };
  const isOffered = id => expenseCategories.some(c => c.id === id);
  const remembered = rememberedFeeCategory();
  const startCategory = (parts?.fee && isOffered(parts.fee.category) && parts.fee.category)
    || (isOffered(remembered) && remembered)
    || expenseCategories.find(c => c.name === 'Admin fees')?.id
    || expenseCategories[0]?.id
    || '';
  const feeCategory = el('select', { id: 'transfer-fee-category' },
    expenseCategories.map(c => el('option', { value: c.id, text: categoryLabel(c) })));
  feeCategory.value = startCategory;
  const feeCategoryField = el('div', { class: 'field', hidden: true },
    el('label', { for: 'transfer-fee-category', text: 'Fee category' }), feeCategory);

  const note = el('input', { id: 'transfer-note', type: 'text', maxLength: 500, value: editing?.note || '' });

  /** The estimate of what arrives, as text for the field, or '' without an amount or a rate. */
  function estimateReceived(source, destination) {
    try {
      const { reportingCurrency, defaultRates } = ledger.state.settings;
      const gross = estimateAccountAmount(parseAmount(sent.value, source.currency),
        { currency: source.currency, precision: source.precision }, destination, reportingCurrency, defaultRates);
      if (gross == null) return '';
      let charge = 0;
      try { charge = parseFee(fee.value, destination.currency); } catch { /* a half-typed fee */ }
      const net = gross > charge ? gross - charge : gross;
      return net > 0 ? plainAmount(net, destination.precision) : '';
    } catch {
      return ''; // no amount typed yet
    }
  }

  /** Labels and the received field follow the two chosen accounts. */
  function syncFields() {
    const source = from.account();
    const destination = to.account();
    sentLabel.textContent = source ? `Amount sent (${source.currency})` : 'Amount sent';
    feeLabel.textContent = destination
      ? `Fee taken from the amount received (optional, ${destination.currency})`
      : 'Fee taken from the amount received (optional)';
    feeCategoryField.hidden = !fee.value.trim();

    const needed = !!source && !!destination && source.currency !== destination.currency;
    receivedField.hidden = !needed;
    if (!needed) {
      // Same currency: what is received equals what is sent.
      received.value = '';
      receivedState = 'auto';
      receivedFor = '';
      return;
    }
    receivedLabelText.textContent = `Amount received (${destination.currency})`;
    if (receivedFor !== null && receivedFor !== destination.currency) {
      received.value = ''; // it was an amount in another currency
      receivedState = 'auto';
    }
    receivedFor = destination.currency;
    if (receivedState === 'auto' || !received.value.trim()) {
      received.value = estimateReceived(source, destination);
      receivedState = received.value ? 'auto' : 'manual';
    }
    estimateTag.hidden = receivedState === 'manual';
  }
  syncFields();

  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });
  const enough = accounts.length >= 2;
  const saveButton = el('button', {
    type: 'submit', class: 'btn-primary', text: editing ? 'Save changes' : 'Save transfer'
  });
  if (!enough) saveButton.disabled = true;

  /** Read the form. Throws a readable error if something is missing. */
  function readForm() {
    const source = from.account();
    const destination = to.account();
    if (!source || !destination) throw Error('Choose the account the money leaves and the account it arrives in.');
    if (source.id === destination.id) throw Error('Choose two different accounts.');
    if (!sent.value.trim()) throw Error('Enter the amount sent.');
    const minor = parseAmount(sent.value, source.currency);
    if (!dateInput.value) throw Error('Choose a date.');
    const charge = parseFee(fee.value, destination.currency);

    let receivedNet;
    if (source.currency === destination.currency) {
      if (charge >= minor) throw Error('The fee must be smaller than the amount sent.');
      receivedNet = minor - charge; // the fee reduced what arrived
    } else {
      if (!received.value.trim()) throw Error(`Enter what ${destination.name} received in ${destination.currency} (an estimate is fine).`);
      receivedNet = parseAmount(received.value, destination.currency);
    }

    const transfer = {
      tags: '', trip: '',
      ...(editing || {}),
      id: editing?.id || uid(),
      kind: 'transfer',
      ledger: 'active',
      status: dateInput.value > today ? 'planned' : editing?.status || 'posted',
      date: dateInput.value,
      minor,
      currency: source.currency,
      precision: source.precision,
      account: source.id,
      toAccount: destination.id,
      category: '',
      pot: '',
      note: note.value.trim()
    };
    return { transfer, receivedNet, fee: charge, feeCategory: charge ? feeCategory.value : '' };
  }

  let saving = false;
  async function submit(event) {
    event.preventDefault();
    if (saving || !enough) return;
    try {
      const input = readForm();
      const next = saveTransfer(ledger.state, input);
      saving = true;
      saveButton.disabled = true;
      lastUsed.from = input.transfer.account;
      lastUsed.to = input.transfer.toAccount;
      if (input.fee) rememberFeeCategory(input.feeCategory);
      await saveLedger(next);
      onSaved(input.transfer);
      showToast(input.transfer.status === 'planned'
        ? `Saved as planned for ${formatDay(input.transfer.date)}.`
        : 'Saved on this device.');
    } catch (error) {
      // Keep everything the user typed.
      saving = false;
      saveButton.disabled = false;
      errorBox.textContent = errorMessage(error);
      errorBox.hidden = false;
    }
  }

  return el('form', { class: 'entry-form transfer-form', onsubmit: submit, novalidate: true },
    sectionTitle(editing ? 'Edit transfer' : 'Move money'),
    !enough && el('p', { class: 'hint', text: 'Add two accounts in Settings to move money between them.' }),
    from.field,
    to.field,
    el('div', { class: 'field' }, sentLabel, el('div', { class: 'amount-row' }, sent)),
    el('div', { class: 'entry-meta-row' }, dateInput),
    receivedField,
    el('div', { class: 'field' }, feeLabel, fee, el('p', { class: 'hint', text: FEE_HINT })),
    feeCategoryField,
    el('div', { class: 'field' }, el('label', { for: 'transfer-note', text: 'Note (optional)' }), note),
    errorBox,
    el('div', { class: 'form-actions' },
      saveButton,
      editing && el('button', { type: 'button', class: 'btn-secondary', text: 'Cancel', onclick: () => onCancel() })));
}
