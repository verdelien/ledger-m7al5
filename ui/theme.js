// Theme choice: System → Light → Dark.
// The choice is stored in this browser and applied as data-theme on <html>.
// With "System" there is no data-theme, and the CSS follows prefers-color-scheme.

const THEME_KEY = 'expense-book.theme'; // shared with the previous version
const THEME_CHOICES = ['system', 'light', 'dark'];
const THEME_LABELS = { system: 'System', light: 'Light', dark: 'Dark' };
const themeListeners = new Set();

// Browser chrome colour: the paper of each theme (see --paper in style.css).
const THEME_COLORS = { light: '#f7f7f5', dark: '#131726' };

// Header button icons, 20×20, drawn in the text colour.
// System is a half-filled disc, Light a sun, Dark a moon.
const ICON_OPEN = '<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" aria-hidden="true" focusable="false">';
const THEME_ICONS = {
  system: `${ICON_OPEN}<circle cx="10" cy="10" r="6.5"/><path d="M10 3.5a6.5 6.5 0 0 1 0 13z" fill="currentColor" stroke="none"/></svg>`,
  light: `${ICON_OPEN}<circle cx="10" cy="10" r="3.5"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4"/></svg>`,
  dark: `${ICON_OPEN}<path d="M16 11.5A6.5 6.5 0 1 1 8.5 4a5 5 0 0 0 7.5 7.5z"/></svg>`
};

export function themeChoices() {
  return THEME_CHOICES.map(value => ({ value, label: THEME_LABELS[value] }));
}

export function getThemeChoice() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return THEME_CHOICES.includes(saved) ? saved : 'system';
  } catch {
    return 'system';
  }
}

export function setThemeChoice(choice) {
  if (!THEME_CHOICES.includes(choice)) choice = 'system';
  try {
    localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Storage is unavailable. The choice still applies until the page closes.
  }
  applyTheme(choice);
  for (const listener of themeListeners) listener(choice);
}

/** Call `listener(choice)` whenever the theme choice changes. */
export function onThemeChange(listener) {
  themeListeners.add(listener);
}

function applyTheme(choice) {
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;

  // With a manual choice both theme-color tags carry that theme's paper colour.
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    const own = (meta.getAttribute('media') || '').includes('dark') ? 'dark' : 'light';
    meta.setAttribute('content', THEME_COLORS[choice === 'system' ? own : choice]);
  }
}

/** Wire the header icon button: each press moves to the next choice. */
export function initThemeToggle(button) {
  const show = choice => {
    const next = THEME_CHOICES[(THEME_CHOICES.indexOf(choice) + 1) % THEME_CHOICES.length];
    button.innerHTML = THEME_ICONS[choice]; // fixed markup from this file
    button.title = `Theme: ${THEME_LABELS[choice]}`;
    button.setAttribute('aria-label', `Theme: ${THEME_LABELS[choice]}. Switch to ${THEME_LABELS[next]}.`);
  };
  button.addEventListener('click', () => {
    const current = getThemeChoice();
    setThemeChoice(THEME_CHOICES[(THEME_CHOICES.indexOf(current) + 1) % THEME_CHOICES.length]);
  });
  onThemeChange(show);
  applyTheme(getThemeChoice());
  show(getThemeChoice());
}
