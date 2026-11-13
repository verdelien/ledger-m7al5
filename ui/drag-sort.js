// Drag to reorder a list, with Pointer Events so it works with a finger on
// iPhone and iPad and with a mouse on a Mac. (The HTML5 drag API does not
// fire on iOS.)
//
// Mark each row with `data-drag-item` and put a dragHandle() inside it. Rows
// are reordered among the direct children of their own list only, so a
// nested list never mixes with its parent's rows.
//
// While dragging, the DOM order is left alone: the row follows the pointer
// with a transform and its neighbours slide aside to show where it will land. Cancelling therefore
// needs no undo; the caller's onDrop is the only thing that changes anything.

import { pixelIconNode, UI_ICONS } from './pixel-icons.js';

/** A copy of `list` with the item at `from` moved so it ends up at index `to`. */
export function moveItem(list, from, to) {
  const next = [...list];
  if (!Number.isInteger(from) || from < 0 || from >= next.length) return next;
  const target = Math.max(0, Math.min(next.length - 1, Number.isInteger(to) ? to : from));
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item);
  return next;
}

/**
 * Where a dragged row would land. `midpoints` are the vertical centres of the
 * OTHER rows, top to bottom; the result is the row's index after the drop:
 * the number of other rows whose centre lies above the pointer.
 */
export function dropIndex(midpoints, pointerY) {
  let index = 0;
  for (const middle of midpoints) if (pointerY > middle) index += 1;
  return index;
}

/**
 * The `order` values to store after a reorder: [{ item, order }] for every
 * item whose stored order differs from its new position. Items already in
 * place are left out, so one save touches only what changed.
 */
export function orderChanges(items) {
  return items
    .map((item, order) => ({ item, order }))
    .filter(({ item, order }) => item.order !== order);
}

const EDGE = 72;       // px from the top or bottom edge where auto-scroll starts
const MAX_SPEED = 14;  // px per frame at the very edge

/** The nearest ancestor that scrolls vertically, or null for the page itself. */
function scrollParent(node) {
  for (let parent = node.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && parent.scrollHeight > parent.clientHeight) return parent;
  }
  return null;
}

/**
 * A grip that drags its row. `onDrop(fromIndex, toIndex)` is called once,
 * only when the row was dropped in a new place. Esc or a cancelled pointer
 * leaves everything as it was.
 */
export function dragHandle({ label, onDrop }) {
  const handle = document.createElement('span');
  handle.className = 'drag-handle';
  handle.title = label;
  handle.setAttribute('aria-hidden', 'true'); // the up and down buttons serve keyboards and screen readers
  handle.append(pixelIconNode('grip', UI_ICONS, 'drag-icon'));

  handle.addEventListener('pointerdown', event => {
    if (event.button > 0 || !event.isPrimary) return;
    const item = handle.closest('[data-drag-item]');
    const list = item?.parentElement;
    if (!list) return;
    const rows = [...list.children].filter(child => child.hasAttribute('data-drag-item'));
    const others = rows.filter(row => row !== item);
    const fromIndex = rows.indexOf(item);
    if (rows.length < 2) return;

    event.preventDefault();
    try { handle.setPointerCapture(event.pointerId); } catch { /* the drag still works without capture */ }

    const scroller = scrollParent(list);
    const grabOffset = event.clientY - item.getBoundingClientRect().top;
    // Measure everything once, before anything moves. Positions are kept
    // relative to the list, so page scrolling during the drag doesn't matter.
    const listTop0 = list.getBoundingClientRect().top;
    const itemRect = item.getBoundingClientRect();
    const restingTop = itemRect.top - listTop0;
    const nextRect = rows[fromIndex + 1]?.getBoundingClientRect();
    const prevRect = rows[fromIndex - 1]?.getBoundingClientRect();
    const gap = Math.max(0, nextRect ? nextRect.top - itemRect.bottom : itemRect.top - prevRect.bottom);
    const step = itemRect.height + gap; // how far a neighbour slides to make room
    const middles = others.map(row => {
      const rect = row.getBoundingClientRect();
      return rect.top - listTop0 + rect.height / 2;
    });

    list.classList.add('is-drag-list');
    item.classList.add('is-dragging');
    document.documentElement.classList.add('is-drag-sorting');

    let pointerY = event.clientY;
    let toIndex = fromIndex;
    let frame = 0;
    let done = false;

    function update() {
      const listTop = list.getBoundingClientRect().top;
      const shift = pointerY - grabOffset - listTop - restingTop;
      item.style.transform = `translateY(${Math.round(shift)}px)`;

      // Compare the lifted row's centre with the neighbours' resting centres.
      const centre = restingTop + shift + itemRect.height / 2;
      toIndex = dropIndex(middles, centre);

      // Neighbours slide aside to open a gap where the row will land.
      others.forEach((row, k) => {
        let offset = 0;
        if (k >= fromIndex && k < toIndex) offset = -step;      // was below, now above
        else if (k < fromIndex && k >= toIndex) offset = step;  // was above, now below
        row.style.transform = offset ? `translateY(${offset}px)` : '';
      });
    }

    function autoScroll() {
      if (done) return;
      const top = scroller ? scroller.getBoundingClientRect().top : 0;
      const bottom = scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight;
      let speed = 0;
      if (pointerY < top + EDGE) speed = -Math.ceil(MAX_SPEED * Math.min(1, (top + EDGE - pointerY) / EDGE));
      else if (pointerY > bottom - EDGE) speed = Math.ceil(MAX_SPEED * Math.min(1, (pointerY - (bottom - EDGE)) / EDGE));
      if (speed) {
        (scroller || window).scrollBy(0, speed);
        update();
      }
      frame = requestAnimationFrame(autoScroll);
    }

    function finish(drop) {
      if (done) return;
      done = true;
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      handle.removeEventListener('lostpointercapture', onUp);
      document.removeEventListener('keydown', onKey, true);
      try { handle.releasePointerCapture(event.pointerId); } catch { /* already released */ }
      document.documentElement.classList.remove('is-drag-sorting');
      const moved = drop && toIndex !== fromIndex;

      if (moved) {
        // Settle the lifted row into the gap; the save then redraws the list
        // in its new order, so nothing visibly jumps.
        const target = toIndex > fromIndex
          ? (toIndex - fromIndex) * step
          : -(fromIndex - toIndex) * step;
        item.classList.add('is-settling');
        item.style.transform = `translateY(${target}px)`;
        onDrop(fromIndex, toIndex);
        // If the save fails and nothing redraws, put the rows back.
        setTimeout(() => { if (item.isConnected) reset(); }, 700);
      } else {
        reset();
      }
    }

    function reset() {
      item.classList.remove('is-dragging', 'is-settling');
      item.style.transform = '';
      others.forEach(row => { row.style.transform = ''; });
      // Let the neighbours glide back before transitions are switched off.
      setTimeout(() => list.classList.remove('is-drag-list'), 200);
    }

    const onMove = moveEvent => { pointerY = moveEvent.clientY; update(); };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = keyEvent => {
      if (keyEvent.key !== 'Escape') return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      finish(false);
    };

    // Listen on window so a release outside the grip still drops (Safari releases capture early).
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    handle.addEventListener('lostpointercapture', onUp);
    document.addEventListener('keydown', onKey, true);
    update();
    frame = requestAnimationFrame(autoScroll);
  });

  return handle;
}
