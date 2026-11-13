// Settings → Sync: connect this device to the Google Sheet, see how sync is
// doing, and settle conflicts. The rules live in ../sync-client.js; this file
// is the screen and the wiring to the ledger.

import { SHEET_TABS, syncTabFor, syncReadableRow, syncView } from '../sync-core.js';
import { createSyncClient, browserConnectionStore } from '../sync-client.js';
import { el, errorMessage, showToast } from './dom.js';
import { ledger, saveLedger, onLedgerChange } from './ledger.js';

let syncClient = null;
let syncPanel = null;          // the open Sync section: { rerender, statusLine, shape }
let knownConflicts = 0;

const RECORD_LABELS = { entries: 'Entry', accounts: 'Account', pots: 'Pot', categories: 'Category', allocations: 'Pot funding', settings: 'Setting' };

/** True while someone is part-way through typing, so a background sync does not redraw the form. */
function someoneIsTyping() {
  const active = document.activeElement;
  if (!active || !active.closest?.('#screen')) return false;
  const textLike = active.tagName === 'TEXTAREA' || (active.tagName === 'INPUT' && !['checkbox', 'radio', 'date', 'button', 'submit'].includes(active.type));
  return textLike && !!active.value;
}

/** What decides the layout of the section; the status text alone changes more often. */
function shapeOf(status) {
  return [status.connected, !!status.awaiting, status.conflicts.map(c => c.table + c.id + JSON.stringify(c.theirs) + JSON.stringify(c.mine)).join('|')].join('/');
}

function statusChanged(status) {
  if (status.conflicts.length > knownConflicts) {
    showToast('Conflict — review', { label: 'Review', run: () => { location.hash = '#settings/sync'; } }, 12000);
  }
  knownConflicts = status.conflicts.length;
  if (!syncPanel || !syncPanel.statusLine.isConnected) { syncPanel = null; return; }
  syncPanel.statusLine.textContent = status.text;
  syncPanel.statusLine.dataset.kind = status.kind;
  const typing = document.activeElement?.matches?.('.set-panel input');
  if (shapeOf(status) !== syncPanel.shape && !typing) syncPanel.rerender();
}

/** Start sync for this page. Safe when storage or the network is unavailable: the ledger still works. */
export async function startSync() {
  let connection;
  try {
    connection = browserConnectionStore(localStorage);
  } catch {
    return; // no localStorage (some private modes): sync stays off
  }
  syncClient = createSyncClient({
    getState: () => ledger.state,
    saveState: saveLedger,
    loadMeta: () => ledger.store.readKey('sync'),
    saveMeta: meta => ledger.store.writeKey('sync', meta),
    connection,
    shouldWait: someoneIsTyping,
    onChange: statusChanged
  });
  await syncClient.start();
  knownConflicts = syncClient.status().conflicts.length;
  onLedgerChange(() => syncClient.schedule());
  syncClient.attach(window, document);
}

// ---- The section ------------------------------------------------------------

/** Run an action from a button, showing any failure in `errorBox`. */
function guarded(errorBox, button, action) {
  return async () => {
    errorBox.hidden = true;
    button.disabled = true;
    try {
      await action();
    } catch (error) {
      errorBox.textContent = errorMessage(error);
      errorBox.hidden = false;
    } finally {
      button.disabled = false;
    }
  };
}

export function buildSync(rerender) {
  if (!syncClient) {
    return el('p', { class: 'note', text: 'Sync is not available in this browser window (its storage is switched off). Your records stay on this device.' });
  }
  const status = syncClient.status();
  const statusLine = el('p', { class: 'sync-status', role: 'status', 'data-kind': status.kind, text: status.text });
  syncPanel = { rerender, statusLine, shape: shapeOf(status) };

  if (!status.connected) return el('div', {}, statusLine, connectForm(rerender));
  if (status.awaiting) return el('div', {}, statusLine, firstChoice(status, rerender));

  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });
  const syncNow = el('button', { type: 'button', class: 'btn-primary', text: 'Sync now', 'data-focus': 'sync-now' });
  syncNow.onclick = guarded(errorBox, syncNow, () => syncClient.sync());
  const disconnect = el('button', { type: 'button', class: 'btn-text', text: 'Disconnect' });
  disconnect.onclick = guarded(errorBox, disconnect, async () => { await syncClient.disconnect(); showToast('Disconnected. The secret was forgotten on this device.'); rerender(); });

  return el('div', {},
    statusLine,
    status.conflicts.length ? conflictList(status, rerender) : null,
    el('div', { class: 'sync-actions' }, syncNow, disconnect),
    errorBox,
    el('p', { class: 'hint', text: 'Changes are sent a moment after you save, and fetched when the app opens and every two minutes while it is open. Offline, they wait here.' }),
    el('p', { class: 'note data-note', text: 'The Google Sheet is a readable copy. Edits typed into the sheet are not brought back into the app. The web app address and secret are remembered on this device only; they are not part of backups, exports or the synced settings. Disconnect forgets them and deletes nothing.' }));
}

function connectForm(rerender) {
  const url = el('input', { id: 'sync-url', type: 'url', inputMode: 'url', autocomplete: 'off', spellcheck: false, placeholder: 'https://script.google.com/macros/s/…/exec' });
  const secret = el('input', { id: 'sync-secret', type: 'password', autocomplete: 'off', spellcheck: false });
  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });
  const connect = el('button', { type: 'submit', class: 'btn-primary', text: 'Connect' });
  const submit = guarded(errorBox, connect, async () => {
    connect.textContent = 'Connecting…';
    try {
      const result = await syncClient.connect(url.value, secret.value);
      if (!result.awaiting) showToast(result.kind === 'synced' ? 'Connected and synced.' : 'Connected.');
    } finally {
      connect.textContent = 'Connect';
    }
    rerender();
  });
  return el('form', { novalidate: true, onsubmit: event => { event.preventDefault(); submit(); } },
    el('p', { class: 'note', text: 'Keep a readable copy of your records in your own Google Sheet, and share them between your devices. Set the sheet up once (the steps are in docs/google-sync-setup.md), then paste its two values here.' }),
    el('div', { class: 'field' }, el('label', { for: 'sync-url', text: 'Web app URL' }), url),
    el('div', { class: 'field' }, el('label', { for: 'sync-secret', text: 'Secret' }), secret),
    el('p', { class: 'hint', text: 'Entered once and remembered on this device. Nothing is sent until you press Connect.' }),
    errorBox,
    connect);
}

function firstChoice(status, rerender) {
  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });
  const choice = (label, cls, answer, question, done) => {
    const button = el('button', { type: 'button', class: cls, text: label });
    button.onclick = guarded(errorBox, button, async () => {
      if (question && !window.confirm(question)) return;
      await syncClient.choose(answer);
      showToast(done);
      rerender();
    });
    return button;
  };
  const count = status.awaiting.sheetRecords;
  return el('div', { class: 'sync-choice' },
    el('p', { class: 'note', text: `The sheet already holds ${count} ${count === 1 ? 'record' : 'records'}, and this device has records of its own. Which copy should both use? Nothing has been sent or changed yet.` }),
    el('div', { class: 'sync-actions' },
      choice('Use sheet', 'btn-primary', 'sheet', 'Replace the records on this device with the sheet’s copy? Export a backup first if you are unsure.', 'This device now uses the sheet’s records.'),
      choice('Upload this device', 'btn-secondary', 'device', 'Make the sheet match this device? Sheet records that are not on this device will be marked deleted.', 'The sheet now matches this device.'),
      choice('Cancel', 'btn-text', 'cancel', '', 'Not connected. Nothing was changed.')),
    errorBox);
}

// ---- Conflicts --------------------------------------------------------------

/** One version of a record as "Label: value" lines, marking the lines that differ from `other`. */
function versionCard(title, table, record, other, view) {
  if (!record) return el('div', { class: 'sync-version' }, el('h4', { text: title }), el('p', { class: 'sync-line is-different', text: 'Deleted' }));
  const columns = (syncTabFor(table) || SHEET_TABS.at(-1)).columns;
  const cells = syncReadableRow(table, record, view);
  const otherCells = other ? syncReadableRow(table, other, view) : [];
  const lines = columns.map((label, i) => (cells[i] === '' && (otherCells[i] ?? '') === '') ? null
    : el('p', { class: 'sync-line' + (other && cells[i] !== otherCells[i] ? ' is-different' : '') },
      el('span', { class: 'sync-line-label', text: label + ': ' }), el('span', { text: cells[i] === '' ? '—' : cells[i] })));
  const hiddenOnly = other && cells.every((cell, i) => cell === otherCells[i]);
  return el('div', { class: 'sync-version' }, el('h4', { text: title }), ...lines,
    hiddenOnly && el('p', { class: 'sync-line is-different', text: 'Differs in a detail not shown in these lines.' }));
}

function conflictList(status, rerender) {
  const view = syncView(ledger.state);
  return el('section', { class: 'sync-conflicts', 'aria-label': 'Conflicts to review' },
    el('p', { class: 'note', text: 'These records were changed both on this device and in the sheet. Nothing has been overwritten. Choose which version to keep for each; everything else keeps syncing.' }),
    status.conflicts.map(conflict => {
      const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });
      const settle = (label, cls, keep, done) => {
        const button = el('button', { type: 'button', class: cls, text: label });
        button.onclick = guarded(errorBox, button, async () => { await syncClient.resolve(conflict.table, conflict.id, keep); showToast(done); rerender(); });
        return button;
      };
      const name = (conflict.mine || conflict.theirs || {}).name || (conflict.table === 'settings' ? conflict.id : '');
      return el('article', { class: 'sync-conflict' },
        el('h3', { class: 'sync-conflict-title', text: (RECORD_LABELS[conflict.table] || 'Record') + (name ? ` · ${name}` : '') }),
        el('div', { class: 'sync-versions' },
          versionCard('This device', conflict.table, conflict.mine, conflict.theirs, view),
          versionCard('Sheet', conflict.table, conflict.theirs, conflict.mine, view)),
        el('div', { class: 'sync-actions' },
          settle('Keep mine', 'btn-secondary', 'mine', 'Kept this device’s version.'),
          settle('Use sheet', 'btn-secondary', 'sheet', 'Now using the sheet’s version.')),
        errorBox);
    }));
}
