// Small DOM and formatting helpers shared by every screen.

/** Where the previous interface lives. The standalone build rewrites this. */
export const LEGACY_URL = 'legacy.html';

/**
 * Create an element.
 * Props: `class`, `text`, `on<event>` listeners, DOM properties (value, type,
 * hidden…) and anything else as an attribute (aria-*, data-*).
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node && !key.includes('-')) node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter(child => child != null && child !== false));
  return node;
}

/** A paper slip: the one main surface of a screen. */
export function slip({ label, kind, wide = false }, ...children) {
  const head = el('div', { class: 'slip-head' },
    el('span', { class: 'qid', text: label }),
    kind && el('span', { class: 'kind', text: kind }));
  return el('div', { class: 'slip-wrap' + (wide ? ' slip-wrap--wide' : '') },
    el('section', { class: 'slip' }, head, ...children));
}

/** A small section heading with the red square in front. */
export function sectionTitle(text) {
  return el('h2', { class: 'section-title', text });
}

/** Today's date on this device, as YYYY-MM-DD. Dates only; no time zones. */
export function todayIso() {
  const now = new Date();
  const pad = number => String(number).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 'Thu 12 Nov' for a YYYY-MM-DD date. */
export function formatDay(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day)
    .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

const CURRENCY_SYMBOLS = { GBP: '£' };

/**
 * Format integer minor units exactly (no floating point).
 * GBP uses its symbol; other currencies show their code so ¥ is never ambiguous.
 * `signed` adds a plus sign to positive amounts.
 */
export function formatMoney(minor, currencyCode, precision, { signed = false } = {}) {
  const value = BigInt(minor);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const sign = negative ? '−' : signed && absolute > 0n ? '+' : '';
  const digitsText = plainAmount(absolute, precision, true);
  const symbol = CURRENCY_SYMBOLS[currencyCode];
  return symbol ? `${sign}${symbol}${digitsText}` : `${sign}${digitsText} ${currencyCode}`;
}

/** Minor units as a plain decimal string, e.g. 1250 → '12.50'. */
export function plainAmount(minor, precision, grouped = false) {
  const value = BigInt(minor);
  const scale = 10n ** BigInt(precision);
  const whole = value / scale;
  const fraction = precision ? '.' + (value % scale).toString().padStart(precision, '0') : '';
  return (grouped ? whole.toLocaleString('en-GB') : whole.toString()) + fraction;
}

/** A readable message for any thrown value. */
export function errorMessage(error) {
  return error?.message || 'That did not work. Your earlier records are unchanged.';
}

let toastTimer = 0;

/**
 * Show a short message at the bottom of the screen.
 * `action` ({ label, run }) adds one button, for example Undo; the toast
 * closes when it is used. `duration` is how long the toast stays, in ms.
 */
export function showToast(message, action = null, duration = 6000) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.replaceChildren(el('span', { text: message }));
  if (action) {
    toast.append(el('button', {
      type: 'button', class: 'toast-action', text: action.label,
      onclick: () => { clearTimeout(toastTimer); toast.hidden = true; action.run(); }
    }));
  }
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, duration);
}
