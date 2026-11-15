// The Pots tab: each pot with its balance, a sheet with the pot's month, the
// payday flow ("Distribute salary"), moving money between pots, the warning
// when an expense would take a pot below zero, and the three-month rollover
// that runs when the app opens.
//
// Pots are a plan for the money, not bank cash: nothing here changes an
// account. All sums come from payday-flow.js and pots-logic.js.

import { parseAmount } from '../domain.js';
import { commitBatch, uid, potBalance } from '../model.js';
import { nextPayday } from '../payday.js';
import {
  paydayFlowSetting, paydayFlowPreview, confirmPaydayFlow, unallocatedSalaries
} from '../payday-flow.js';
import {
  potMonthSummary, potUpcoming, potMoveOperation, rolloverSetting, applyRollover, undoRollover
} from '../pots-logic.js';
import { el, slip, sectionTitle, todayIso, formatDay, formatMoney, plainAmount, errorMessage, showToast } from './dom.js';
import { ledger, saveLedger } from './ledger.js';
import { openPopover, closePopover } from './popover.js';
import { categoryIconNode } from './pixel-icons.js';
import { wishlistSection } from './wishlist.js';

/** Format an amount in a pot's own currency. */
function potMoney(minor, pot) {
  return formatMoney(minor, pot.currency, pot.precision);
}

/** A stored percentage (hundredths) as text: 1250 → "12.5", 1000 → "10". */
export function percentText(hundredths) {
  const text = plainAmount(hundredths, 2);
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

/** The savings rule in a few words: "Savings · £300.00 + 10% of disposable". */
export function savingsRuleLabel(savings, currencyCode, precision) {
  const parts = [
    savings.fixedMinor > 0 && formatMoney(savings.fixedMinor, currencyCode, precision),
    savings.percent > 0 && `${percentText(savings.percent)}% of ${savings.percentBase === 'disposable' ? 'disposable' : 'total'}`
  ].filter(Boolean);
  return parts.length ? `Savings · ${parts.join(' + ')}` : 'Savings';
}

/** Read an amount field; empty or zero is 0. Returns integer minor units. */
function potAmountInput(text, currencyCode) {
  const trimmed = text.trim();
  if (!trimmed || /^0*(?:[.,]0*)?$/.test(trimmed)) return 0;
  return parseAmount(trimmed, currencyCode);
}

/** A labelled field. */
function potField(id, label, control) {
  return el('div', { class: 'field' }, el('label', { for: id, text: label }), control);
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export function renderPots(root) {
  const state = ledger.state;
  const today = todayIso();
  const pots = state.pots.filter(p => !p.archived);

  const distribute = el('button', {
    type: 'button', class: 'btn-primary', text: 'Distribute salary',
    'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'data-focus': 'pots-distribute',
    onclick: () => openDistribute(distribute)
  });
  const waiting = unallocatedSalaries(state).length;

  root.append(slip({ label: 'Pots', kind: `Payday ${formatDay(nextPayday(today, state.settings))}`, wide: true },
    el('p', { class: 'note', text: 'Pots are a plan for your money. Moving money between pots never moves it between bank accounts.' }),
    el('div', { class: 'pots-actions' },
      distribute,
      waiting > 0 && el('span', { class: 'hint', text: waiting === 1 ? 'One salary is waiting to be shared out.' : `${waiting} salaries are waiting to be shared out.` })),
    sectionTitle('Your pots'),
    pots.length
      ? el('ul', { class: 'plain-list pots-list' }, pots.map(pot => potRow(state, pot, today)))
      : el('p', { class: 'empty', text: 'There are no pots yet. You can add one in Settings.' }),
    el('p', { class: 'hint', text: 'Tap a pot to see its month. A pot below zero stays red until you cover it; nothing moves on its own.' }),
    el('a', { class: 'btn-text', href: '#settings/pots', text: 'Add, rename or archive pots' }),
    wishlistSection(state, today),
    el('a', { class: 'btn-text nw-link', href: '#networth', text: 'Net worth & investments →' })));
}

function potRow(state, pot, today) {
  const balance = potBalance(state, pot.id, today);
  const negative = balance.minor < 0n;
  const rollover = rolloverSetting(pot);
  const meta = [
    pot.kind === 'savings' ? 'Savings' : 'Budget',
    rollover.enabled && `rolls over after ${rollover.months} months`,
    balance.missing > 0 && `${balance.missing} not counted (another currency)`
  ].filter(Boolean).join(' · ');

  const open = el('button', {
    type: 'button', class: 'pot-open', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'data-focus': `pot:${pot.id}`,
    'aria-label': `${pot.name}, ${potMoney(balance.minor, pot)}${negative ? ', below zero' : ''}`,
    onclick: () => openPopover({ anchor: open, label: pot.name, role: 'dialog', content: potSheet(ledger.state, pot, todayIso()) })
  },
    el('span', { class: 'entry-text' },
      el('span', { class: 'entry-title' }, categoryIconNode(pot.icon), el('span', { text: pot.name })),
      el('span', { class: 'entry-meta', text: meta })),
    el('span', { class: 'entry-amount' + (negative ? ' is-negative' : ''), text: potMoney(balance.minor, pot) }));

  const move = negative && el('button', {
    type: 'button', class: 'btn-secondary btn-small', text: 'Move money',
    'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'data-focus': `pot-move:${pot.id}`,
    'aria-label': `Move money into ${pot.name}`,
    onclick: () => openMoveMoney(move, pot)
  });

  return el('li', { class: 'list-row pot-row' + (negative ? ' is-negative' : '') }, open, move);
}

// ---------------------------------------------------------------------------
// One pot's sheet
// ---------------------------------------------------------------------------

function potSheet(state, pot, today) {
  const balance = potBalance(state, pot.id, today);
  const month = potMonthSummary(state, pot.id, today);
  const upcoming = potUpcoming(state, pot.id, today);
  const rollover = rolloverSetting(pot);
  const target = state.pots.find(p => p.id === rollover.to);
  const monthName = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, 1).toLocaleDateString('en-GB', { month: 'long' });

  const fact = (label, value, negative = false) => el('div', { class: 'pot-fact' },
    el('dt', { text: label }),
    el('dd', { class: negative ? 'is-negative' : '', text: value }));

  return el('div', { class: 'pot-sheet' },
    el('dl', { class: 'pot-facts' },
      fact('Balance', potMoney(balance.minor, pot), balance.minor < 0n),
      fact(`Funded in ${monthName}`, potMoney(month.funded, pot)),
      month.movedOut > 0n && fact(`Moved out in ${monthName}`, potMoney(month.movedOut, pot)),
      fact(`Spent in ${monthName}`, potMoney(month.spent, pot))),
    (balance.missing > 0 || month.missing > 0) && el('p', { class: 'hint', text: 'Spending in another currency with no recorded value is not counted here.' }),

    el('div', { class: 'day-head' }, el('span', { text: 'Fixed items before payday' })),
    upcoming.length
      ? el('ul', { class: 'plain-list' }, upcoming.map(item => el('li', { class: 'list-row' },
          el('span', { class: 'entry-text' },
            el('span', { class: 'entry-title', text: item.label }),
            el('span', { class: 'entry-meta', text: formatDay(item.date) + (item.estimated ? ' · estimate' : '') })),
          el('span', { class: 'entry-amount', text: formatMoney(item.minor, item.currency, item.precision) }))))
      : el('p', { class: 'empty', text: 'Nothing planned from this pot before payday.' }),

    el('div', { class: 'day-head' }, el('span', { text: 'Rollover' })),
    el('p', {
      class: 'note', text: rollover.enabled
        ? `On. Money left unused for ${rollover.months} months moves to ${target?.name || 'savings'} when the app opens.`
        : 'Off. Unused money stays in this pot.'
    }),
    el('a', { class: 'btn-text', href: '#settings/pots', text: 'Change in Settings' }),
    pot.id === 'Travel' && el('a', { class: 'btn-text', href: '#trips', text: 'Travel budget & trips', onclick: () => closePopover({ restoreFocus: false }) }));
}

// ---------------------------------------------------------------------------
// Moving money between pots (only ever when the user asks)
// ---------------------------------------------------------------------------

/**
 * The two fields of a move into `target`: where from, and how much
 * (prefilled with `amountMinor`). Returns { element, hasSource, read(state, date) };
 * read gives the allocation operation or throws a readable error.
 */
function potMoveFields(state, target, amountMinor, date) {
  const sources = state.pots.filter(p => !p.archived && p.id !== target.id && p.currency === target.currency && p.precision === target.precision);
  const held = new Map(sources.map(p => [p.id, potBalance(state, p.id, date).minor]));
  const flow = paydayFlowSetting(state);

  const from = el('select', { id: 'pot-move-from' }, sources.map(p => el('option', { value: p.id, text: `${p.name} · ${potMoney(held.get(p.id), p)}` })));
  // Prefer "Flexible savings" (the leftover pot), then savings, then any pot that holds enough.
  const enough = id => held.has(id) && held.get(id) >= BigInt(amountMinor);
  const preferred = [flow.leftoverPot, flow.savingsPot, ...sources.map(p => p.id)].find(enough);
  if (preferred) from.value = preferred;

  const amount = el('input', {
    id: 'pot-move-amount', type: 'text', inputMode: 'decimal', autocomplete: 'off',
    value: amountMinor > 0n ? plainAmount(amountMinor, target.precision) : ''
  });

  return {
    hasSource: sources.length > 0,
    element: el('div', { class: 'field-pair' },
      potField('pot-move-from', 'Move from', from),
      potField('pot-move-amount', `Amount (${target.currency})`, amount)),
    read(current, moveDate) {
      const minor = potAmountInput(amount.value, target.currency);
      return potMoveOperation(current, {
        id: uid(), from: from.value, to: target.id, minor, date: moveDate, note: `Moved to cover ${target.name}`
      });
    }
  };
}

/** "Move money" on a pot below zero. */
function openMoveMoney(anchor, pot) {
  const today = todayIso();
  const balance = potBalance(ledger.state, pot.id, today).minor;
  const fields = potMoveFields(ledger.state, pot, balance < 0n ? -balance : 0n, today);
  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });

  const form = el('form', {
    class: 'pot-sheet', novalidate: true,
    onsubmit: async event => {
      event.preventDefault();
      try {
        const operation = fields.read(ledger.state, today);
        const next = commitBatch(ledger.state, [operation]);
        const sourceName = ledger.state.pots.find(p => p.id === operation.record.from)?.name;
        closePopover({ restoreFocus: false });
        await saveLedger(next);
        showToast(`Moved ${potMoney(operation.record.minor, pot)} from ${sourceName} to ${pot.name}.`);
      } catch (error) {
        errorBox.textContent = errorMessage(error);
        errorBox.hidden = false;
        if (!form.isConnected) showToast(errorMessage(error));
      }
    }
  },
    el('p', { class: 'note', text: `${pot.name} is at ${potMoney(balance, pot)}. Choose where the money comes from. No bank account changes.` }),
    fields.hasSource ? fields.element : el('p', { class: 'empty', text: 'There is no other pot in this currency to move from.' }),
    errorBox,
    fields.hasSource && el('button', { type: 'submit', class: 'btn-primary btn-small', text: 'Move' }));

  openPopover({ anchor, label: `Move money into ${pot.name}`, role: 'dialog', content: form });
}

/**
 * Today's Save, when the expense would take its pot below zero.
 * `warning` comes from negativePotCheck; `next` is the ledger with the
 * expense already in it (not saved yet).
 *
 * Resolves with null (closed: nothing is saved), or { state, moved }:
 *   OK        → state is `next`; the pot shows red until it is covered
 *   Move now  → state also holds one allocation from the chosen pot; moved describes it
 */
export function askNegativePot(anchor, warning, next, date) {
  return new Promise(resolve => {
    let answer = null;
    const pot = warning.pot;
    const fields = potMoveFields(next, pot, warning.shortfall, date);
    const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });

    const moveForm = el('form', {
      hidden: true, novalidate: true,
      onsubmit: event => {
        event.preventDefault();
        try {
          const operation = fields.read(next, date);
          answer = {
            state: commitBatch(next, [operation]),
            moved: { minor: operation.record.minor, from: next.pots.find(p => p.id === operation.record.from)?.name, pot }
          };
          closePopover({ restoreFocus: false });
        } catch (error) {
          errorBox.textContent = errorMessage(error);
          errorBox.hidden = false;
        }
      }
    },
      fields.hasSource ? fields.element : el('p', { class: 'empty', text: 'There is no other pot in this currency to move from.' }),
      errorBox,
      fields.hasSource && el('button', { type: 'submit', class: 'btn-primary btn-small', text: 'Move and save' }));

    const choices = el('div', { class: 'form-actions' },
      el('button', {
        type: 'button', class: 'btn-secondary', text: 'Move now',
        onclick: () => { choices.hidden = true; moveForm.hidden = false; moveForm.querySelector('select, input')?.focus(); }
      }),
      el('button', {
        type: 'button', class: 'btn-primary', text: 'OK',
        onclick: () => { answer = { state: next, moved: null }; closePopover({ restoreFocus: false }); }
      }));

    openPopover({
      anchor, label: 'Below zero', role: 'dialog', onClose: () => resolve(answer),
      content: el('div', { class: 'pot-sheet' },
        el('p', { class: 'pot-warning', text: `This takes ${pot.name} to ${potMoney(warning.balance, pot)}.` }),
        el('p', { class: 'hint', text: 'Nothing moves unless you choose it. With OK the expense is saved and the pot stays red until it is covered.' }),
        choices, moveForm)
    });
    choices.querySelector('.btn-primary').focus();
  });
}

// ---------------------------------------------------------------------------
// Distribute salary (the monthly payday flow)
// ---------------------------------------------------------------------------

/**
 * First step: choose a salary that has not been shared out yet.
 * A salary is recorded on Today, as income in the Salary category.
 */
function openDistribute(anchor) {
  const state = ledger.state;
  const waiting = unallocatedSalaries(state);
  const accountName = id => state.accounts.find(a => a.id === id)?.name || 'No account';

  const list = waiting.length > 0 && el('ul', { class: 'plain-list' }, waiting.slice(0, 6).map(entry => el('li', { class: 'list-row' },
    el('span', { class: 'entry-text' },
      el('span', { class: 'entry-title', text: `${formatDay(entry.date)} ${entry.date.slice(0, 4)}` }),
      el('span', { class: 'entry-meta', text: accountName(entry.account) })),
    el('span', { class: 'entry-amount is-income', text: formatMoney(entry.minor, entry.currency, entry.precision) }),
    el('button', {
      type: 'button', class: 'btn-secondary btn-small', text: 'Preview',
      onclick: () => openPaydayPreview(anchor, entry)
    }))));

  openPopover({
    anchor, label: 'Distribute salary', role: 'dialog',
    content: el('div', { class: 'pot-sheet' },
      waiting.length > 0
        ? el('div', { class: 'day-head' }, el('span', { text: 'Not shared out yet' }))
        : el('p', { class: 'empty', text: 'No salary is waiting to be shared out.' }),
      list,
      el('p', { class: 'hint', text: 'To add a salary, record it on Today as income in the Salary category. The preview opens when you save it.' }),
      el('a', { class: 'btn-text', href: '#today', text: 'Go to Today', onclick: () => closePopover({ restoreFocus: false }) }))
  });
}

/**
 * Second step: the four lines, each editable, then Confirm.
 * Also opened from Today straight after a salary is saved.
 */
export function openPaydayPreview(anchor, entry) {
  const state = ledger.state;
  let preview;
  try {
    preview = paydayFlowPreview(state, entry, todayIso());
  } catch (error) {
    closePopover({ restoreFocus: false });
    showToast(errorMessage(error));
    return;
  }

  const { currency: code, precision } = preview.entry;
  const money = minor => formatMoney(minor, code, precision);
  const salary = preview.salary;
  const until = formatDay(preview.period.to);
  const inputs = new Map();
  let leftoverEdited = false;

  const remainingText = el('p', { class: 'pf-remaining', role: 'status' });
  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });
  const confirm = el('button', { type: 'submit', class: 'btn-primary', text: 'Confirm' });

  /** What each line means, and what it is short by. */
  function lineDetail(line) {
    const notCounted = line.missing > 0 ? ` ${line.missing} in another currency not counted.` : '';
    if (line.step === 'savings') {
      const rule = preview.savings;
      if (rule.fixedMinor === 0 && rule.percent === 0) return 'No savings portion is set yet (Settings → Payday).';
      if (rule.percent === 0) return 'Your set amount.';
      const base = rule.percentBase === 'disposable'
        ? `disposable income (${money(rule.base)} after fixed and regulars)`
        : `the salary (${money(rule.base)})`;
      return `${rule.fixedMinor > 0 ? `${money(rule.fixedMinor)} plus ` : ''}${percentText(rule.percent)}% of ${base}: ${money(rule.percentPart)}.`;
    }
    if (line.step === 'fixed') return `Due until ${until}: ${money(line.target)}. In the pot now: ${money(line.balance)}.${notCounted}`;
    if (line.step === 'regulars') return `Weekly estimates until ${until}: ${money(line.target)}. In the pot now: ${money(line.balance)}.${notCounted}`;
    return 'Whatever the steps above leave.';
  }

  /** The amounts as typed, or null while one of them cannot be read. */
  function readAmounts() {
    const amounts = {};
    try {
      for (const [step, input] of inputs) amounts[step] = potAmountInput(input.value, code);
    } catch {
      return null;
    }
    return amounts;
  }

  /** Keep the last line and the running total in step with the edits. */
  function update(editedStep) {
    if (editedStep === 'leftover') leftoverEdited = true;
    let amounts = readAmounts();
    if (amounts && !leftoverEdited && editedStep) {
      const others = BigInt(amounts.savings) + BigInt(amounts.fixed) + BigInt(amounts.regulars);
      const rest = salary > others ? salary - others : 0n;
      inputs.get('leftover').value = plainAmount(rest, precision);
      amounts = readAmounts();
    }
    if (!amounts) {
      remainingText.textContent = 'Check the amounts: one of them is not a number.';
      remainingText.classList.add('is-negative');
      confirm.disabled = true;
      return;
    }
    const total = Object.values(amounts).reduce((sum, minor) => sum + BigInt(minor), 0n);
    const over = total > salary;
    remainingText.textContent = over
      ? `Over the salary by ${money(total - salary)}.`
      : total === salary ? 'All of the salary is shared out.' : `Not shared out: ${money(salary - total)}. It stays outside the pots.`;
    remainingText.classList.toggle('is-negative', over);
    confirm.disabled = over || total === 0n;
  }

  const rows = preview.lines.map((line, index) => {
    const id = `pf-${line.step}`;
    const input = el('input', {
      id, type: 'text', inputMode: 'decimal', autocomplete: 'off', class: 'pf-amount',
      value: plainAmount(line.funded, precision), oninput: () => update(line.step)
    });
    inputs.set(line.step, input);
    return el('li', { class: 'pf-line' + (line.shortfall > 0n ? ' is-short' : '') },
      el('label', { for: id, class: 'pf-label' },
        el('span', { class: 'pf-step', text: String(index + 1) }),
        el('span', { text: line.step === 'leftover' ? `What is left → ${line.potName}`
          : line.step === 'savings' ? `${savingsRuleLabel(preview.savings, code, precision)} → ${line.potName}`
          : `${line.label} → ${line.potName}` })),
      input,
      el('p', { class: 'hint pf-detail', text: lineDetail(line) }),
      line.shortfall > 0n && el('p', { class: 'pf-short', text: `Short by ${money(line.shortfall)}.` }));
  });

  const form = el('form', {
    class: 'pot-sheet pf', novalidate: true,
    onsubmit: async event => {
      event.preventDefault();
      if (confirm.disabled) return;
      try {
        const amounts = readAmounts();
        if (!amounts) throw Error('Check the amounts: one of them is not a number.');
        // One batch, tied to the salary entry: a second attempt is refused by the ledger.
        const next = confirmPaydayFlow(ledger.state, preview.entry, amounts);
        confirm.disabled = true;
        closePopover({ restoreFocus: false });
        await saveLedger(next);
        showToast('Salary shared out between your pots. No bank account changed.');
      } catch (error) {
        confirm.disabled = false;
        errorBox.textContent = errorMessage(error);
        errorBox.hidden = false;
        if (!form.isConnected) showToast(errorMessage(error));
      }
    }
  },
    el('p', { class: 'note', text: `Salary of ${money(salary)} on ${formatDay(preview.entry.date)}. Change any line before you confirm.` }),
    preview.short.length > 0 && el('p', { class: 'pf-short', text: 'This salary does not cover every step. They are filled in order; nothing is taken from savings.' }),
    el('ol', { class: 'plain-list pf-lines' }, rows),
    remainingText, errorBox,
    el('div', { class: 'form-actions' },
      confirm,
      el('button', { type: 'button', class: 'btn-secondary', text: 'Not now', onclick: () => closePopover() })));

  update('');
  openPopover({ anchor, label: 'Payday preview', role: 'dialog', content: form });
}

// ---------------------------------------------------------------------------
// Three-month rollover, when the app opens
// ---------------------------------------------------------------------------

/**
 * Move unused funding that is past its months into savings, for the pots
 * the user switched this on for. Shows what moved, with Undo. Doing it again
 * moves nothing more.
 */
export async function runRolloverOnOpen() {
  try {
    const { state, moved } = applyRollover(ledger.state, todayIso());
    if (!moved.length) return;
    await saveLedger(state);

    const ids = moved.map(move => move.id);
    // One line per pot, never adding currencies together.
    const byPot = new Map();
    for (const move of moved) {
      const line = byPot.get(move.pot) || { ...move, minor: 0n };
      line.minor += move.minor;
      byPot.set(move.pot, line);
    }
    const parts = [...byPot.values()].map(line => `${formatMoney(line.minor, line.currency, line.precision)} from ${line.potName} to ${line.toName}`);
    showToast(`Unused money rolled over: ${parts.join('; ')}.`, {
      label: 'Undo',
      run: async () => {
        try {
          await saveLedger(undoRollover(ledger.state, ids));
          showToast('Put back. Those months stay in their pots.');
        } catch (error) {
          showToast(errorMessage(error));
        }
      }
    }, 20000);
  } catch (error) {
    showToast(errorMessage(error));
  }
}
