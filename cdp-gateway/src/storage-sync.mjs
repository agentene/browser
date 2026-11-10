// Carrying the main browser's live storage into a new context: what the
// profile clone may miss because chromium has not written it to disk yet.

import { CdpClient } from './cdp-client.mjs';
import { MAIN_PORT } from './config.mjs';
import { fetchJson, pageTargets } from './devtools-http.mjs';
import { mainBrowser } from './main-browser.mjs';
import { log, sleep } from './util.mjs';

// Storage.getCookies' cookie as Storage.setCookies' parameter.
export function cookieParam(c) {
  const p = {
    name: c.name, value: c.value, domain: c.domain, path: c.path,
    secure: c.secure, httpOnly: c.httpOnly, priority: c.priority,
    sourceScheme: c.sourceScheme, sourcePort: c.sourcePort,
  };
  if (c.sameSite) p.sameSite = c.sameSite;
  if (!c.session) p.expires = c.expires;
  if (c.partitionKey) p.partitionKey = c.partitionKey;
  return p;
}

// What makes a cookie the same cookie in the store.
export function cookieKey(c) {
  return `${c.name}\0${c.domain}\0${c.path}\0${JSON.stringify(c.partitionKey ?? null)}`;
}

// The cookie database is copied while the main browser runs, so it may lag
// behind the in-memory jar by a flush interval; overlay the live cookies
// (HttpOnly included) from the main browser to close that gap. Clients
// reach contexts through the main browser, which starts a stopped one; if
// it was stopped in between, its orderly exit left them all on disk.
export async function copyCookies(contextWsUrl) {
  if (!mainBrowser.running) return 0;
  const version = await fetchJson(MAIN_PORT, '/json/version');
  const main = await CdpClient.connect(version.webSocketDebuggerUrl);
  let cookies;
  try {
    ({ cookies } = await main.send('Storage.getCookies'));
  } finally {
    main.close();
  }
  const params = cookies.map(cookieParam);
  const context = await CdpClient.connect(contextWsUrl);
  let missing = [];
  try {
    const set = async (batch) => {
      try {
        await context.send('Storage.setCookies', { cookies: batch });
      } catch {
        // one malformed cookie fails the whole batch; retry one by one
        for (const p of batch) {
          try { await context.send('Storage.setCookies', { cookies: [p] }); } catch { /* counted below */ }
        }
      }
    };
    const absent = async (batch) => {
      const have = new Set((await context.send('Storage.getCookies')).cookies.map(cookieKey));
      return batch.filter((p) => !have.has(cookieKey(p)));
    };
    await set(params);
    // read back: anything chromium dropped after accepting it (startup
    // cleanup, store loading) gets one more try
    missing = await absent(params);
    if (missing.length) {
      await set(missing);
      missing = await absent(missing);
    }
  } finally {
    context.close();
  }
  if (missing.length) {
    log(`cookie sync: ${missing.length}/${params.length} cookies missing in the context: ${missing.slice(0, 10).map((c) => `${c.name}@${c.domain}`).join(', ')}`);
  }
  return params.length - missing.length;
}

// One tab per http(s) origin: [[origin, targetId], ...] of the given targets.
export function originTabs(targets) {
  const tabs = new Map();
  for (const target of targets) {
    let origin;
    try {
      origin = new URL(target.url).origin;
    } catch {
      continue;
    }
    if (/^https?:/.test(origin) && !tabs.has(origin)) tabs.set(origin, target.id);
  }
  return [...tabs];
}

// How long one origin's localStorage read may take (connect included).
const SNAPSHOT_TIMEOUT_MS = 3000;

// localStorage reaches disk lazily too — chromium rate-limits its commits,
// so a value written seconds (or, after a burst of writes, minutes) ago may
// not be in the cloned files yet. The origins with such pending writes are
// the ones open in the main browser, so read their live localStorage through
// their own tabs (DOMStorage only serves a frame of the same storage key;
// read-only, runs no page script). All origins at once, so a context starts
// within SNAPSHOT_TIMEOUT_MS however many tabs are open.
export async function snapshotLocalStorage() {
  const snapshot = new Map(); // origin -> [[key, value], ...]
  await Promise.all(originTabs(await pageTargets(MAIN_PORT)).map(async ([origin, targetId]) => {
    let cdp;
    try {
      cdp = await CdpClient.connect(`ws://127.0.0.1:${MAIN_PORT}/devtools/page/${targetId}`, SNAPSHOT_TIMEOUT_MS);
      const { entries } = await cdp.send('DOMStorage.getDOMStorageItems',
        { storageId: { storageKey: `${origin}/`, isLocalStorage: true } }, { timeout: SNAPSHOT_TIMEOUT_MS });
      snapshot.set(origin, entries);
    } catch (err) {
      log(`localStorage snapshot of ${origin} skipped: ${err.message}`);
    } finally {
      cdp?.close();
    }
  }));
  return snapshot;
}

// Write the snapshot into the context through a temporary tab that "visits"
// each origin: every request is answered with an empty page (Fetch) and
// service workers are bypassed, so no site code runs.
export async function restoreLocalStorage(contextWsUrl, snapshot) {
  if (!snapshot.size) return 0;
  const cdp = await CdpClient.connect(contextWsUrl);
  let restored = 0;
  let targetId; // the temporary tab; closed however the restoring went
  try {
    ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', background: true }));
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const opts = { sessionId };
    cdp.on('Fetch.requestPaused', ({ requestId }) => {
      cdp.send('Fetch.fulfillRequest', {
        requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
        body: Buffer.from('<html></html>').toString('base64'),
      }, opts).catch(() => {});
    });
    // the load of each navigation by its loaderId: a late load of the one
    // before (after its timeout) must not count for the next
    const loads = new Map(); // loaderId -> resolve, or true once loaded
    cdp.on('Page.lifecycleEvent', ({ name, loaderId }) => {
      if (name !== 'load') return;
      const waiting = loads.get(loaderId);
      if (typeof waiting === 'function') waiting();
      loads.set(loaderId, true);
    });
    const loaded = (loaderId) => (loads.get(loaderId) === true ? Promise.resolve()
      : new Promise((resolve) => { loads.set(loaderId, resolve); }));
    await cdp.send('Page.enable', {}, opts);
    await cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }, opts);
    await cdp.send('Network.enable', {}, opts);
    await cdp.send('Network.setBypassServiceWorker', { bypass: true }, opts);
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, opts);
    for (const [origin, entries] of snapshot) {
      try {
        const { loaderId, errorText } = await cdp.send('Page.navigate', { url: `${origin}/` }, opts);
        if (errorText) throw new Error(`navigation: ${errorText}`);
        await Promise.race([loaded(loaderId), sleep(5000)]);
        const storageId = { storageKey: `${origin}/`, isLocalStorage: true };
        await cdp.send('DOMStorage.clear', { storageId }, opts);
        // all items in one go: chromium runs them in order, so only the
        // round trips are saved
        await Promise.all(entries.map(([key, value]) => (
          cdp.send('DOMStorage.setDOMStorageItem', { storageId, key, value }, opts))));
        restored++;
      } catch (err) {
        log(`localStorage restore of ${origin} failed: ${err.message}`);
      }
    }
  } finally {
    // closed on every way out: left open, the tab would surface as a page
    // of the alias context (best effort — the connection may already be gone)
    if (targetId) await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    cdp.close();
  }
  return restored;
}
