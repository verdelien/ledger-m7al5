// The wishlist: things to buy, each with a price and a deadline or a restock cycle.
//
// A wish can be saved towards in a pot ("Start saving"): that writes one pot allocation
// and nothing else. Pots are a plan for the money, so no bank account changes. Buying the
// item is an ordinary expense recorded on Today; saving that expense marks the wish as
// bought, or, for something bought again and again, sets its next restock date.
//
// Records keep the shape the previous version wrote:
//   { id, name, amount (decimal text), currency, deadlineKind, deadline, restockMonths,
//     reviewMonths, nextReview, lastReviewed?, nextRestock?, pot, status }

import { commit, commitBatch, uid, potBalance } from './model.js';
import { digits, parseAmount, validDate } from './domain.js';
import { addMonths } from './planning.js';

export const WISH_DEADLINE_KINDS = [
  ['exact', 'On a date'],
  ['within3', 'Within three months'],
  ['midyear', 'By midyear'],
  ['yearend', 'By the end of the year'],
  ['restock', 'Restock cycle'],
  ['none', 'No deadline']
];
export const WISH_REVIEW_CHOICES = [[0, 'Off'], [1, 'Every month'], [3, 'Every three months'], [6, 'Every six months']];
const WISH_STATUSES = ['open', 'saving', 'purchased', 'dropped'];
const WISH_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Handed from the wishlist to the Today form by "Record purchase": the id of the wish
 * being bought. Today reads it once when it next draws, then clears it.
 */
export const wishPurchase = { id: '' };

function wishFind(state, id) {
  const wish = state.wishlist.find(w => w.id === id);
  if (!wish) throw Error('That wish no longer exists.');
  return wish;
}

/** Minor units as plain decimal text: 12000 → '120.00'. */
function wishAmountText(minor, precision) {
  const text = String(minor).padStart(precision + 1, '0');
  return precision ? `${text.slice(0, -precision)}.${text.slice(-precision)}` : text;
}

/** A wish's price in minor units; 0 when the stored text cannot be read. */
export function wishPriceMinor(wish) {
  try { return parseAmount(String(wish.amount ?? ''), wish.currency); } catch { return 0; }
}

/** '2027-06-30' → '30 Jun 2027'. */
export function wishDateWords(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return `${day} ${WISH_MONTHS[month - 1]} ${year}`;
}

/** The deadline in words: "by 30 Jun 2027", "restock every 3 months", "no deadline". */
export function wishDeadlineWords(wish) {
  if (wish.deadlineKind === 'restock') {
    const months = wish.restockMonths || 3;
    const every = months === 1 ? 'restock every month' : `restock every ${months} months`;
    const next = wish.nextRestock || wish.deadline;
    return next ? `${every} · next ${wishDateWords(next)}` : every;
  }
  return wish.deadline ? `by ${wishDateWords(wish.deadline)}` : 'no deadline';
}

/**
 * The date a wish is due, from its deadline type.
 *   none → ''; within3 → today + 3 months; midyear → this year's 30 June (next year's once
 *   that has passed); yearend → this year's 31 December; exact / restock → the given date.
 */
export function computeDeadline(kind, date, today) {
  const year = today.slice(0, 4);
  if (kind === 'none') return '';
  if (kind === 'within3') return addMonths(today, 3);
  if (kind === 'midyear') return `${today > `${year}-06-30` ? Number(year) + 1 : year}-06-30`;
  if (kind === 'yearend') return `${year}-12-31`;
  if (kind === 'exact' || kind === 'restock') return date || '';
  throw Error('Choose a deadline type.');
}

/**
 * Add a wish, or change one (fields.id). Returns the new ledger.
 * fields: { id?, name, amountText, currency, deadlineKind, deadline, restockMonths, reviewMonths, pot }
 * The review date is set when the reminder is first chosen or its interval changes;
 * otherwise an edit leaves it where it was.
 */
export function saveWish(state, fields, today) {
  const old = fields.id ? wishFind(state, fields.id) : null;
  const name = String(fields.name ?? '').trim();
  if (!name) throw Error('Give the item a name.');
  if (name.length > 150) throw Error('The name can be at most 150 characters.');

  const currency = fields.currency;
  if (!state.settings.activeCurrencies.includes(currency)) throw Error('Choose one of your active currencies.');
  let minor;
  try { minor = parseAmount(String(fields.amountText ?? ''), currency); } catch {
    throw Error(`Enter a price above zero with at most ${digits(currency)} decimal places, without thousands separators.`);
  }

  const kind = fields.deadlineKind;
  if (!WISH_DEADLINE_KINDS.some(([value]) => value === kind)) throw Error('Choose a deadline type.');
  const given = fields.deadline || '';
  if (kind === 'exact' || kind === 'restock') {
    if (!validDate(given)) throw Error(kind === 'restock' ? 'Choose the date of the next restock.' : 'Choose the date you want it by.');
  }
  const restockMonths = fields.restockMonths === '' || fields.restockMonths == null ? 3 : Number(fields.restockMonths);
  if (!Number.isInteger(restockMonths) || restockMonths < 1 || restockMonths > 120) throw Error('Restock interval must be 1 to 120 months.');
  const reviewMonths = Number(fields.reviewMonths || 0);
  if (!WISH_REVIEW_CHOICES.some(([value]) => value === reviewMonths)) throw Error('Choose a review reminder from the list.');

  const pot = fields.pot || '';
  if (pot) {
    const target = state.pots.find(p => p.id === pot);
    if (!target) throw Error('That pot no longer exists.');
    if (target.currency !== currency) throw Error(`Choose a pot in ${currency}, the currency of the price.`);
  }

  const deadline = computeDeadline(kind, given, today);
  const record = {
    ...old,
    id: old?.id || uid(),
    name,
    amount: wishAmountText(minor, digits(currency)),
    currency,
    deadlineKind: kind,
    deadline,
    restockMonths,
    reviewMonths,
    nextReview: !reviewMonths ? ''
      : old && Number(old.reviewMonths) === reviewMonths && old.nextReview ? old.nextReview
      : addMonths(today, reviewMonths),
    pot,
    status: old?.status || 'open'
  };
  if (kind === 'restock') record.nextRestock = deadline;
  else delete record.nextRestock;
  return commit(state, 'wishlist', record);
}

/** A pot that exists for this wish: it carries the wish's name, or has a target. */
function wishPotIsDedicated(wish, pot) {
  return Boolean(pot) && (pot.name === wish.name || pot.target != null);
}

/**
 * "Start saving" / "Add more": put `amountText` aside for a wish.
 *   fromPot  '' = new money, or a pot in the same currency to take it from
 *   toPot    '' = make a savings pot named after the wish, with the price as its target
 * Writes one allocation and links the wish to the pot (status 'saving'). No bank account changes.
 */
export function fundWish(state, { wishId, amountText, fromPot = '', toPot = '', today }) {
  const wish = wishFind(state, wishId);
  if (!['open', 'saving'].includes(wish.status)) throw Error('This wish is closed. Put it back on the list first.');
  let minor;
  try { minor = parseAmount(String(amountText ?? ''), wish.currency); } catch {
    throw Error(`Enter an amount above zero with at most ${digits(wish.currency)} decimal places.`);
  }
  const precision = digits(wish.currency);
  const operations = [];

  let to = toPot;
  if (to) {
    const target = state.pots.find(p => p.id === to);
    if (!target) throw Error('That pot no longer exists.');
    if (target.currency !== wish.currency) throw Error(`Choose a pot in ${wish.currency}, the currency of the price.`);
  } else {
    to = uid();
    operations.push({
      table: 'pots',
      record: {
        id: to, name: wish.name, kind: 'savings', currency: wish.currency, precision,
        target: wishPriceMinor(wish), protected: false, archived: false
      }
    });
  }

  if (fromPot) {
    const source = state.pots.find(p => p.id === fromPot);
    if (!source) throw Error('The pot to take the money from no longer exists.');
    if (source.id === to) throw Error('Choose a different pot to take the money from.');
    if (source.currency !== wish.currency) throw Error(`Take the money from a pot in ${wish.currency}.`);
    if (potBalance(state, source.id, today).minor < BigInt(minor)) throw Error(`${source.name} does not hold that much.`);
  }

  operations.push({
    table: 'allocations',
    record: { id: uid(), date: today, from: fromPot || '', to, minor, note: `Saving for ${wish.name}` }
  });
  operations.push({ table: 'wishlist', record: { ...wish, pot: to, status: 'saving' } });
  return commitBatch(state, operations);
}

/** "Reviewed": note today and move the reminder on by the wish's interval. */
export function markReviewed(state, id, today) {
  const wish = wishFind(state, id);
  const months = Number(wish.reviewMonths || 0);
  return commit(state, 'wishlist', { ...wish, lastReviewed: today, nextReview: months ? addMonths(today, months) : '' });
}

/** Drop a wish, or put a closed one back on the list. */
export function setWishStatus(state, id, status) {
  if (!WISH_STATUSES.includes(status)) throw Error('Unknown wishlist status.');
  return commit(state, 'wishlist', { ...wishFind(state, id), status });
}

/**
 * The wish record as it should be once it has been bought on `purchaseDate`.
 * A restock item goes back to 'open' with its next restock one interval later;
 * anything else becomes 'purchased'. Null when the wish is gone.
 */
export function purchasedWish(state, wishId, purchaseDate) {
  const wish = state.wishlist.find(w => w.id === wishId);
  if (!wish) return null;
  if (wish.deadlineKind === 'restock') {
    const next = addMonths(purchaseDate, wish.restockMonths || 3);
    return { ...wish, nextRestock: next, deadline: next, status: 'open' };
  }
  return { ...wish, status: 'purchased' };
}

/**
 * The pot a purchase of this wish is paid from: the wish's own pot, when it is in use,
 * in the wish's currency and holds money on `today`. Null otherwise, and the expense
 * then comes out of its category's pot as usual.
 */
export function wishPurchasePot(state, wishId, today) {
  const wish = state.wishlist.find(w => w.id === wishId);
  const pot = wish?.pot ? state.pots.find(p => p.id === wish.pot) : null;
  if (!pot || pot.archived || pot.currency !== wish.currency) return null;
  return potBalance(state, pot.id, today).minor > 0n ? pot : null;
}

function wishDaysBetween(from, to) {
  const utc = iso => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((utc(to) - utc(from)) / 86400000);
}

/**
 * The live wishes (open or saving), soonest deadline first, no deadline last.
 * Each: { wish, priceMinor, precision, pot, saved, progress, daysLeft, reviewDue }
 *   saved     the pot's balance (BigInt) when the pot is dedicated to this wish, else null
 *   progress  0–100 of the price, or null when saved is null
 *   daysLeft  days until the deadline (negative once past), or null without one
 */
export function wishRows(state, today) {
  return state.wishlist
    .filter(wish => wish.status === 'open' || wish.status === 'saving')
    .map(wish => {
      const pot = state.pots.find(p => p.id === wish.pot) || null;
      const priceMinor = wishPriceMinor(wish);
      const saved = wishPotIsDedicated(wish, pot) ? potBalance(state, pot.id, today).minor : null;
      let progress = null;
      if (saved !== null) {
        progress = priceMinor > 0 ? Number(saved * 100n / BigInt(priceMinor)) : 0;
        progress = Math.max(0, Math.min(100, progress));
      }
      return {
        wish, priceMinor, precision: digits(wish.currency), pot, saved, progress,
        daysLeft: wish.deadline ? wishDaysBetween(today, wish.deadline) : null,
        reviewDue: Boolean(wish.nextReview) && wish.nextReview <= today
      };
    })
    .sort((a, b) => (a.wish.deadline || '9999-99-99').localeCompare(b.wish.deadline || '9999-99-99')
      || a.wish.name.localeCompare(b.wish.name));
}

/** Bought and dropped wishes, most recently changed first (at most `limit`). */
export function wishDone(state, limit = 20) {
  return state.wishlist.filter(w => w.status === 'purchased' || w.status === 'dropped').slice(-limit).reverse();
}
