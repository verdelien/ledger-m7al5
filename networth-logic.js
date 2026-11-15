// Net worth and investment valuations.
//
// An investment account's worth is whatever its provider says it is, so the user records
// a valuation now and then. Gain or loss is that value minus what was paid in: the
// account's `initialContributions` (paid in before tracking began) plus transfers in,
// minus transfers out. Net worth is listed per currency; currencies are never added
// together and nothing is converted.

import { commit, uid, accountBalance } from './model.js';
import { digits, validDate } from './domain.js';
import { sharedBalance } from './planning.js';
import { investment } from './features.js';

/** Account types that can carry a recorded value. */
const NETWORTH_VALUED_TYPES = ['investment', 'savings'];

/** '1234.50' → 123450 minor units. Zero is allowed; negatives and thousands separators are not. */
function networthParseAmount(text, currency, precision) {
  const places = precision ?? digits(currency);
  const match = /^(\d+)(?:[.,](\d+))?$/.exec(String(text ?? '').trim());
  if (!match || (match[2] || '').length > places) {
    throw Error(`Enter an amount of zero or more with at most ${places} decimal places, without thousands separators.`);
  }
  const minor = BigInt(match[1]) * 10n ** BigInt(places) + BigInt((match[2] || '').padEnd(places, '0') || '0');
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Amount is outside the supported range.');
  return Number(minor);
}

function networthAccount(state, accountId) {
  const account = state.accounts.find(a => a.id === accountId);
  if (!account) throw Error('Account not found.');
  return account;
}

/** Valuations of one account, newest first. */
function networthHistory(state, accountId) {
  return state.valuations
    .filter(v => v.account === accountId)
    .sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Record what an investment or savings account was worth on a date.
 * A second value for the same account and date replaces the first.
 */
export function saveValuation(state, { accountId, date, amountText, today }) {
  const account = networthAccount(state, accountId);
  if (!NETWORTH_VALUED_TYPES.includes(account.type)) throw Error('Only investment and savings accounts have a recorded value.');
  if (!validDate(date)) throw Error('Choose a valid date.');
  if (date < account.openingDate) throw Error(`${account.name} opens on ${account.openingDate}. Choose that date or a later one.`);
  if (date > today) throw Error('A value cannot be recorded for a future date.');
  if (!String(amountText ?? '').trim()) throw Error('Enter the value.');
  const minor = networthParseAmount(amountText, account.currency, account.precision);
  const existing = state.valuations.find(v => v.account === accountId && v.date === date);
  return commit(state, 'valuations', { id: existing?.id || uid(), account: accountId, date, minor });
}

export function deleteValuation(state, id) {
  const record = state.valuations.find(v => v.id === id);
  if (!record) throw Error('That value no longer exists.');
  return commit(state, 'valuations', record, 'delete');
}

/** What had been paid into an investment account before tracking began. '' forgets it. */
export function setInitialContributions(state, accountId, amountText) {
  const account = networthAccount(state, accountId);
  if (account.type !== 'investment') throw Error('Only investment accounts record what was paid in.');
  const next = { ...account };
  if (String(amountText ?? '').trim() === '') delete next.initialContributions;
  else next.initialContributions = networthParseAmount(amountText, account.currency, account.precision);
  return commit(state, 'accounts', next);
}

/** Each investment account in use: paid in, latest value, gain or loss, and its values newest first. */
export function investmentRows(state, today) {
  return state.accounts
    .filter(account => account.type === 'investment' && !account.archived)
    .map(account => {
      const { contributions, valuation, complete, growth } = investment(state, account.id, today);
      return { account, contributions, valuation, growth, complete, history: networthHistory(state, account.id) };
    });
}

/**
 * Net worth, one line per currency: accounts (card debt is negative), investment accounts
 * at their latest recorded value, and what friends owe (negative when I owe them).
 * An investment account with no recorded value falls back to its balance, flagged `estimated`.
 * Parts worth nothing are left out, and so is a currency with no parts.
 */
export function netWorth(state, today) {
  const groups = new Map();
  const add = (currency, precision, part) => {
    const minor = BigInt(part.minor);
    if (minor === 0n) return;
    const key = `${currency}:${precision}`;
    if (!groups.has(key)) groups.set(key, { currency, precision, minor: 0n, parts: [] });
    const group = groups.get(key);
    group.minor += minor;
    group.parts.push({ ...part, minor });
  };

  for (const account of state.accounts) {
    if (account.type === 'investment') {
      const valuation = state.valuations
        .filter(v => v.account === account.id && v.date <= today)
        .sort((a, b) => b.date.localeCompare(a.date))[0];
      const part = valuation
        ? { label: account.name, minor: valuation.minor, kind: 'investment', date: valuation.date }
        : { label: account.name, minor: accountBalance(state, account.id, today), kind: 'investment', estimated: true };
      add(account.currency, account.precision, part);
    } else {
      add(account.currency, account.precision, { label: account.name, minor: accountBalance(state, account.id, today), kind: 'account' });
    }
  }

  for (const friend of state.friends) {
    const currencies = new Set([
      ...state.entries.filter(e => e.friend === friend.id).map(e => e.currency),
      ...state.settlements.filter(r => r.friend === friend.id).map(r => r.currency)
    ]);
    for (const currency of currencies) {
      add(currency, digits(currency), { label: friend.name, minor: sharedBalance(state, friend.id, currency), kind: 'friends' });
    }
  }

  const reporting = state.settings.reportingCurrency;
  return [...groups.values()].sort((a, b) =>
    (a.currency === reporting ? 0 : 1) - (b.currency === reporting ? 0 : 1) || a.currency.localeCompare(b.currency));
}
