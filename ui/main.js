// Entry point: theme first (so it works even if storage fails), then the ledger.

import { el, errorMessage, LEGACY_URL } from './dom.js';
import { initThemeToggle } from './theme.js';
import { enhanceSelects } from './select.js';
import { openLedger } from './ledger.js';
import { startShell } from './shell.js';
import { runRolloverOnOpen } from './pots.js';
import { runRecurringOnOpen } from './recurring.js';
import { startSync } from './sync.js';

initThemeToggle(document.getElementById('theme-toggle'));
enhanceSelects();

try {
  await openLedger();
  startShell();
  // Opt-in pots only: unused funding past its months moves to savings, with Undo.
  // (The earlier calendar-quarter sweep is not run from this interface.)
  await runRolloverOnOpen();
  // Recurring payments that fell due since the last visit (card repayments stay with the previous version).
  await runRecurringOnOpen();
  // Google Sheets sync, if this device is connected. A failure here never blocks the ledger.
  startSync().catch(() => {});
} catch (error) {
  // Never overwrite a stored copy that could not be read; say what happened.
  document.getElementById('screen').replaceChildren(
    el('div', { class: 'slip-wrap' }, el('section', { class: 'slip' },
      el('h1', { class: 'screen-title', text: 'The ledger could not be opened.' }),
      el('p', { class: 'form-error', text: errorMessage(error) }),
      el('p', { class: 'note', text: 'Nothing was changed. Reloading often helps. The previous version has export and recovery tools.' }),
      el('a', { class: 'btn-secondary', href: LEGACY_URL, text: 'Open previous version' }))));
}

// Offline shell, only where service workers exist (not for file:// previews).
if (location.protocol.startsWith('http') && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
