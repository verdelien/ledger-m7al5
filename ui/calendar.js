// Calendar: a month grid where each day shows only the money spent, with
// planned amounts outlined and payday marked. Under it, the forecast.
// Every figure comes from ../forecast-view.js; this file only draws.

import { monthCells } from '../domain.js';
import { categoryPath } from '../model.js';
import { personalAmount } from '../money.js';
import { paydayFor } from '../payday.js';
import {
  FORECAST_RANGES, DEFAULT_FORECAST_RANGE, ALL_ACCOUNTS,
  monthBounds, forecastRange, calendarDays, cellAmount, compactAmount,
  forecastAccounts, defaultForecastAccount, forecastSummary, estimateTrust,
  forecastPotsOf, validateCustomRange
} from '../forecast-view.js';
import { el, slip, sectionTitle, todayIso, formatDay, formatMoney, errorMessage, showToast } from './dom.js';
import { ledger } from './ledger.js';
import { openPopover, closePopover } from './popover.js';
import { pixelIconNode, categoryIconNode, UI_ICONS } from './pixel-icons.js';
import { saveSettings } from './currencies.js';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const RANGE_KEY = 'expense-book.forecastRange';

/** The forecast range last chosen on this device, custom dates included. Anything unreadable falls back to the default. */
function loadRangeChoice() {
  const choice = { range: DEFAULT_FORECAST_RANGE, custom: null };
  try {
    const saved = JSON.parse(localStorage.getItem(RANGE_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      try { choice.custom = validateCustomRange(saved.from, saved.to); } catch { /* no custom dates kept */ }
      if (FORECAST_RANGES.some(r => r.id === saved.range) && (saved.range !== 'custom' || choice.custom)) choice.range = saved.range;
    }
  } catch { /* storage is blocked or holds something else: use the default */ }
  return choice;
}

function saveRangeChoice() {
  try {
    localStorage.setItem(RANGE_KEY, JSON.stringify({ range: calendarView.range, from: calendarView.custom?.from, to: calendarView.custom?.to }));
  } catch { /* the choice then lasts until the page is closed */ }
}

// View state kept between re-renders. Empty means "not chosen yet".
const calendarView = { month: '', account: '', ...loadRangeChoice() };

export function renderCalendar(root) {
  const state = ledger.state;
  const today = todayIso();
  if (!calendarView.month) calendarView.month = today.slice(0, 7);
  const rerender = () => { root.replaceChildren(); renderCalendar(root); };

  root.append(slip({ label: 'Calendar', kind: monthTitle(calendarView.month), wide: true },
    buildMonth(state, today, rerender),
    buildForecast(state, today, rerender)));
}

/** 'November 2026' for '2026-11'. */
function monthTitle(month) {
  const [year, number] = month.split('-').map(Number);
  return new Date(year, number - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

/** 'Thu 12 Nov', with the year when it is not this one. */
function shortDate(iso, today) {
  return formatDay(iso) + (iso.slice(0, 4) === today.slice(0, 4) ? '' : ' ' + iso.slice(0, 4));
}

/** '3 Dec' for '2026-12-03'. */
function dayMonth(iso) {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

// ---------------------------------------------------------------------------
// Month grid
// ---------------------------------------------------------------------------

function buildMonth(state, today, rerender) {
  const [year, month] = calendarView.month.split('-').map(Number);
  const { from, to } = monthBounds(calendarView.month + '-01');
  const days = calendarDays(state, from, to, today);
  const payday = paydayFor(year, month, state.settings);

  const step = count => {
    calendarView.month = monthBounds(calendarView.month + '-01', count).from.slice(0, 7);
    rerender();
  };
  const nav = el('div', { class: 'cal-nav' },
    el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Previous month', 'data-focus': 'cal-prev', onclick: () => step(-1) },
      pixelIconNode('prev', UI_ICONS)),
    el('h1', { class: 'cal-title', text: monthTitle(calendarView.month) }),
    el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Next month', 'data-focus': 'cal-next', onclick: () => step(1) },
      pixelIconNode('next', UI_ICONS)),
    el('button', {
      type: 'button', class: 'btn-text cal-today', text: 'Today', 'data-focus': 'cal-today',
      disabled: calendarView.month === today.slice(0, 7),
      onclick: () => { calendarView.month = today.slice(0, 7); rerender(); }
    }));

  const grid = el('div', { class: 'cal-grid' },
    WEEKDAYS.map(name => el('div', { class: 'cal-weekday', text: name })),
    monthCells(year, month - 1).map(date => date
      ? dayCell(state, date, days.get(date), { isToday: date === today, isPayday: date === payday })
      : el('div', { class: 'cal-blank' })));

  return el('div', { class: 'cal' }, nav, grid,
    el('p', { class: 'cal-legend' },
      el('span', { class: 'cal-key' }, el('span', { class: 'cal-amount', text: '12' }), ' spent'),
      el('span', { class: 'cal-key' }, el('span', { class: 'cal-amount cal-amount--planned', text: '12' }), ' planned'),
      el('span', { class: 'cal-key' }, el('span', { class: 'cal-payday' }), ' payday'),
      el('span', { class: 'cal-key', text: '+ other currencies too' })));
}

/** An amount for a cell: exact on wide screens, short on a phone. `more` adds the "+" for further currencies. */
function cellAmountNode(amount, reporting, planned) {
  if (!amount) return null;
  const plus = amount.more ? '+' : '';
  const foreign = amount.currency !== reporting;
  return el('span', { class: 'cal-amount' + (planned ? ' cal-amount--planned' : '') },
    el('span', { class: 'cal-full', text: formatMoney(amount.minor, amount.currency, amount.precision) + plus }),
    el('span', { class: 'cal-short', text: compactAmount(amount.minor, amount.precision) + plus }),
    foreign && el('span', { class: 'cal-code', text: amount.currency }));
}

function dayCell(state, date, day, { isToday, isPayday }) {
  const reporting = state.settings.reportingCurrency;
  const spent = day ? cellAmount(day.spent, state.settings) : null;
  const planned = day ? cellAmount(day.planned, state.settings) : null;
  const say = (amount, word) => amount
    && `${word} ${formatMoney(amount.minor, amount.currency, amount.precision)}${amount.more ? ' and other currencies' : ''}`;
  const label = [formatDay(date), isToday && 'today', say(spent, 'spent'), say(planned, 'planned'), isPayday && 'payday']
    .filter(Boolean).join(', ');

  const button = el('button', {
    type: 'button',
    class: 'cal-cell' + (isToday ? ' is-today' : ''),
    'aria-label': label, 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'data-focus': `cal:${date}`,
    onclick: () => openPopover({ anchor: button, label: formatDay(date), role: 'dialog', content: daySheet(state, date, day, isPayday) })
  },
    el('span', { class: 'cal-daynum' }, el('span', { text: String(Number(date.slice(8))) }), isPayday && el('span', { class: 'cal-payday' })),
    cellAmountNode(spent, reporting, false),
    cellAmountNode(planned, reporting, true));
  return button;
}

// ---------------------------------------------------------------------------
// Day sheet
// ---------------------------------------------------------------------------

/** Totals by currency as text, e.g. '£31.50 · 88.00 CNY'. Never added together. */
function bucketText(buckets) {
  return [...buckets.values()].filter(b => b.minor !== 0n)
    .map(b => formatMoney(b.minor, b.currency, b.precision)).join(' · ');
}

function daySheet(state, date, day, isPayday) {
  const accountName = id => state.accounts.find(a => a.id === id)?.name || '';

  /** One row for a recorded entry or a planned item. */
  const row = (e, planned) => {
    const isTransfer = e.kind === 'transfer';
    const title = planned ? e.label
      : isTransfer ? `${accountName(e.account)} → ${accountName(e.toAccount)}`
      : state.categories.find(c => c.id === e.category)?.name || e.kind;
    const own = isTransfer ? BigInt(e.minor) : personalAmount(e);
    const signed = isTransfer ? own : ['income', 'refund'].includes(e.kind) ? own : -own;
    const meta = [
      isTransfer ? 'Transfer' : categoryPath(state, e.category),
      !isTransfer && accountName(e.account),
      e.kind === 'refund' && 'Refund',
      !isTransfer && own !== BigInt(e.minor) && 'your share',
      !planned && e.note
    ].filter(Boolean).join(' · ');
    return el('li', { class: 'list-row' },
      el('span', { class: 'entry-text' },
        el('span', { class: 'entry-title', text: title }),
        meta && el('span', { class: 'entry-meta', text: meta })),
      planned && el('span', { class: 'tag-estimate', text: e.estimated ? 'estimate' : 'planned' }),
      el('span', {
        class: 'entry-amount' + (signed > 0n && !isTransfer ? ' is-income' : ''),
        text: formatMoney(signed, e.currency, e.precision, { signed: !isTransfer })
      }));
  };

  const posted = day?.posted || [];
  const items = day?.items || [];
  const spentText = day ? bucketText(day.spent) : '';
  const plannedText = day ? bucketText(day.planned) : '';

  return el('div', { class: 'cal-sheet' },
    isPayday && el('p', { class: 'cal-sheet-payday' }, el('span', { class: 'cal-payday' }), ' Payday'),
    spentText && el('div', { class: 'day-head' }, el('span', { text: 'Spent' }), el('span', { class: 'day-total', text: spentText })),
    posted.length > 0 && el('ul', { class: 'plain-list' }, posted.map(e => row(e, false))),
    plannedText && el('div', { class: 'day-head' }, el('span', { text: 'Planned' }), el('span', { class: 'day-total', text: plannedText })),
    items.length > 0 && el('ul', { class: 'plain-list' }, items.map(e => row(e, true))),
    !posted.length && !items.length && el('p', { class: 'empty', text: 'Nothing recorded or planned on this day.' }));
}

// ---------------------------------------------------------------------------
// Forecast
// ---------------------------------------------------------------------------

function buildForecast(state, today, rerender) {
  const wrap = el('div', { class: 'fc' }, sectionTitle('Forecast'));

  const accounts = forecastAccounts(state);
  if (!accounts.length) {
    wrap.append(el('p', { class: 'empty', text: 'Add your main account in Settings to see what is left before payday.' }));
    return wrap;
  }

  // Keep the choices valid when accounts change.
  const reporting = state.settings.reportingCurrency;
  if (calendarView.account !== ALL_ACCOUNTS && !accounts.some(a => a.id === calendarView.account)) {
    calendarView.account = defaultForecastAccount(state);
  }
  if (calendarView.range === 'custom' && !calendarView.custom) calendarView.range = DEFAULT_FORECAST_RANGE;

  const range = forecastRange(calendarView.range, today, state.settings, calendarView.custom);
  const forecast = forecastSummary(state, { range, today, account: calendarView.account, pots: forecastPotsOf(state) });

  const rangeChoice = el('div', { class: 'segmented fc-ranges', role: 'group', 'aria-label': 'Forecast range' },
    FORECAST_RANGES.map(({ id, label }) => {
      const selected = id === calendarView.range;
      const isCustom = id === 'custom';
      const custom = calendarView.custom;
      const button = el('button', {
        type: 'button',
        class: selected ? 'is-selected' : '',
        'aria-pressed': String(selected),
        'aria-haspopup': isCustom ? 'dialog' : null,
        'aria-expanded': isCustom ? 'false' : null,
        'aria-label': isCustom && custom ? `Custom range, ${dayMonth(custom.from)} to ${dayMonth(custom.to)}` : null,
        'data-focus': `fc-range:${id}`,
        text: isCustom && custom ? `${dayMonth(custom.from)}–${dayMonth(custom.to)}` : label,
        onclick: () => {
          if (isCustom) return openCustomRange(button, today, rerender);
          calendarView.range = id;
          saveRangeChoice();
          rerender();
        }
      });
      return button;
    }));

  const accountSelect = el('select', { id: 'fc-account', 'data-focus': 'fc-account', onchange: event => { calendarView.account = event.target.value; rerender(); } },
    accounts.map(a => el('option', { value: a.id, text: `${a.name} (${a.currency})` })),
    el('option', { value: ALL_ACCOUNTS, text: `All ${reporting} accounts` }));
  accountSelect.value = calendarView.account;

  const span = `${shortDate(range.from, today)} to ${shortDate(range.to, today)}`;
  wrap.append(
    rangeChoice,
    el('p', {
      class: 'note',
      text: range.days < 1 ? `${span} · this range has ended.`
        : range.from > today ? `${span} · counted from today, ${range.days} ${range.days === 1 ? 'day' : 'days'} to the end.`
        : `${span} · ${range.days} ${range.days === 1 ? 'day' : 'days'} left, today included.`
    }),
    el('div', { class: 'field' }, el('label', { for: 'fc-account', text: 'Account' }), accountSelect));

  if (!forecast) {
    wrap.append(el('p', { class: 'empty', text: `No account is held in ${reporting}. Choose one account instead.` }));
    return wrap;
  }

  const money = minor => formatMoney(minor, forecast.currency, forecast.precision);
  wrap.append(el('dl', { class: 'fc-figures' },
    el('div', { class: 'fc-figure' },
      el('dt', { text: `Forecast left on ${shortDate(range.to, today)}` }),
      el('dd', { class: forecast.left < 0n ? 'is-negative' : '', text: money(forecast.left) }),
      el('dd', {
        class: 'fc-detail',
        text: `Balance today ${money(forecast.balance)}, fixed ${formatMoney(forecast.fixedTotal, forecast.currency, forecast.precision, { signed: true })}, estimates −${money(forecast.estimateTotal)}`
      }))));

  if (forecast.uncounted) {
    wrap.append(el('p', { class: 'hint', text: `${forecast.uncounted} ${forecast.uncounted === 1 ? 'line is' : 'lines are'} in another currency and not counted. No exchange rate was assumed.` }));
  }

  wrap.append(
    buildPotsLeft(state, forecast.pots, range, today),
    forecastGroup('Fixed', forecast.fixed, 'Nothing planned in this range.', today),
    forecastGroup('Estimate', forecast.estimates, 'No estimates. Add them in Settings.', today),
    buildTrust(state, today));
  return wrap;
}

/** The Custom range popover: From, To and Apply. Nothing changes until the dates are valid. */
function openCustomRange(anchor, today, rerender) {
  const start = calendarView.custom || { from: today, to: monthBounds(today).to };
  const from = el('input', { id: 'fc-custom-from', type: 'date', value: start.from });
  const to = el('input', { id: 'fc-custom-to', type: 'date', value: start.to });
  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });
  const form = el('form', {
    class: 'fc-custom', novalidate: true,
    onsubmit: event => {
      event.preventDefault();
      try {
        calendarView.custom = validateCustomRange(from.value, to.value);
      } catch (error) {
        errorBox.textContent = errorMessage(error);
        errorBox.hidden = false;
        return;
      }
      calendarView.range = 'custom';
      saveRangeChoice();
      closePopover({ restoreFocus: false });
      rerender();
      document.querySelector('[data-focus="fc-range:custom"]')?.focus();
    }
  },
    el('div', { class: 'field-pair' },
      el('div', { class: 'field' }, el('label', { for: from.id, text: 'From' }), from),
      el('div', { class: 'field' }, el('label', { for: to.id, text: 'To' }), to)),
    el('p', { class: 'hint', text: 'Up to 366 days. Upcoming items are counted from today to the To date.' }),
    errorBox,
    el('button', { type: 'submit', class: 'btn-primary btn-small', text: 'Apply' }));
  openPopover({ anchor, label: 'Custom range', role: 'dialog', content: form });
  from.focus();
}

/** "Left in pots": one line per chosen pot, with what is left in it at the end of the range. */
function buildPotsLeft(state, lines, range, today) {
  const choose = el('button', {
    type: 'button', class: 'btn-text', text: 'Choose pots', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'data-focus': 'fc-pots',
    onclick: () => openPotChoice(choose, state)
  });
  return el('div', { class: 'fc-group fc-pots' },
    el('div', { class: 'day-head fc-pots-head' }, el('span', { text: `Left in pots on ${shortDate(range.to, today)}` }), choose),
    lines.length
      ? el('ul', { class: 'plain-list' }, lines.map(pot => el('li', { class: 'list-row' },
          el('span', { class: 'entry-text' },
            el('span', { class: 'entry-title' }, pot.icon && categoryIconNode(pot.icon), el('span', { text: pot.name })),
            el('span', {
              class: 'entry-meta',
              text: `In the pot today ${formatMoney(pot.balance, pot.currency, pot.precision)}` + (pot.missing ? ` · ${pot.missing} in another currency not counted` : '')
            })),
          el('span', { class: 'entry-amount' + (pot.left < 0n ? ' is-negative' : ''), text: formatMoney(pot.left, pot.currency, pot.precision) }))))
      : el('p', { class: 'empty', text: 'No pots chosen.' }));
}

/** The "Choose pots" popover: a checkbox per pot. Save keeps the choice in settings.forecastPots. */
function openPotChoice(anchor, state) {
  const chosen = new Set(forecastPotsOf(state));
  const pots = state.pots.filter(p => !p.archived);
  const boxes = pots.map(pot => el('input', { type: 'checkbox', value: pot.id, checked: chosen.has(pot.id) }));
  const form = el('form', {
    class: 'fc-pot-choice',
    onsubmit: async event => {
      event.preventDefault();
      const ids = boxes.filter(box => box.checked).map(box => box.value);
      closePopover({ restoreFocus: false });
      try {
        await saveSettings(settings => { settings.forecastPots = ids; });
      } catch (error) {
        showToast(errorMessage(error));
      }
      document.querySelector('[data-focus="fc-pots"]')?.focus();
    }
  },
    pots.length
      ? el('ul', { class: 'plain-list' }, pots.map((pot, index) => el('li', {},
          el('label', { class: 'check-row' }, boxes[index], el('span', { text: pot.name })))))
      : el('p', { class: 'empty', text: 'There are no pots yet.' }),
    el('button', { type: 'submit', class: 'btn-primary btn-small', text: 'Save' }));
  openPopover({ anchor, label: 'Choose pots', role: 'dialog', content: form });
}

/** One itemised group: each line has its date, amount and a 'fixed' or 'estimate' tag. */
function forecastGroup(title, lines, emptyText, today) {
  const row = line => {
    const out = line.tag === 'estimate' ? -line.minor : line.minor; // estimates are money going out
    const shown = line.counted ? out : (out < 0n ? -out : out);
    const meta = [
      shortDate(line.date, today),
      line.tag === 'estimate' && line.days < 7 && `${line.days} of 7 days`,
      line.tag === 'fixed' && line.estimated && 'amount estimated',
      !line.counted && 'not counted'
    ].filter(Boolean).join(' · ');
    return el('li', { class: 'list-row' + (line.counted ? '' : ' is-uncounted') },
      el('span', { class: 'entry-text' },
        el('span', { class: 'entry-title', text: line.name }),
        el('span', { class: 'entry-meta', text: meta })),
      el('span', { class: line.tag === 'fixed' ? 'tag-fixed' : 'tag-estimate', text: line.tag }),
      el('span', {
        class: 'entry-amount' + (line.counted && out > 0n ? ' is-income' : ''),
        text: formatMoney(shown, line.currency, line.precision, { signed: line.counted })
      }));
  };
  return el('div', { class: 'fc-group' },
    el('div', { class: 'day-head' }, el('span', { text: title }), el('span', { text: `${lines.length} ${lines.length === 1 ? 'line' : 'lines'}` })),
    lines.length ? el('ul', { class: 'plain-list' }, lines.map(row)) : el('p', { class: 'empty', text: emptyText }));
}

/** Last month's estimate beside what was recorded, so the estimates can be trusted or changed. */
function buildTrust(state, today) {
  const rows = estimateTrust(state, today);
  if (!rows.length) return null;
  return el('div', { class: 'fc-group' },
    el('div', { class: 'day-head' }, el('span', { text: 'Last month' }), el('span', { text: 'estimate against actual' })),
    el('ul', { class: 'plain-list' }, rows.map(t => el('li', { class: 'list-row' },
      el('span', { class: 'entry-text' },
        el('span', { class: 'entry-title', text: t.estimate.name }),
        el('span', {
          class: 'entry-meta',
          text: !t.estimate.category ? 'No category to compare with.'
            : `Last month: estimated ${formatMoney(t.estimated, t.currency, t.precision)}, actual ${formatMoney(t.actual, t.currency, t.precision)}`
              + (t.missing ? ` · ${t.missing} in another currency not counted` : '')
        }))))),
    el('p', { class: 'hint' }, 'Change the weekly amounts in ', el('a', { href: '#settings/estimates', text: 'Settings' }), ' under Estimates.'));
}
