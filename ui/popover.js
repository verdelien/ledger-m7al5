// One popover at a time. On iPad and wider it is a small panel under the
// button that opened it; on a phone it is a sheet rising from the bottom.
// It closes with an outside tap, Esc, or when the caller closes it.

import { el } from './dom.js';

const POPOVER_WIDE_SCREEN = '(min-width: 768px)';
const POPOVER_EDGE = 8; // smallest gap to the window edge, in px

let currentPopover = null;

/** Close the open popover, if there is one. */
export function closePopover(options) {
  currentPopover?.close(options);
}

/**
 * Open `content` in a popover anchored to the button `anchor`.
 *   label    → the heading, also the accessible name
 *   role     → 'dialog' for a panel of controls; leave out when the content
 *              carries its own role (a listbox)
 *   wide     → a fixed, wider panel (for grids)
 *   onClose  → called once, however it closes
 * The content node is only detached on close, so it can be shown again.
 * Returns { close({ restoreFocus }), panel }.
 */
export function openPopover({ anchor, content, label, role = null, wide = false, onClose = () => {} }) {
  closePopover();

  const backdrop = el('div', { class: 'popover-backdrop' });
  const panel = el('div', {
    class: 'popover' + (wide ? ' popover--wide' : ''),
    role, 'aria-label': role ? label : null, 'aria-modal': role === 'dialog' ? 'false' : null
  },
    el('div', { class: 'popover-head' },
      el('span', { class: 'popover-title', text: label }),
      el('button', { type: 'button', class: 'btn-text', text: 'Close', onclick: () => close() })),
    content);

  const viewport = window.visualViewport;
  let closed = false;

  /** Place the panel under (or above) its button; on a phone, clear the keyboard. */
  function place() {
    if (!anchor.isConnected) return close({ restoreFocus: false });
    const style = panel.style;
    if (!window.matchMedia(POPOVER_WIDE_SCREEN).matches) {
      const visibleHeight = viewport ? viewport.height : window.innerHeight;
      const hiddenBelow = viewport ? Math.max(0, window.innerHeight - viewport.offsetTop - viewport.height) : 0;
      style.setProperty('--pop-bottom', `${hiddenBelow}px`);
      style.setProperty('--pop-max', `${Math.max(160, visibleHeight - 24)}px`);
      return;
    }
    style.removeProperty('--pop-max');
    const button = anchor.getBoundingClientRect();
    const size = panel.getBoundingClientRect();
    const below = window.innerHeight - button.bottom - 4 - POPOVER_EDGE;
    const above = button.top - 4 - POPOVER_EDGE;
    const goesAbove = size.height > below && above > below;
    const room = Math.max(120, goesAbove ? above : below);
    const top = goesAbove ? button.top - 4 - Math.min(size.height, room) : button.bottom + 4;
    const left = Math.min(Math.max(POPOVER_EDGE, button.left), Math.max(POPOVER_EDGE, window.innerWidth - size.width - POPOVER_EDGE));
    style.setProperty('--pop-top', `${Math.max(POPOVER_EDGE, top)}px`);
    style.setProperty('--pop-left', `${left}px`);
    style.setProperty('--pop-max', `${room}px`);
  }

  function onPointerDown(event) {
    if (panel.contains(event.target) || anchor.contains(event.target)) return;
    close({ restoreFocus: false });
  }
  function onKeyDown(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    close();
  }
  /** Tabbing out of the panel closes it. */
  function onFocusOut(event) {
    const next = event.relatedTarget;
    if (next && !panel.contains(next) && next !== anchor) close({ restoreFocus: false });
  }
  const onNavigate = () => close({ restoreFocus: false });

  function close({ restoreFocus = true } = {}) {
    if (closed) return;
    closed = true;
    if (currentPopover === handle) currentPopover = null;
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place, true);
    window.removeEventListener('hashchange', onNavigate);
    viewport?.removeEventListener('resize', place);
    viewport?.removeEventListener('scroll', place);
    panel.removeEventListener('focusout', onFocusOut);
    content.remove(); // kept by the caller; only the frame is thrown away
    panel.remove();
    backdrop.remove();
    anchor.setAttribute('aria-expanded', 'false');
    onClose();
    if (restoreFocus && anchor.isConnected) anchor.focus();
  }

  const handle = { close, panel };
  currentPopover = handle;

  document.body.append(backdrop, panel);
  anchor.setAttribute('aria-expanded', 'true');
  place();

  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);
  window.addEventListener('hashchange', onNavigate);
  viewport?.addEventListener('resize', place);
  viewport?.addEventListener('scroll', place);
  panel.addEventListener('focusout', onFocusOut);

  return handle;
}
