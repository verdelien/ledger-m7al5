// The payday rule. Pure date arithmetic on YYYY-MM-DD strings: no clock, no
// time zones, no state changes.
//
// Payday is a fixed day of the month (the 24th by default). When that day is
// a Saturday, a Sunday, an England & Wales bank holiday or one of the user's
// own extra holiday dates, payday is the last working day before it.

export const DEFAULT_PAYDAY = Object.freeze({ day: 24, rule: 'previous-working-day' });
export const PAYDAY_RULES = ['previous-working-day', 'exact'];

const paydayPad = number => String(number).padStart(2, '0');
const paydayIso = (year, month, day) => `${year}-${paydayPad(month)}-${paydayPad(day)}`;

/** A UTC date object for a calendar day. Only used for weekday arithmetic. */
function paydayUtc(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day));
}

function paydayIsoOf(date) {
  return date.toISOString().slice(0, 10);
}

/** Easter Sunday in the Gregorian calendar (anonymous Gregorian algorithm), as { month, day }. */
export function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

/** The first Monday of a month, or with `last`, the last one. */
function paydayMonday(year, month, last = false) {
  if (last) {
    const end = paydayUtc(year, month + 1, 0);
    end.setUTCDate(end.getUTCDate() - ((end.getUTCDay() + 6) % 7));
    return paydayIsoOf(end);
  }
  const start = paydayUtc(year, month, 1);
  start.setUTCDate(1 + ((8 - start.getUTCDay()) % 7));
  return paydayIsoOf(start);
}

// One-off changes to the usual pattern that have already been announced.
const BANK_HOLIDAY_MOVES = {
  2020: { earlyMay: '2020-05-08' },                                        // VE Day anniversary
  2022: { spring: '2022-06-02', extra: ['2022-06-03', '2022-09-19'] },      // Platinum Jubilee, state funeral
  2023: { extra: ['2023-05-08'] }                                          // Coronation
};

/**
 * England & Wales bank holidays for a year, as sorted YYYY-MM-DD strings.
 * Holidays that fall on a weekend are replaced by their substitute weekday.
 */
export function bankHolidays(year) {
  const moves = BANK_HOLIDAY_MOVES[year] || {};
  const days = [];

  // New Year's Day, or the Monday after when it falls on a weekend.
  const newYear = paydayUtc(year, 1, 1).getUTCDay();
  days.push(paydayIso(year, 1, newYear === 6 ? 3 : newYear === 0 ? 2 : 1));

  // Good Friday and Easter Monday.
  const easter = easterSunday(year);
  for (const offset of [-2, 1]) {
    days.push(paydayIsoOf(paydayUtc(year, easter.month, easter.day + offset)));
  }

  days.push(moves.earlyMay || paydayMonday(year, 5));         // early May
  days.push(moves.spring || paydayMonday(year, 5, true));     // spring
  days.push(paydayMonday(year, 8, true));                     // summer

  // Christmas Day and Boxing Day, with substitutes after a weekend.
  const christmas = paydayUtc(year, 12, 25).getUTCDay();
  if (christmas === 5) days.push(paydayIso(year, 12, 25), paydayIso(year, 12, 28));      // Fri, Sat → Mon
  else if (christmas === 6) days.push(paydayIso(year, 12, 27), paydayIso(year, 12, 28)); // Sat, Sun → Mon, Tue
  else if (christmas === 0) days.push(paydayIso(year, 12, 26), paydayIso(year, 12, 27)); // Sun, Mon → Mon, Tue
  else days.push(paydayIso(year, 12, 25), paydayIso(year, 12, 26));

  days.push(...(moves.extra || []));
  return days.sort();
}

/** The payday setting with defaults filled in. Accepts the settings object or nothing. */
export function paydaySetting(settings) {
  return { ...DEFAULT_PAYDAY, ...(settings?.payday || {}) };
}

/** True on Monday to Friday unless the day is a bank holiday or one of settings.holidays. */
export function isWorkingDay(iso, settings) {
  const [year, month, day] = iso.split('-').map(Number);
  const weekday = paydayUtc(year, month, day).getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  if ((settings?.holidays || []).includes(iso)) return false;
  return !bankHolidays(year).includes(iso);
}

/**
 * Payday in a given month (month is 1 to 12), as YYYY-MM-DD.
 * A day past the end of a short month means its last day.
 */
export function paydayFor(year, month, settings) {
  const { day, rule } = paydaySetting(settings);
  const lastDay = paydayUtc(year, month + 1, 0).getUTCDate();
  const date = paydayUtc(year, month, Math.min(day, lastDay));
  if (rule === 'previous-working-day') {
    while (!isWorkingDay(paydayIsoOf(date), settings)) date.setUTCDate(date.getUTCDate() - 1);
  }
  return paydayIsoOf(date);
}

/** The first payday on or after `fromDate` (YYYY-MM-DD). */
export function nextPayday(fromDate, settings) {
  let [year, month] = fromDate.split('-').map(Number);
  for (let step = 0; step < 3; step++) {
    const payday = paydayFor(year, month, settings);
    if (payday >= fromDate) return payday;
    month++;
    if (month > 12) { month = 1; year++; }
  }
  throw Error('No payday found.');
}

/** Throws when a stored payday setting or holiday list is not usable. Called by validateState. */
export function validatePaydaySettings(settings) {
  if (settings.payday != null) {
    const { day, rule } = settings.payday;
    if (!Number.isInteger(day) || day < 1 || day > 31) throw Error('Payday must be a day from 1 to 31.');
    if (!PAYDAY_RULES.includes(rule)) throw Error('Unknown payday rule.');
  }
  if (settings.holidays != null) {
    if (!Array.isArray(settings.holidays)) throw Error('Extra holidays must be a list of dates.');
    for (const iso of settings.holidays) {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
      if (!match || paydayIsoOf(paydayUtc(+match[1], +match[2], +match[3])) !== iso) throw Error('Extra holidays must be valid dates.');
    }
  }
}
