// Isolated contexts: one chromium each, on a clone of the main profile,
// driven over its DevTools pipe (pipe.mjs) like the main browser.

import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { notifyChange } from './changes.mjs';
import {
  CONTEXT_COLORS, CONTEXTS_DIR, CONTEXTS_HEADLESS, MAIN_PROFILE, MAX_CONTEXTS, CONTEXTS_OVERFLOW, HIBERNATED_MAX, WAYLAND,
  appId, readFlags,
} from './config.mjs';
import { browserReady, launchChromium } from './launch.mjs';
import { restoreScreen } from './screen.mjs';
import { cloneProfile, preparePrefs } from './profile.mjs';
import { copyCookies, restoreLocalStorage, snapshotLocalStorage } from './storage-sync.mjs';
import { killGroup, log, sleep } from './util.mjs';
import { ContextSession } from './context-session.mjs';
import { captureTabs, nativeRestore, restoreTabs, parkSessionFiles, finishSessionFiles } from './context-restore.mjs';

const STARTUP_TIMEOUT_MS = 15_000;

// The chromium flags for the proxy a client's Target.createBrowserContext
// names (proxyServer, proxyBypassList — Playwright's newContext({ proxy })).
// The context is a chromium of its own, so they become its command line,
// after the main browser's flags (CHROMIUM_EXTRA_ARGS included): the
// client asked for this context in particular. Each is one argv element,
// so nothing in them can become another flag; control characters and
// (in the server) whitespace are refused all the same.
export function proxyFlags({ proxyServer, proxyBypassList } = {}) {
  const flags = [];
  if (proxyServer === undefined || proxyServer === '') {
    if (proxyBypassList !== undefined && proxyBypassList !== '') throw new Error('proxyBypassList needs a proxyServer');
    return flags;
  }
  if (typeof proxyServer !== 'string' || /[\x00-\x20\x7f]/.test(proxyServer)) throw new Error('proxyServer is not a valid proxy server');
  flags.push(`--proxy-server=${proxyServer}`);
  if (proxyBypassList !== undefined && proxyBypassList !== '') {
    if (typeof proxyBypassList !== 'string' || /[\x00-\x1f\x7f]/.test(proxyBypassList)) throw new Error('proxyBypassList is not a valid bypass list');
    flags.push(`--proxy-bypass-list=${proxyBypassList}`);
  }
  return flags;
}

export class Context {
  constructor(registry, index, client, proxy = []) {
    this.registry = registry;
    this.name = `context-${index}`;
    this.color = CONTEXT_COLORS[(index - 1) % CONTEXT_COLORS.length];
    this.client = client; // remote address of the CDP client that owns it
    this.proxy = proxy; // proxyFlags() of the client's createBrowserContext
    this.dir = path.join(CONTEXTS_DIR, this.name);
    this.profile = path.join(this.dir, 'profile');
    this.createdAt = new Date().toISOString();
    this.proc = null;
    this.pipe = null; // its DevTools pipe (pipe.mjs)
    this.mux = null; // the client connection it is attached to (mux.mjs)
    this.destroyed = false;
    // armed from here on, before the process exists: an exit during startup
    // is destroyed the same way (destroy is idempotent) instead of relying
    // on the later startup steps failing
    this.onExit = () => this.destroy('chromium exited');
    this.state = 'starting';
    this.slot = true;
    this.holds = 0;
    this.relays = 0;
    this.lastUsedAt = Date.now();
    this.session = null;
    this.snapshot = null;
    this.hibernatedAt = null;
    this.lastError = '';
    this.restoreWarning = '';
    this.starting = null;
    this.waking = null;
    this.wakeActive = false;
    this.hibernating = null;
    this.destroying = null;
    this.alive = () => true;
  }

  async start() {
    const t0 = Date.now();
    await fs.mkdir(this.dir, { recursive: true });
    const localStorageSnapshot = await snapshotLocalStorage();
    await cloneProfile(MAIN_PROFILE, this.profile);
    await preparePrefs(this.profile, this.color);
    const tClone = Date.now();

    await this.launch(false);
    const { pipe } = this;

    // Both sync steps are best effort: the profile clone on disk already
    // carries most of the storage, so one of them failing must not fail the
    // whole context — a warning is all it takes
    let cookies = 0;
    try {
      cookies = await copyCookies(pipe);
    } catch (err) {
      log(`${this.name}: cookie sync skipped: ${err.message}`);
    }
    let origins = 0;
    try {
      origins = await restoreLocalStorage(pipe, localStorageSnapshot);
    } catch (err) {
      log(`${this.name}: localStorage restore skipped: ${err.message}`);
    }
    log(`${this.name}: up (pid ${this.proc?.pid}; clone ${tClone - t0}ms, total ${Date.now() - t0}ms; synced from main: ${cookies} cookies, localStorage of ${origins} open origin(s))`);
  }

  async launch(restore) {
    if (this.destroyed || !this.alive()) throw new Error('context owner disconnected');
    // Only reached after the previous process group exited. A forced stop
    // can leave these profile-local symlinks behind (as for main-browser).
    for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      await fs.rm(path.join(this.profile, name), { force: true });
    }
    let flags = readFlags();
    if (CONTEXTS_HEADLESS && !flags.includes('--headless')) flags.push('--headless');
    flags = flags.concat([
      `--user-data-dir=${this.profile}`,
      // With the debugging pipe, this also keeps Chromium and its profile alive after the last window closes. Native restore is triggered explicitly in restoreTabs().
      '--no-startup-window',
      ...(restore ? ['--restore-last-session'] : []),
      ...this.proxy,
    ]);
    // the Wayland app_id focus() raises this context's windows by
    if (WAYLAND && !CONTEXTS_HEADLESS) flags.push(`--class=${appId(this.name)}`);
    const logPath = path.join(this.dir, 'chromium.log');
    const logFile = createWriteStream(logPath, { flags: 'a' });
    // an error on the log (cannot be opened, the disk filled up) would be an
    // unhandled 'error' event otherwise, which takes the whole gateway (and
    // so the container) down; chromium writes to the file itself
    logFile.on('error', (err) => log(`${this.name}: ${logPath}: ${err.message}`));
    await new Promise((resolve, reject) => {
      logFile.once('open', resolve);
      logFile.once('error', reject);
    });
    if (!CONTEXTS_HEADLESS) await restoreScreen();
    if (this.destroyed || !this.alive()) { logFile.end(); throw new Error('context was deleted or its owner disconnected'); }
    const { proc, pipe } = launchChromium(flags, logFile, this.name);
    this.proc = proc;
    this.pipe = pipe;
    // a failed spawn (EAGAIN, ENOMEM, ...) is an 'error' event and no 'exit';
    // unhandled it would take the whole gateway down
    proc.on('error', (err) => {
      log(`${this.name}: chromium: ${err.message}`);
      if (!proc.pid) { logFile.end(); pipe.close(); if (this.proc === proc) { this.proc = null; this.pipe = null; } }
    });
    proc.once('exit', (code, signal) => {
      log(`${this.name}: chromium exited (code=${code} signal=${signal})`);
      logFile.end();
      killGroup(proc.pid, 'SIGKILL');
      if (this.proc !== proc) return;
      this.proc = null;
      this.pipe = null;
      if (['running', 'starting'].includes(this.state) && !this.destroyed) this.onExit?.();
    });
    await browserReady(proc, pipe, STARTUP_TIMEOUT_MS, logPath);
    if (this.destroyed || !this.alive()) throw new Error('context was deleted or its owner disconnected');

  }

  async connect() {
    this.session = new ContextSession(this, await this.pipe.connect());
    return this.session;
  }

  touch() { this.lastUsedAt = Date.now(); }
  get blockedReason() {
    if (this.mux?.innerContexts.size) return 'browser contains incognito contexts';
    if (this.relays) return 'a direct page connection is attached';
    if (this.holds) return 'browser action is in progress';
    return this.session?.blockedReason ?? '';
  }

  hibernate(reason = 'requested via console') {
    return this.registry.serialize(async () => {
      if (this.state === 'hibernated') return;
      await this.hibernateNow(reason);
      await this.registry.trim();
    });
  }

  hibernateNow(reason) {
    if (this.hibernating) return this.hibernating;
    this.hibernating = (async () => {
      if (this.destroyed || this.state !== 'running') throw new Error('context is not running');
      if (this.blockedReason) throw new Error(this.blockedReason);
      this.state = 'hibernating';
      if (this.session) this.session.mode = 'quiescing';
      notifyChange();
      try {
        this.snapshot = await captureTabs(this);
      } catch (err) {
        this.state = this.destroyed ? 'destroying' : 'running';
        if (this.session && !this.destroyed) { this.session.mode = 'running'; this.session.flush(); }
        this.lastError = `snapshot failed: ${err.message}`;
        notifyChange();
        throw err;
      }
      this.session?.suspend();
      this.snapshot.forced = await this.stop(true);
      if (this.snapshot.forced) this.restoreWarning = 'browser required a signal to stop; recent unsaved state may be lost';
      this.slot = false;
      if (this.destroyed) return;
      this.state = 'hibernated';
      this.hibernatedAt = new Date().toISOString();
      log(`${this.name}: hibernated (${reason}; ${this.snapshot.tabs.length} saved tabs)`);
      notifyChange();
    })().finally(() => { this.hibernating = null; });
    return this.hibernating;
  }

  wake() {
    if (this.destroyed) return Promise.reject(new Error('context is gone'));
    if (this.state === 'running') { this.touch(); return Promise.resolve(); }
    if (this.waking) return this.waking;
    this.waking = this.registry.serialize(async () => {
      if (this.destroyed) throw new Error('context is gone');
      if (this.state === 'running') return;
      await this.registry.makeRoom(this);
      if (this.destroyed) throw new Error('context is gone');
      this.slot = true;
      this.state = 'waking';
      this.wakeActive = true;
      this.lastError = '';
      this.restoreWarning = this.snapshot?.forced ? 'browser required a signal to stop; recent unsaved state may be lost' : '';
      notifyChange();
      try {
        let native = nativeRestore(this);
        if (!native) await parkSessionFiles(this);
        await this.launch(native);
        let pages;
        try { pages = await restoreTabs(this, native); }
        catch (err) {
          if (!native) throw err;
          this.restoreWarning = `${err.message}; restored URLs instead`;
          await this.stop(true);
          await parkSessionFiles(this);
          native = false;
          await this.launch(false);
          pages = await restoreTabs(this, false);
        }
        if (this.session) await this.session.restore(this.pipe, pages);
        else for (const p of pages.filter((p) => p.navigate)) {
          const { sessionId } = await this.pipe.call('Target.attachToTarget', { targetId: p.physical, flatten: true });
          await this.pipe.call('Page.navigate', { url: p.url }, { sessionId });
          await this.pipe.call('Target.detachFromTarget', { sessionId });
        }
        this.restoredTargets = new Map(pages.map((p) => [p.id, p.physical]));
        const current = pages.find((p) => p.id === this.snapshot.current);
        if (current) await this.pipe.call('Target.activateTarget', { targetId: current.physical });
        if (this.destroyed) throw new Error('context was deleted');
        await finishSessionFiles(this, true);
        this.state = 'running';
        this.hibernatedAt = null;
        this.touch();
        this.session?.flush();
        log(`${this.name}: resumed (${pages.length} tabs; ${native ? 'native session' : 'URL snapshot'})`);
        notifyChange();
      } catch (err) {
        this.session?.suspend();
        await this.stop(false);
        await finishSessionFiles(this, false);
        this.slot = false;
        this.state = this.destroyed ? 'destroying' : 'hibernated';
        this.lastError = err.message;
        this.session?.flush(err);
        notifyChange();
        this.wakeActive = false; // cleanup is complete; trimming must not wait on this task
        await this.registry.trim(this);
        throw err;
      }
      this.wakeActive = false;
      await this.registry.trim();
    }).finally(() => { this.wakeActive = false; this.waking = null; });
    return this.waking;
  }

  logicalTarget(id) {
    if (this.session) return this.session.logicalTarget(id);
    return [...(this.restoredTargets ?? [])].find(([, physical]) => physical === id)?.[0] ?? id;
  }
  physicalTarget(id) {
    if (this.session) return this.session.physicalTarget(id);
    return this.restoredTargets?.get(id) ?? id;
  }

  async stop(graceful) {
    const proc = this.proc;
    if (!proc?.pid || proc.exitCode !== null || proc.signalCode !== null) return false;
    let forced = false;
    const exited = new Promise((resolve) => proc.once('exit', resolve));
    const timers = [
      setTimeout(() => { forced = graceful; killGroup(proc.pid, 'SIGTERM'); }, graceful ? 5000 : 0),
      setTimeout(() => { forced = graceful; killGroup(proc.pid, 'SIGKILL'); }, graceful ? 15000 : 5000),
    ];
    if (graceful && this.pipe) this.pipe.call('Browser.close').catch(() => {});
    await exited;
    timers.forEach(clearTimeout);
    killGroup(proc.pid, 'SIGKILL');
    return forced;
  }

  destroy(reason) {
    if (this.destroying) return this.destroying;
    this.destroyed = true;
    this.state = 'destroying';
    this.destroying = Promise.resolve().then(async () => {
      // A queued wake has not touched the profile and will observe destroyed
      // before it starts. Waiting on it from a registry eviction deadlocks
      // the queue behind that same eviction.
      await Promise.allSettled([this.starting, this.wakeActive ? this.waking : null, this.hibernating].filter(Boolean));
      await this.stop(false);
      this.slot = false;
      await fs.rm(this.dir, { recursive: true, force: true });
      this.registry.forget(this);
      notifyChange();
    });
    this.mux?.contextGone(this);
    this.session?.close();
    notifyChange();
    log(`${this.name}: destroying (${reason})`);
    return this.destroying;
  }
}

export class ContextRegistry {
  #contexts = new Map();
  #counter = 0;
  #tail = Promise.resolve();
  closing = false;

  close() { this.closing = true; }

  get size() { return this.#contexts.size; }
  get running() { return this.values().filter((c) => c.slot).length; }
  get busy() { return this.size > 0; }
  get(name) { return this.#contexts.get(name); }
  names() { return [...this.#contexts.keys()]; }
  values() { return [...this.#contexts.values()]; }

  serialize(fn) {
    const task = this.#tail.then(fn);
    this.#tail = task.catch(() => {});
    return task;
  }

  async makeRoom(exclude) {
    if (this.closing) throw new Error('CDP gateway is shutting down');
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (this.running >= MAX_CONTEXTS) {
      if (CONTEXTS_OVERFLOW === 'reject') throw new Error(`CDP context limit reached (${MAX_CONTEXTS}); close another isolated session or raise CDP_CONTEXTS_MAX`);
      const candidates = this.values().filter((c) => c !== exclude && c.state === 'running' && !c.destroyed && !c.blockedReason);
      candidates.sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.createdAt.localeCompare(b.createdAt));
      if (candidates.length) { await candidates[0].hibernateNow('least recently used; running limit reached'); continue; }
      // A newly created context's Mux finishes attaching outside the registry
      // lock. Wait for that short lease, not for an arbitrary user command.
      if (Date.now() < deadline && this.values().some((c) => c.holds || c.destroyed)) { await sleep(20); continue; }
      throw new Error(`CDP context limit reached (${MAX_CONTEXTS}); no hibernatable browser: ${this.values().filter((c) => c.slot).map((c) => `${c.name}: ${c.blockedReason || c.state}`).join('; ')}`);
    }
  }

  async trim(protect = null) {
    const sleeping = this.values().filter((c) => c.state === 'hibernated' && !c.destroyed)
      .sort((a, b) => a.hibernatedAt.localeCompare(b.hibernatedAt));
    while (sleeping.length > HIBERNATED_MAX) {
      const index = HIBERNATED_MAX === 0 ? 0 : sleeping.findIndex((c) => c !== protect);
      if (index < 0) break;
      const [old] = sleeping.splice(index, 1);
      const mux = old.mux;
      await old.destroy('hibernated context limit reached');
      mux?.close('hibernated context evicted');
    }
  }

  async create(clientAddr, options = {}, { hold = false, alive = () => true } = {}) {
    const proxy = proxyFlags(options);
    return this.serialize(async () => {
      if (!alive()) throw new Error('client disconnected before context startup');
      await this.makeRoom();
      if (this.closing || !alive()) throw new Error('context startup cancelled');
      const context = new Context(this, ++this.#counter, clientAddr, proxy);
      context.alive = alive;
      context.holds = hold ? 1 : 0;
      this.#contexts.set(context.name, context);
      context.starting = context.start();
      try {
        await context.starting;
        if (context.destroyed) throw new Error('isolated CDP context exited during startup');
        context.state = 'running';
        context.touch();
        notifyChange();
        await this.trim();
        return context;
      } catch (err) {
        await context.destroy(`startup failed: ${err.message}`);
        throw err;
      } finally { context.starting = null; }
    });
  }

  forget(context) { this.#contexts.delete(context.name); }
}

export const contexts = new ContextRegistry();
