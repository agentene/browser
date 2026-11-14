// Startup and shutdown: the HTTP server on the gateway's unix socket.

import fs from 'node:fs/promises';
import http from 'node:http';
import {
  CHROME_BIN, CONTEXTS_DIR, CONTEXTS_OVERFLOW, HIBERNATED_MAX, IDLE_TIMEOUT_MS, MAIN_AUTOSTART, MAIN_FLAGS_FILE, MAX_CONTEXTS, SOCKET_PATH,
  readFlags,
} from './config.mjs';
import { contexts } from './contexts.mjs';
import { handleHttp } from './http.mjs';
import { watchIdle } from './idle.mjs';
import { mainBrowser } from './main-browser.mjs';
import { probeReflink } from './profile.mjs';
import { handleUpgrade } from './upgrade.mjs';
import { log } from './util.mjs';

export async function startGateway() {
  if (!CHROME_BIN) throw new Error('CHROME_BIN is not set');
  // fail fast when the entrypoint did not write the flag files
  readFlags();
  readFlags(MAIN_FLAGS_FILE);
  await fs.mkdir(CONTEXTS_DIR, { recursive: true });
  log(`profile clones: ${await probeReflink()}`);

  const server = http.createServer((req, res) => {
    handleHttp(req, res);
  });
  watchIdle();
  server.on('upgrade', (req, socket, head) => {
    handleUpgrade(req, socket, head);
  });
  // A unix socket, not a loopback port: a page in the browser can open any
  // loopback port's origin, and nginx — the only public front door — is
  // the one meant to reach the gateway (pipe.mjs). Connectable by everyone
  // who can reach the directory (the entrypoint's, see config.sh): with
  // RUN_USER=0 the nginx workers are nobody, not the gateway's root.
  await fs.rm(SOCKET_PATH, { force: true });
  server.listen(SOCKET_PATH, async () => {
    // CHROMIUM_AUTOSTART=true: up right away — 'starting' before the socket
    // is opened to anyone, so the entrypoint's /json/version wait (and an
    // early client) waits for it instead of being answered for a stopped
    // browser. A failed start is no reason to exit — the next client or the
    // console's Start tries again.
    if (MAIN_AUTOSTART) mainBrowser.ensure().catch(() => { /* logged by launch() */ });
    await fs.chmod(SOCKET_PATH, 0o666);
    const idle = IDLE_TIMEOUT_MS ? `, closed after ${IDLE_TIMEOUT_MS / 60_000} idle min` : '';
    log(`listening on ${SOCKET_PATH} (main browser started ${MAIN_AUTOSTART ? 'now' : 'when a client uses it'}${idle}, max ${MAX_CONTEXTS} running contexts, overflow=${CONTEXTS_OVERFLOW}, max ${HIBERNATED_MAX} sleepers, data in ${CONTEXTS_DIR}; the browsers speak CDP on their pipes only)`);
  });

  async function shutdown(signal) {
    contexts.close(); // queued creation/wake requests must not spawn after shutdown starts
    log(`${signal}: destroying ${contexts.size} context(s)`);
    server.close();
    await Promise.all(contexts.values().map((s) => s.destroy('gateway shutdown')).concat(mainBrowser.stop()));
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
