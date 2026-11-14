// The Reports tab: one row of controls (period, view, filters), the figure, the
// Hide toggles for Fixed expenses and Regulars, a view (donut, bars, trend or
// treemap) and under every view a ranked list of categories. Any view can be
// compared with earlier months.
//
// The figures come from ../reports-view.js; the drawings from ./report-charts.js.
// Totals are in the reporting currency. Entries without a value in it are
// never mixed in: they are counted and shown apart, in their own currency.

import { el, slip, sectionTitle, todayIso, formatMoney, errorMessage } from './dom.js';
import { ledger } from './ledger.js';
import { openPopover, closePopover } from './popover.js';
import { pixelIconNode, categoryIconNode, UI_ICONS } from './pixel-icons.js';
import { monthBounds } from '../forecast-view.js';
import {
  reportsView, reportPeriod, groupSmallSlices, sharePercent, reportHideGroups, compareView, trendReference,
  REPORT_PERIODS, REPORT_VIEWS, REPORT_COMPARISONS, REPORT_MONTHS, DEFAULT_REPORT_PERIOD, DEFAULT_REPORT_VIEW
} from '../reports-view.js';
import {
  chartColour, createChartTip, donutChart, barsChart, compareBarsChart, trendChart, treemapChart, trendLines,
  reportMonthShort, reportMonthLong
} from './report-charts.js';

const REPORTS_KEY = 'expense-book.reports';

/**
 * The period, view, Hide toggles and comparison last chosen on this device.
 * Anything unreadable falls back to the defaults: nothing hidden, no comparison.
 */
function loadReportChoice() {
  const choice = { period: DEFAULT_REPORT_PERIOD, custom: null, view: DEFAULT_REPORT_VIEW, hide: { fixed: false, regulars: false }, compare: '' };
  try {
    const saved = JSON.parse(localStorage.getItem(REPORTS_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      try { choice.custom = reportPeriod('custom', '', { from: saved.from, to: saved.to }); } catch { /* no custom dates kept */ }
      if (REPORT_PERIODS.some(p => p.id === saved.period) && (saved.period !== 'custom' || choice.custom)) choice.period = saved.period;
      if (REPORT_VIEWS.some(v => v.id === saved.view)) choice.view = saved.view;
      choice.hide = { fixed: saved.hideFixed === true, regulars: saved.hideRegulars === true };
      if (REPORT_COMPARISONS.some(c => c.id === saved.compare)) choice.compare = saved.compare;
    }
  } catch { /* storage is blocked or holds something else: use the defaults */ }
  return choice;
}

function saveReportChoice() {
  try {
    localStorage.setItem(REPORTS_KEY, JSON.stringify({
      period: reportsUi.period, view: reportsUi.view, from: reportsUi.custom?.from, to: reportsUi.custom?.to,
      hideFixed: reportsUi.hide.fixed, hideRegulars: reportsUi.hide.regulars, compare: reportsUi.compare
    }));
  } catch { /* the choice then lasts until the page is closed */ }
}

// View state kept between re-renders.
//   hide    → { fixed, regulars }: the Hide toggles
//   compare → '' or an ID from REPORT_COMPARISONS
//   drill   → '' (all categories), a top-level category ID, or 'other' (the donut's small slices)
//   hidden  → categories switched off in the bars legend
//   animate → the next drawing was reached by drilling, so it may ease in
const reportsUi = {
  ...loadReportChoice(),
  account: '', pot: '', includeTravel: false,
  drill: '', hidden: new Set(), table: false, animate: false
};

/** '1 Nov 2026' for '2026-11-01'. */
function reportDate(iso) {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function renderReports(root) {
  const state = ledger.state;
  const today = todayIso();
  /** Draw again; focus goes to `focusKey`, or stays on the control that had it. */
  const rerender = focusKey => {
    const key = focusKey || document.activeElement?.dataset?.focus;
    root.replaceChildren();
    renderReports(root);
    if (key) root.querySelector(`[data-focus="${CSS.escape(key)}"]`)?.focus();
  };

  // Keep the choices valid when accounts or pots change.
  if (reportsUi.account && !state.accounts.some(a => a.id === reportsUi.account)) reportsUi.account = '';
  if (reportsUi.pot && !state.pots.some(p => p.id === reportsUi.pot && !p.archived)) reportsUi.pot = '';
  if (reportsUi.period === 'custom' && !reportsUi.custom) reportsUi.period = DEFAULT_REPORT_PERIOD;

  const period = reportPeriod(reportsUi.period, today, reportsUi.custom);
  const filters = { account: reportsUi.account, pot: reportsUi.pot, includeTravel: reportsUi.includeTravel };
  const groups = reportHideGroups(state);
  const exclude = groups.filter(group => reportsUi.hide[group.key]).map(group => group.pot);
  const report = reportsView(state, { period, filters, exclude, today });
  const compare = reportsUi.compare ? compareView(state, { period, filters, exclude, today, mode: reportsUi.compare, report }) : null;
  const context = { state, today, report, compare, groups, filters, exclude, rerender, money: minor => formatMoney(minor, report.currency, report.precision) };

  root.append(slip({ label: 'Reports', kind: REPORT_PERIODS.find(p => p.id === reportsUi.period).label, wide: true },
    buildReportControls(context),
    buildReportSummary(context),
    buildReportView(context),
    buildMissingNote(report)));
}

// ---------------------------------------------------------------------------
// Controls: period, view, filters
// ---------------------------------------------------------------------------

function buildReportControls({ state, today, groups, rerender }) {
  const custom = reportsUi.custom;
  const label = REPORT_PERIODS.find(p => p.id === reportsUi.period).label;
  const periodButton = el('button', {
    type: 'button', class: 'btn-secondary btn-small rp-period-button',
    'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'data-focus': 'rp-period',
    'aria-label': 'Period: ' + (reportsUi.period === 'custom' && custom ? `Custom, ${reportDate(custom.from)} to ${reportDate(custom.to)}` : label),
    text: label + ' ▾',
    onclick: () => openReportMenu(periodButton, 'Period',
      REPORT_PERIODS.map(p => ({ id: p.id, label: p.id === 'custom' ? 'Custom…' : p.label })), reportsUi.period,
      id => {
        if (id === 'custom') return openCustomPeriod(periodButton, today, rerender);
        setReportPeriod(id);
        closePopover({ restoreFocus: false });
        rerender('rp-period');
      })
  });

  // Icon only on a phone (the label is hidden in style.css), so every button carries its name.
  const views = el('div', { class: 'segmented rp-views', role: 'group', 'aria-label': 'View' },
    REPORT_VIEWS.map(({ id, label: name }) => {
      const selected = id === reportsUi.view;
      return el('button', {
        type: 'button',
        class: selected ? 'is-selected' : '',
        'aria-pressed': String(selected),
        'aria-label': name,
        title: name,
        'data-focus': `rp-view:${id}`,
        onclick: () => {
          reportsUi.view = id;
          saveReportChoice();
          rerender();
        }
      }, pixelIconNode(id, UI_ICONS, 'rp-view-icon'), el('span', { class: 'rp-view-label', 'aria-hidden': 'true', text: name }));
    }));

  const active = [reportsUi.account, reportsUi.pot, reportsUi.includeTravel, ...groups.map(group => reportsUi.hide[group.key])].filter(Boolean).length;
  const filterButton = el('button', {
    type: 'button', class: 'btn-secondary btn-small rp-filter-button',
    'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'data-focus': 'rp-filters',
    text: active ? `Filters · ${active}` : 'Filters',
    onclick: () => openReportFilters(filterButton, state, groups, rerender)
  });

  return el('div', { class: 'rp-controls' }, periodButton, views, filterButton);
}

/** A short list of choices in a popover; the current one is marked. */
function openReportMenu(anchor, label, options, current, onChoose) {
  const buttons = options.map(option => el('button', {
    type: 'button', class: 'rp-menu-item' + (option.id === current ? ' is-selected' : ''),
    'aria-pressed': String(option.id === current), text: option.label,
    onclick: () => onChoose(option.id)
  }));
  openPopover({ anchor, label, role: 'dialog', content: el('div', { class: 'rp-menu' }, buttons) });
  (buttons[options.findIndex(option => option.id === current)] || buttons[0])?.focus();
}

function setReportPeriod(id) {
  reportsUi.period = id;
  reportsUi.drill = '';
  saveReportChoice();
}

/** The Custom period popover: From, To and Apply. Nothing changes until the dates are valid. */
function openCustomPeriod(anchor, today, rerender) {
  const start = reportsUi.custom || monthBounds(today);
  const from = el('input', { id: 'rp-custom-from', type: 'date', value: start.from });
  const to = el('input', { id: 'rp-custom-to', type: 'date', value: start.to });
  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });
  const form = el('form', {
    class: 'fc-custom', novalidate: true,
    onsubmit: event => {
      event.preventDefault();
      try {
        reportsUi.custom = reportPeriod('custom', today, { from: from.value, to: to.value });
      } catch (error) {
        errorBox.textContent = errorMessage(error);
        errorBox.hidden = false;
        return;
      }
      setReportPeriod('custom');
      closePopover({ restoreFocus: false });
      rerender('rp-period');
    }
  },
    el('div', { class: 'field-pair' },
      el('div', { class: 'field' }, el('label', { for: from.id, text: 'From' }), from),
      el('div', { class: 'field' }, el('label', { for: to.id, text: 'To' }), to)),
    el('p', { class: 'hint', text: 'Up to 366 days, both dates counted.' }),
    errorBox,
    el('button', { type: 'submit', class: 'btn-primary btn-small', text: 'Apply' }));
  openPopover({ anchor, label: 'Custom period', role: 'dialog', content: form });
  from.focus();
}

/** The Filters popover: account, pot, whether trips are counted, and the two Hide toggles. Applied together. */
function openReportFilters(anchor, state, groups, rerender) {
  const account = el('select', { id: 'rp-filter-account' },
    el('option', { value: '', text: 'All accounts' }),
    state.accounts.filter(a => !a.archived || a.id === reportsUi.account).map(a => el('option', { value: a.id, text: `${a.name} (${a.currency})` })));
  account.value = reportsUi.account;
  const pot = el('select', { id: 'rp-filter-pot' },
    el('option', { value: '', text: 'All pots' }),
    state.pots.filter(p => !p.archived).map(p => el('option', { value: p.id, text: p.name })));
  pot.value = reportsUi.pot;
  const travel = el('input', { type: 'checkbox', checked: reportsUi.includeTravel });

  const hides = groups.map(group => ({ group, box: el('input', { type: 'checkbox', checked: reportsUi.hide[group.key] }) }));

  const apply = () => {
    reportsUi.drill = '';
    saveReportChoice();
    closePopover({ restoreFocus: false });
    rerender('rp-filters');
  };
  const form = el('form', {
    class: 'fc-custom rp-filter-form', novalidate: true,
    onsubmit: event => {
      event.preventDefault();
      Object.assign(reportsUi, { account: account.value, pot: pot.value, includeTravel: travel.checked });
      for (const { group, box } of hides) reportsUi.hide[group.key] = box.checked;
      apply();
    }
  },
    el('div', { class: 'field' }, el('label', { for: account.id, text: 'Account' }), account),
    el('div', { class: 'field' }, el('label', { for: pot.id, text: 'Pot' }), pot),
    el('label', { class: 'check-row' }, travel, el('span', { text: 'Include travel' })),
    el('p', { class: 'hint', text: 'Spending on a trip is left out unless you include it here.' }),
    hides.map(({ group, box }) => el('label', { class: 'check-row' }, box, el('span', { text: group.label }))),
    hides.length > 0 && el('p', { class: 'hint', text: 'Hidden categories are left out of the chart, the list and the totals. The figure at the top says what is hidden.' }),
    el('div', { class: 'rp-filter-actions' },
      el('button', { type: 'submit', class: 'btn-primary btn-small', text: 'Apply' }),
      el('button', {
        type: 'button', class: 'btn-text', text: 'Clear filters',
        onclick: () => {
          Object.assign(reportsUi, { account: '', pot: '', includeTravel: false, hide: { fixed: false, regulars: false } });
          apply();
        }
      })));
  openPopover({ anchor, label: 'Filters', role: 'dialog', content: form });
  account.focus();
}

// ---------------------------------------------------------------------------
// The figure above the view, and the note about entries left out
// ---------------------------------------------------------------------------

function buildReportSummary({ state, report, compare, groups, money, rerender }) {
  const { from, to } = report.period;
  const scope = [
    reportsUi.account && state.accounts.find(a => a.id === reportsUi.account)?.name,
    reportsUi.pot && state.pots.find(p => p.id === reportsUi.pot)?.name,
    reportsUi.includeTravel ? 'travel included' : 'travel left out'
  ].filter(Boolean).join(' · ');

  // Said outright, with the amount: "Fixed expenses hidden (£1,140.00)".
  const hidden = report.hidden.map(part => {
    const title = groups.find(group => group.pot === part.pot)?.title || part.name;
    const unvalued = part.missing ? `, and ${part.missing} with no ${report.currency} value` : '';
    return `${title} hidden (${money(part.minor)}${unvalued})`;
  }).join(' · ');

  const compareButton = el('button', {
    type: 'button', class: 'rp-toggle rp-compare-button' + (compare ? ' is-on' : ''),
    'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'data-focus': 'rp-compare',
    'aria-label': 'Compare: ' + (compare ? compare.label : 'off'),
    text: (compare ? compare.label : 'Compare') + ' ▾',
    onclick: () => openReportMenu(compareButton, 'Compare',
      [{ id: '', label: 'No comparison' }, ...REPORT_COMPARISONS], reportsUi.compare,
      id => {
        reportsUi.compare = id;
        saveReportChoice();
        closePopover({ restoreFocus: false });
        rerender('rp-compare');
      })
  });

  const delta = compare && reportDelta({ ...compare.total, isNew: false }, money);
  return el('div', { class: 'rp-summary' },
    el('div', { class: 'rp-total-row' },
      el('p', { class: 'rp-total' },
        el('span', { class: 'rp-total-label', text: 'Spent' }),
        el('strong', { text: money(report.total) })),
      compareButton),
    hidden && el('p', { class: 'rp-hidden-note', text: hidden }),
    compare && el('p', { class: 'rp-compare-total' },
      el('span', { text: `${compare.label}: ${money(compare.total.previous)}` }),
      el('span', { class: `rp-delta rp-delta--${delta.kind}`, text: delta.text })),
    compare && el('p', { class: 'hint rp-compare-note', text: compare.note + '.'
      + (compare.toDate ? ' Month to date: the same days of each earlier month.' : '')
      + (compare.missing ? ` ${compare.missing} earlier ${compare.missing === 1 ? 'entry has' : 'entries have'} no ${report.currency} value and ${compare.missing === 1 ? 'is' : 'are'} left out.` : '') }),
    el('p', { class: 'hint', text: `${reportDate(from)} to ${reportDate(to)} · ${scope}. Net of refunds; shared purchases count your share only.` }));
}

/**
 * A difference in words: "▲ +£23.10 (+18%)" for more spending (vermilion), "▼ −£8.00 (−4%)"
 * for less (blue), "new" when there was nothing before. Returns { kind, text }.
 */
function reportDelta(row, money) {
  if (row.isNew) return { kind: 'new', text: 'new' };
  if (row.diff === 0n) return { kind: 'same', text: 'no change' };
  const up = row.diff > 0n;
  const percent = row.percent == null ? '' : ` (${up ? '+' : '−'}${Math.abs(row.percent)}%)`;
  return { kind: up ? 'up' : 'down', text: `${up ? '▲ +' : '▼ −'}${money(up ? row.diff : -row.diff)}${percent}` };
}

/** The two Hide chips, directly above the chart. Pressed means hidden. */
function buildHideToggles({ groups, rerender }) {
  if (!groups.length) return null;
  return el('div', { class: 'rp-toggles', role: 'group', 'aria-label': 'Hide from the report' },
    groups.map(group => {
      const on = reportsUi.hide[group.key];
      return el('button', {
        type: 'button', class: 'rp-toggle' + (on ? ' is-on' : ''), 'aria-pressed': String(on), 'data-focus': 'rp-hide:' + group.key,
        onclick: () => {
          reportsUi.hide[group.key] = !on;
          reportsUi.drill = '';
          saveReportChoice();
          rerender();
        },
        'aria-label': group.label
      }, el('span', { class: 'rp-toggle-box', 'aria-hidden': 'true' }),
        // On a phone only "Hide <pot>" shows, so both chips fit on one row.
        el('span', { text: `Hide ${group.title}` }),
        el('span', { class: 'rp-toggle-names', text: group.label.slice(`Hide ${group.title}`.length) }));
    }));
}

/** Entries with no value in the reporting currency: how many, and their sums, each in its own currency. */
function buildMissingNote(report) {
  if (!report.missing) return null;
  const one = report.missing === 1;
  const sums = report.others.map(other => formatMoney(other.minor, other.currency, other.precision)).join(' · ');
  return el('p', { class: 'empty rp-missing' },
    `${report.missing} ${one ? 'entry has' : 'entries have'} no ${report.currency} value, so ${one ? 'it is' : 'they are'} not in the figures for this period. `
    + `Kept apart, not converted: ${sums}. Add a ${report.currency} value to an entry to include it.`);
}

/** A calm message with a way forward (none when the way forward is a toggle on this page). */
function reportEmpty(text, link = true) {
  return el('p', { class: 'empty rp-empty' }, text, link && [' ', el('a', { href: '#today', text: 'Add an entry on Today' }), '.']);
}

/** What to say when there is nothing to draw for the period. */
function nothingSpent(report) {
  return report.hidden.some(part => part.minor !== 0n || part.missing)
    ? { text: 'Everything spent in this period is hidden. Switch a Hide chip off to see it.', link: false }
    : { text: 'Nothing spent in this period yet.', link: true };
}

// ---------------------------------------------------------------------------
// The chosen view
// ---------------------------------------------------------------------------

function buildReportView(context) {
  const view = reportsUi.view;
  const animate = reportsUi.animate;
  reportsUi.animate = false;

  const figure = el('div', { class: 'rp-figure' });
  const tip = createChartTip(figure);
  const parts = { donut: donutParts, bars: barsParts, trend: trendParts, treemap: treemapParts }[view]({ ...context, tip, animate });

  const tableToggle = el('button', {
    type: 'button', class: 'btn-text rp-table-toggle', 'aria-pressed': String(reportsUi.table), 'data-focus': 'rp-table',
    text: reportsUi.table ? 'Show as chart' : 'Show as table',
    onclick: () => {
      reportsUi.table = !reportsUi.table;
      context.rerender();
    }
  });

  if (parts.empty) figure.append(typeof parts.empty === 'string' ? reportEmpty(parts.empty) : reportEmpty(parts.empty.text, parts.empty.link));
  else figure.append(reportsUi.table ? parts.table() : parts.chart());

  // `head` sits above the chart and is kept short; `foot` (long legends) goes under it.
  return el('div', { class: `rp-view rp-view--${view}` },
    parts.head,
    buildHideToggles(context),
    figure,
    !parts.empty && el('div', { class: 'rp-under' }, parts.note && el('p', { class: 'hint', text: parts.note }), tableToggle),
    parts.foot,
    parts.list && [sectionTitle(parts.listTitle), parts.list]);
}

/** A table that scrolls sideways inside its own box on a narrow screen. Amount columns are right-aligned. */
function reportTable(caption, head, rows) {
  return el('div', { class: 'rp-table-wrap', tabindex: '0', role: 'region', 'aria-label': caption },
    el('table', { class: 'rp-table' },
      el('caption', { text: caption }),
      el('thead', {}, el('tr', {}, head.map((text, column) => el('th', { scope: 'col', class: column ? 'num' : '', text })))),
      el('tbody', {}, rows.map(cells => el('tr', {}, cells.map((text, column) =>
        column ? el('td', { class: 'num', text }) : el('th', { scope: 'row', text })))))));
}

/**
 * Categories, largest first: colour, icon, name, share, amount, and a thin bar.
 * With `onPick`, rows that hold subcategories are buttons that open them.
 * With `compare`, the items are compareView() lines and each row adds the earlier
 * amount and the difference.
 */
function rankedList(items, money, onPick = null, compare = null) {
  if (!items.length) return null;
  const whole = items.reduce((sum, item) => (item.minor > 0n ? sum + item.minor : sum), 0n);
  const largest = items.reduce((max, item) => (item.minor > max ? item.minor : max), 0n);
  return el('ol', { class: 'rp-list' }, items.map(item => {
    const width = item.minor > 0n ? Number(item.minor * 1000n / largest) / 10 : 0;
    const share = item.minor > 0n ? `${sharePercent(item.minor, whole)}%` : item.minor < 0n ? 'net refund' : '–';
    const pick = onPick && item.children?.length;
    const delta = compare && reportDelta(item, money);
    const before = compare && (item.isNew ? '' : `${compare.short} ${money(item.previous)}`);
    const content = [
      el('span', { class: 'rp-swatch', style: `background:${chartColour(item.colour)}`, 'aria-hidden': 'true' }),
      el('span', { class: 'rp-row-name' }, categoryIconNode(item.icon), el('span', { text: item.name })),
      el('span', { class: 'rp-row-share', text: share }),
      el('span', { class: 'rp-row-amount', text: money(item.minor) }),
      pick ? pixelIconNode('next', UI_ICONS, 'rp-row-next') : el('span', { class: 'rp-row-next' }),
      compare && el('span', { class: 'rp-row-compare' },
        before && el('span', { class: 'rp-row-before', text: before }),
        el('span', { class: `rp-delta rp-delta--${delta.kind}`, text: delta.text })),
      el('span', { class: 'rp-row-bar', 'aria-hidden': 'true' },
        el('span', { style: `width:${width}%;background:${chartColour(item.colour)}` }))
    ];
    return el('li', {}, pick
      ? el('button', {
        type: 'button', class: 'rp-row rp-row--pick', 'data-focus': 'rp-row:' + item.id,
        'aria-label': `${item.name}, ${money(item.minor)}, ${share}. ` + (compare ? `${before ? before + ', ' : ''}${delta.text}. ` : '') + 'Show what is inside.',
        onclick: () => onPick(item)
      }, content)
      : el('div', { class: 'rp-row' }, content));
  }));
}

/**
 * Where the donut and the treemap are looking: every category, one category's
 * subcategories, or (donut only) the small slices gathered as "Other".
 */
function reportLevel(categories, allowOther) {
  const top = categories.find(c => c.id === reportsUi.drill && c.children.length);
  if (top) return { parent: top, items: top.children };
  if (reportsUi.drill === 'other' && allowOther) {
    const other = groupSmallSlices(categories).slices.find(slice => slice.other);
    if (other) return { parent: other, items: other.members };
  }
  reportsUi.drill = '';
  return { parent: null, items: categories };
}

/** The categories to list: with a comparison on, the same ones carrying their earlier amounts. */
function listedCategories({ report, compare }) {
  return compare ? compare.categories : report.categories;
}

/** The comparison as a tooltip line: "vs last month: £180.00". */
function compareTipLine(compare, money) {
  if (!compare) return undefined;
  return item => {
    const members = item.members || [item]; // the donut's "Other" slice adds its members up
    const previous = members.reduce((sum, member) => sum + (member.previous || 0n), 0n);
    return [`${compare.label}: ${members.every(member => member.isNew) ? 'nothing, new' : money(previous)}`];
  };
}

/** "‹ All categories" and the name of what is open. */
function reportCrumbs(parent, drillTo) {
  if (!parent) return null;
  return el('nav', { class: 'rp-crumbs', 'aria-label': 'Breadcrumb' },
    el('button', { type: 'button', class: 'btn-text', 'data-focus': 'rp-back', text: '‹ All categories', onclick: () => drillTo('', 'rp-slice:' + parent.id) }),
    el('span', { class: 'rp-crumb-here', 'aria-current': 'true' }, categoryIconNode(parent.icon), el('span', { text: parent.name })));
}

/** What the donut and the treemap share: the level, its positive total, drilling, table and list. */
function levelParts(context, allowOther) {
  const { report, compare, money, rerender } = context;
  const level = reportLevel(listedCategories(context), allowOther);
  const refunded = level.items.some(item => item.minor < 0n);
  const positive = level.items.filter(item => item.minor > 0n);
  const total = positive.reduce((sum, item) => sum + item.minor, 0n);
  const whole = level.parent ? level.parent.name : 'the total';
  const drillTo = (id, focusKey = 'rp-back') => {
    reportsUi.drill = id;
    reportsUi.animate = true;
    rerender(focusKey);
  };
  return {
    level, positive, total, whole, drillTo,
    head: reportCrumbs(level.parent, drillTo),
    more: compareTipLine(compare, money),
    empty: !positive.length && (refunded ? 'Refunds outweigh spending here, so there is nothing to draw.' : nothingSpent(report)),
    table: () => reportTable(`Spending by category, ${whole === 'the total' ? 'all categories' : whole}`,
      ['Category', 'Amount', 'Share', ...(compare ? [compare.label, 'Difference'] : [])],
      level.items.map(item => [item.name, money(item.minor), item.minor > 0n ? `${sharePercent(item.minor, total)}%` : '–',
        ...(compare ? [item.isNew ? '–' : money(item.previous), reportDelta(item, money).text] : [])])),
    listTitle: level.parent ? `Inside ${level.parent.name}` : 'Categories',
    list: rankedList(level.items, money, level.parent ? null : item => drillTo(item.id), compare),
    note: refunded ? 'A category with more refunded than spent is not drawn. It is in the list below.' : ''
  };
}

function donutParts(context) {
  const { report, money, tip, animate } = context;
  const shared = levelParts(context, true);
  const { level, positive, total, whole, drillTo, more } = shared;
  const slices = level.parent ? positive : groupSmallSlices(positive).slices;
  const centre = level.parent
    ? { title: level.parent.name, amount: money(level.parent.minor), note: `${sharePercent(level.parent.minor, positiveTotal(report))}% of the total`, whole }
    : { title: 'Spent', amount: money(report.total), note: 'net of refunds', whole };
  return {
    ...shared,
    chart: () => donutChart({
      slices, total, centre, format: money, tip, animate, more,
      canPick: slice => Boolean(slice.other || slice.children?.length),
      onPick: slice => drillTo(slice.other ? 'other' : slice.id),
      label: `Donut of spending by category, ${whole === 'the total' ? 'all categories' : whole}. ${money(total)} in ${slices.length} ${slices.length === 1 ? 'segment' : 'segments'}.`
    }),
    note: shared.note || (level.parent ? '' : 'Tap a segment to see what is inside it.')
  };
}

function positiveTotal(report) {
  return report.categories.reduce((sum, c) => (c.minor > 0n ? sum + c.minor : sum), 0n);
}

function treemapParts(context) {
  const { money, tip, animate } = context;
  const shared = levelParts(context, false);
  const { level, positive, total, whole, drillTo, more } = shared;
  return {
    ...shared,
    chart: () => treemapChart({
      items: positive, total, whole, format: money, tip, animate, more,
      onPick: item => drillTo(item.id),
      label: `Treemap of spending by category, ${whole === 'the total' ? 'all categories' : whole}. ${money(total)} in ${positive.length} ${positive.length === 1 ? 'block' : 'blocks'}.`
    }),
    note: shared.note || (level.parent ? '' : 'Each block is a category; the faint lines are its subcategories. Tap a block to zoom in.')
  };
}

/** Bars with a comparison on: the period against it, a pair of bars per top-level category. */
function compareBarsParts({ report, compare, money, tip }) {
  const rows = compare.categories.filter(row => row.minor > 0n || row.previous > 0n);
  const key = el('ul', { class: 'rp-key', 'aria-hidden': 'true' },
    el('li', {}, el('span', { class: 'rp-key-mark rp-key-mark--spent' }), 'This period'),
    el('li', {}, el('span', { class: 'rp-key-mark rp-key-mark--before' }), compare.label.replace(/^vs /, '')));
  return {
    head: key,
    empty: !rows.length && nothingSpent(report),
    chart: () => compareBarsChart({
      rows, format: money, tip, compareLabel: compare.label, deltaText: row => reportDelta(row, money).text,
      label: `Paired bars by category: this period ${compare.label}. ${compare.note}.`
    }),
    table: () => reportTable(`Spending by category, this period ${compare.label}`, ['Category', 'This period', compare.label, 'Difference'],
      rows.map(row => [row.name, money(row.minor), row.isNew ? '–' : money(row.previous), reportDelta(row, money).text])),
    note: `${compare.note}. Each category has two bars: this period, and ${compare.short} underneath. Choose "No comparison" for the 12-month bars.`,
    listTitle: 'Categories in the period',
    list: rankedList(compare.categories, money, null, compare)
  };
}

function barsParts(context) {
  if (context.compare) return compareBarsParts(context);
  const { report, money, tip, rerender } = context;
  const all = report.monthCategories;
  const visible = all.filter(category => !reportsUi.hidden.has(category.id));
  const legend = all.length > 0 && el('div', { class: 'rp-legend', role: 'group', 'aria-label': 'Categories shown' },
    all.map(category => {
      const on = !reportsUi.hidden.has(category.id);
      return el('button', {
        type: 'button', class: 'rp-chip' + (on ? ' is-on' : ''), 'aria-pressed': String(on), 'data-focus': 'rp-chip:' + category.id,
        onclick: () => {
          if (on) reportsUi.hidden.add(category.id); else reportsUi.hidden.delete(category.id);
          rerender();
        }
      }, el('span', { class: 'rp-swatch', style: `background:${chartColour(category.colour)}`, 'aria-hidden': 'true' }), el('span', { text: category.name }));
    }));
  const visibleSum = month => visible.reduce((sum, category) => sum + (month.byCategory[category.id] || 0n), 0n);
  return {
    foot: legend,
    empty: !all.length && (report.hidden.length ? { text: 'Nothing to show for the last 12 months with these categories hidden.', link: false } : 'Nothing spent in the last 12 months yet.'),
    chart: () => barsChart({
      months: report.months, categories: visible, format: money, tip,
      onPick: (month, anchor) => openMonthBreakdown(anchor, month, context),
      label: `Stacked bars of spending by month and category, ${reportMonthLong(report.months[0].month)} to ${reportMonthLong(report.months[report.months.length - 1].month)}.`
    }),
    table: () => reportTable('Spending by month and category, last 12 months',
      ['Month', 'Total', ...visible.map(category => category.name)],
      report.months.map(month => [reportMonthLong(month.month), money(visibleSum(month)),
        ...visible.map(category => money(month.byCategory[category.id] || 0n))])),
    note: 'The last 12 months, whatever the period above. Open a bar for that month; the chips underneath switch categories on and off.',
    listTitle: 'Categories in the period',
    list: rankedList(report.categories, money)
  };
}

/** A month's categories in a popover, with a way to make that month the period. */
function openMonthBreakdown(anchor, month, { state, today, filters, exclude, rerender }) {
  const period = monthBounds(month + '-01');
  const report = reportsView(state, { period, filters, exclude, today });
  const money = minor => formatMoney(minor, report.currency, report.precision);
  const content = el('div', { class: 'rp-month' },
    el('p', { class: 'rp-total' }, el('span', { class: 'rp-total-label', text: 'Spent' }), el('strong', { text: money(report.total) })),
    rankedList(report.categories, money) || el('p', { class: 'empty', text: 'Nothing spent in this month.' }),
    buildMissingNote(report),
    el('button', {
      type: 'button', class: 'btn-secondary btn-small', text: 'Use this month as the period',
      onclick: () => {
        reportsUi.custom = period;
        setReportPeriod('custom');
        closePopover({ restoreFocus: false });
        rerender('rp-period');
      }
    }));
  openPopover({ anchor, label: reportMonthLong(month), role: 'dialog', content });
}

function trendParts(context) {
  const { state, today, report, compare, filters, exclude, money, tip, rerender } = context;
  const { pots, all } = report.budget;
  const series = pots.find(p => p.id === reportsUi.pot) || all;
  const format = minor => formatMoney(minor, series.currency, series.precision);
  const hasBudget = series.months.some(point => point.budget !== 0n);
  const hasAnything = hasBudget || series.months.some(point => point.actual !== 0n || point.missing);

  const select = el('select', {
    id: 'rp-trend-pot', 'data-focus': 'rp-trend-pot',
    onchange: event => {
      reportsUi.pot = event.target.value;
      reportsUi.drill = '';
      rerender();
    }
  }, el('option', { value: '', text: 'All pots' }), pots.map(p => el('option', { value: p.id, text: p.name })));
  select.value = series.id;

  // The comparison as a line: each month against the month(s) it would be compared with,
  // which needs a second year of months to look back on.
  let reference = null;
  if (compare) {
    const longer = reportsView(state, { period: report.period, filters, exclude, today, monthCount: REPORT_MONTHS * 2 }).budget;
    const longSeries = series.id ? longer.pots.find(p => p.id === series.id) : longer.all;
    if (longSeries) reference = { label: compare.label, values: trendReference(longSeries.months, compare.mode).map(point => point.minor) };
  }

  const key = el('ul', { class: 'rp-key', 'aria-hidden': 'true' },
    reference && el('li', {}, el('span', { class: 'rp-key-mark rp-key-mark--reference' }), compare.short),
    el('li', {}, el('span', { class: 'rp-key-mark rp-key-mark--spent' }), 'Spent'),
    el('li', {}, el('span', { class: 'rp-key-mark rp-key-mark--budget' }), 'Budget'),
    el('li', {}, el('span', { class: 'rp-key-mark rp-key-mark--over' }), 'Over budget'));

  const notes = [
    'Everything paid from the pot each month, travel included, against the money allocated to it that month. Tap a point for the exact figures.',
    !hasBudget && hasAnything && 'Nothing was allocated in these months, so there is no budget line.',
    !reportsUi.pot && all.leftOut.length && `Not added in, because they are kept in another currency: ${all.leftOut.join(', ')}.`,
    !reportsUi.pot && all.hidden.length && `Hidden, so not added in: ${all.hidden.join(', ')}.`,
    reference && `The faint dashed line is ${compare.short} for each month, whole months.`
  ].filter(Boolean).join(' ');

  return {
    head: [el('div', { class: 'field rp-trend-pot' }, el('label', { for: select.id, text: 'Pot (the same choice as in Filters)' }), select), key],
    empty: !hasAnything && 'Nothing spent from or allocated to this pot in the last 12 months.',
    chart: () => trendChart({
      series, format, tip, reference,
      label: `Monthly spending against budget for ${series.name}, ${reportMonthLong(series.months[0].month)} to ${reportMonthLong(series.months[series.months.length - 1].month)}.`
    }),
    table: () => reportTable(`Spending against budget by month, ${series.name}`, ['Month', 'Spent', 'Budget', 'Difference', ...(reference ? [compare.label] : [])],
      series.months.map((point, index) => {
        const lines = trendLines(point, format, hasBudget);
        return [`${reportMonthShort(point.month)} ${point.month.slice(0, 4)}`, format(point.actual), hasBudget ? format(point.budget) : '–', hasBudget ? lines[2] : '–',
          ...(reference ? [reference.values[index] == null ? '–' : format(reference.values[index])] : [])];
      })),
    note: notes,
    listTitle: 'Categories in the period',
    list: rankedList(listedCategories(context), money, null, compare)
  };
}
