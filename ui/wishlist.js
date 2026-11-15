// The wishlist, shown on the Pots tab below the pots: things to buy, what has been put
// aside for each, and the way into "Record purchase" (an ordinary expense on Today).
// The rules live in wishlist-logic.js. Saving towards a wish only writes a pot
// allocation: no bank account changes.

import { potBalance } from '../model.js';
import {
  WISH_DEADLINE_KINDS, WISH_REVIEW_CHOICES, wishPurchase, saveWish, fundWish, markReviewed, setWishStatus,
  wishRows, wishDone, wishPriceMinor, wishDeadlineWords, wishDateWords
} from '../wishlist-logic.js';
import { el, sectionTitle, todayIso, formatMoney, plainAmount, errorMessage, showToast } from './dom.js';
import { ledger, saveLedger } from './ledger.js';
import { openPopover, closePopover } from './popover.js';

function wishMoney(minor, wish) {
  return formatMoney(minor, wish.currency, wishRowPrecision(wish));
}

function wishRowPrecision(wish) {
  const text = String(wish.amount ?? '');
  return text.includes('.') ? text.length - text.indexOf('.') - 1 : 0;
}

function wishField(id, label, control, hint = null) {
  return el('div', { class: 'field' }, el('label', { for: id, text: label }), control, hint && el('p', { class: 'hint', text: hint }));
}

/** "in 12 days", "today", "5 days late". */
function wishDaysWords(days) {
  if (days === 0) return 'today';
  const count = Math.abs(days) === 1 ? '1 day' : `${Math.abs(days)} days`;
  return days > 0 ? `in ${count}` : `${count} late`;
}

/** Run a change, save it, and say so; an error is shown in `errorBox` when it is still on screen. */
async function wishApply(change, message, errorBox = null) {
  try {
    const next = change(ledger.state);
    closePopover({ restoreFocus: false });
    await saveLedger(next);
    showToast(message);
  } catch (error) {
    if (errorBox?.isConnected) {
      errorBox.textContent = errorMessage(error);
      errorBox.hidden = false;
    } else showToast(errorMessage(error));
  }
}

// ---------------------------------------------------------------------------
// The section on the Pots tab
// ---------------------------------------------------------------------------

/** The nodes of the Wishlist section, for renderPots to place. */
export function wishlistSection(state, today) {
  const rows = wishRows(state, today);
  const done = wishDone(state);
  return [
    sectionTitle('Wishlist'),
    rows.length
      ? el('ul', { class: 'plain-list wl-list' }, rows.map(wishRow))
      : el('p', { class: 'empty', text: 'Nothing on the wishlist. Add something you plan to buy, and save towards it in a pot.' }),
    el('details', { class: 'fold' },
      el('summary', { text: 'Add a wish' }),
      wishForm(state, null)),
    done.length > 0 && el('details', { class: 'fold' },
      el('summary', { text: `Done (${done.length})` }),
      el('ul', { class: 'plain-list fold-body' }, done.map(wishDoneRow)))
  ];
}

function wishRow(row) {
  const { wish, priceMinor, saved, progress, daysLeft, reviewDue } = row;
  const late = daysLeft !== null && daysLeft < 0;
  const meta = [wishDeadlineWords(wish), daysLeft !== null && wishDaysWords(daysLeft)].filter(Boolean).join(' · ');

  const open = el('button', {
    type: 'button', class: 'pot-open wl-open', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'data-focus': `wish:${wish.id}`,
    'aria-label': `${wish.name}, ${wishMoney(priceMinor, wish)}, ${meta}${reviewDue ? ', review due' : ''}`,
    onclick: () => openWishSheet(open, wish.id)
  },
    el('span', { class: 'entry-text' },
      el('span', { class: 'entry-title wl-title' },
        el('span', { text: wish.name }),
        reviewDue && el('span', { class: 'wl-tag', text: 'Review due' })),
      el('span', { class: 'entry-meta wl-wrap' + (late ? ' wl-late' : ''), text: meta }),
      saved !== null && el('span', { class: 'wl-saved' },
        el('span', { class: 'tv-meter', 'aria-hidden': 'true' }, el('span', { class: 'tv-meter-fill', style: `width:${progress}%` })),
        el('span', { class: 'entry-meta', text: `${wishMoney(saved, wish)} saved · ${progress}%` }))),
    el('span', { class: 'entry-amount', text: wishMoney(priceMinor, wish) }));

  return el('li', { class: 'list-row wl-row' }, open);
}

function wishDoneRow(wish) {
  const back = el('button', {
    type: 'button', class: 'btn-text', text: 'Put back', 'aria-label': `Put ${wish.name} back on the wishlist`,
    onclick: () => wishApply(s => setWishStatus(s, wish.id, wish.pot ? 'saving' : 'open'), `${wish.name} is back on the wishlist.`)
  });
  return el('li', { class: 'list-row' },
    el('span', { class: 'entry-text' },
      el('span', { class: 'entry-title', text: wish.name }),
      el('span', { class: 'entry-meta', text: `${wish.status === 'purchased' ? 'Bought' : 'Dropped'} · ${wishMoney(wishPriceMinor(wish), wish)}` })),
    back);
}

// ---------------------------------------------------------------------------
// One wish's sheet
// ---------------------------------------------------------------------------

function openWishSheet(anchor, id) {
  const state = ledger.state;
  const today = todayIso();
  const row = wishRows(state, today).find(r => r.wish.id === id);
  if (!row) return;
  const { wish, priceMinor, pot, saved, progress, daysLeft, reviewDue } = row;
  const fact = (label, value) => el('div', { class: 'pot-fact' }, el('dt', { text: label }), el('dd', { text: value }));
  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });
  const months = Number(wish.reviewMonths || 0);

  let armed = false;
  const drop = el('button', { type: 'button', class: 'btn-text', text: 'Drop' });
  drop.addEventListener('blur', () => { armed = false; drop.textContent = 'Drop'; drop.classList.remove('is-armed'); });
  drop.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      drop.textContent = 'Press again to drop';
      drop.classList.add('is-armed');
      return;
    }
    wishApply(s => setWishStatus(s, id, 'dropped'),
      pot ? `${wish.name} dropped. What you saved is still in ${pot.name}.` : `${wish.name} dropped.`, errorBox);
  });

  const content = el('div', { class: 'pot-sheet wl-sheet' },
    el('dl', { class: 'pot-facts' },
      fact('Price', wishMoney(priceMinor, wish)),
      fact('Deadline', wishDeadlineWords(wish) + (daysLeft !== null ? ` (${wishDaysWords(daysLeft)})` : '')),
      saved !== null && fact(`Saved in ${pot.name}`, `${wishMoney(saved, wish)} · ${progress}%`),
      saved === null && pot && fact('Pot', pot.name),
      months > 0 && fact('Review', wish.nextReview ? (reviewDue ? `due since ${wishDateWords(wish.nextReview)}` : `next ${wishDateWords(wish.nextReview)}`) : 'on')),
    saved === null && pot && el('p', { class: 'hint', text: `${pot.name} is shared with other things, so no saved amount is shown for this wish.` }),
    errorBox,
    el('div', { class: 'wl-actions' },
      el('button', {
        type: 'button', class: 'btn-primary btn-small', text: 'Record purchase',
        onclick: () => {
          closePopover({ restoreFocus: false });
          wishPurchase.id = id;
          location.hash = '#today';
        }
      }),
      el('button', {
        type: 'button', class: 'btn-secondary btn-small', text: wish.status === 'saving' ? 'Add more' : 'Start saving',
        onclick: () => openPopover({ anchor, label: `Save for ${wish.name}`, role: 'dialog', content: wishFundForm(ledger.state, row, today) })
      }),
      el('button', {
        type: 'button', class: 'btn-secondary btn-small', text: 'Edit',
        onclick: () => openPopover({ anchor, label: `Edit ${wish.name}`, role: 'dialog', content: wishForm(ledger.state, wish) })
      }),
      months > 0 && el('button', {
        type: 'button', class: 'btn-secondary btn-small', text: 'Reviewed',
        onclick: () => wishApply(s => markReviewed(s, id, todayIso()), `Reviewed. Next reminder in ${months === 1 ? 'a month' : months + ' months'}.`, errorBox)
      }),
      drop),
    el('p', { class: 'hint', text: 'Record purchase opens Today with the price filled in. Saving that expense closes this wish.' }));

  openPopover({ anchor, label: wish.name, role: 'dialog', content });
}

// ---------------------------------------------------------------------------
// Start saving / Add more
// ---------------------------------------------------------------------------

function wishFundForm(state, row, today) {
  const { wish, priceMinor, saved } = row;
  const precision = wishRowPrecision(wish);
  const pots = state.pots.filter(p => !p.archived && p.currency === wish.currency);
  const held = pot => formatMoney(potBalance(state, pot.id, today).minor, pot.currency, pot.precision);
  const remaining = saved !== null ? BigInt(priceMinor) - saved : BigInt(priceMinor);

  const amount = el('input', {
    id: 'wish-fund-amount', type: 'text', inputMode: 'decimal', autocomplete: 'off',
    value: remaining > 0n ? plainAmount(remaining, precision) : ''
  });
  const from = el('select', { id: 'wish-fund-from' },
    el('option', { value: '', text: 'New money (not from a pot)' }),
    pots.map(p => el('option', { value: p.id, text: `${p.name} · ${held(p)}` })));
  const to = el('select', { id: 'wish-fund-to' },
    el('option', { value: '', text: `A new pot called “${wish.name}”` }),
    pots.map(p => el('option', { value: p.id, text: `${p.name} · ${held(p)}` })));
  if (pots.some(p => p.id === wish.pot)) to.value = wish.pot;
  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });

  return el('form', {
    class: 'pot-sheet', novalidate: true,
    onsubmit: event => {
      event.preventDefault();
      const text = amount.value.trim();
      wishApply(
        s => fundWish(s, { wishId: wish.id, amountText: text, fromPot: from.value, toPot: to.value, today: todayIso() }),
        `Put ${text} ${wish.currency} aside for ${wish.name}.`, errorBox);
    }
  },
    el('p', { class: 'note', text: 'This sets money aside in a pot. No bank account changes.' }),
    wishField('wish-fund-amount', `Amount to set aside now (${wish.currency})`, amount),
    wishField('wish-fund-from', 'Take it from', from),
    wishField('wish-fund-to', 'Save it in', to),
    errorBox,
    el('button', { type: 'submit', class: 'btn-primary btn-small', text: 'Save' }));
}

// ---------------------------------------------------------------------------
// Add / edit
// ---------------------------------------------------------------------------

function wishForm(state, wish) {
  const key = wish ? 'wish-edit' : 'wish-new';
  const currencies = [...new Set([...state.settings.activeCurrencies, wish?.currency].filter(Boolean))];
  const startCurrency = wish?.currency
    || (currencies.includes(state.settings.reportingCurrency) ? state.settings.reportingCurrency : currencies[0]);

  const name = el('input', { id: `${key}-name`, type: 'text', maxLength: 150, autocomplete: 'off', value: wish?.name || '' });
  const amount = el('input', { id: `${key}-amount`, type: 'text', inputMode: 'decimal', autocomplete: 'off', value: wish?.amount || '' });
  const currency = el('select', { id: `${key}-currency` }, currencies.map(code => el('option', { value: code, text: code })));
  currency.value = startCurrency;
  const kind = el('select', { id: `${key}-kind` }, WISH_DEADLINE_KINDS.map(([value, text]) => el('option', { value, text })));
  kind.value = wish?.deadlineKind || 'exact';
  const date = el('input', { id: `${key}-date`, type: 'date', value: wish?.deadline || '' });
  const dateLabel = el('label', { for: `${key}-date` });
  const dateField = el('div', { class: 'field' }, dateLabel, date);
  const restock = el('input', {
    id: `${key}-restock`, type: 'number', inputMode: 'numeric', min: '1', max: '120', step: '1', value: String(wish?.restockMonths || 3)
  });
  const restockField = wishField(`${key}-restock`, 'Restock every (months)', restock);
  const review = el('select', { id: `${key}-review` }, WISH_REVIEW_CHOICES.map(([value, text]) => el('option', { value: String(value), text })));
  review.value = String(wish?.reviewMonths || 0);
  const pot = el('select', { id: `${key}-pot` });
  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });

  function syncPots() {
    const chosen = pot.options.length ? pot.value : wish?.pot || '';
    const pots = state.pots.filter(p => p.currency === currency.value && (!p.archived || p.id === wish?.pot));
    pot.replaceChildren(el('option', { value: '', text: 'None yet' }), ...pots.map(p => el('option', { value: p.id, text: p.name })));
    pot.value = pots.some(p => p.id === chosen) ? chosen : '';
  }
  function syncKind() {
    const needsDate = kind.value === 'exact' || kind.value === 'restock';
    dateField.hidden = !needsDate;
    dateLabel.textContent = kind.value === 'restock' ? 'Next restock' : 'Wanted by';
    restockField.hidden = kind.value !== 'restock';
  }
  currency.addEventListener('change', syncPots);
  kind.addEventListener('change', syncKind);
  syncPots();
  syncKind();

  return el('form', {
    class: wish ? 'pot-sheet' : 'fold-body', novalidate: true,
    onsubmit: event => {
      event.preventDefault();
      const itemName = name.value.trim();
      wishApply(s => saveWish(s, {
        id: wish?.id, name: itemName, amountText: amount.value.trim(), currency: currency.value,
        deadlineKind: kind.value, deadline: date.value,
        restockMonths: kind.value === 'restock' ? restock.value.trim() : wish?.restockMonths ?? 3,
        reviewMonths: Number(review.value), pot: pot.value
      }, todayIso()), wish ? `${itemName} updated.` : `${itemName} is on the wishlist.`, errorBox);
    }
  },
    wishField(`${key}-name`, 'Item', name),
    el('div', { class: 'field-pair' },
      wishField(`${key}-amount`, 'Price', amount),
      wishField(`${key}-currency`, 'Currency', currency)),
    wishField(`${key}-kind`, 'Deadline', kind),
    dateField,
    restockField,
    wishField(`${key}-review`, 'Review reminder', review),
    wishField(`${key}-pot`, 'Pot (optional)', pot, 'Where the money is likely to come from. “Start saving” can make a pot just for this.'),
    errorBox,
    el('div', { class: 'form-actions' },
      el('button', { type: 'submit', class: 'btn-primary btn-small', text: wish ? 'Save' : 'Add to wishlist' })));
}
