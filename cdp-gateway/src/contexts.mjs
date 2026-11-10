// Isolated contexts: one chromium each, on a clone of the main profile.

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { notifyChange } from './changes.mjs';
import {
  CHROME_BIN, CONTEXT_COLORS, CONTEXTS_DIR, CONTEXTS_HEADLESS, MAIN_PROFILE, MAX_CONTEXTS, WAYLAND,
  appId, readFlags,
} from './config.mjs';
import { cloneProfile, preparePrefs } from './profile.mjs';
import { copyCookies, restoreLocalStorage, snapshotLocalStorage } from './storage-sync.mjs';
import { freePort, killGroup, log } from './util.mjs';

const STARTUP_TIMEOUT_MS = 15_000;

// Resolves with the browser WebSocket path chromium prints on stderr once its
// DevTools port is open ("DevTools listening on ws://127.0.0.1:<port>/...").
function devtoolsAnnounced(proc, port, logPath) {
  const listening = new RegExp(`DevTools listening on ws://127\\.0\\.0\\.1:${port}(/devtools/browser/\\S+)\\r?\n`); // the whole line: a chunk may end mid-path
  return new Promise((resolve, reject) => {
    let tail = '';
    const onData = (chunk) => {
      const text = tail + chunk;
      const m = listening.exec(text);
      if (m) done(null, m[1]);
      else tail = text.slice(-512); // a line split across chunks
    };
    const onExit = () => done(new Error(`chromium exited during startup, see ${logPath}`));
    const timer = setTimeout(() => {
      done(new Error(`chromium did not open its DevTools port ${port} within ${STARTUP_TIMEOUT_MS / 1000}s, see ${logPath}`));
    }, STARTUP_TIMEOUT_MS);
    function done(err, wsPath) {
      clearTimeout(timer);
      proc.stderr.off('data', onData);
      proc.off('exit', onExit);
      if (err) reject(err);
      else resolve(wsPath);
    }
    proc.stderr.on('data', onData);
    proc.once('exit', onExit);
  });
}

class Context {
  constructor(registry, index, client) {
    this.registry = registry;
    this.name = `context-${index}`;
    this.color = CONTEXT_COLORS[(index - 1) % CONTEXT_COLORS.length];
    this.client = client; // remote address of the CDP client that owns it
    this.dir = path.join(CONTEXTS_DIR, this.name);
    this.profile = path.join(this.dir, 'profile');
    this.createdAt = new Date().toISOString();
    this.proc = null;
    this.port = 0;
    this.browserWsPath = '';
    this.mux = null; // the client connection it is attached to (mux.mjs)
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

    let flags = readFlags();
    if (CONTEXTS_HEADLESS && !flags.includes('--headless')) flags.push('--headless');
    const port = await freePort();
    flags = flags.concat([
      `--user-data-dir=${this.profile}`,
      `--remote-debugging-port=${port}`,
      '--no-startup-window',
    ]);
    // the Wayland app_id focus() raises this context's windows by
    if (WAYLAND && !CONTEXTS_HEADLESS) flags.push(`--class=${appId(this.name)}`);
    const logPath = path.join(this.dir, 'chromium.log');
    const logFile = createWriteStream(logPath, { flags: 'a' });
    await new Promise((resolve) => logFile.once('open', resolve));
    const proc = spawn(CHROME_BIN, flags, {
      detached: true, // own process group: destroy() takes renderers down too
      stdio: ['ignore', logFile, 'pipe'], // stderr: read below, then into the log
    });
    this.proc = proc;
    proc.stderr.pipe(logFile);
    proc.once('exit', (code, signal) => {
      log(`${this.name}: chromium exited (code=${code} signal=${signal})`);
      this.proc = null;
      this.onExit?.();
    });
    // chromium announces the browser endpoint on stderr once it is listening;
    // seeing it from this very process also proves nothing else grabbed the
    // port in between
    this.browserWsPath = await devtoolsAnnounced(proc, port, logPath);
    this.port = port;

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
    this.registry.forget(this);
    notifyChange();
    log(`${this.name}: destroying (${reason})`);
    // detach from the client first: its pages are gone from now on, and the
    // same connection may create its next isolated context right away
    this.mux?.contextGone(this);
    const proc = this.proc;
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      const exited = new Promise((resolve) => proc.once('exit', resolve));
      killGroup(proc.pid, 'SIGTERM');
      const timer = setTimeout(() => killGroup(proc.pid, 'SIGKILL'), 5000);
      await exited;
      clearTimeout(timer);
    }
    await fs.rm(this.dir, { recursive: true, force: true });
  }
}

class ContextRegistry {
  #contexts = new Map(); // name -> Context, running ones only
  #counter = 0;
  #creating = 0; // contexts in startup, counted against the limit too

  get size() {
    return this.#contexts.size;
  }

  // running or starting up
  get busy() {
    return this.#contexts.size + this.#creating > 0;
  }

  get(name) {
    return this.#contexts.get(name);
  }

  names() {
    return [...this.#contexts.keys()];
  }

  values() {
    return [...this.#contexts.values()];
  }

  async create(clientAddr) {
    if (this.#contexts.size + this.#creating >= MAX_CONTEXTS) {
      throw new Error(`CDP context limit reached (${MAX_CONTEXTS}); close another isolated session or raise CDP_CONTEXTS_MAX`);
    }
    this.#creating++;
    const context = new Context(this, ++this.#counter, clientAddr);
    try {
      await context.start();
    } catch (err) {
      await context.destroy(`startup failed: ${err.message}`);
      throw err;
    } finally {
      this.#creating--;
    }
    this.#contexts.set(context.name, context);
    notifyChange();
    context.onExit = () => context.destroy('chromium exited');
    return context;
  }

  forget(context) {
    this.#contexts.delete(context.name);
  }
}

export const contexts = new ContextRegistry();
