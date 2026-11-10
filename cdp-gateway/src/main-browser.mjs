// The main browser.
//
// By default (CHROMIUM_AUTOSTART=true) the entrypoint supervises the main
// chromium: it is always up, and its exit restarts the container. With
// CHROMIUM_AUTOSTART=false it is this process's child instead, started on
// demand — by the first CDP client (ensure() in http.mjs / upgrade.mjs) or
// the console — from the command line the entrypoint left in
// MAIN_FLAGS_FILE; when it exits the gateway just marks it stopped.

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CdpClient } from './cdp-client.mjs';
import { notifyChange } from './changes.mjs';
import {
  CHROME_BIN, MAIN_FLAGS_FILE, MAIN_LOG, MAIN_ON_DEMAND, MAIN_PORT, MAIN_PROFILE, MAIN_SUPERVISED_PID,
  readFlags,
} from './config.mjs';
import { devtoolsUp, fetchJson } from './devtools-http.mjs';
import { killGroup, log, sleep } from './util.mjs';

class MainBrowser {
  constructor() {
    this.onDemand = MAIN_ON_DEMAND;
    this.state = this.onDemand ? 'stopped' : 'running'; // | 'starting'
    this.proc = null;
    this.starting = null; // the launch in progress, shared by concurrent callers
    this.lastActive = Date.now(); // last time idle.mjs saw it in use
  }

  get running() {
    return this.state === 'running';
  }

  pid() {
    return this.onDemand ? this.proc?.pid : MAIN_SUPERVISED_PID;
  }

  // Resolves once the main browser's DevTools endpoint answers.
  ensure() {
    if (this.running) return Promise.resolve();
    this.starting ??= this.launch().finally(() => { this.starting = null; });
    return this.starting;
  }

  async launch() {
    this.state = 'starting';
    notifyChange();
    const t0 = Date.now();
    let proc;
    try {
      // something else on the fixed DevTools port would be mistaken for it
      if (await devtoolsUp(MAIN_PORT)) {
        throw new Error(`port ${MAIN_PORT} (CDP_INTERNAL_PORT) is already in use`);
      }
      // a crashed run leaves its lock files behind, which chromium refuses
      // to start on (chromium.sh clears them at container start likewise)
      for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
        await fs.rm(path.join(MAIN_PROFILE, name), { force: true });
      }
      const logFile = createWriteStream(MAIN_LOG, { flags: 'a' });
      await new Promise((resolve, reject) => {
        logFile.once('open', resolve);
        logFile.once('error', reject);
      });
      logFile.write(`--- ${new Date().toISOString()} main browser started by the CDP gateway ---\n`);
      proc = spawn(CHROME_BIN, readFlags(MAIN_FLAGS_FILE), {
        detached: true, // own process group: stop() takes renderers down too
        stdio: ['ignore', logFile, logFile],
      });
      this.proc = proc;
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
          this.state = 'stopped';
          notifyChange();
        }
      });
      for (let i = 0; i < 150; i++) {
        if (this.proc !== proc) throw new Error(`main chromium exited during startup, see ${MAIN_LOG}`);
        if (await devtoolsUp(MAIN_PORT)) {
          this.state = 'running';
          this.lastActive = Date.now();
          notifyChange();
          log(`main browser up on 127.0.0.1:${MAIN_PORT} (pid ${proc.pid}, ${Date.now() - t0}ms)`);
          return;
        }
        await sleep(100);
      }
      throw new Error(`main chromium did not open its DevTools port ${MAIN_PORT} within 15s, see ${MAIN_LOG}`);
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
  async stop() {
    const proc = this.proc;
    if (!proc?.pid || proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = new Promise((resolve) => proc.once('exit', resolve));
    const term = () => {
      try { process.kill(proc.pid, 'SIGTERM'); } catch { /* already gone */ }
    };
    const timers = [setTimeout(term, 5000), setTimeout(() => killGroup(proc.pid, 'SIGKILL'), 15000)];
    if (this.running) {
      fetchJson(MAIN_PORT, '/json/version')
        .then((v) => CdpClient.connect(v.webSocketDebuggerUrl))
        .then((cdp) => cdp.send('Browser.close').catch(() => { /* the connection dies with it */ }))
        .catch(term);
    } else {
      term(); // still starting: no DevTools to ask yet
    }
    await exited;
    timers.forEach(clearTimeout);
  }
}

export const mainBrowser = new MainBrowser();
