// The one place the UI reads and writes the ledger.
// State is immutable from the UI's point of view: build the next state with
// the model's commit functions, then hand it to saveLedger().

import { ensureDocumentedCategories, validateState } from '../model.js';
import { LedgerStore } from '../store.js';
import { todayIso, showToast } from './dom.js';

/** `ledger.state` is the current, validated ledger. */
export const ledger = { state: null, store: null };

const ledgerListeners = new Set();

/** Call `listener()` after every successful save. */
export function onLedgerChange(listener) {
  ledgerListeners.add(listener);
}

/** Open the browser database and add any default categories or pots it lacks. */
export async function openLedger() {
  ledger.store = new LedgerStore();
  ledger.state = await ledger.store.open(todayIso());

  const upgraded = ensureDocumentedCategories(ledger.state);
  if (upgraded !== ledger.state) {
    await ledger.store.write(upgraded, ledger.state.revision);
    ledger.state = upgraded;
  }

  ledger.store.watch(() => showToast('Another tab saved changes. Reload this tab before editing.'));
}

/**
 * Validate and store the next state. The store refuses the write if another
 * tab saved first, so nothing is overwritten silently.
 */
export async function saveLedger(next) {
  if (!ledger.state) throw Error('Storage is not ready yet.');
  if (next === ledger.state) return;
  validateState(next);
  await ledger.store.write(next, ledger.state.revision);
  ledger.state = next;
  for (const listener of ledgerListeners) listener();
}
