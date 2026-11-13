// Category tree helpers and the category picker.
//
// The picker is a grid of equal top-level tiles, icon above label. Tapping a tile with
// subcategories unfolds them in place; nested groups (Travel) fold again
// inside. Choosing a pill, or a tile without children, sets the category.
// The chosen category is shown above the grid, with "Change" to clear it.

import { el } from './dom.js';
import { categoryIconNode } from './pixel-icons.js';

/** Children of `parentId` ('' for top level), in the user's order. */
export function childCategories(state, parentId, kind, includeArchived = false) {
  return state.categories
    .filter(c => c.kind === kind && (c.parent || '') === parentId && (includeArchived || !c.archived))
    .sort((a, b) => (a.order ?? 1e6) - (b.order ?? 1e6) || a.name.localeCompare(b.name));
}

/** True when `id` is `ancestorId` or sits somewhere beneath it. */
export function isWithinCategory(state, id, ancestorId) {
  const seen = new Set();
  while (id && !seen.has(id)) {
    if (id === ancestorId) return true;
    seen.add(id);
    id = state.categories.find(c => c.id === id)?.parent;
  }
  return false;
}

/**
 * Build a picker.
 *   getState()  → current ledger state
 *   kind        → 'expense' or 'income'
 *   value       → selected category ID, or ''
 *   onChange(id)
 * Returns { element, getValue() }.
 */
export function createCategoryPicker({ getState, kind = 'expense', value = '', onChange = () => {} }) {
  let selected = value;
  let openTile = '';   // top-level tile whose panel is unfolded
  let openGroup = '';  // nested group unfolded inside that panel
  const element = el('div', { class: 'cat-picker' });

  function choose(id) {
    selected = id;
    openTile = '';
    openGroup = '';
    onChange(id);
    render(id);
  }

  /** `label` replaces the name ("All Bills"); such a pill shows no icon. */
  function pill(category, label) {
    return el('button', {
      type: 'button',
      class: 'pill' + (selected === category.id ? ' is-selected' : ''),
      'aria-pressed': String(selected === category.id),
      onclick: () => choose(category.id)
    }, label ? null : categoryIconNode(category.icon), el('span', { text: label || category.name }));
  }

  /** The unfolded contents of one category: its own pill, leaves, then groups. */
  function branch(state, category) {
    const children = childCategories(state, category.id, kind);
    const leaves = children.filter(child => !childCategories(state, child.id, kind).length);
    const groups = children.filter(child => !leaves.includes(child));

    const nodes = [el('div', { class: 'pill-row' },
      pill(category, `All ${category.name}`),
      leaves.map(leaf => pill(leaf)))];

    for (const group of groups) {
      const isOpen = openGroup === group.id;
      const holdsSelection = isWithinCategory(state, selected, group.id);
      nodes.push(el('div', { class: 'cat-group' },
        el('button', {
          type: 'button',
          class: 'cat-group-head' + (holdsSelection ? ' has-selection' : ''),
          'aria-expanded': String(isOpen),
          'data-cat': group.id,
          onclick: () => { openGroup = isOpen ? '' : group.id; render(group.id); }
        },
          el('span', { class: 'cat-group-name' }, categoryIconNode(group.icon), el('span', { text: group.name })),
          el('span', { class: 'fold-mark', 'aria-hidden': 'true', text: isOpen ? '−' : '+' })),
        isOpen && el('div', { class: 'cat-group-body' }, branch(state, group))));
    }
    return nodes;
  }

  function render(focusId) {
    const state = getState();
    const grid = el('div', { class: 'cat-grid' });

    for (const top of childCategories(state, '', kind)) {
      const hasChildren = childCategories(state, top.id, kind).length > 0;
      const isOpen = openTile === top.id;
      const holdsSelection = isWithinCategory(state, selected, top.id);
      // Labels wrap at spaces only, so a long single word is set a little smaller.
      const isLong = top.name.split(/\s+/).some(word => word.length >= 12);

      grid.append(el('button', {
        type: 'button',
        class: 'cat-tile' + (holdsSelection ? ' is-selected' : '') + (isOpen ? ' is-open' : '') + (isLong ? ' is-long' : ''),
        'data-cat': top.id,
        'aria-expanded': hasChildren ? String(isOpen) : null,
        'aria-pressed': hasChildren ? null : String(selected === top.id),
        onclick: () => {
          if (!hasChildren) return choose(top.id);
          openTile = isOpen ? '' : top.id;
          openGroup = '';
          render(top.id);
        }
      }, categoryIconNode(top.icon), el('span', { class: 'cat-tile-label', text: top.name })));

      // The panel spans the full row, directly under the row of its tile.
      if (isOpen) grid.append(el('div', { class: 'cat-panel' }, branch(state, top)));
    }

    // The selection sits above the grid: icon, path, and a way to clear it.
    const path = [];
    for (let c = state.categories.find(c => c.id === selected); c && !path.includes(c);
      c = state.categories.find(parent => parent.id === c.parent)) path.unshift(c);
    const summary = path.length
      ? el('div', { class: 'cat-summary' },
          categoryIconNode([...path].reverse().find(c => c.icon)?.icon),
          el('strong', { class: 'cat-summary-path', text: path.map(c => c.name).join(' › ') }),
          el('button', {
            type: 'button', class: 'btn-text', text: 'Change', 'aria-label': 'Change category',
            onclick: () => {
              selected = '';
              onChange('');
              render();
              element.querySelector('.cat-tile')?.focus();
            }
          }))
      : el('p', { class: 'cat-summary cat-summary--empty', text: 'No category chosen yet.' });
    element.replaceChildren(summary, grid);

    // Re-rendering drops focus; put it back on the control that was used.
    if (focusId) {
      const selector = `[data-cat="${CSS.escape(focusId)}"]`;
      const top = [...state.categories].find(c => c.id === focusId && !c.parent) ? focusId
        : state.categories.find(c => isWithinCategory(state, focusId, c.id) && !c.parent)?.id;
      (element.querySelector(selector) || (top && element.querySelector(`[data-cat="${CSS.escape(top)}"]`)))?.focus();
    }
  }

  render();
  return { element, getValue: () => selected };
}
