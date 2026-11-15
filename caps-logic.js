// Spending targets ("spend £1,000 on this card between two dates", e.g. a
// card offer). Pure functions over the ledger state.
//
// A target (`state.caps`, the shape the previous version also reads):
//   { id, name, account, start, end, minor, threshold, archived }
// `minor` is in the account's currency; `threshold` is the percentage at
// which a heads-up is given (default 80). An entry counts when it is posted,
// on that account, dated inside the period and marked `eligible: true`:
// expenses add, refunds take away (see capUsed in features.js).

import { parseAmount, validDate } from './domain.js';
import { commit, uid } from './model.js';
import { capUsed } from './features.js';

const CAP_DEFAULT_THRESHOLD = 80;
const capThreshold = cap => cap.threshold ?? CAP_DEFAULT_THRESHOLD;
const capDayNumber = iso => Math.round(Date.parse(iso + 'T12:00:00Z') / 86400000);

/** Add a spending target, or change one (`fields.id` set). Throws a readable error when something is missing. */
export function saveCap(s, fields) {
  const old = fields.id ? s.caps.find(c => c.id === fields.id) : null;
  if (fields.id && !old) throw Error('That spending target no longer exists.');
  const name = String(fields.name ?? '').trim();
  if (!name) throw Error('Give the spending target a name.');
  if (name.length > 150) throw Error('Use a name of at most 150 characters.');
  const account = s.accounts.find(a => a.id === fields.account);
  if (!account || (account.archived && old?.account !== account.id)) throw Error('Choose the account the spending counts on.');
  const start = String(fields.start ?? ''), end = String(fields.end ?? '');
  if (!validDate(start)) throw Error('Choose the first date.');
  if (!validDate(end)) throw Error('Choose the last date.');
  if (end < start) throw Error('The last date cannot be before the first date.');
  let minor;
  try { minor = parseAmount(String(fields.amount ?? ''), account.currency); } catch {
    throw Error(`Enter an amount above zero in ${account.currency} with at most ${account.precision} decimal places.`);
  }
  const thresholdText = String(fields.threshold ?? '').trim();
  const threshold = thresholdText === '' ? CAP_DEFAULT_THRESHOLD : Number(thresholdText);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 100) throw Error('Set the heads-up between 1 and 100 percent.');
  return commit(s, 'caps', { ...(old || {}), id: old?.id || uid(), name, account: account.id, start, end, minor, threshold });
}

/** Put a spending target away. Its entries keep their mark; nothing else changes. */
export function archiveCap(s, id) {
  const cap = s.caps.find(c => c.id === id);
  if (!cap) throw Error('That spending target no longer exists.');
  return cap.archived ? s : commit(s, 'caps', { ...cap, archived: true });
}

/** The targets an entry on `accountId` dated `date` can count towards. */
export function activeCaps(s, accountId, date) {
  if (!accountId || !date) return [];
  return s.caps.filter(c => !c.archived && c.account === accountId && c.start <= date && date <= c.end);
}

function capStatus(cap, used, today) {
  if (used >= BigInt(cap.minor)) return 'reached';
  if (today > cap.end) return 'ended';
  return used * 100n >= BigInt(cap.minor) * BigInt(capThreshold(cap)) ? 'alert' : 'ok';
}

/**
 * One row per target that is not archived, soonest end first:
 * { cap, used, left, percent, daysLeft, status }. `used` and `left` are minor
 * units of the account's currency (`used` can be below zero after refunds);
 * `percent` is 0 to 100; `daysLeft` counts today, and is 0 once it has ended.
 */
export function capRows(s, today) {
  return s.caps.filter(c => !c.archived)
    .sort((a, b) => a.end.localeCompare(b.end) || a.name.localeCompare(b.name))
    .map(cap => {
      const usedBig = capUsed(s, cap), total = BigInt(cap.minor);
      const used = Number(usedBig);
      const percent = usedBig <= 0n ? 0 : usedBig >= total ? 100 : Number(usedBig * 100n / total);
      return {
        cap, used, left: Math.max(0, cap.minor - used), percent,
        daysLeft: today > cap.end ? 0 : capDayNumber(cap.end) - capDayNumber(today),
        status: capStatus(cap, usedBig, today)
      };
    });
}

/**
 * Did a save take the target past a line? 'reached' when it went from below
 * the amount to it or over, 'alert' when it passed the heads-up percentage,
 * otherwise null. `before` and `after` are ledger states.
 */
export function capCrossing(before, after, cap) {
  const was = capUsed(before, cap), now = capUsed(after, cap), total = BigInt(cap.minor);
  if (was < total && now >= total) return 'reached';
  const line = total * BigInt(capThreshold(cap));
  return was * 100n < line && now * 100n >= line ? 'alert' : null;
}
