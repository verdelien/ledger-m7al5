// The four report drawings, as inline SVG. No chart library.
// Every mark can be reached with Tab, carries an aria-label, and shows a
// tooltip on hover, focus or tap. Colours come from the --chart-* variables
// in style.css, so both themes work without any change here.

import { el } from './dom.js';
import { pixelIconNode, PIXEL_ICONS } from './pixel-icons.js';
import { squarify, sharePercent } from '../reports-view.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** Create an SVG element. Props: `text`, `on<event>` listeners, everything else as an attribute. */
export function svgNode(tag, props = {}, ...children) {
  const node = document.createElementNS(SVG_NAMESPACE, tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false || value === '') continue;
    if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  node.append(...children.flat().filter(child => child != null && child !== false));
  return node;
}

/** The CSS colour for a palette position (0–9); anything else is the quiet "other" tone. */
export function chartColour(index) {
  return index >= 0 ? `var(--chart-${index + 1})` : 'var(--chart-other)';
}

/** 'Nov' and 'November 2026' for '2026-11'. */
export function reportMonthShort(month) {
  return new Date(month + '-01T12:00:00Z').toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
}
export function reportMonthLong(month) {
  return new Date(month + '-01T12:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/**
 * One tooltip for a chart, placed inside `frame` (which must be position: relative).
 * It is centred on a point of the drawing and then pulled back inside the frame,
 * so it cannot run off a phone screen.
 */
export function createChartTip(frame) {
  const box = el('div', { class: 'rp-tip', hidden: true, 'aria-hidden': 'true' });
  frame.append(box);
  // A tap on empty chart space puts the tooltip away.
  frame.addEventListener('click', event => { if (!event.target.closest?.('.rp-mark')) box.hidden = true; });
  return {
    /** `fx`, `fy`: the point as fractions of the drawing's width and height. */
    show(svg, fx, fy, title, lines = []) {
      box.replaceChildren(el('strong', { text: title }), ...lines.filter(Boolean).map(text => el('span', { text })));
      box.hidden = false;
      const outer = frame.getBoundingClientRect();
      const chart = svg.getBoundingClientRect();
      const x = chart.left - outer.left + fx * chart.width;
      const y = chart.top - outer.top + fy * chart.height;
      const left = Math.max(0, Math.min(x - box.offsetWidth / 2, frame.clientWidth - box.offsetWidth));
      const above = y - box.offsetHeight - 10;
      box.style.left = `${left}px`;
      box.style.top = `${above < 0 ? y + 14 : above}px`;
    },
    hide() { box.hidden = true; }
  };
}

/**
 * Make a drawn shape behave like a control: focusable, labelled, with a tooltip.
 * With `onPick` it is a button (Enter, Space, click or tap); without, a tap shows the tooltip.
 */
function chartMark(node, { svg, tip, at, title, lines, label, onPick = null, focusKey = null }) {
  node.setAttribute('tabindex', '0');
  node.setAttribute('role', onPick ? 'button' : 'img');
  node.setAttribute('aria-label', label);
  if (focusKey) node.setAttribute('data-focus', focusKey);
  node.classList.add('rp-mark');
  if (onPick) node.classList.add('rp-mark--pick');

  const show = () => tip.show(svg, at[0], at[1], title, lines);
  const act = () => {
    if (!onPick) return show();
    tip.hide();
    onPick(node);
  };
  node.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') show(); });
  node.addEventListener('pointerleave', event => { if (event.pointerType === 'mouse') tip.hide(); });
  node.addEventListener('focus', show);
  node.addEventListener('blur', () => tip.hide());
  node.addEventListener('click', act);
  node.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); act(); }
  });
  return node;
}

/** A category icon inside a drawing, centred on (x, y). Pixel icons are nested SVG; emoji are text. */
function chartIcon(icon, x, y, size, className = 'rp-chart-icon') {
  if (!icon) return null;
  if (icon.type === 'pixel') {
    const node = pixelIconNode(icon.value, PIXEL_ICONS, className);
    if (!node) return null;
    for (const [name, value] of [['x', x - size / 2], ['y', y - size / 2], ['width', size], ['height', size]]) node.setAttribute(name, value);
    return node;
  }
  if (icon.type !== 'emoji' || !icon.value) return null;
  return svgNode('text', {
    x, y, class: className + ' rp-chart-emoji', 'font-size': size * .9,
    'text-anchor': 'middle', 'dominant-baseline': 'central', 'aria-hidden': 'true', text: icon.value
  });
}

/** `text` cut to fit `width` at about `charWidth` per character; '' when not even three fit. */
function fitText(text, width, charWidth) {
  const room = Math.floor(width / charWidth);
  if (text.length <= room) return text;
  return room >= 4 ? text.slice(0, room - 1).trimEnd() + '…' : '';
}

// ---------------------------------------------------------------------------
// Donut
// ---------------------------------------------------------------------------

/** The outline of a ring segment between two angles (radians, clockwise from 12 o'clock at -π/2). */
function ringSegment(centre, outer, inner, from, to) {
  const end = Math.min(to, from + Math.PI * 2 - 0.0001); // a full ring still needs two distinct ends
  const large = end - from > Math.PI ? 1 : 0;
  const point = (radius, angle) => `${(centre + radius * Math.cos(angle)).toFixed(2)} ${(centre + radius * Math.sin(angle)).toFixed(2)}`;
  return `M${point(outer, from)} A${outer} ${outer} 0 ${large} 1 ${point(outer, end)} `
    + `L${point(inner, end)} A${inner} ${inner} 0 ${large} 0 ${point(inner, from)} Z`;
}

/**
 * slices → [{ id, name, icon, colour, minor (BigInt > 0) }], total → their sum.
 * centre → { title, amount, note }: the three lines in the middle.
 * canPick(slice) says which segments open something; onPick(slice) opens it.
 * more(slice) → extra tooltip lines (the comparison, when one is on).
 */
export function donutChart({ slices, total, centre, format, tip, canPick, onPick, animate, label, more = () => [] }) {
  const size = 300, middle = 150, outer = 108, inner = 68, iconRadius = 128;
  const svg = svgNode('svg', { class: 'rp-chart rp-donut', viewBox: `0 0 ${size} ${size}`, role: 'group', 'aria-label': label });
  const ring = svgNode('g', { class: animate ? 'rp-enter' : '' });
  const icons = svgNode('g', { class: animate ? 'rp-enter' : '', 'aria-hidden': 'true' });
  const whole = Number(total);
  let angle = -Math.PI / 2;

  for (const slice of slices) {
    const sweep = Number(slice.minor) / whole * Math.PI * 2;
    const from = angle;
    const mid = from + sweep / 2;
    angle += sweep;
    const percent = sharePercent(slice.minor, total);
    const pick = canPick(slice);
    const band = (outer + inner) / 2;
    ring.append(chartMark(svgNode('path', { class: 'rp-slice', d: ringSegment(middle, outer, inner, from, angle), fill: chartColour(slice.colour) }), {
      svg, tip,
      at: [(middle + band * Math.cos(mid)) / size, (middle + band * Math.sin(mid)) / size],
      title: slice.name,
      lines: [format(slice.minor), `${percent}% of ${centre.whole}`, ...more(slice)],
      label: [`${slice.name}, ${format(slice.minor)}, ${percent}% of ${centre.whole}`, ...more(slice)].join('. ') + '.' + (pick ? ' Opens what is inside.' : ''),
      onPick: pick ? () => onPick(slice) : null,
      focusKey: 'rp-slice:' + slice.id
    }));
    // The icon sits just outside its segment, when the segment is wide enough to own that spot.
    if (sweep >= 0.2) icons.append(chartIcon(slice.icon, middle + iconRadius * Math.cos(mid), middle + iconRadius * Math.sin(mid), 16) || '');
  }

  const amountSize = Math.min(22, (inner * 2 - 20) / (centre.amount.length * .62));
  svg.append(ring, icons, svgNode('g', { class: 'rp-centre', 'aria-hidden': 'true', 'text-anchor': 'middle' },
    svgNode('text', { class: 'rp-centre-title', x: middle, y: middle - 20, text: fitText(centre.title, inner * 2 - 24, 6.4) || centre.title.slice(0, 12) }),
    svgNode('text', { class: 'rp-centre-amount', x: middle, y: middle + 6, 'font-size': amountSize.toFixed(1), text: centre.amount }),
    svgNode('text', { class: 'rp-centre-note', x: middle, y: middle + 26, text: centre.note })));
  return svg;
}

// ---------------------------------------------------------------------------
// Shared frame for the two month charts
// ---------------------------------------------------------------------------

const MONTH_CHART = { width: 360, height: 236, left: 4, right: 356, top: 22, base: 196 };

/** Gridlines, the top value, and month letters with the year under each January (and the first month). */
function monthAxis(months, topLabel) {
  const { left, right, top, base } = MONTH_CHART;
  const slot = (right - left) / months.length;
  const axis = svgNode('g', { 'aria-hidden': 'true' },
    svgNode('line', { class: 'rp-grid', x1: left, x2: right, y1: top, y2: top }),
    svgNode('line', { class: 'rp-grid', x1: left, x2: right, y1: (top + base) / 2, y2: (top + base) / 2 }),
    svgNode('line', { class: 'rp-baseline', x1: left, x2: right, y1: base, y2: base }),
    svgNode('text', { class: 'rp-axis-text', x: left, y: top - 7, text: topLabel }));
  months.forEach((month, index) => {
    const x = left + slot * (index + .5);
    axis.append(svgNode('text', { class: 'rp-axis-text', x, y: base + 15, 'text-anchor': 'middle', text: reportMonthShort(month).slice(0, 1) }));
    if (index === 0 || month.endsWith('-01')) {
      axis.append(svgNode('text', { class: 'rp-axis-text rp-axis-year', x: left + slot * index + 2, y: base + 31, text: month.slice(0, 4) }));
    }
  });
  return { axis, slot };
}

/** A see-through rectangle over a month's whole column, so the tap target is as tall as the chart. */
function monthHit(index, slot) {
  const { left, top, height } = MONTH_CHART;
  return svgNode('rect', { class: 'rp-hit', x: left + slot * index, y: top - 8, width: slot, height: height - top + 8 });
}

// ---------------------------------------------------------------------------
// Bars
// ---------------------------------------------------------------------------

/**
 * months → [{ month, byCategory }], categories → the ones switched on, in colour order.
 * onPick(month, anchor) opens that month's breakdown.
 */
export function barsChart({ months, categories, format, tip, onPick, label }) {
  const { width, height, left, top, base } = MONTH_CHART;
  const part = (month, category) => {
    const minor = month.byCategory[category.id] || 0n;
    return minor > 0n ? minor : 0n; // a month of net refunds in a category draws nothing
  };
  const sums = months.map(month => categories.reduce((sum, category) => sum + part(month, category), 0n));
  const highest = sums.reduce((max, sum) => (sum > max ? sum : max), 0n);
  const scale = (base - top) / Math.max(1, Number(highest));

  const svg = svgNode('svg', { class: 'rp-chart rp-wide-chart', viewBox: `0 0 ${width} ${height}`, role: 'group', 'aria-label': label });
  const { axis, slot } = monthAxis(months.map(m => m.month), format(highest));
  svg.append(axis);

  const barWidth = slot * .64;
  months.forEach((month, index) => {
    const x = left + slot * index + (slot - barWidth) / 2;
    const stack = svgNode('g', { class: 'rp-grow' });
    let y = base;
    for (const category of categories) {
      const barHeight = Number(part(month, category)) * scale;
      if (barHeight <= 0) continue;
      y -= barHeight;
      stack.append(svgNode('rect', { class: 'rp-bar', x: x.toFixed(2), y: y.toFixed(2), width: barWidth.toFixed(2), height: barHeight.toFixed(2), fill: chartColour(category.colour) }));
    }
    const name = reportMonthLong(month.month);
    svg.append(chartMark(svgNode('g', {}, monthHit(index, slot), stack), {
      svg, tip,
      at: [(x + barWidth / 2) / width, y / height],
      title: name,
      lines: [format(sums[index]), 'Open for the breakdown'],
      label: `${name}, ${format(sums[index])}. Opens the breakdown.`,
      onPick: anchor => onPick(month.month, anchor),
      focusKey: 'rp-month:' + month.month
    }));
  });
  return svg;
}

/**
 * The period against its comparison: a pair of horizontal bars per category, the period's
 * in the category colour and the comparison's faint and dashed underneath, on one scale.
 * rows → [{ id, name, icon, colour, minor, previous, isNew }]; negative amounts draw nothing.
 * deltaText(row) → the difference in words, for the tooltip and the label.
 */
export function compareBarsChart({ rows, format, tip, label, compareLabel, deltaText }) {
  const width = 360, rowHeight = 46, left = 4, barRoom = 252, amountRight = 356;
  const height = Math.max(1, rows.length) * rowHeight + 4;
  const drawn = minor => (minor > 0n ? minor : 0n);
  const highest = rows.reduce((max, row) => [drawn(row.minor), drawn(row.previous)].reduce((m, v) => (v > m ? v : m), max), 0n);
  const scale = barRoom / Math.max(1, Number(highest));
  const svg = svgNode('svg', { class: 'rp-chart rp-wide-chart rp-compare-bars', viewBox: `0 0 ${width} ${height}`, role: 'group', 'aria-label': label });

  rows.forEach((row, index) => {
    const y = index * rowHeight + 4;
    const icon = chartIcon(row.icon, left + 6, y + 6, 12);
    const now = Math.max(drawn(row.minor) > 0n ? 1 : 0, Number(drawn(row.minor)) * scale);
    const before = Math.max(drawn(row.previous) > 0n ? 1 : 0, Number(drawn(row.previous)) * scale);
    const group = svgNode('g', {},
      svgNode('rect', { class: 'rp-hit', x: 0, y, width, height: rowHeight - 4 }),
      icon || '',
      svgNode('text', { class: 'rp-pair-name', x: left + (icon ? 17 : 0), y: y + 10, 'aria-hidden': 'true', text: fitText(row.name, 300, 6.8) || row.name.slice(0, 24) }),
      svgNode('g', { class: 'rp-widen' },
        svgNode('rect', { class: 'rp-bar', x: left, y: y + 16, width: now.toFixed(2), height: 10, fill: chartColour(row.colour) }),
        svgNode('rect', { class: 'rp-bar rp-bar--before', x: left, y: y + 29, width: before.toFixed(2), height: 8, fill: chartColour(row.colour), stroke: chartColour(row.colour) })),
      svgNode('text', { class: 'rp-pair-amount', x: amountRight, y: y + 25, 'text-anchor': 'end', 'aria-hidden': 'true', text: format(row.minor) }),
      svgNode('text', { class: 'rp-pair-amount rp-pair-amount--before', x: amountRight, y: y + 37, 'text-anchor': 'end', 'aria-hidden': 'true', text: row.isNew ? 'new' : format(row.previous) }));
    const lines = [`This period: ${format(row.minor)}`, `${compareLabel}: ${row.isNew ? 'nothing' : format(row.previous)}`, deltaText(row)];
    svg.append(chartMark(group, {
      svg, tip, at: [.5, (y + 14) / height], title: row.name, lines, label: `${row.name}. ${lines.join('. ')}.`,
      focusKey: 'rp-pair:' + row.id
    }));
  });
  return svg;
}

// ---------------------------------------------------------------------------
// Trend
// ---------------------------------------------------------------------------

/** What a month's point says: spent, budget and the difference, in words. */
export function trendLines(point, format, hasBudget, reference = null) {
  const gap = point.actual - point.budget;
  return [
    `Spent ${format(point.actual)}`,
    reference && reference.minor != null && `${reference.label}: ${format(reference.minor)}`,
    hasBudget && `Budget ${format(point.budget)}`,
    hasBudget && (gap > 0n ? `${format(gap)} over budget` : gap < 0n ? `${format(-gap)} under budget` : 'Exactly on budget'),
    point.missing ? `${point.missing} left out: no value in this currency` : null
  ].filter(Boolean);
}

/**
 * series → { months: [{ month, budget, actual, missing }] }. Points over budget are vermilion diamonds.
 * reference → { label, values: [minor | null per month] }: the comparison, drawn as a faint
 * dashed line wherever there is a value.
 */
export function trendChart({ series, format, tip, label, reference = null }) {
  const { width, height, left, top, base } = MONTH_CHART;
  const points = series.months;
  const hasBudget = points.some(point => point.budget !== 0n);
  const referenceAt = index => (reference ? { label: reference.label, minor: reference.values[index] ?? null } : null);
  const highest = points.reduce((max, point, index) => [point.actual, point.budget, referenceAt(index)?.minor ?? 0n].reduce((m, v) => (v > m ? v : m), max), 0n);
  const scale = (base - top) / Math.max(1, Number(highest));
  const yOf = minor => base - Math.max(0, Number(minor)) * scale;

  const svg = svgNode('svg', { class: 'rp-chart rp-wide-chart', viewBox: `0 0 ${width} ${height}`, role: 'group', 'aria-label': label });
  const { axis, slot } = monthAxis(points.map(p => p.month), format(highest));
  const xOf = index => left + slot * (index + .5);
  const line = pick => points.map((point, index) => `${xOf(index).toFixed(2)},${yOf(pick(point)).toFixed(2)}`).join(' ');

  // The reference line is broken wherever a month has nothing to compare with.
  const runs = [];
  points.forEach((point, index) => {
    const minor = referenceAt(index)?.minor;
    if (minor == null) return runs.push([]);
    if (!runs.length) runs.push([]);
    runs[runs.length - 1].push(`${xOf(index).toFixed(2)},${yOf(minor).toFixed(2)}`);
  });

  svg.append(axis, svgNode('g', { class: 'rp-enter', 'aria-hidden': 'true' },
    runs.filter(run => run.length > 1).map(run => svgNode('polyline', { class: 'rp-line rp-line--reference', points: run.join(' ') })),
    runs.filter(run => run.length === 1).map(run => svgNode('circle', { class: 'rp-reference-dot', cx: run[0].split(',')[0], cy: run[0].split(',')[1], r: 1.5 })),
    hasBudget && svgNode('polyline', { class: 'rp-line rp-line--budget', points: line(point => point.budget) }),
    svgNode('polyline', { class: 'rp-line rp-line--spent', points: line(point => point.actual) })));

  points.forEach((point, index) => {
    const x = xOf(index), y = yOf(point.actual);
    const over = hasBudget && point.actual > point.budget;
    const half = over ? 5 : 3.5;
    const square = svgNode('rect', {
      class: 'rp-point' + (over ? ' rp-point--over' : ''),
      x: (x - half).toFixed(2), y: (y - half).toFixed(2), width: half * 2, height: half * 2,
      transform: over ? `rotate(45 ${x.toFixed(2)} ${y.toFixed(2)})` : null
    });
    const name = reportMonthLong(point.month);
    const lines = trendLines(point, format, hasBudget, referenceAt(index));
    svg.append(chartMark(svgNode('g', {}, monthHit(index, slot), square), {
      svg, tip, at: [x / width, y / height], title: name, lines, label: `${name}. ${lines.join('. ')}.`,
      focusKey: 'rp-month:' + point.month
    }));
  });
  return svg;
}

// ---------------------------------------------------------------------------
// Treemap
// ---------------------------------------------------------------------------

/**
 * items → [{ id, name, icon, colour, minor (BigInt > 0), children? }]. Blocks with children show
 * them as faint subdivisions and can be picked to zoom in. more(item) → extra tooltip lines.
 */
export function treemapChart({ items, total, whole, format, tip, onPick, animate, label, more = () => [] }) {
  const width = 360, height = 270;
  const svg = svgNode('svg', { class: 'rp-chart rp-wide-chart rp-treemap', viewBox: `0 0 ${width} ${height}`, role: 'group', 'aria-label': label });
  const blocks = svgNode('g', { class: animate ? 'rp-enter' : '' });
  const rects = squarify(items.map(item => Number(item.minor)), width, height);

  items.forEach((item, index) => {
    const { x, y, w, h } = rects[index];
    const inside = (item.children || []).filter(child => child.minor > 0n);
    const percent = sharePercent(item.minor, total);
    const group = svgNode('g', {}, svgNode('rect', { class: 'rp-block', x: x.toFixed(2), y: y.toFixed(2), width: w.toFixed(2), height: h.toFixed(2), fill: chartColour(item.colour) }));

    if (inside.length > 1) {
      squarify(inside.map(child => Number(child.minor)), w, h).forEach(sub => group.append(svgNode('rect', {
        class: 'rp-subblock', x: (x + sub.x).toFixed(2), y: (y + sub.y).toFixed(2), width: sub.w.toFixed(2), height: sub.h.toFixed(2)
      })));
    }

    // Icon, name and amount, each only where the block has room for it.
    const icon = w >= 26 && h >= 24 ? chartIcon(item.icon, x + 13, y + 13, 12, 'rp-block-icon') : null;
    const textLeft = x + (icon ? 24 : 6);
    const name = h >= 20 ? fitText(item.name, x + w - textLeft - 4, 6.4) : '';
    const amount = h >= 40 ? fitText(format(item.minor), w - 10, 6) : '';
    group.append(icon || '',
      name && svgNode('text', { class: 'rp-block-name', x: textLeft, y: y + 17, 'aria-hidden': 'true', text: name }),
      amount && svgNode('text', { class: 'rp-block-amount', x: x + 6, y: y + 33, 'aria-hidden': 'true', text: amount }));

    blocks.append(chartMark(group, {
      svg, tip, at: [(x + w / 2) / width, (y + Math.min(h / 2, 24)) / height],
      title: item.name,
      lines: [format(item.minor), `${percent}% of ${whole}`, ...more(item)],
      label: [`${item.name}, ${format(item.minor)}, ${percent}% of ${whole}`, ...more(item)].join('. ') + '.' + (inside.length ? ' Zooms in.' : ''),
      onPick: item.children?.length ? () => onPick(item) : null,
      focusKey: 'rp-slice:' + item.id
    }));
  });
  svg.append(blocks);
  return svg;
}
