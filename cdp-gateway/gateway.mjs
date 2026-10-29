// cdp-gateway/gateway.mjs — CDP gateway that backs every isolated browser
// context with its own Chromium process running on a clone of the main
// browser profile, so every isolated client inherits the main browser's
// logins (cookies, localStorage, IndexedDB, service workers, ...) while
// staying isolated from the main browser and from each other.
//
// Started by docker-entrypoint.sh when ENABLE_CDP_GATEWAY=true; nginx then
// proxies the whole public CDP port here instead of to chromium directly.
//
// How it works (clients need no changes — see README "CDP gateway"):
//   * every browser-level DevTools WebSocket gets a Mux that speaks to the
//     main chromium and forwards everything verbatim, so default-context
//     clients behave exactly as without the gateway;
//   * the FIRST Target.createBrowserContext on a connection (what an isolated
//     Playwright / playwright-cli session sends) is answered by the gateway:
//     it clones the main profile, launches a chromium on it and hands
//     the client an alias browserContextId that stands for that chromium's
//     default (persistent, cloned) context;
//   * from then on commands are routed per sessionId / targetId /
//     browserContextId to the main or the context's chromium, and its events
//     get their browserContextId rewritten to the alias;
//   * Target.disposeBrowserContext(alias) or the client disconnecting
//     destroys the context: process killed, cloned profile deleted.
//
// Also serves /json/* (with URLs rewritten to the public host:port the
// client dialed) and a small dashboard + API under /console/.

import { spawn } from 'node:child_process';
import { constants as fsConstants, createWriteStream, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';

const env = process.env;
const LISTEN_PORT = intEnv('CDP_GATEWAY_INTERNAL_PORT', 9220);
const MAIN_PORT = intEnv('CDP_INTERNAL_PORT', 9221);
const MAX_CONTEXTS = intEnv('CDP_CONTEXTS_MAX', 4);
const CONTEXTS_DIR = env.CDP_CONTEXTS_DIR || '/browser/contexts';
const MAIN_PROFILE = env.CHROMIUM_USER_DATA_DIR || '/browser/user-data';
const CHROME_BIN = env.CHROME_BIN;
const FLAGS_FILE = env.CDP_GATEWAY_FLAGS_FILE || '/tmp/cdp-gateway-chromium-flags';
const PUBLIC_FALLBACK = `127.0.0.1:${env.CDP_LISTEN_PORT || 9222}`;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WAYLAND = env.DISPLAY_BACKEND === 'wayland';

// Ids the gateway uses for its own commands on a client's upstreams; client
// ids (small integers counted up by Playwright) never get there.
const INTERNAL_ID_BASE = 1_000_000_000;
const MAX_PAYLOAD = 256 * 1024 * 1024; // screenshots and traces can be large

// Profile entries not worth cloning: per-run lock/port files, caches (pure
// performance state, rebuilt on demand) and the main browser's open tabs —
// Sessions/ and Sessions_Encrypted/ (chromium 15x), or the older
// Current/Last Session|Tabs files. Clones start with "continue where you
// left off" (see preparePrefs), so any session left in would reopen the
// main browser's tabs inside the context — asynchronously, so depending on
// timing Playwright files them under the main browser's context (it only
// registers a new context after its setup round-trips) and no tab list
// shows them.
const SKIP_NAMES = new Set([
  'DevToolsActivePort', 'Cache', 'Code Cache', 'GPUCache', 'GrShaderCache',
  'ShaderCache', 'GraphiteDawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'Crashpad', 'component_crx_cache', 'extensions_crx_cache',
  'Current Session', 'Current Tabs', 'Last Session', 'Last Tabs',
]);
const SKIP_PREFIXES = ['Singleton', 'BrowserMetrics', 'Sessions'];

// Browser frame color per context (cycled), so a context window on the desktop
// is recognizable and matches its dashboard card. No window manager draws
// title bars on the Xvfb display, so chromium's own frame is the only place
// a marker shows.
const CONTEXT_COLORS = ['#e53935', '#43a047', '#fb8c00', '#8e24aa', '#00897b', '#d81b60', '#3949ab', '#6d4c41'];

function intEnv(name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name}=${raw} is not a non-negative integer`);
  return n;
}

function log(...args) {
  console.log(new Date().toISOString(), '[cdp-gateway]', ...args);
}

function readFlags() {
  // NUL-separated, written by the entrypoint from the same flag assembly as
  // the main chromium (GPU policy, locale features, CHROMIUM_EXTRA_ARGS, ...)
  return readFileSync(FLAGS_FILE, 'utf8').split('\0').filter(Boolean);
}

// A free loopback port for a context's DevTools. Not --remote-debugging-port=0:
// chromium counts that as automation and reports navigator.webdriver=true,
// which the main browser (fixed port) does not — sites' risk control notices.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function fetchJson(port, pathname, method = 'GET') {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { method });
  if (!res.ok) throw new Error(`GET ${pathname} on :${port} -> HTTP ${res.status}`);
  return res.json();
}

// Swap the loopback host:port chromium embeds in its JSON for the public
// host:port the client dialed (nginx passes the original Host through).
function rewriteHost(value, port, publicHost) {
  return JSON.parse(JSON.stringify(value).replaceAll(`127.0.0.1:${port}`, publicHost));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- a minimal CDP client for the gateway's own one-off commands ------------
class CdpClient {
  static async connect(url) {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: MAX_PAYLOAD });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return new CdpClient(ws);
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map(); // event method -> handler(params, sessionId)
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method) {
        this.listeners.get(msg.method)?.(msg.params, msg.sessionId);
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
    });
    ws.on('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('CDP connection closed'));
      this.pending.clear();
    });
  }

  on(method, handler) {
    this.listeners.set(method, handler);
  }

  send(method, params = {}, { sessionId, timeout = 15000 } = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: timed out after ${timeout}ms`));
      }, timeout);
      this.pending.set(id, {
        method,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  close() {
    this.ws.close();
  }
}

// --- contexts ---------------------------------------------------------------
class Context {
  constructor(index, client) {
    this.name = `context-${index}`;
    this.color = CONTEXT_COLORS[(index - 1) % CONTEXT_COLORS.length];
    this.client = client; // remote address of the CDP client that owns it
    this.dir = path.join(CONTEXTS_DIR, this.name);
    this.profile = path.join(this.dir, 'profile');
    this.createdAt = new Date().toISOString();
    this.proc = null;
    this.port = 0;
    this.browserWsPath = '';
    this.mux = null;
    this.destroyed = false;
    this.onExit = null;
  }

  async start() {
    const t0 = Date.now();
    await fs.mkdir(this.dir, { recursive: true });
    const localStorageSnapshot = await snapshotLocalStorage();
    await cloneProfile(MAIN_PROFILE, this.profile);
    await preparePrefs(this.profile, this.color);
    const tClone = Date.now();

    const headless = env.CDP_CONTEXTS_HEADLESS === '1';
    let flags = readFlags();
    if (headless && !flags.includes('--headless')) flags.push('--headless');
    const port = await freePort();
    flags = flags.concat([
      `--user-data-dir=${this.profile}`,
      `--remote-debugging-port=${port}`,
      '--no-startup-window',
    ]);
    // the Wayland app_id focus() raises this context's windows by
    if (WAYLAND && !headless) flags.push(`--class=${appId(this.name)}`);
    const logPath = path.join(this.dir, 'chromium.log');
    const logFile = createWriteStream(logPath);
    await new Promise((resolve) => logFile.once('open', resolve));
    this.proc = spawn(CHROME_BIN, flags, {
      detached: true, // own process group: destroy() takes renderers down too
      stdio: ['ignore', logFile, logFile],
    });
    this.proc.once('exit', (code, signal) => {
      log(`${this.name}: chromium exited (code=${code} signal=${signal})`);
      this.proc = null;
      this.onExit?.();
    });

    // chromium announces the browser endpoint on stderr once it is listening;
    // finding it in this process's own log also proves nothing else grabbed
    // the port in between
    const listening = new RegExp(`DevTools listening on ws://127\\.0\\.0\\.1:${port}(/devtools/browser/\\S+)`);
    for (let i = 0; i < 150 && !this.port; i++) {
      if (!this.proc) throw new Error(`chromium exited during startup, see ${logPath}`);
      const m = listening.exec(await fs.readFile(logPath, 'utf8').catch(() => ''));
      if (m) {
        this.port = port;
        this.browserWsPath = m[1];
      } else {
        await sleep(100);
      }
    }
    if (!this.port) throw new Error(`chromium did not open its DevTools port ${port} within 15s, see ${logPath}`);

    const cookies = await copyCookies(this.browserWsUrl());
    const origins = await restoreLocalStorage(this.browserWsUrl(), localStorageSnapshot);
    log(`${this.name}: up on 127.0.0.1:${this.port} (pid ${this.proc?.pid}; clone ${tClone - t0}ms, total ${Date.now() - t0}ms; synced from main: ${cookies} cookies, localStorage of ${origins} open origin(s))`);
  }

  browserWsUrl() {
    return `ws://127.0.0.1:${this.port}${this.browserWsPath}`;
  }

  async destroy(reason) {
    if (this.destroyed) return;
    this.destroyed = true;
    contexts.delete(this.name);
    log(`${this.name}: destroying (${reason})`);
    // detach from the client first: its pages are gone from now on, and the
    // same connection may create its next isolated context right away
    this.mux?.contextGone(this);
    const proc = this.proc;
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      const exited = new Promise((resolve) => proc.once('exit', resolve));
      try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* already gone */ }
      const timer = setTimeout(() => {
        try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* already gone */ }
      }, 5000);
      await exited;
      clearTimeout(timer);
    }
    await fs.rm(this.dir, { recursive: true, force: true });
  }
}

const contexts = new Map();
let contextCounter = 0;
let creating = 0; // contexts in startup, counted against the limit too

async function createContext(clientAddr) {
  if (contexts.size + creating >= MAX_CONTEXTS) {
    throw new Error(`CDP context limit reached (${MAX_CONTEXTS}); close another isolated session or raise CDP_CONTEXTS_MAX`);
  }
  creating++;
  const context = new Context(++contextCounter, clientAddr);
  try {
    await context.start();
  } catch (err) {
    await context.destroy(`startup failed: ${err.message}`);
    throw err;
  } finally {
    creating--;
  }
  contexts.set(context.name, context);
  context.onExit = () => context.destroy('chromium exited');
  return context;
}

async function cloneProfile(src, dst) {
  // COPYFILE_FICLONE = reflink (copy-on-write) where the filesystem supports
  // it, a plain copy otherwise
  await fs.cp(src, dst, {
    recursive: true,
    mode: fsConstants.COPYFILE_FICLONE,
    filter: (source) => {
      const base = path.basename(source);
      if (SKIP_NAMES.has(base)) return false;
      return !SKIP_PREFIXES.some((p) => base.startsWith(p));
    },
  });
}

// Whether cloneProfile gets reflinks: FICLONE needs source and destination
// on one mount of a reflink-capable filesystem (XFS, btrfs), which is what
// the /browser mount (profile + CONTEXTS_DIR side by side) is for. Probed
// once on the seeded Preferences file, for the log only.
async function probeReflink() {
  const probe = path.join(CONTEXTS_DIR, '.reflink-probe');
  try {
    await fs.copyFile(path.join(MAIN_PROFILE, 'Default', 'Preferences'), probe,
      fsConstants.COPYFILE_FICLONE_FORCE);
    return 'reflink (copy-on-write)';
  } catch (err) {
    return `full copy (no reflink: ${err.code || err.message}; needs ${CONTEXTS_DIR} and ${MAIN_PROFILE} on one XFS/btrfs mount)`;
  } finally {
    await fs.rm(probe, { force: true });
  }
}

// Adjust the clone's Preferences: the main browser is running, so they say
// it did not exit cleanly (a clone would greet the user with a "restore
// pages?" bubble), and the context gets its frame color (the theme's
// user_color2 as a signed ARGB int; the older user_color key is ignored).
// A clean exit plus any startup setting but "continue where you left off"
// makes chromium drop the session cookies (no expiry — most logins, e.g.
// taobao's cookie2/unb) while loading the cookie store, overlay included; so
// startup is switched to 1. The clone has no Sessions dir, so there are no
// tabs to restore.
async function preparePrefs(profile, color) {
  const prefsPath = path.join(profile, 'Default', 'Preferences');
  let prefs = {};
  try {
    prefs = JSON.parse(await fs.readFile(prefsPath, 'utf8'));
  } catch { /* fresh profile without Preferences */ }
  prefs.profile = { ...prefs.profile, exit_type: 'Normal', exited_cleanly: true };
  prefs.session = { ...prefs.session, restore_on_startup: 1 };
  const browser = prefs.browser || {};
  browser.theme = { ...browser.theme, user_color2: (0xff000000 | parseInt(color.slice(1), 16)) | 0, color_variant2: 3 };
  prefs.browser = browser;
  await fs.mkdir(path.dirname(prefsPath), { recursive: true });
  await fs.writeFile(prefsPath, JSON.stringify(prefs));
}

// The cookie database is copied while the main browser runs, so it may lag
// behind the in-memory jar by a flush interval; overlay the live cookies
// (HttpOnly included) from the main browser to close that gap.
async function copyCookies(contextWsUrl) {
  const version = await fetchJson(MAIN_PORT, '/json/version');
  const main = await CdpClient.connect(version.webSocketDebuggerUrl);
  let cookies;
  try {
    ({ cookies } = await main.send('Storage.getCookies'));
  } finally {
    main.close();
  }
  const params = cookies.map((c) => {
    const p = {
      name: c.name, value: c.value, domain: c.domain, path: c.path,
      secure: c.secure, httpOnly: c.httpOnly, priority: c.priority,
      sourceScheme: c.sourceScheme, sourcePort: c.sourcePort,
    };
    if (c.sameSite) p.sameSite = c.sameSite;
    if (!c.session) p.expires = c.expires;
    if (c.partitionKey) p.partitionKey = c.partitionKey;
    return p;
  });
  const key = (c) => `${c.name}\0${c.domain}\0${c.path}\0${JSON.stringify(c.partitionKey ?? null)}`;
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
      const have = new Set((await context.send('Storage.getCookies')).cookies.map(key));
      return batch.filter((p) => !have.has(key(p)));
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

// localStorage reaches disk lazily too — chromium rate-limits its commits,
// so a value written seconds (or, after a burst of writes, minutes) ago may
// not be in the cloned files yet. The origins with such pending writes are
// the ones open in the main browser, so read their live localStorage through
// their own tabs (DOMStorage only serves a frame of the same storage key;
// read-only, runs no page script).
async function snapshotLocalStorage() {
  const snapshot = new Map(); // origin -> [[key, value], ...]
  for (const target of await pageTargets(MAIN_PORT)) {
    let origin;
    try {
      origin = new URL(target.url).origin;
    } catch {
      continue;
    }
    if (!/^https?:/.test(origin) || snapshot.has(origin)) continue;
    let cdp;
    try {
      cdp = await CdpClient.connect(`ws://127.0.0.1:${MAIN_PORT}/devtools/page/${target.id}`);
      const { entries } = await cdp.send('DOMStorage.getDOMStorageItems',
        { storageId: { storageKey: `${origin}/`, isLocalStorage: true } }, { timeout: 3000 });
      snapshot.set(origin, entries);
    } catch (err) {
      log(`localStorage snapshot of ${origin} skipped: ${err.message}`);
    } finally {
      cdp?.close();
    }
  }
  return snapshot;
}

// Write the snapshot into the context through a temporary tab that "visits"
// each origin: every request is answered with an empty page (Fetch) and
// service workers are bypassed, so no site code runs.
async function restoreLocalStorage(contextWsUrl, snapshot) {
  if (!snapshot.size) return 0;
  const cdp = await CdpClient.connect(contextWsUrl);
  let restored = 0;
  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', background: true });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const opts = { sessionId };
    cdp.on('Fetch.requestPaused', ({ requestId }) => {
      cdp.send('Fetch.fulfillRequest', {
        requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
        body: Buffer.from('<html></html>').toString('base64'),
      }, opts).catch(() => {});
    });
    let loaded = () => {};
    cdp.on('Page.loadEventFired', () => loaded());
    await cdp.send('Page.enable', {}, opts);
    await cdp.send('Network.enable', {}, opts);
    await cdp.send('Network.setBypassServiceWorker', { bypass: true }, opts);
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, opts);
    for (const [origin, entries] of snapshot) {
      try {
        const load = new Promise((resolve) => { loaded = resolve; });
        await cdp.send('Page.navigate', { url: `${origin}/` }, opts);
        await Promise.race([load, sleep(5000)]);
        const storageId = { storageKey: `${origin}/`, isLocalStorage: true };
        await cdp.send('DOMStorage.clear', { storageId }, opts);
        for (const [key, value] of entries) {
          await cdp.send('DOMStorage.setDOMStorageItem', { storageId, key, value }, opts);
        }
        restored++;
      } catch (err) {
        log(`localStorage restore of ${origin} failed: ${err.message}`);
      }
    }
    await cdp.send('Target.closeTarget', { targetId });
  } finally {
    cdp.close();
  }
  return restored;
}

// --- per-connection multiplexer ---------------------------------------------
const muxes = new Set();

class Mux {
  constructor(client, clientAddr, mainUrl) {
    this.client = client;
    this.clientAddr = clientAddr;
    this.context = null;
    this.contextWs = null;
    this.alias = '';
    this.innerContexts = new Set(); // real extra contexts created inside the context's chromium
    // In-flight client commands the gateway may have to answer itself, kept
    // until their reply: anything sent to the context chromium (which can
    // die before answering) and context disposals sent to the main chromium.
    this.pending = new Map(); // client command id -> { origin, msg }
    this.sessionOwner = new Map(); // sessionId -> 'main' | 'context'
    this.sessionTarget = new Map(); // context sessionId -> targetId
    this.sessionParent = new Map(); // context sessionId -> the client session it was attached on
    this.contextTargets = new Set();
    // A client's browser-target session (Target.attachToBrowserTarget, e.g.
    // Playwright's newCDPSession) lives on the main chromium; whatever it
    // addresses in the context chromium goes through a browser-target session
    // the gateway opens there instead.
    this.browserSessions = new Map(); // client sessionId -> Promise<context browser sessionId>
    this.browserSessionOf = new Map(); // context browser sessionId -> client sessionId
    this.autoAttach = null; // last Target.setAutoAttach params from the client
    this.discover = null; // last Target.setDiscoverTargets params
    this.nextInternalId = INTERNAL_ID_BASE;
    this.internal = new Map();
    this.queue = [];
    this.closed = false;
    muxes.add(this);

    this.main = new WebSocket(mainUrl, { perMessageDeflate: false, maxPayload: MAX_PAYLOAD });
    this.main.on('open', () => {
      for (const m of this.queue) this.main.send(m);
      this.queue = null;
    });
    this.main.on('message', (data) => this.fromUpstream('main', data));
    this.main.on('close', () => this.close('main browser connection closed'));
    this.main.on('error', (err) => log(`mux ${clientAddr}: main upstream error: ${err.message}`));

    client.on('message', (data) => this.fromClient(data));
    client.on('close', () => this.close('client disconnected'));
    client.on('error', (err) => log(`mux ${clientAddr}: client error: ${err.message}`));
  }

  sendMain(msg) {
    const text = JSON.stringify(msg);
    if (this.queue) this.queue.push(text);
    else if (this.main.readyState === WebSocket.OPEN) this.main.send(text);
  }

  sendContext(msg) {
    if (this.contextWs?.readyState === WebSocket.OPEN) this.contextWs.send(JSON.stringify(msg));
  }

  // A client command for the context chromium. Without one nothing would
  // ever answer it, so the gateway does (answerAs: the client's original
  // command when msg was rewritten for the upstream).
  toContext(msg, answerAs = msg) {
    if (!this.context) {
      this.answerGone(answerAs);
      return;
    }
    if (msg.id !== undefined) this.pending.set(msg.id, { origin: 'context', msg: answerAs });
    this.sendContext(msg);
  }

  // Disposing a context that does not exist (any more) succeeds — it is gone
  // either way, and Playwright's context.close() must not fail on it;
  // anything else fails right away instead of hanging.
  answerGone(msg) {
    if (msg.id === undefined) return;
    if (msg.method === 'Target.disposeBrowserContext') this.reply(msg, {});
    else this.replyError(msg, 'isolated CDP context is gone');
  }

  sendClient(msg) {
    if (this.client.readyState === WebSocket.OPEN) this.client.send(JSON.stringify(msg));
  }

  reply(msg, result) {
    this.sendClient({ id: msg.id, sessionId: msg.sessionId, result });
  }

  replyError(msg, message) {
    this.sendClient({ id: msg.id, sessionId: msg.sessionId, error: { code: -32000, message } });
  }

  internalSend(target, method, params) {
    const id = this.nextInternalId++;
    return new Promise((resolve, reject) => {
      this.internal.set(id, { resolve, reject, method, target });
      const msg = { id, method, params };
      if (target === 'context') this.sendContext(msg);
      else this.sendMain(msg);
    });
  }

  fromClient(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const { method, params = {}, sessionId } = msg;

    if (sessionId) {
      if (this.sessionOwner.get(sessionId) === 'context') this.toContext(msg);
      else if (this.addressesContext(params)) this.viaContextBrowserSession(msg);
      else this.sendMain(msg);
      return;
    }

    switch (method) {
      case 'Target.createBrowserContext':
        if (this.context) {
          // a second isolated context on the same connection: a plain
          // incognito context inside this context's chromium
          this.toContext(msg);
        } else {
          if (params.proxyServer) {
            log(`mux ${this.clientAddr}: context proxy ${params.proxyServer} is not applied to contexts (they use the main browser's network settings)`);
          }
          this.attachContext(msg);
        }
        return;
      case 'Target.disposeBrowserContext':
        if (this.alias && params.browserContextId === this.alias) {
          const context = this.context;
          this.reply(msg, {});
          context?.destroy('context disposed by client');
          return;
        }
        if (this.innerContexts.delete(params.browserContextId)) {
          this.toContext(msg);
        } else {
          // the main browser's, or one gone with its context chromium: an
          // unknown id is answered as disposed (see fromUpstream)
          if (msg.id !== undefined) this.pending.set(msg.id, { origin: 'main', msg });
          this.sendMain(msg);
        }
        return;
      case 'Target.setAutoAttach':
        this.autoAttach = params;
        if (this.context) this.internalSend('context', method, params).catch(() => {});
        break;
      case 'Target.setDiscoverTargets':
        this.discover = params;
        if (this.context) this.internalSend('context', method, params).catch(() => {});
        break;
      default:
        break;
    }

    if (this.alias && params.browserContextId === this.alias) {
      // the alias stands for the context chromium's default context, which CDP
      // addresses by leaving browserContextId out
      const { browserContextId: _, ...rest } = params;
      this.toContext({ ...msg, params: rest }, msg);
      return;
    }
    if (this.context && (this.innerContexts.has(params.browserContextId)
        || this.addressesContext(params))) {
      this.toContext(msg);
      return;
    }
    this.sendMain(msg);
  }

  // Browser-level params naming a target or session of the context chromium.
  addressesContext(params) {
    return Boolean(this.context) && (this.contextTargets.has(params.targetId)
      || this.sessionOwner.get(params.sessionId) === 'context');
  }

  async viaContextBrowserSession(msg) {
    const clientSession = msg.sessionId;
    let pending = this.browserSessions.get(clientSession);
    if (!pending) {
      pending = this.internalSend('context', 'Target.attachToBrowserTarget', {}).then(({ sessionId }) => {
        this.browserSessionOf.set(sessionId, clientSession);
        return sessionId;
      });
      this.browserSessions.set(clientSession, pending);
    }
    try {
      this.toContext({ ...msg, sessionId: await pending }, msg);
    } catch (err) {
      this.browserSessions.delete(clientSession);
      this.replyError(msg, err.message);
    }
  }

  async attachContext(msg) {
    let context;
    try {
      context = await createContext(this.clientAddr);
      if (this.closed) {
        await context.destroy('client went away during startup');
        return;
      }
      const ws = new WebSocket(context.browserWsUrl(), { perMessageDeflate: false, maxPayload: MAX_PAYLOAD });
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      this.context = context;
      this.contextWs = ws;
      context.mux = this;
      this.alias = `CONTEXT${context.name.replace(/\W/g, '').toUpperCase()}${Date.now().toString(16).toUpperCase()}`;
      ws.on('message', (data) => this.fromUpstream('context', data));
      ws.on('close', () => {
        if (this.context === context) context.destroy('context connection closed');
      });
      ws.on('error', (err) => log(`mux ${this.clientAddr}: ${context.name} upstream error: ${err.message}`));
      // mirror the client's target-tracking setup onto the new browser so
      // its pages reach the client the same way the main browser's do
      if (this.discover) await this.internalSend('context', 'Target.setDiscoverTargets', this.discover);
      if (this.autoAttach) await this.internalSend('context', 'Target.setAutoAttach', this.autoAttach);
      log(`${context.name}: attached to client ${this.clientAddr} as context ${this.alias}`);
      this.reply(msg, { browserContextId: this.alias });
    } catch (err) {
      log(`mux ${this.clientAddr}: context creation failed: ${err.message}`);
      if (context && !context.destroyed) await context.destroy('attach failed');
      this.replyError(msg, err.message);
    }
  }

  fromUpstream(origin, data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.id >= INTERNAL_ID_BASE) {
      const p = this.internal.get(msg.id);
      if (p) {
        this.internal.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
        else p.resolve(msg.result);
      }
      return;
    }

    const pending = msg.id !== undefined && this.pending.get(msg.id);
    if (pending) {
      this.pending.delete(msg.id);
      if (msg.error && pending.msg.method === 'Target.disposeBrowserContext') {
        this.answerGone(pending.msg);
        return;
      }
    }
    if (origin === 'context') {
      // the gateway's own browser-target sessions stay invisible to the client
      if (msg.method === 'Target.attachedToTarget' && msg.params.targetInfo.type === 'browser') return;
      if (msg.method === 'Target.detachedFromTarget' && this.browserSessionOf.has(msg.params.sessionId)) return;
      if (this.browserSessionOf.has(msg.sessionId)) msg.sessionId = this.browserSessionOf.get(msg.sessionId);
      this.trackContextMessage(msg);
    } else if (msg.method === 'Target.attachedToTarget') {
      this.sessionOwner.set(msg.params.sessionId, 'main');
    } else if (msg.method === 'Target.detachedFromTarget') {
      this.sessionOwner.delete(msg.params.sessionId);
    }
    this.sendClient(msg);
  }

  trackContextMessage(msg) {
    const p = msg.params;
    if (msg.result?.browserContextId) this.innerContexts.add(msg.result.browserContextId);
    if (msg.result?.targetId) this.contextTargets.add(msg.result.targetId);
    switch (msg.method) {
      case 'Target.attachedToTarget':
        this.sessionOwner.set(p.sessionId, 'context');
        this.sessionTarget.set(p.sessionId, p.targetInfo.targetId);
        if (msg.sessionId) this.sessionParent.set(p.sessionId, msg.sessionId);
        break;
      case 'Target.detachedFromTarget':
        this.sessionOwner.delete(p.sessionId);
        this.sessionTarget.delete(p.sessionId);
        this.sessionParent.delete(p.sessionId);
        break;
      case 'Target.targetDestroyed':
        this.contextTargets.delete(p.targetId);
        break;
      default:
        break;
    }
    const info = p?.targetInfo;
    if (info) {
      this.contextTargets.add(info.targetId);
      // everything in the context chromium's default context belongs to the alias
      if (!this.innerContexts.has(info.browserContextId)) info.browserContextId = this.alias;
    }
  }

  // The context is gone (disposed, crashed or deleted from the dashboard):
  // tell the client its pages are gone, the same way chromium would.
  contextGone(context) {
    if (this.context !== context) return;
    for (const [sessionId, targetId] of this.sessionTarget) {
      this.sendClient({ method: 'Target.detachedFromTarget', sessionId: this.sessionParent.get(sessionId), params: { sessionId, targetId } });
      this.sessionOwner.delete(sessionId);
    }
    for (const targetId of this.contextTargets) {
      this.sendClient({ method: 'Target.targetDestroyed', params: { targetId } });
    }
    // commands still in flight to the dead browser never get an answer
    for (const [id, p] of this.pending) {
      if (p.origin !== 'context') continue;
      this.pending.delete(id);
      this.answerGone(p.msg);
    }
    for (const [id, p] of this.internal) {
      if (p.target !== 'context') continue;
      this.internal.delete(id);
      p.reject(new Error(`${p.method}: isolated CDP context is gone`));
    }
    this.innerContexts.clear();
    this.sessionTarget.clear();
    this.sessionParent.clear();
    this.contextTargets.clear();
    this.browserSessions.clear();
    this.browserSessionOf.clear();
    this.contextWs?.close();
    this.contextWs = null;
    this.context = null;
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    muxes.delete(this);
    this.context?.destroy(reason);
    if (this.main.readyState === WebSocket.OPEN || this.main.readyState === WebSocket.CONNECTING) this.main.terminate();
    if (this.client.readyState === WebSocket.OPEN) this.client.close();
  }
}

// --- HTTP: /json/*, dashboard, API ------------------------------------------
function publicHost(req) {
  return req.headers.host || PUBLIC_FALLBACK;
}

function send(res, status, body, type = 'application/json; charset=UTF-8') {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(payload);
}

async function pageTargets(port) {
  try {
    return (await fetchJson(port, '/json/list')).filter((t) => t.type === 'page');
  } catch {
    return [];
  }
}

// Which chromium (port) owns a target id: the main browser or a context.
async function targetPort(targetId) {
  for (const context of contexts.values()) {
    if ((await pageTargets(context.port)).some((t) => t.id === targetId)) return context.port;
  }
  return MAIN_PORT;
}

async function apiState() {
  const tabs = (list) => list.map((t) => ({ id: t.id, title: t.title, url: t.url }));
  const result = {
    max: MAX_CONTEXTS,
    main: { name: 'main', tabs: tabs(await pageTargets(MAIN_PORT)) },
    contexts: [],
  };
  for (const s of contexts.values()) {
    result.contexts.push({
      name: s.name, color: s.color, client: s.client, createdAt: s.createdAt, pid: s.proc?.pid ?? null,
      tabs: tabs(await pageTargets(s.port)),
    });
  }
  return result;
}

function portOf(name) {
  if (name === 'main') return MAIN_PORT;
  return contexts.get(name)?.port ?? 0;
}

const thumbCache = new Map(); // `${port}/${targetId}` -> { at, jpeg }
const thumbInflight = new Map(); // `${port}/${targetId}` -> Promise<jpeg>

function thumbnail(port, targetId) {
  const key = `${port}/${targetId}`;
  const hit = thumbCache.get(key);
  if (hit && Date.now() - hit.at < 2500) return hit.jpeg;
  // one capture per tab at a time: overlapping captures of a page time out
  if (!thumbInflight.has(key)) {
    thumbInflight.set(key, captureThumb(port, targetId, key).finally(() => thumbInflight.delete(key)));
  }
  return thumbInflight.get(key);
}

// Full-size and unclipped on purpose: a clip (or its scale) makes chromium
// emulate a resized viewport for the capture, and overlapping captures
// restore each other's emulation, leaving the live page laid out at the
// thumbnail width inside a full-size window until it reloads. The dashboard
// scales the image down instead.
async function captureThumb(port, targetId, key) {
  const cdp = await CdpClient.connect(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
  try {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 50 }, { timeout: 4000 });
    const jpeg = Buffer.from(data, 'base64');
    thumbCache.set(key, { at: Date.now(), jpeg });
    if (thumbCache.size > 200) thumbCache.delete(thumbCache.keys().next().value);
    return jpeg;
  } finally {
    cdp.close();
  }
}

// Bring a context's (or the main browser's) window to the front of the desktop
// so it shows up in the Selkies stream.
async function focus(name, targetId) {
  const port = portOf(name);
  if (!port) return false;
  const pages = await pageTargets(port);
  const id = targetId || pages[0]?.id;
  if (!id) return false;
  await fetch(`http://127.0.0.1:${port}/json/activate/${id}`);
  if (name !== 'main' && env.CDP_CONTEXTS_HEADLESS === '1') return true;
  if (WAYLAND) {
    await run('wlrctl', ['toplevel', 'focus', `app_id:${appId(name)}`]);
  } else {
    const pid = name === 'main' ? env.CDP_MAIN_CHROMIUM_PID : contexts.get(name)?.proc?.pid;
    if (pid) await run('python3', [path.join(HERE, 'raise-window.py'), String(pid)]);
  }
  return true;
}

// The Wayland app_id of the main browser (set by the entrypoint) or a context.
function appId(name) {
  return `cdp-${name}`;
}

// Chromium's own activate does not restack its window: on X11 no window
// manager runs (raise-window.py restacks via the X server directly), and on
// Wayland labwc refuses activation requests that no user input led to, so
// wlrctl activates the window through labwc's foreign-toplevel protocol.
function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'ignore' });
    child.on('exit', resolve);
    child.on('error', resolve);
  });
}

async function handleHttp(req, res) {
  const url = new URL(req.url, 'http://gateway');
  const p = url.pathname;
  const host = publicHost(req);
  try {
    if (p === '/json/version' || p === '/json/version/') {
      return send(res, 200, rewriteHost(await fetchJson(MAIN_PORT, '/json/version'), MAIN_PORT, host));
    }
    if (['/json', '/json/', '/json/list', '/json/list/'].includes(p)) {
      let list = rewriteHost(await fetchJson(MAIN_PORT, '/json/list'), MAIN_PORT, host);
      for (const s of contexts.values()) {
        try {
          list = list.concat(rewriteHost(await fetchJson(s.port, '/json/list'), s.port, host));
        } catch { /* context shutting down */ }
      }
      return send(res, 200, list);
    }
    if (p === '/json/protocol' || p === '/json/protocol/') {
      return send(res, 200, await fetchJson(MAIN_PORT, '/json/protocol'));
    }
    if (p.startsWith('/json/new')) {
      return send(res, 200, rewriteHost(await fetchJson(MAIN_PORT, `/json/new${url.search}`, 'PUT'), MAIN_PORT, host));
    }
    const m = p.match(/^\/json\/(activate|close)\/([^/]+)$/);
    if (m) {
      const port = await targetPort(m[2]);
      const r = await fetch(`http://127.0.0.1:${port}/json/${m[1]}/${m[2]}`);
      return send(res, r.status, await r.text(), 'text/plain; charset=UTF-8');
    }

    if (p === '/console') {
      res.writeHead(302, { Location: '/console/' });
      return res.end();
    }
    if (p === '/console/') {
      return send(res, 200, await fs.readFile(path.join(HERE, 'dashboard.html')), 'text/html; charset=UTF-8');
    }
    if (p === '/console/api') return send(res, 200, await apiState());
    const a = p.match(/^\/console\/api\/([\w.-]+)(?:\/(thumb|focus)(?:\/([^/]+))?)?$/);
    if (a) {
      const [, name, action, targetId] = a;
      if (action === 'thumb' && req.method === 'GET') {
        const port = portOf(name);
        if (!port || !targetId) return send(res, 404, { error: 'no such context or tab' });
        try {
          return send(res, 200, await thumbnail(port, targetId), 'image/jpeg');
        } catch (err) {
          return send(res, 503, { error: err.message });
        }
      }
      if (action === 'focus' && req.method === 'POST') {
        return (await focus(name, targetId)) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'nothing to focus' });
      }
      if (!action && req.method === 'DELETE') {
        const context = contexts.get(name);
        if (!context) return send(res, 404, { error: `no context ${name}` });
        await context.destroy('deleted via API');
        context.mux?.close('context deleted via API');
        return send(res, 200, { ok: true });
      }
    }
    return send(res, 404, { error: `not found: ${p}` });
  } catch (err) {
    log(`HTTP ${req.method} ${p}: ${err.message}`);
    return send(res, 502, { error: err.message });
  }
}

// --- WebSocket upgrades -----------------------------------------------------
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_PAYLOAD });

function clientAddress(req) {
  return req.headers['x-real-ip'] || req.socket.remoteAddress;
}

// /devtools/page/<id>: a plain relay to whichever chromium owns the target.
function relay(client, upstreamUrl) {
  const upstream = new WebSocket(upstreamUrl, { perMessageDeflate: false, maxPayload: MAX_PAYLOAD });
  const queue = [];
  upstream.on('open', () => {
    for (const m of queue) upstream.send(m);
    queue.length = 0;
  });
  client.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    else queue.push(data);
  });
  upstream.on('message', (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  const closeBoth = () => {
    upstream.terminate();
    client.terminate();
  };
  upstream.on('close', closeBoth);
  client.on('close', closeBoth);
  upstream.on('error', closeBoth);
  client.on('error', closeBoth);
}

async function handleUpgrade(req, socket, head) {
  const p = new URL(req.url, 'http://gateway').pathname;
  try {
    let target;
    if (p.startsWith('/devtools/browser/')) {
      target = { kind: 'browser', url: (await fetchJson(MAIN_PORT, '/json/version')).webSocketDebuggerUrl };
    } else if (p.startsWith('/devtools/page/')) {
      const port = await targetPort(p.slice('/devtools/page/'.length));
      target = { kind: 'page', url: `ws://127.0.0.1:${port}${p}` };
    } else {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      if (target.kind === 'browser') new Mux(client, clientAddress(req), target.url);
      else relay(client, target.url);
    });
  } catch (err) {
    log(`upgrade ${p}: ${err.message}`);
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  }
}

// --- main -------------------------------------------------------------------
if (!CHROME_BIN) throw new Error('CHROME_BIN is not set');
readFlags(); // fail fast when the entrypoint did not write the flag file
await fs.mkdir(CONTEXTS_DIR, { recursive: true });
log(`profile clones: ${await probeReflink()}`);

const server = http.createServer((req, res) => {
  handleHttp(req, res);
});
server.on('upgrade', (req, socket, head) => {
  handleUpgrade(req, socket, head);
});
server.listen(LISTEN_PORT, '127.0.0.1', () => {
  log(`listening on 127.0.0.1:${LISTEN_PORT} (main chromium on :${MAIN_PORT}, max ${MAX_CONTEXTS} contexts, data in ${CONTEXTS_DIR})`);
});

async function shutdown(signal) {
  log(`${signal}: destroying ${contexts.size} context(s)`);
  server.close();
  await Promise.all([...contexts.values()].map((s) => s.destroy('gateway shutdown')));
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
