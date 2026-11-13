// The main browser.
//
// Always this process's child, launched from the command line the entrypoint
// left in MAIN_FLAGS_FILE: right when the gateway starts with
// CHROMIUM_AUTOSTART=true (server.mjs), otherwise on demand only. Either way
// a stopped one is started again by the next CDP client that uses the
// default context (ensure() in mux.mjs / routes-json.mjs) or the console. When it exits — window
// closed, Stop, a crash, a client's Browser.close — the gateway just marks it
// stopped: the gateway, not the browser, is what the container supervises.
// The gateway speaks CDP with it over its pipe (pipe.mjs), the only way in.

import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { notifyChange } from './changes.mjs';
import { MAIN_FLAGS_FILE, MAIN_LOG, MAIN_PROFILE, readFlags } from './config.mjs';
import { browserReady, launchChromium } from './launch.mjs';
import { killGroup, log } from './util.mjs';

const STARTUP_TIMEOUT_MS = 15_000;

class MainBrowser {
  constructor() {
    this.state = 'stopped'; // | 'starting' | 'running'
    this.proc = null;
    this.pipe = null; // its DevTools pipe while it runs
    this.version = null; // its Browser.getVersion
    this.browserId = ''; // the id in its /devtools/browser/<id> URL, new per launch
    this.starting = null; // the launch in progress, shared by concurrent callers
    this.stopping = null; // the shutdown in progress, likewise
    this.lastActive = Date.now(); // last time idle.mjs saw it in use
  }

  get running() {
    return this.state === 'running';
  }

  pid() {
    return this.proc?.pid;
  }

  // Resolves once the main browser answers on its pipe. One that is being
  // stopped (still 'running' until it has exited) is waited for and started
  // anew, instead of handing a client a browser on its way out.
  ensure() {
    if (this.running && !this.stopping) return Promise.resolve();
    this.starting ??= (async () => {
      if (this.stopping) await this.stopping;
      if (!this.running) await this.launch();
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  async launch() {
    this.state = 'starting';
    notifyChange();
    const t0 = Date.now();
    let proc;
    try {
      // a crashed run leaves its lock files behind, which chromium refuses
      // to start on (chromium.sh clears them at container start likewise)
      for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
        await fs.rm(path.join(MAIN_PROFILE, name), { force: true });
      }
      const logFile = createWriteStream(MAIN_LOG, { flags: 'a' });
      // for good, not just while it opens: a later error with no listener
      // would take the gateway down (chromium writes to the file itself)
      logFile.on('error', (err) => log(`main browser: ${MAIN_LOG}: ${err.message}`));
      await new Promise((resolve, reject) => {
        logFile.once('open', resolve);
        logFile.once('error', reject);
      });
      logFile.write(`--- ${new Date().toISOString()} main browser started by the CDP gateway ---\n`);
      let pipe;
      ({ proc, pipe } = launchChromium(readFlags(MAIN_FLAGS_FILE), logFile, 'main browser'));
      this.proc = proc;
      this.pipe = pipe;
      // a failed spawn is an 'error' event and no 'exit' (unhandled, it would
      // take the gateway down): the launch below then fails
      proc.on('error', (err) => {
        log(`main browser: ${err.message}`);
        if (!proc.pid && this.proc === proc) {
          this.proc = null;
          logFile.end();
        }
      });
      proc.once('exit', (code, signal) => {
        log(`main browser exited (code=${code} signal=${signal}); the container keeps running without it`);
        killGroup(proc.pid, 'SIGKILL');
        logFile.end();
        if (this.proc === proc) {
          this.proc = null;
          this.pipe = null;
          this.state = 'stopped';
          notifyChange();
        }
      });
      this.version = await browserReady(proc, pipe, STARTUP_TIMEOUT_MS, MAIN_LOG);
      this.browserId = randomUUID();
      this.state = 'running';
      this.lastActive = Date.now();
      notifyChange();
      log(`main browser up (pid ${proc.pid}, ${Date.now() - t0}ms)`);
    } catch (err) {
      log(`main browser start failed: ${err.message}`);
      if (proc) await this.stop();
      this.state = 'stopped';
      notifyChange();
      throw err;
    }
  }

  // Browser.close is chromium's orderly exit, the one closing its last window
  // takes: it commits cookies and the session to the profile first. A
  // SIGTERM exits with code 0 as well but drops what is still in memory
  // (verified: a cookie set seconds before was gone after the restart), so
  // it is only the fallback; the group is killed after a grace period.
  // One shutdown at a time: the console's Stop, an idle tick (every 15 s
  // while Browser.close is still underway) and a failed launch all wait for
  // the same one instead of each sending signals and arming timers of its own.
  stop() {
    this.stopping ??= this.#shutdown().finally(() => { this.stopping = null; });
    return this.stopping;
  }

  async #shutdown() {
    const proc = this.proc;
    if (!proc?.pid || proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = new Promise((resolve) => proc.once('exit', resolve));
    const term = () => {
      try { process.kill(proc.pid, 'SIGTERM'); } catch { /* already gone */ }
    };
    const timers = [setTimeout(term, 5000), setTimeout(() => killGroup(proc.pid, 'SIGKILL'), 15000)];
    const { pipe } = this;
    if (this.running && pipe) {
      // no reply comes when it works: the pipe closes with the browser
      pipe.call('Browser.close').catch(() => { if (!pipe.closed) term(); });
    } else {
      term(); // still starting: nothing to ask yet
    }
    await exited;
    timers.forEach(clearTimeout);
  }
}

export const mainBrowser = new MainBrowser();
