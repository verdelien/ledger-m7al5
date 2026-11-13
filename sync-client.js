// Google Sheets sync, client side. Offline first: the ledger on this device
// is always usable, and changes wait here until the sheet confirms them.
//
// How it keeps track:
//   - `baseline` is what the sheet last confirmed. Anything in the ledger
//     that differs from it is a change waiting to be sent.
//   - A push is stored with a stable `opId` before it is sent, and the same
//     push is repeated until the sheet answers, so nothing is applied twice.
//   - A record changed both here and in the sheet is a conflict. It is never
//     overwritten; the person chooses "Keep mine" or "Use sheet".
//
// The web app address and secret are kept by `connection` (localStorage in
// the browser), apart from the ledger, so they never reach a backup, an
// export or the synced settings.

import { uid } from './model.js';
import { SYNC_SCHEMA, SYNC_TABLES, canonicalJson, syncView, emptyView, syncDiff, syncRecord, syncPutRecord, syncKey } from './sync-core.js';

export const SYNC_CONNECTION_KEY = 'expense-book.sync-connection';
export const SYNC_PUSH_DELAY = 2500;
export const SYNC_PULL_EVERY = 120000;

/** Where the address and secret live on this device. */
export function browserConnectionStore(storage = globalThis.localStorage) {
  return {
    get() {
      try {
        const saved = JSON.parse(storage.getItem(SYNC_CONNECTION_KEY));
        return saved && typeof saved.url === 'string' && typeof saved.secret === 'string' ? saved : null;
      } catch { return null; }
    },
    set(connection) { storage.setItem(SYNC_CONNECTION_KEY, JSON.stringify({ url: connection.url, secret: connection.secret })); },
    clear() { try { storage.removeItem(SYNC_CONNECTION_KEY); } catch { /* nothing stored */ } }
  };
}

/** Accept only a deployed Apps Script web app address. Returns it normalised. */
export function syncCheckAddress(address) {
  let url;
  try { url = new URL(String(address).trim()); } catch { throw Error('Paste the web app URL from Apps Script. It ends in /exec.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'script.google.com' || !/^\/(a\/macros\/[^/]+|macros)\/s\/[^/]+\/exec$/.test(url.pathname)) {
    throw Error('Use the web app URL from Apps Script: https://script.google.com/macros/s/…/exec');
  }
  return url.origin + url.pathname;
}

function syncProblem(code, message) {
  const error = Error(message);
  error.syncCode = code;
  return error;
}

const syncCopy = value => JSON.parse(JSON.stringify(value));
const syncBlankMeta = () => ({ ledgerKey: '', serverRevision: 0, baseline: null, pendingOp: null, conflicts: [], lastSyncedAt: '', awaiting: null });

/** "Synced 2 min ago". */
export function syncAgo(iso, now = Date.now()) {
  if (!iso) return 'Not synced yet';
  const minutes = Math.floor((now - Date.parse(iso)) / 60000);
  if (!(minutes >= 1)) return 'Synced just now';
  if (minutes < 60) return `Synced ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Synced ${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `Synced ${days} ${days === 1 ? 'day' : 'days'} ago`;
}

/**
 * @param getState    () => the current ledger
 * @param saveState   async next => validates and stores the next ledger (throws on failure)
 * @param loadMeta / saveMeta  durable storage for the sync record (not part of the ledger)
 * @param connection  { get, set, clear } for { url, secret }
 * @param shouldWait  () => true while an automatic sync should hold off (someone is typing)
 */
export function createSyncClient({
  getState, saveState, loadMeta, saveMeta, connection,
  fetch: fetchFn = (...args) => globalThis.fetch(...args),
  isOnline = () => globalThis.navigator?.onLine !== false,
  newId = uid, now = () => new Date(), onChange = () => {}, shouldWait = () => false, timeout = 60000
}) {
  let meta = syncBlankMeta();
  let link = null;        // { url, secret }
  let busy = false;
  let again = false;
  let problem = null;     // { code, message } from the last attempt
  let pushTimer = 0;
  let detach = () => {};

  const emit = () => { try { onChange(status()); } catch { /* a listener must not stop sync */ } };
  const persist = () => saveMeta(syncCopy(meta));
  const conflictIndex = (table, id) => meta.conflicts.findIndex(c => c.table === table && c.id === id);

  /** Changes on this device the sheet has not confirmed (conflicts wait for a choice). */
  function waiting() {
    if (!meta.baseline) return [];
    return syncDiff(meta.baseline, syncView(getState())).filter(change => conflictIndex(change.table, change.record.id) < 0);
  }

  function withMine(conflicts) {
    const local = syncView(getState());
    return conflicts.map(c => ({ ...c, mine: syncRecord(local, c.table, c.id) }));
  }

  function status() {
    const connected = !!link;
    const count = connected && meta.baseline ? waiting().length : 0;
    const changes = `${count} ${count === 1 ? 'change' : 'changes'} waiting`;
    let kind = 'synced';
    let text = syncAgo(meta.lastSyncedAt, now().getTime());
    if (!connected) { kind = 'off'; text = 'Not connected'; }
    else if (meta.awaiting) { kind = 'choose'; text = 'Connected — choose which copy to keep'; }
    else if (meta.conflicts.length) { kind = 'conflict'; text = 'Conflict — review'; }
    else if (busy) { kind = 'syncing'; text = 'Syncing…'; }
    else if (!isOnline() || problem?.code === 'network') { kind = 'offline'; text = count ? `Offline — ${changes}` : 'Offline — nothing waiting'; }
    else if (problem) { kind = 'error'; text = `Sync paused — ${problem.message}`; }
    else if (count) { kind = 'waiting'; text = changes[0].toUpperCase() + changes.slice(1); }
    return {
      kind, text, connected, waiting: count, url: link?.url || '', awaiting: meta.awaiting, lastSyncedAt: meta.lastSyncedAt,
      problem: problem?.message || '', conflicts: meta.conflicts.length ? withMine(meta.conflicts) : []
    };
  }

  /** One request. Anything but a readable `{ ok: true }` answer is a failure. */
  async function post(body, target = link) {
    if (!target) throw syncProblem('off', 'Connect to a sheet first.');
    if (!isOnline()) throw syncProblem('network', 'This device is offline.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response;
    try {
      // text/plain keeps this a "simple" request (no CORS preflight, which Apps
      // Script cannot answer). Apps Script replies with a 302 that must be followed.
      response = await fetchFn(target.url, {
        method: 'POST', redirect: 'follow', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ secret: target.secret, schema: SYNC_SCHEMA, ledgerKey: meta.ledgerKey || undefined, ...body }),
        signal: controller.signal
      });
    } catch (error) {
      throw syncProblem('network', error?.name === 'AbortError' ? 'The sheet took too long to answer.' : 'The sheet could not be reached.');
    } finally {
      clearTimeout(timer);
    }
    if (!response || response.type === 'opaque' || response.type === 'opaqueredirect' || !response.ok) {
      throw syncProblem('network', `The sheet did not answer${response?.status ? ` (HTTP ${response.status})` : ''}.`);
    }
    let reply;
    try { reply = JSON.parse(await response.text()); } catch {
      throw syncProblem('server', 'The web app did not answer as expected. Check the deployment: Execute as “Me”, Who has access “Anyone”.');
    }
    if (!reply || reply.ok !== true) throw syncProblem(reply?.code || 'server', reply?.error || 'The sheet refused the request.');
    return reply;
  }

  const remoteValue = change => (change.deleted ? null : change.record);

  /** Note a record that differs here and in the sheet. `draft` is the sync record being built. */
  function noteConflict(draft, change, state) {
    const theirs = remoteValue(change);
    const mine = syncRecord(syncView(state), change.table, change.id);
    syncPutRecord(draft.baseline, change.table, change.id, theirs);
    draft.conflicts = draft.conflicts.filter(c => !(c.table === change.table && c.id === change.id));
    if (canonicalJson(mine) !== canonicalJson(theirs)) draft.conflicts.push({ table: change.table, id: change.id, theirs, changedAt: change.changedAt });
  }

  /** Send one stored push and record the answer. Throws (keeping the push) when no answer came. */
  async function send(op) {
    let reply;
    try {
      reply = await post({ op: 'push', opId: op.opId, baseRevision: op.baseRevision, changes: op.changes });
    } catch (error) {
      // The sheet read the request and said no: sending the same bytes again cannot help.
      if (error.syncCode === 'invalid' || error.syncCode === 'reused') { meta.pendingOp = null; await persist(); }
      throw error;
    }
    const draft = syncCopy(meta);
    draft.pendingOp = null;
    if (reply.rejected) {
      meta = draft;
      await persist();
      throw syncProblem('rejected', `The sheet did not accept these changes: ${reply.rejected}`);
    }
    const refused = new Set((reply.conflicts || []).map(c => syncKey(c.table, c.id)));
    for (const change of op.changes) {
      if (!refused.has(syncKey(change.table, change.record.id))) syncPutRecord(draft.baseline, change.table, change.record.id, change.deleted ? null : change.record);
    }
    const state = getState();
    for (const conflict of reply.conflicts || []) noteConflict(draft, conflict, state);
    // Move the cursor only when nothing else can have happened in between.
    if (!reply.duplicate && reply.serverRevision === draft.serverRevision + 1) draft.serverRevision = reply.serverRevision;
    meta = draft;
    await persist();
  }

  /** Fetch what changed in the sheet and merge it. Untouched records update; edited ones become conflicts. */
  async function pull() {
    const reply = await post({ op: 'pull', sinceRevision: meta.serverRevision });
    if (!Array.isArray(reply.changes) || !Number.isSafeInteger(reply.serverRevision)) throw syncProblem('server', 'The sheet sent an answer this app does not understand.');
    if (!reply.changes.length) {
      if (meta.serverRevision !== reply.serverRevision) { meta.serverRevision = reply.serverRevision; await persist(); }
      return;
    }
    const state = getState();
    const local = syncView(state);
    const draft = syncCopy(meta);
    const incoming = [];
    for (const change of reply.changes) {
      const theirs = canonicalJson(remoteValue(change));
      const known = canonicalJson(syncRecord(draft.baseline, change.table, change.id));
      if (theirs === known) continue; // already known here (often our own push)
      const mine = canonicalJson(syncRecord(local, change.table, change.id));
      if (mine === theirs || mine === known) {
        if (mine !== theirs) incoming.push(change);
        syncPutRecord(draft.baseline, change.table, change.id, remoteValue(change));
        draft.conflicts = draft.conflicts.filter(c => !(c.table === change.table && c.id === change.id));
      } else {
        noteConflict(draft, change, state);
      }
    }
    draft.serverRevision = reply.serverRevision;
    if (incoming.length) {
      const next = structuredClone(state);
      next.settings = { ...next.settings };
      for (const change of incoming) syncPutRecord(next, change.table, change.id, remoteValue(change));
      next.revision++;
      try {
        await saveState(next); // the ledger first; the sync record only once it is stored
      } catch (error) {
        throw syncProblem('merge', `Changes from the sheet could not be applied here (${error.message}). Nothing was changed on this device.`);
      }
    }
    meta = draft;
    await persist();
  }

  async function cycle() {
    if (meta.pendingOp) await send(meta.pendingOp);
    await pull();
    const changes = waiting();
    if (changes.length) {
      // Store the push before sending it, so a lost answer is retried with the same ID.
      meta.pendingOp = { opId: newId(), baseRevision: meta.serverRevision, changes: syncCopy(changes) };
      await persist();
      await send(meta.pendingOp);
    }
    meta.lastSyncedAt = now().toISOString();
    await persist();
  }

  /** Push what is waiting and pull what is new. `automatic` runs hold off while someone is typing. */
  async function sync({ automatic = false } = {}) {
    if (!link || !meta.baseline || meta.awaiting) return status();
    if (automatic && shouldWait()) return status();
    if (busy) { again = true; return status(); }
    busy = true;
    emit();
    try {
      do {
        again = false;
        await cycle();
      } while (again);
      problem = null;
    } catch (error) {
      problem = { code: error.syncCode || 'error', message: error.message || 'Sync failed.' };
    } finally {
      busy = false;
      again = false;
    }
    emit();
    return status();
  }

  /** Call after every local save: sends the change once things have been quiet for 2.5 s. */
  function schedule() {
    clearTimeout(pushTimer);
    if (!link || !meta.baseline || meta.awaiting) return;
    pushTimer = setTimeout(() => { sync({ automatic: true }); }, SYNC_PUSH_DELAY);
    emit();
  }

  /** Read the stored connection and sync record. Call once, before anything else. */
  async function start() {
    link = connection.get();
    meta = { ...syncBlankMeta(), ...(await loadMeta() || {}) };
    emit();
    return status();
  }

  const hasOwnRecords = state => ['entries', 'accounts', 'allocations'].some(table => state[table]?.length);

  async function fetchSheet(target) {
    const reply = await post({ op: 'pull', sinceRevision: 0 }, target);
    const view = emptyView();
    for (const change of reply.changes) if (!change.deleted) syncPutRecord(view, change.table, change.id, change.record);
    return { view, serverRevision: reply.serverRevision };
  }

  /** Replace this device's records with the sheet's. */
  async function adoptSheet(target) {
    const sheet = await fetchSheet(target);
    if (!sheet.view.settings) throw syncProblem('server', 'The sheet has records but no settings. Upload from the device that has your records.');
    const next = structuredClone(getState());
    next.settings = syncCopy(sheet.view.settings);
    for (const table of SYNC_TABLES) next[table] = syncCopy(sheet.view[table]);
    next.revision++;
    await saveState(next);
    meta = { ...meta, baseline: sheet.view, serverRevision: sheet.serverRevision, pendingOp: null, conflicts: [], awaiting: null };
    await persist();
  }

  /**
   * Check the address and secret with the sheet, then remember them on this device.
   * Returns the status; `status.awaiting` is set when the person must choose a copy.
   */
  async function connect(address, secret) {
    const target = { url: syncCheckAddress(address), secret: String(secret || '').trim() };
    if (target.secret.length < 40) throw Error('Paste the whole secret from the script log. It is at least 40 characters.');
    const previous = meta;
    try {
      meta = { ...previous, ledgerKey: '' }; // a new connection may point at a different sheet
      const ping = await post({ op: 'ping' }, target);
      if (ping.ledgerKey === previous.ledgerKey && previous.baseline) {
        meta = previous;                                               // the same sheet as before: carry on
      } else {
        meta = { ...syncBlankMeta(), ledgerKey: ping.ledgerKey };
        if (ping.records === 0) meta.baseline = emptyView();           // empty sheet: upload everything
        else if (hasOwnRecords(getState())) meta.awaiting = { sheetRecords: ping.records };
        else await adoptSheet(target);                                 // nothing here yet: take the sheet's copy
      }
    } catch (error) {
      meta = previous;
      throw error;
    }
    link = target;
    connection.set(target);
    problem = null;
    await persist();
    emit();
    if (!meta.awaiting) await sync();
    return status();
  }

  /** Answer the first-connect question: 'sheet', 'device' or 'cancel'. */
  async function choose(answer) {
    if (!meta.awaiting || !link) return status();
    if (answer === 'cancel') return disconnect();
    if (answer === 'sheet') {
      await adoptSheet(link);
    } else if (answer === 'device') {
      // The sheet becomes the baseline; everything that differs here is then pushed,
      // including deletions for sheet records this device does not have.
      const sheet = await fetchSheet(link);
      meta = { ...meta, baseline: sheet.view, serverRevision: sheet.serverRevision, pendingOp: null, conflicts: [], awaiting: null };
      await persist();
    } else throw Error('Choose the sheet, this device, or cancel.');
    emit();
    return sync();
  }

  /** Settle one conflict: 'mine' sends this device's version, 'sheet' takes the sheet's. */
  async function resolve(table, id, keep) {
    const index = conflictIndex(table, id);
    if (index < 0) return status();
    const conflict = meta.conflicts[index];
    if (keep === 'sheet') {
      const next = structuredClone(getState());
      next.settings = { ...next.settings };
      syncPutRecord(next, table, id, conflict.theirs);
      next.revision++;
      await saveState(next); // throws, leaving the conflict open, if the sheet's version does not fit
    } else if (keep !== 'mine') throw Error('Choose “Keep mine” or “Use sheet”.');
    meta.conflicts = meta.conflicts.filter((_, i) => i !== index);
    await persist();
    emit();
    return sync();
  }

  /** Forget the address and secret on this device. Records stay; nothing is deleted anywhere. */
  async function disconnect() {
    clearTimeout(pushTimer);
    connection.clear();
    link = null;
    problem = null;
    if (meta.awaiting) meta = syncBlankMeta();
    await persist();
    emit();
    return status();
  }

  /** Sync on open, on reconnect, on return to the page, and every two minutes while visible. */
  function attach(win = globalThis.window, doc = globalThis.document) {
    const visible = () => doc.visibilityState !== 'hidden';
    const auto = () => { if (visible()) sync({ automatic: true }); };
    const interval = setInterval(auto, SYNC_PULL_EVERY);
    win.addEventListener('online', auto);
    doc.addEventListener('visibilitychange', auto);
    detach = () => { clearInterval(interval); win.removeEventListener('online', auto); doc.removeEventListener('visibilitychange', auto); };
    sync();
  }

  function dispose() {
    clearTimeout(pushTimer);
    detach();
  }

  return { start, status, connect, choose, sync, schedule, resolve, disconnect, attach, dispose, connected: () => !!link };
}

/**
 * The previous interface (legacy.html) used an older sync that no longer
 * exists. This stand-in keeps that page working; sync is set up in the new
 * interface under Settings → Sync.
 */
export function createSync({ onStatus = () => {} } = {}) {
  const moved = () => onStatus('Sync has moved to the new interface: Settings → Sync.');
  return { connect: moved, sync: async () => moved(), schedule() {}, resolve: async () => moved(), dispose() {}, connected: () => false };
}
