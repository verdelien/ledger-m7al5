// Every <select> in the new interface keeps working as before (value, change
// events, disabled), but its native list is replaced by the app's own popover
// list. The select stays in the page, hidden, as the source of truth; a button
// placed right after it shows the chosen option and opens the list.

import { el } from './dom.js';
import { openPopover, closePopover } from './popover.js';

const buttons = new WeakMap(); // select → its button
let rootObserver = null;
let labelClicksInstalled = false;

/** Enhance every select under `root`, now and whenever one is added later. */
export function enhanceSelects(root = document.body) {
  if (!root) return;
  scan(root);
  installLabelClicks();
  if (rootObserver) return;
  rootObserver = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.removedNodes) {
        // A select taken out on its own takes its button with it.
        if (node.nodeType === 1 && node.matches('select') && !node.isConnected) buttons.get(node)?.remove();
      }
      for (const node of record.addedNodes) {
        if (node.nodeType === 1) scan(node);
      }
    }
  });
  rootObserver.observe(root, { childList: true, subtree: true });
}

function scan(node) {
  const selects = node.matches?.('select') ? [node] : [];
  if (node.querySelectorAll) selects.push(...node.querySelectorAll('select'));
  for (const select of selects) {
    if (select.closest('.legacy')) continue;
    if (select.hasAttribute('data-enhanced')) {
      // Moved elsewhere: bring its button along.
      const button = buttons.get(select);
      if (button && select.isConnected && select.nextSibling !== button) select.after(button);
      continue;
    }
    enhance(select);
  }
}

/** A click on a label focuses the button of the select it belongs to. */
function installLabelClicks() {
  if (labelClicksInstalled) return;
  labelClicksInstalled = true;
  document.addEventListener('click', event => {
    const label = event.target.closest?.('label[for]');
    if (!label) return;
    const target = document.getElementById(label.htmlFor);
    const button = target && buttons.get(target);
    if (!button) return;
    event.preventDefault();
    if (!button.disabled) button.focus();
  });
}

function labelOf(select) {
  const own = select.getAttribute('aria-label');
  if (own) return own.trim();
  if (select.id) {
    const label = document.querySelector(`label[for="${CSS.escape(select.id)}"]`);
    if (label) return label.textContent.trim();
  }
  const wrapping = select.closest('label');
  if (wrapping) {
    // The label's own words, without the select's options or the button's text.
    const copy = wrapping.cloneNode(true);
    copy.querySelectorAll('select, .select-button').forEach(node => node.remove());
    return copy.textContent.trim();
  }
  return '';
}

function enhance(select) {
  if (select.multiple) return; // a list box, not a dropdown
  select.setAttribute('data-enhanced', '');

  // Keep the place the select held in its row before it is hidden.
  const inlineWidth = select.style.width;
  let flex = null;
  if (select.isConnected) {
    const computed = getComputedStyle(select);
    if (computed.flexGrow !== '0' || select.style.flex) {
      flex = `${computed.flexGrow} ${computed.flexShrink} ${computed.flexBasis}`;
    }
  }

  const text = el('span', { class: 'select-button-text' });
  const button = el('button', {
    type: 'button', class: 'select-button',
    'aria-haspopup': 'listbox', 'aria-expanded': 'false'
  }, text, el('span', { class: 'caret', 'aria-hidden': 'true', text: '▾' }));
  if (inlineWidth) button.style.width = inlineWidth;
  if (flex) button.style.flex = flex;
  buttons.set(select, button);

  let popover = null;

  function refresh() {
    const chosen = select.options[select.selectedIndex];
    const value = chosen ? chosen.textContent.trim() : '';
    const label = labelOf(select);
    if (text.textContent !== value) text.textContent = value;
    const name = label ? `${label}: ${value}` : value;
    if (button.getAttribute('aria-label') !== name) button.setAttribute('aria-label', name);
    if (button.disabled !== select.disabled) button.disabled = select.disabled;
    if (button.hidden !== select.hidden) button.hidden = select.hidden;
    if (select.disabled && popover) closePopover();
  }

  function choose(option) {
    const changed = select.selectedIndex !== option.index;
    closePopover();
    if (!changed) return;
    select.selectedIndex = option.index;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    refresh();
  }

  function open() {
    refresh();
    if (select.disabled) return;
    const label = labelOf(select);
    const items = [];   // the choosable rows, in order
    const byItem = new Map();

    const row = (option, groupDisabled) => {
      const disabled = option.disabled || groupDisabled;
      const item = el('li', {
        role: 'option', tabIndex: -1, class: 'pop-option',
        'aria-selected': String(option.index === select.selectedIndex),
        'aria-disabled': disabled ? 'true' : null,
        'data-value': option.value,
        onclick: () => { if (!disabled) choose(option); }
      }, el('strong', { text: option.textContent.trim() || ' ' }));
      if (!disabled) { items.push(item); byItem.set(item, option); }
      return item;
    };

    const rows = [];
    for (const child of select.children) {
      if (child.tagName === 'OPTGROUP') {
        rows.push(el('li', { class: 'pop-group', role: 'presentation', text: child.label }));
        for (const option of child.children) {
          if (option.tagName === 'OPTION') rows.push(row(option, child.disabled));
        }
      } else if (child.tagName === 'OPTION') rows.push(row(child, false));
    }
    const list = el('ul', { class: 'pop-list', role: 'listbox', 'aria-label': label || null }, rows);

    list.addEventListener('keydown', event => {
      if (!items.length) return;
      const at = items.indexOf(document.activeElement);
      let to = -1;
      if (event.key === 'ArrowDown') to = (at + 1) % items.length;
      else if (event.key === 'ArrowUp') to = (at - 1 + items.length) % items.length;
      else if (event.key === 'Home') to = 0;
      else if (event.key === 'End') to = items.length - 1;
      else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (at >= 0) choose(byItem.get(items[at]));
        return;
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        // Typing a character jumps to the next option that starts with it.
        const letter = event.key.toLowerCase();
        const order = [...items.slice(at + 1), ...items.slice(0, at + 1)];
        to = items.indexOf(order.find(item => item.textContent.trim().toLowerCase().startsWith(letter)));
      }
      if (to < 0) return;
      event.preventDefault();
      items[to].focus();
    });

    popover = openPopover({
      anchor: button, content: list, label: label || 'Choose',
      onClose: () => { popover = null; }
    });
    const start = items.find(item => item.getAttribute('aria-selected') === 'true') || items[0];
    start?.focus();
  }

  button.addEventListener('click', () => (popover ? closePopover() : open()));
  button.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    if (!popover) open();
  });

  // Hide the native control; it stays in the page as the source of truth.
  select.classList.add('select-native');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  select.after(button);

  // Stay in step when code sets .value / .selectedIndex directly…
  for (const name of ['value', 'selectedIndex']) {
    const native = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, name);
    if (!native?.set) continue;
    Object.defineProperty(select, name, {
      configurable: true,
      enumerable: native.enumerable,
      get() { return native.get.call(this); },
      set(next) { native.set.call(this, next); refresh(); }
    });
  }
  // …when its options or attributes change, and when it changes itself.
  new MutationObserver(refresh).observe(select, {
    childList: true, subtree: true, attributes: true, characterData: true
  });
  select.addEventListener('change', refresh);

  // Screens restore focus after a redraw by `data-focus`, and may focus the
  // select itself before this runs: send that focus on to the button.
  if (select.dataset.focus) button.dataset.focus = select.dataset.focus;
  select.addEventListener('focus', () => button.focus());

  refresh();
  if (document.activeElement === select) button.focus();
}
