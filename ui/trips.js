// Travel: the year's travel budget, the list of trips, and one trip's breakdown.
// Reached from Reports ('#trips', and '#trips/<id>' for one trip); it is not a tab.
// Travel is analysed here, apart from the normal reports.

import { categoryPath } from '../model.js';
import {
  travelYear, tripSummary, saveTravelBudget, saveTrip, archiveTrip, listTrips
} from '../travel-logic.js';
import { el, slip, sectionTitle, todayIso, formatDay, formatMoney, plainAmount, errorMessage, showToast } from './dom.js';
import { ledger, saveLedger } from './ledger.js';
import { openPopover, closePopover } from './popover.js';

// View state kept between re-renders: the budget year shown (0 = this year) and whether the trip is being edited.
const tripsView = { year: 0, editing: false };

const TRIP_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '3–10 Dec 2026', '28 Nov – 3 Dec 2026' or '30 Dec 2026 – 2 Jan 2027'. */
export function tripDatesText(start, end) {
  const [y1, m1, d1] = start.split('-').map(Number), [y2, m2, d2] = end.split('-').map(Number);
  const last = `${d2} ${TRIP_MONTHS[m2 - 1]} ${y2}`;
  if (start === end) return last;
  if (y1 !== y2) return `${d1} ${TRIP_MONTHS[m1 - 1]} ${y1} – ${last}`;
  if (m1 !== m2) return `${d1} ${TRIP_MONTHS[m1 - 1]} – ${last}`;
  return `${d1}–${last}`;
}

/** "Also 3,000 JPY with no GBP value", one line per currency. Nothing is converted. */
function tripsUnvaluedNotes(unvalued, currency) {
  return unvalued.map((line, index) => el('p', {
    class: 'hint',
    text: `${index ? 'And' : 'Also'} ${formatMoney(line.minor, line.currency, line.precision)} with no ${currency} value (${line.count === 1 ? '1 entry' : `${line.count} entries`}), not added in.`
  }));
}

function tripsRerender() {
  const root = document.getElementById('screen');
  root.replaceChildren();
  renderTrips(root, location.hash.replace('#', '').split('/')[1] || '');
}

export function renderTrips(root, section) {
  const state = ledger.state;
  const trip = section && state.trips.find(t => t.id === decodeURIComponent(section));
  if (section && !trip) {
    root.append(slip({ label: 'Travel', kind: 'Trip' },
      el('a', { class: 'btn-text', href: '#trips', text: '‹ Travel' }),
      el('p', { class: 'empty', text: 'That trip no longer exists.' })));
    return;
  }
  if (!trip) tripsView.editing = false;
  root.append(trip ? buildTripDetail(state, trip) : buildTripsOverview(state));
}

// ---------------------------------------------------------------------------
// '#trips': the year's budget and the list of trips
// ---------------------------------------------------------------------------

function buildTripsOverview(state) {
  const today = todayIso();
  const thisYear = Number(today.slice(0, 4));
  const year = tripsView.year || thisYear;
  const data = travelYear(state, year);
  const { budget } = data;
  const money = minor => formatMoney(minor, budget.currency, budget.precision);
  const over = data.left < 0n;
  const share = data.spent <= 0n ? 0 : Math.min(100, Number(data.spent * 100n / BigInt(budget.minor)));

  const step = (delta, symbol, word) => el('button', {
    type: 'button', class: 'icon-btn', text: symbol, 'aria-label': `${word} year`, 'data-focus': `tv-year-${word}`,
    onclick: () => { tripsView.year = year + delta; tripsRerender(); }
  });
  const editBudget = el('button', {
    type: 'button', class: 'btn-text', text: 'Edit budget', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'data-focus': 'tv-budget',
    onclick: () => openTravelBudget(editBudget, budget)
  });
  const fact = (label, value, negative = false) => el('div', { class: 'pot-fact' },
    el('dt', { text: label }), el('dd', { class: negative ? 'is-negative' : '', text: value }));

  const tripRow = trip => {
    const sum = tripSummary(state, trip.id);
    const current = trip.start <= today && today <= trip.end;
    return el('li', { class: 'list-row' },
      el('a', { class: 'tv-trip-link', href: `#trips/${encodeURIComponent(trip.id)}`, 'data-focus': `tv-trip:${trip.id}` },
        el('span', { class: 'entry-text' },
          el('span', { class: 'entry-title' }, el('span', { text: trip.name }), current && ' ', current && el('span', { class: 'tag-fixed', text: 'Now' })),
          el('span', { class: 'entry-meta', text: [tripDatesText(trip.start, trip.end), sum.unvalued.length && 'some not valued'].filter(Boolean).join(' · ') })),
        el('span', { class: 'entry-amount', text: formatMoney(sum.totalReporting, sum.reportingCurrency, sum.reportingPrecision) }),
        el('span', { class: 'tv-arrow', 'aria-hidden': 'true', text: '→' })));
  };
  const trips = listTrips(state, today);

  return slip({ label: 'Travel', kind: String(year), wide: true },
    el('a', { class: 'btn-text', href: '#reports', text: '‹ Reports' }),
    el('p', { class: 'note', text: 'Travel is kept apart from the normal reports. The budget covers the whole calendar year.' }),
    el('div', { class: 'tv-year' }, step(-1, '‹', 'Previous'), el('strong', { class: 'tv-year-label', text: String(year) }), step(1, '›', 'Next'), editBudget),
    el('dl', { class: 'pot-facts' },
      fact('Budget for the year', money(budget.minor)),
      fact('Spent', money(data.spent)),
      fact(over ? 'Over budget' : 'Left', money(over ? -data.left : data.left), over)),
    el('div', {
      class: 'tv-meter' + (over ? ' is-over' : ''), role: 'img',
      'aria-label': over ? `Over the budget by ${money(-data.left)}` : `${share}% of the budget spent`
    }, el('span', { class: 'tv-meter-fill', style: `width:${over ? 100 : share}%` })),
    tripsUnvaluedNotes(data.unvalued, budget.currency),

    sectionTitle('Trips'),
    trips.length
      ? el('ul', { class: 'plain-list' }, trips.map(tripRow))
      : el('p', { class: 'empty', text: 'No trips yet. Add one below, then choose it when you record a travel expense.' }),
    el('details', { class: 'fold' },
      el('summary', { text: 'Add a trip' }),
      buildTripForm(state, null)),

    sectionTitle(`Travel outside trips in ${year}`),
    el('p', { class: 'tv-total', text: money(data.outsideTrips) }),
    el('p', { class: 'hint', text: 'Travel spending in this year that is not attached to a trip.' }));
}

/** The small form behind "Edit budget". */
function openTravelBudget(anchor, budget) {
  const amount = el('input', { id: 'tv-budget-amount', type: 'text', inputMode: 'decimal', autocomplete: 'off', value: plainAmount(budget.minor, budget.precision) });
  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });
  const form = el('form', {
    class: 'pot-sheet', novalidate: true,
    onsubmit: async event => {
      event.preventDefault();
      try {
        const next = saveTravelBudget(ledger.state, { amountText: amount.value });
        closePopover({ restoreFocus: false });
        await saveLedger(next);
        showToast('Travel budget saved.');
      } catch (error) {
        errorBox.textContent = errorMessage(error);
        errorBox.hidden = false;
      }
    }
  },
    el('div', { class: 'field' },
      el('label', { for: amount.id, text: `Budget for a year (${ledger.state.settings.reportingCurrency})` }), amount,
      el('p', { class: 'hint', text: 'One amount for the whole calendar year. It applies to every year shown here.' })),
    errorBox,
    el('button', { type: 'submit', class: 'btn-primary btn-small', text: 'Save' }));
  openPopover({ anchor, label: 'Travel budget', role: 'dialog', content: form });
  amount.focus();
}

/** The form for a new trip (`trip` null) or an existing one. */
function buildTripForm(state, trip) {
  const key = trip ? 'edit' : 'new';
  const today = todayIso();
  const name = el('input', { id: `tv-name-${key}`, type: 'text', maxLength: 150, value: trip?.name || '' });
  const start = el('input', { id: `tv-start-${key}`, type: 'date', value: trip?.start || today });
  const end = el('input', { id: `tv-end-${key}`, type: 'date', value: trip?.end || today });
  const code = trip?.currency || state.settings.reportingCurrency;
  const currency = el('select', { id: `tv-currency-${key}` },
    [...new Set([...state.settings.activeCurrencies, code])].map(c => el('option', { value: c, text: c })));
  currency.value = code;
  const account = el('select', { id: `tv-account-${key}` },
    el('option', { value: '', text: 'Not set' }),
    state.accounts.filter(a => !a.archived || a.id === trip?.account).map(a => el('option', { value: a.id, text: `${a.name} (${a.currency})` })));
  account.value = trip?.account || '';
  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });
  const field = (control, label, hint) => el('div', { class: 'field' },
    el('label', { for: control.id, text: label }), control, hint && el('p', { class: 'hint', text: hint }));

  async function submit(event) {
    event.preventDefault();
    try {
      const next = saveTrip(ledger.state, {
        id: trip?.id, name: name.value, start: start.value, end: end.value, currency: currency.value, account: account.value
      });
      tripsView.editing = false;
      await saveLedger(next);
      showToast(trip ? 'Trip saved.' : 'Trip added. Choose it on Today when you record a travel expense.');
    } catch (error) {
      errorBox.textContent = errorMessage(error);
      errorBox.hidden = false;
    }
  }

  return el('form', { class: trip ? 'ed-edit' : 'fold-body', onsubmit: submit, novalidate: true },
    field(name, 'Name'),
    field(start, 'From'),
    field(end, 'To'),
    field(currency, 'Main currency', 'The currency you mostly pay in there. Add others in Settings → Currencies.'),
    field(account, 'Usual account (optional)'),
    errorBox,
    el('div', { class: 'ed-edit-actions' },
      el('button', { type: 'submit', class: 'btn-primary btn-small', text: trip ? 'Save' : 'Add trip' }),
      trip && el('button', { type: 'button', class: 'btn-text', text: 'Cancel', onclick: () => { tripsView.editing = false; tripsRerender(); } })));
}

// ---------------------------------------------------------------------------
// '#trips/<id>': one trip
// ---------------------------------------------------------------------------

function buildTripDetail(state, trip) {
  const sum = tripSummary(state, trip.id);
  const code = sum.reportingCurrency, precision = sum.reportingPrecision;
  const money = minor => formatMoney(minor, code, precision);
  const largest = sum.byGroup.reduce((max, group) => (group.minor > max ? group.minor : max), 0n);

  const groupRow = (group, index) => el('li', { class: 'tv-bar-row' },
    el('span', { class: 'tv-bar-name', text: group.name }),
    el('span', { class: 'tv-bar-amount', text: money(group.minor) }),
    el('span', { class: 'tv-bar-track', 'aria-hidden': 'true' },
      el('span', {
        class: 'tv-bar-fill',
        style: `width:${largest > 0n && group.minor > 0n ? Math.max(1, Number(group.minor * 100n / largest)) : 0}%;background:var(--chart-${index % 10 + 1})`
      })));

  const entryRow = ({ entry, refunded, net, reporting }) => {
    const category = state.categories.find(c => c.id === entry.category);
    const settled = entry.settledMinor != null && entry.settledCurrency && entry.settledCurrency !== entry.currency
      && `charged ${formatMoney(entry.settledMinor, entry.settledCurrency, entry.settledPrecision)}${entry.settledEstimate ? ' (estimate)' : ''}`;
    const meta = [
      formatDay(entry.date),
      entry.note,
      refunded > 0n && `${formatMoney(refunded, entry.currency, entry.precision)} refunded`,
      settled,
      entry.currency !== code && (reporting === null ? `no ${code} value` : `= ${money(reporting)}`)
    ].filter(Boolean).join(' · ');
    return el('li', { class: 'list-row' },
      el('span', { class: 'entry-text' },
        el('span', { class: 'entry-title', text: category?.parent ? categoryPath(state, category.id).replaceAll(' / ', ' › ') : category?.name || 'No category' }),
        el('span', { class: 'entry-meta', text: meta })),
      el('span', { class: 'entry-amount', text: formatMoney(net, entry.currency, entry.precision) }));
  };

  let armed = false;
  const archive = el('button', { type: 'button', class: 'btn-text', text: 'Archive', 'aria-label': `Archive ${trip.name}` });
  archive.addEventListener('blur', () => { armed = false; archive.textContent = 'Archive'; archive.classList.remove('is-armed'); });
  archive.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      archive.textContent = 'Press again to archive';
      archive.classList.add('is-armed');
      return;
    }
    try {
      const next = archiveTrip(ledger.state, trip.id);
      tripsView.editing = false;
      await saveLedger(next);
      location.hash = '#trips';
      showToast('Trip archived. Its entries are kept and still count in the year.');
    } catch (error) {
      showToast(errorMessage(error));
    }
  });
  const edit = el('button', {
    type: 'button', class: 'btn-text', text: 'Edit trip', 'aria-expanded': String(tripsView.editing), 'data-focus': 'tv-edit',
    onclick: () => { tripsView.editing = !tripsView.editing; tripsRerender(); }
  });

  return slip({ label: 'Travel', kind: trip.archived ? 'Archived trip' : 'Trip', wide: true },
    el('a', { class: 'btn-text', href: '#trips', text: '‹ Travel' }),
    el('h2', { class: 'tv-name', text: trip.name }),
    el('p', { class: 'note', text: `${tripDatesText(trip.start, trip.end)} · ${sum.days === 1 ? '1 day' : `${sum.days} days`} · mainly ${trip.currency}` }),
    el('dl', { class: 'pot-facts' },
      el('div', { class: 'pot-fact' }, el('dt', { text: `Spent (${code})` }), el('dd', { text: money(sum.totalReporting) })),
      el('div', { class: 'pot-fact' }, el('dt', { text: 'Per day' }), el('dd', { text: money(sum.perDay) }))),
    tripsUnvaluedNotes(sum.unvalued, code),

    sectionTitle('As paid'),
    sum.byCurrency.length
      ? el('ul', { class: 'plain-list' }, sum.byCurrency.map(line => el('li', { class: 'list-row' },
          el('span', { class: 'entry-text' }, el('span', { class: 'entry-title', text: line.currency })),
          el('span', { class: 'entry-amount', text: formatMoney(line.minor, line.currency, line.precision) }))))
      : el('p', { class: 'empty', text: 'Nothing recorded for this trip yet.' }),
    sum.byCurrency.length > 1 && el('p', { class: 'hint', text: 'Each currency is shown as it was paid. They are not added together.' }),

    sum.byGroup.length > 0 && sectionTitle(`By kind (${code})`),
    sum.byGroup.length > 0 && el('ul', { class: 'plain-list tv-bars' }, sum.byGroup.map(groupRow)),

    sectionTitle('Entries'),
    sum.entries.length
      ? el('ul', { class: 'plain-list' }, sum.entries.map(entryRow))
      : el('p', { class: 'empty', text: 'No entries. On Today, choose a Travel category and this trip.' }),
    sum.entries.length > 0 && el('p', { class: 'hint', text: 'Posted expenses, your own share, less refunds. Edit them on Today.' }),

    el('div', { class: 'ed-edit-actions' }, edit, !trip.archived && archive),
    tripsView.editing && buildTripForm(state, trip));
}
