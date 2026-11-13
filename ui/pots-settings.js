// Settings → Pots (add, rename, icon, archive, and the rollover switch per
// pot) and the payday flow part of Settings → Payday.

import { digits, parseAmount } from '../domain.js';
import { commit, uid, potBalance } from '../model.js';
import { paydayFlowSetting, PAYDAY_FLOW_STEPS, savingsExample } from '../payday-flow.js';
import { percentText } from './pots.js';
import { rolloverSetting, DEFAULT_ROLLOVER_MONTHS } from '../pots-logic.js';
import { el, todayIso, formatMoney, plainAmount, errorMessage, showToast } from './dom.js';
import { ledger, saveLedger } from './ledger.js';
import { iconField } from './category-editor.js';
import { categoryIconNode } from './pixel-icons.js';
import { saveSettings } from './currencies.js';

// View state kept between re-renders: the pot being edited.
const potsView = { editingId: '' };

const POT_KINDS = [['budget', 'Budget'], ['savings', 'Savings']];

/** A name that is not empty and not already used by another pot. */
function checkedPotName(raw, pots, ownId) {
  const name = raw.trim();
  if (!name) throw Error('Give the pot a name.');
  if (name.length > 150) throw Error('That name is too long.');
  if (pots.some(p => p.id !== ownId && p.name.trim().toLowerCase() === name.toLowerCase())) throw Error('Another pot already has that name.');
  return name;
}

/** Where a pot is still needed, as text for a message; '' when it is free to archive. */
function potInUse(state, pot) {
  const flow = paydayFlowSetting(state);
  const step = PAYDAY_FLOW_STEPS.find(s => flow[s.potKey] === pot.id);
  if (step) return `the payday flow ("${step.label}")`;
  const feeder = state.pots.find(p => !p.archived && rolloverSetting(p).enabled && rolloverSetting(p).to === pot.id);
  if (feeder) return `the rollover of ${feeder.name}`;
  if (state.settings.savingsPot === pot.id) return 'the default savings setting';
  return '';
}

// ---------------------------------------------------------------------------
// Settings → Pots
// ---------------------------------------------------------------------------

export function buildPotsSettings(rerender) {
  const state = ledger.state;
  const today = todayIso();
  const pots = [...state.pots.filter(p => !p.archived), ...state.pots.filter(p => p.archived)];

  const list = el('ul', { class: 'plain-list' }, pots.map(pot => {
    const rollover = rolloverSetting(pot);
    const target = state.pots.find(p => p.id === rollover.to);
    const meta = [
      pot.kind === 'savings' ? 'Savings' : 'Budget',
      pot.archived ? 'archived' : rollover.enabled ? `rolls over to ${target?.name || 'savings'} after ${rollover.months} months` : 'no rollover'
    ].join(' · ');
    const editing = potsView.editingId === pot.id;
    return el('li', { class: pot.archived ? 'is-archived' : '' },
      el('div', { class: 'list-row' },
        el('span', { class: 'entry-text' },
          el('span', { class: 'entry-title' }, categoryIconNode(pot.icon), el('span', { text: pot.name })),
          el('span', { class: 'entry-meta', text: meta })),
        el('span', { class: 'entry-amount', text: formatMoney(potBalance(state, pot.id, today).minor, pot.currency, pot.precision) }),
        el('button', {
          type: 'button', class: 'btn-text', text: editing ? 'Close' : 'Edit', 'aria-label': `${editing ? 'Close' : 'Edit'} ${pot.name}`,
          'aria-expanded': String(editing), 'data-focus': `pot-edit:${pot.id}`,
          onclick: () => { potsView.editingId = editing ? '' : pot.id; rerender(); }
        })),
      editing && potEditForm(state, pot, rerender));
  }));

  return el('div', {},
    el('p', { class: 'note', text: 'Pots are a plan for your money; they never move bank cash. Rollover is off for every pot until you switch it on. Travel carries for the year, so it is best left off there.' }),
    list,
    potAddForm(state));
}

/** Rename, icon, rollover and archive for one pot. */
function potEditForm(state, pot, rerender) {
  const rollover = rolloverSetting(pot);
  const name = el('input', { id: 'pot-name', type: 'text', maxLength: 150, value: pot.name });
  const icon = iconField(pot);
  const targets = state.pots.filter(p => !p.archived && p.id !== pot.id && p.kind === 'savings' && p.currency === pot.currency && p.precision === pot.precision);

  const enabled = el('input', { type: 'checkbox', checked: rollover.enabled && targets.length > 0, disabled: !targets.length });
  const to = el('select', { id: 'pot-rollover-to', 'aria-label': 'Rollover goes to' }, targets.map(p => el('option', { value: p.id, text: p.name })));
  const preferredTarget = [rollover.to, state.settings.savingsPot].find(id => targets.some(p => p.id === id));
  if (preferredTarget) to.value = preferredTarget;
  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });

  const fail = error => { errorBox.textContent = errorMessage(error); errorBox.hidden = false; };

  async function save(event) {
    event.preventDefault();
    try {
      const record = { ...pot, name: checkedPotName(name.value, ledger.state.pots, pot.id) };
      const chosenIcon = icon.getValue();
      if (chosenIcon !== undefined) record.icon = chosenIcon;
      if (enabled.checked) record.rollover = { enabled: true, months: rollover.months, to: to.value };
      else if (pot.rollover) record.rollover = { ...rollover, enabled: false };
      potsView.editingId = '';
      await saveLedger(commit(ledger.state, 'pots', record));
      showToast('Pot saved.');
    } catch (error) {
      potsView.editingId = pot.id;
      fail(error);
    }
  }

  async function setArchived(archived) {
    try {
      const use = archived ? potInUse(ledger.state, pot) : '';
      if (use) throw Error(`${pot.name} is used by ${use}. Choose another pot there first.`);
      const record = { ...pot, archived };
      if (archived && pot.rollover) record.rollover = { ...rollover, enabled: false };
      potsView.editingId = '';
      await saveLedger(commit(ledger.state, 'pots', record));
      showToast(archived ? `${pot.name} archived. Its records are kept.` : `${pot.name} is back.`);
    } catch (error) {
      potsView.editingId = pot.id;
      fail(error);
    }
  }

  return el('form', { class: 'ed-edit', onsubmit: save, novalidate: true },
    el('div', { class: 'field' }, el('label', { for: 'pot-name', text: 'Name' }), name),
    icon.element,
    el('div', { class: 'pot-rollover' },
      el('label', { class: 'check-row' }, enabled,
        el('span', { text: `After ${rollover.months} months unused, move what is left to` })),
      to),
    !targets.length && el('p', { class: 'hint', text: 'Rollover needs another savings pot in the same currency.' }),
    el('p', { class: 'hint', text: 'Checked when the app opens. Spending uses the oldest money first; only money older than the months above moves, and you can undo it.' }),
    errorBox,
    el('div', { class: 'ed-edit-actions' },
      el('button', { type: 'submit', class: 'btn-primary btn-small', text: 'Save' }),
      el('button', { type: 'button', class: 'btn-text', text: 'Cancel', onclick: () => { potsView.editingId = ''; rerender(); } }),
      pot.archived
        ? el('button', { type: 'button', class: 'btn-text', text: 'Restore', onclick: () => setArchived(false) })
        : el('button', { type: 'button', class: 'btn-text', text: 'Archive', onclick: () => setArchived(true) })));
}

function potAddForm(state) {
  const code = state.settings.reportingCurrency;
  const name = el('input', { id: 'pot-new-name', type: 'text', maxLength: 150 });
  const kind = el('select', { id: 'pot-new-kind' }, POT_KINDS.map(([value, label]) => el('option', { value, text: label })));
  const icon = iconField({});
  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });

  async function submit(event) {
    event.preventDefault();
    try {
      const record = {
        id: uid(), name: checkedPotName(name.value, ledger.state.pots, ''), kind: kind.value,
        currency: code, precision: digits(code), archived: false
      };
      const chosenIcon = icon.getValue();
      if (chosenIcon) record.icon = chosenIcon;
      await saveLedger(commit(ledger.state, 'pots', record));
      showToast('Pot added.');
    } catch (error) {
      errorBox.textContent = errorMessage(error);
      errorBox.hidden = false;
    }
  }

  return el('details', { class: 'fold' },
    el('summary', { text: 'Add a pot' }),
    el('form', { class: 'fold-body', onsubmit: submit, novalidate: true },
      el('div', { class: 'field-pair' },
        el('div', { class: 'field' }, el('label', { for: 'pot-new-name', text: 'Name' }), name),
        el('div', { class: 'field' }, el('label', { for: 'pot-new-kind', text: 'Type' }), kind)),
      icon.element,
      el('p', { class: 'hint', text: `New pots are in ${code}. A budget pot is for spending; a savings pot can receive rollovers. Rollover (default ${DEFAULT_ROLLOVER_MONTHS} months) starts switched off.` }),
      errorBox,
      el('button', { type: 'submit', class: 'btn-primary', text: 'Add pot' })));
}

// ---------------------------------------------------------------------------
// Settings → Payday: the payday flow
// ---------------------------------------------------------------------------

export function buildPaydayFlowSettings() {
  const state = ledger.state;
  const flow = paydayFlowSetting(state);
  const pots = state.pots.filter(p => !p.archived);
  const codeOf = potId => state.pots.find(p => p.id === potId)?.currency || state.settings.reportingCurrency;

  const potSelect = (id, value) => {
    const select = el('select', { id }, pots.map(p => el('option', { value: p.id, text: p.name })));
    if (pots.some(p => p.id === value)) select.value = value;
    return select;
  };
  const savingsPot = potSelect('flow-savings-pot', flow.savingsPot);
  const fixedPot = potSelect('flow-fixed-pot', flow.fixedPot);
  const regularsPot = potSelect('flow-regulars-pot', flow.regularsPot);
  const leftoverPot = potSelect('flow-leftover-pot', flow.leftoverPot);

  // The savings portion: a fixed amount and a percentage, added together. Either may be left empty.
  const fixedAmount = el('input', {
    id: 'flow-savings-fixed', type: 'text', inputMode: 'decimal', autocomplete: 'off', placeholder: '0.00',
    value: flow.savings.fixedMinor > 0 ? plainAmount(flow.savings.fixedMinor, digits(codeOf(flow.savingsPot))) : ''
  });
  const fixedLabel = el('label', { for: 'flow-savings-fixed' });
  // A percentage is kept in hundredths of a percent, so 12.5% is exact.
  const percent = el('input', {
    id: 'flow-savings-percent', type: 'text', inputMode: 'decimal', autocomplete: 'off', placeholder: '0',
    value: flow.savings.percent > 0 ? percentText(flow.savings.percent) : ''
  });
  const percentBase = el('select', { id: 'flow-savings-base', 'aria-label': 'Percentage of' },
    el('option', { value: 'total', text: 'of total income' }),
    el('option', { value: 'disposable', text: 'of disposable income (after fixed and regulars)' }));
  percentBase.value = flow.savings.percentBase;
  const example = el('p', { class: 'hint', role: 'status' });
  const order = el('p', { class: 'hint' });
  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });

  /** The typed savings rule in its stored shape; an empty field is zero. */
  function readSavings() {
    const empty = text => !text || /^0*(?:[.,]0*)?$/.test(text);
    const amountText = fixedAmount.value.trim();
    const percentTyped = percent.value.trim();
    let hundredths = 0;
    if (!empty(percentTyped)) {
      const match = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(percentTyped);
      hundredths = match ? Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0')) : NaN;
      if (!Number.isInteger(hundredths) || hundredths > 10000) throw Error('Enter a percentage from 0 to 100, with at most two decimals.');
    }
    return {
      fixedMinor: empty(amountText) ? 0 : parseAmount(amountText, codeOf(savingsPot.value)),
      percent: hundredths,
      percentBase: percentBase.value === 'disposable' ? 'disposable' : 'total'
    };
  }

  /** The labels, the order of the steps and a worked example, kept in step with the form. */
  function showSavings() {
    const code = codeOf(savingsPot.value);
    fixedLabel.textContent = `Fixed amount (${code})`;
    order.textContent = percentBase.value === 'disposable'
      ? 'Order: fixed expenses, regulars, savings, then what is left.'
      : 'Order: savings, fixed expenses, regulars, then what is left.';
    let text = '';
    try {
      const savings = readSavings();
      const sample = savingsExample(state, savings);
      if (sample && sample.entry.currency === code) {
        const money = minor => formatMoney(minor, sample.entry.currency, sample.entry.precision);
        const sum = [
          savings.fixedMinor > 0 && money(sample.fixedPart),
          savings.percent > 0 && `${percentText(savings.percent)}% of ${money(sample.base)}`
        ].filter(Boolean).join(' + ');
        text = sum
          ? `Example, your last salary of ${money(sample.salary)}: ${sum} = ${money(sample.requested)} to savings.`
          : `Example, your last salary of ${money(sample.salary)}: nothing goes to savings yet.`;
      }
    } catch {
      text = ''; // the fields cannot be read yet; Save explains why
    }
    example.textContent = text;
    example.hidden = !text;
  }
  for (const control of [fixedAmount, percent]) control.addEventListener('input', showSavings);
  for (const control of [percentBase, savingsPot]) control.addEventListener('change', showSavings);
  showSavings();

  async function submit(event) {
    event.preventDefault();
    try {
      const next = {
        savingsPot: savingsPot.value, savings: readSavings(),
        fixedPot: fixedPot.value, regularsPot: regularsPot.value, leftoverPot: leftoverPot.value
      };
      const codes = new Set([next.savingsPot, next.fixedPot, next.regularsPot, next.leftoverPot].map(codeOf));
      if (codes.size > 1) throw Error('Choose pots in one currency; nothing is converted between pots.');
      await saveSettings(settings => { settings.paydayFlow = next; });
      showToast('Payday flow saved.');
    } catch (error) {
      errorBox.textContent = errorMessage(error);
      errorBox.hidden = false;
    }
  }

  const field = (label, control) => el('div', { class: 'field' }, el('label', { for: control.id, text: label }), control);
  return el('form', { class: 'flow-form', onsubmit: submit, novalidate: true },
    el('p', { class: 'note', text: 'When a salary is shared out, the steps are filled in this order. You see a preview and can change every line before anything is saved.' }),
    field('Savings go to', savingsPot),
    el('div', { class: 'field-pair' },
      el('div', { class: 'field' }, fixedLabel, fixedAmount),
      el('div', { class: 'field' }, el('label', { for: 'flow-savings-percent', text: 'Percentage (%)' }), percent)),
    el('div', { class: 'field' }, percentBase),
    el('p', { class: 'hint', text: 'Savings are the fixed amount plus the percentage. Leave either empty if you do not use it.' }),
    example,
    el('div', { class: 'field-pair' }, field('Fixed expenses pot', fixedPot), field('Regulars pot', regularsPot)),
    field('What is left goes to', leftoverPot),
    order,
    el('p', { class: 'hint', text: 'Fixed expenses is filled up to what is due before the next payday; Regulars up to your weekly estimates. If the salary is short, later steps get less. Savings are never drawn on automatically.' }),
    errorBox,
    el('button', { type: 'submit', class: 'btn-primary btn-small', text: 'Save payday flow' }));
}
