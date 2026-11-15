// The app shell: five tabs (a bottom bar on phones, a side rail on iPad), hash routing, and re-rendering after a save.

import { el } from './dom.js';
import { navIconNode } from './pixel-icons.js';
import { onLedgerChange } from './ledger.js';
import { onThemeChange } from './theme.js';
import { renderToday } from './today.js';
import { renderSettings } from './settings.js';
import { renderCalendar } from './calendar.js';
import { renderPots } from './pots.js';
import { renderReports } from './reports.js';
import { renderTrips } from './trips.js';
import { renderPeople } from './people.js';
import { renderNetWorth } from './networth.js';

const TABS = [
  { id: 'today', label: 'Today', render: renderToday },
  { id: 'calendar', label: 'Calendar', render: renderCalendar },
  { id: 'pots', label: 'Pots', render: renderPots },
  { id: 'reports', label: 'Reports', render: renderReports },
  { id: 'settings', label: 'Settings', render: renderSettings }
];

// Screens with a route but no tab of their own. `tab` is the tab marked as current while they show.
const HIDDEN_ROUTES = [
  { id: 'trips', label: 'Travel', render: renderTrips, tab: 'reports' },
  { id: 'people', label: 'People', render: renderPeople, tab: 'today' },
  { id: 'networth', label: 'Net worth', render: renderNetWorth, tab: 'pots' }
];

/** The hash is '#tab' or '#tab/section' (Settings has sections, e.g. '#settings/estimates'). */
function currentRoute() {
  const [id, section = ''] = location.hash.replace('#', '').split('/');
  return { tab: [...TABS, ...HIDDEN_ROUTES].find(tab => tab.id === id) || TABS[0], section };
}

function currentTab() {
  return currentRoute().tab;
}

/** Draw the current screen. Focus returns to the same control when it still exists. */
function renderScreen() {
  const { tab, section } = currentRoute();
  const screen = document.getElementById('screen');
  const focusKey = document.activeElement?.dataset?.focus;

  for (const link of document.querySelectorAll('#tabs a')) {
    if (link.dataset.tab === (tab.tab || tab.id)) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }

  screen.replaceChildren();
  tab.render(screen, section);
  document.title = `${tab.label} · Expense book`;

  if (focusKey) screen.querySelector(`[data-focus="${CSS.escape(focusKey)}"]`)?.focus();
}

export function startShell() {
  document.getElementById('tabs').replaceChildren(
    ...TABS.map(tab => el('a', { class: 'tab', href: `#${tab.id}`, 'data-tab': tab.id },
      navIconNode(tab.id), el('span', { class: 'tab-label', text: tab.label }))));

  window.addEventListener('hashchange', () => { renderScreen(); window.scrollTo(0, 0); });
  onLedgerChange(renderScreen);
  // Keep the Settings theme control in step with the header button.
  onThemeChange(() => { if (currentTab().id === 'settings') renderScreen(); });
  renderScreen();
}
