// Settings → Categories: add, rename, reorder and archive.
// Nothing is ever deleted here; archived categories stay on old entries and
// can be restored.

import { commit, commitBatch, uid } from '../model.js';
import { el, errorMessage, showToast } from './dom.js';
import { ledger, saveLedger } from './ledger.js';
import { childCategories } from './categories.js';
import { dragHandle, moveItem, orderChanges } from './drag-sort.js';
import { PIXEL_ICON_IDS, PIXEL_ICONS, categoryIconNode, firstGrapheme, pixelIconLabel, pixelIconNode } from './pixel-icons.js';

const MAX_DEPTH = 3; // top level → group → item

// View state kept between re-renders.
const editorView = { kind: 'expense', open: new Set(), editingId: '' };

export function buildCategoryEditor(rerender) {
  const state = ledger.state;

  const kindSwitch = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Category type' },
    [['expense', 'Spending'], ['income', 'Income']].map(([kind, label]) => el('button', {
      type: 'button',
      class: editorView.kind === kind ? 'is-selected' : '',
      'aria-pressed': String(editorView.kind === kind),
      'data-focus': `kind:${kind}`,
      text: label,
      onclick: () => { editorView.kind = kind; editorView.editingId = ''; rerender(); }
    })));

  return el('div', { class: 'cat-editor' },
    el('p', { class: 'note', text: 'Tap a name to unfold it. Drag the grip, or use the arrows, to reorder within a level. Archiving hides a category from the picker; entries that use it keep it.' }),
    kindSwitch,
    levelList(state, '', 1, rerender));
}

/** One level of the tree, followed by its "add" row. */
function levelList(state, parentId, depth, rerender) {
  const siblings = childCategories(state, parentId, editorView.kind, true);
  const parent = state.categories.find(c => c.id === parentId);

  return el('ul', { class: 'ed-list' + (depth > 1 ? ' ed-list--nested' : '') },
    siblings.map((category, index) => categoryRow(state, category, index, siblings, depth, rerender)),
    el('li', { class: 'ed-add' }, addForm(parent, siblings, rerender)));
}

function categoryRow(state, category, index, siblings, depth, rerender) {
  const canHoldChildren = depth < MAX_DEPTH;
  const isOpen = editorView.open.has(category.id);
  const childCount = childCategories(state, category.id, editorView.kind, true).length;
  const pot = state.pots.find(p => p.id === category.pot);

  if (editorView.editingId === category.id) {
    return el('li', { class: 'ed-item', 'data-drag-item': '' }, renameForm(category, siblings, rerender));
  }

  const label = [
    el('span', { class: 'ed-name-text' }, categoryIconNode(category.icon), el('span', { text: category.name })),
    el('span', { class: 'ed-meta', text: [childCount ? `${childCount}` : '', pot?.name, category.archived && 'archived'].filter(Boolean).join(' · ') })
  ];
  const name = canHoldChildren
    ? el('button', {
        type: 'button', class: 'ed-name', 'aria-expanded': String(isOpen), 'data-focus': `fold:${category.id}`,
        onclick: () => { isOpen ? editorView.open.delete(category.id) : editorView.open.add(category.id); rerender(); }
      }, el('span', { class: 'fold-mark', 'aria-hidden': 'true', text: isOpen ? '−' : '+' }), label)
    : el('span', { class: 'ed-name' }, label);

  const moveButton = (direction, symbol, word) => el('button', {
    type: 'button', class: 'icon-btn', text: symbol,
    'aria-label': `Move ${category.name} ${word}`,
    'data-focus': `${word}:${category.id}`,
    disabled: direction < 0 ? index === 0 : index === siblings.length - 1,
    onclick: () => run(() => saveCategoryOrder(moveItem(siblings, index, index + direction)))
  });
  // Dragging stays inside this list, so a category keeps its parent.
  const grip = siblings.length > 1 && dragHandle({
    label: `Drag ${category.name} to reorder`,
    onDrop: (from, to) => run(() => saveCategoryOrder(moveItem(siblings, from, to)))
  });

  return el('li', { class: 'ed-item' + (category.archived ? ' is-archived' : ''), 'data-drag-item': '' },
    el('div', { class: 'ed-row' },
      grip,
      name,
      el('div', { class: 'ed-actions' },
        moveButton(-1, '↑', 'up'),
        moveButton(1, '↓', 'down'),
        el('button', {
          type: 'button', class: 'btn-text', text: 'Edit', 'aria-label': `Edit ${category.name}`,
          'data-focus': `edit:${category.id}`,
          onclick: () => { editorView.editingId = category.id; rerender(); document.getElementById('ed-rename')?.focus(); }
        }))),
    canHoldChildren && isOpen && levelList(state, category.id, depth + 1, rerender));
}

/**
 * The "Icon" control: None, one emoji, or one of the built-in pixel icons.
 * Works for any record with an optional `icon` (categories and accounts).
 * Returns { element, getValue() }. getValue gives the icon to store:
 * an icon object, null for "None", or undefined to leave the record as it is.
 */
export function iconField(category, noneLabel = 'None') {
  const current = category.icon;
  let type = current?.type === 'emoji' ? 'emoji' : current?.type === 'pixel' ? 'pixel' : 'none';
  let pixelId = current?.type === 'pixel' && Object.hasOwn(PIXEL_ICONS, current.value) ? current.value : '';

  const emojiInput = el('input', {
    type: 'text', class: 'icon-emoji-input', maxLength: 32, autocomplete: 'off',
    value: current?.type === 'emoji' ? current.value : '',
    'aria-label': 'Emoji', placeholder: '🙂',
    // Keep one symbol once typing has settled (not in the middle of IME input).
    oninput: event => { if (!event.isComposing) emojiInput.value = firstGrapheme(emojiInput.value); }
  });
  const pixelButtons = PIXEL_ICON_IDS.map(id => el('button', {
    type: 'button', class: 'icon-choice', title: pixelIconLabel(id), 'aria-label': pixelIconLabel(id),
    onclick: () => { pixelId = id; update(); }
  }, pixelIconNode(id)));
  const pixelGrid = el('div', { class: 'icon-grid', role: 'group', 'aria-label': 'Pixel icons' }, pixelButtons);

  const typeButtons = [['none', noneLabel], ['emoji', 'Emoji'], ['pixel', 'Pixel']].map(([value, label]) => el('button', {
    type: 'button', text: label, 'data-icon-type': value,
    onclick: () => { type = value; update(); if (value === 'emoji') emojiInput.focus(); }
  }));

  function update() {
    for (const button of typeButtons) {
      const on = button.dataset.iconType === type;
      button.classList.toggle('is-selected', on);
      button.setAttribute('aria-pressed', String(on));
    }
    emojiInput.hidden = type !== 'emoji';
    pixelGrid.hidden = type !== 'pixel';
    pixelButtons.forEach((button, index) => {
      const on = PIXEL_ICON_IDS[index] === pixelId;
      button.classList.toggle('is-selected', on);
      button.setAttribute('aria-pressed', String(on));
    });
  }
  update();

  return {
    element: el('div', { class: 'icon-field' },
      el('span', { class: 'icon-field-label', text: 'Icon' }),
      el('div', { class: 'segmented', role: 'group', 'aria-label': 'Icon type' }, typeButtons),
      emojiInput, pixelGrid),
    getValue() {
      const emoji = firstGrapheme(emojiInput.value);
      if (type === 'emoji' && emoji) return { type: 'emoji', value: emoji };
      if (type === 'pixel' && pixelId) return { type: 'pixel', value: pixelId };
      // "None" is stored as null so a later upgrade does not put a default back.
      return current === undefined ? undefined : null;
    }
  };
}

/** How many levels deep a category sits (top level = 1). */
function depthOf(state, id) {
  let depth = 0;
  for (let c = state.categories.find(x => x.id === id); c; c = state.categories.find(x => x.id === c.parent)) depth += 1;
  return depth;
}

/** Levels in a category's own subtree (a leaf = 1). */
function subtreeHeight(state, id) {
  const kids = state.categories.filter(c => c.parent === id);
  return 1 + kids.reduce((most, c) => Math.max(most, subtreeHeight(state, c.id)), 0);
}

/** Every category a given one could move under without breaking the tree. */
function moveTargets(state, category) {
  const height = subtreeHeight(state, category.id);
  const insideItself = id => {
    for (let c = state.categories.find(x => x.id === id); c; c = state.categories.find(x => x.id === c.parent)) {
      if (c.id === category.id) return true;
    }
    return false;
  };
  const targets = [];
  const walk = (parentId, depth) => {
    for (const c of childCategories(state, parentId, category.kind, false)) {
      if (insideItself(c.id)) continue;
      if (depth + height <= MAX_DEPTH) targets.push({ category: c, depth });
      if (depth < MAX_DEPTH - 1) walk(c.id, depth + 1);
    }
  };
  walk('', 1);
  return targets;
}

/**
 * Records for moving a category under a new parent: it goes to the end of
 * its new level, and it (with any children that shared its pot) follows the
 * new parent's pot. Entries keep pointing at the same category ID.
 */
function moveRecords(state, category, newParentId, base) {
  const newParent = state.categories.find(c => c.id === newParentId);
  const newSiblings = state.categories.filter(c => c.parent === newParentId && c.kind === category.kind && c.id !== category.id);
  const order = newSiblings.reduce((highest, c) => Math.max(highest, c.order ?? -1), newSiblings.length - 1) + 1;
  const newPot = newParent ? newParent.pot : category.pot;
  const records = [{ ...base, parent: newParentId, order, pot: newPot }];
  if (newPot !== category.pot) {
    const walk = id => state.categories.filter(c => c.parent === id).forEach(child => {
      if (child.pot === category.pot) records.push({ ...child, pot: newPot });
      walk(child.id);
    });
    walk(category.id);
  }
  return records;
}

/** Inline form: rename, choose an icon, move, archive or restore. */
function renameForm(category, siblings, rerender) {
  const state = ledger.state;
  const input = el('input', { id: 'ed-rename', type: 'text', maxLength: 150, value: category.name, 'aria-label': 'Category name' });
  const icon = iconField(category);
  const close = () => { editorView.editingId = ''; };

  const parentSelect = el('select', { id: 'ed-parent', 'aria-label': 'Belongs to' },
    el('option', { value: '', text: 'Top level' }),
    moveTargets(state, category).map(({ category: target, depth }) => el('option', {
      value: target.id,
      text: `${'  '.repeat(depth - 1)}${depth > 1 ? '└ ' : ''}${target.name}`
    })));
  parentSelect.value = category.parent || '';
  const moveField = el('label', { class: 'ed-move' },
    el('span', { class: 'ed-move-label', text: 'Belongs to' }),
    parentSelect);

  return el('form', {
    class: 'ed-edit',
    onsubmit: event => {
      event.preventDefault();
      run(() => {
        const current = ledger.state;
        const newParent = parentSelect.value;
        const moving = newParent !== (category.parent || '');
        const targetSiblings = moving
          ? current.categories.filter(c => c.parent === newParent && c.kind === category.kind)
          : siblings;
        const name = checkedName(input.value, targetSiblings, category.id);
        const record = { ...category, name };
        const chosenIcon = icon.getValue();
        if (chosenIcon !== undefined) record.icon = chosenIcon;
        close();
        if (!moving) return saveLedger(commit(current, 'categories', record));
        if (newParent) editorView.open.add(newParent); // show where it went
        const operations = moveRecords(current, category, newParent, record)
          .map(r => ({ table: 'categories', record: r }));
        const destination = current.categories.find(c => c.id === newParent)?.name || 'the top level';
        return saveLedger(commitBatch(current, operations)).then(() => showToast(`Moved ${name} to ${destination}.`));
      });
    }
  },
    input,
    icon.element,
    moveField,
    el('div', { class: 'ed-edit-actions' },
      el('button', { type: 'submit', class: 'btn-primary btn-small', text: 'Save' }),
      el('button', {
        type: 'button', class: 'btn-secondary btn-small', text: category.archived ? 'Restore' : 'Archive',
        onclick: () => run(() => {
          close();
          return saveLedger(commit(ledger.state, 'categories', { ...category, archived: !category.archived }));
        })
      }),
      el('button', { type: 'button', class: 'btn-text', text: 'Cancel', onclick: () => { close(); rerender(); } })));
}

function addForm(parent, siblings, rerender) {
  const label = parent ? `Add to ${parent.name}` : 'Add a category';
  const input = el('input', { type: 'text', maxLength: 150, placeholder: label, 'aria-label': label, 'data-focus': `add:${parent?.id || ''}` });

  return el('form', {
    class: 'ed-add-form',
    onsubmit: event => {
      event.preventDefault();
      run(() => {
        const state = ledger.state;
        const name = checkedName(input.value, siblings, '');
        // A new category follows its parent's pot. Top-level spending starts in Flexible.
        const pot = parent ? parent.pot
          : editorView.kind === 'income' ? state.settings.savingsPot || ''
          : state.pots.find(p => p.id === 'Clothing' && !p.archived)?.id || '';
        const order = siblings.reduce((highest, c) => Math.max(highest, c.order ?? -1), siblings.length - 1) + 1;
        return saveLedger(commit(state, 'categories', {
          id: uid(), name, kind: editorView.kind, parent: parent?.id || '', pot, order, archived: false
        }));
      });
    }
  }, input, el('button', { type: 'submit', class: 'btn-secondary btn-small', text: 'Add' }));
}

/** Trimmed name, or a readable error. Names are unique among siblings. */
function checkedName(raw, siblings, ownId) {
  const name = raw.trim();
  if (!name) throw Error('Type a name first.');
  if (siblings.some(c => c.id !== ownId && c.name.trim().toLowerCase() === name.toLowerCase())) {
    throw Error(`There is already a category called “${name}” here.`);
  }
  return name;
}

/** Store a clean 0…n order for one level, in a single commit. */
function saveCategoryOrder(reordered) {
  const operations = orderChanges(reordered)
    .map(({ item, order }) => ({ table: 'categories', record: { ...item, order } }));
  if (operations.length) return saveLedger(commitBatch(ledger.state, operations));
}

/** Run an action and show any problem calmly. */
async function run(action) {
  try {
    await action();
  } catch (error) {
    showToast(errorMessage(error));
  }
}
