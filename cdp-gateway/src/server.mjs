// Startup and shutdown: the HTTP server on the gateway's unix socket.

import fs from 'node:fs/promises';
import http from 'node:http';
import {
  BROWSER_ENABLED, CHROME_BIN, CONTEXTS_DIR, CONTEXTS_OVERFLOW, HIBERNATED_MAX, MAIN_FLAGS_FILE, MAX_CONTEXTS, SOCKET_PATH,
  readFlags,
} from './config.mjs';
import { contexts } from './contexts.mjs';
import { handleHttp } from './http.mjs';
import { mainBrowser } from './main-browser.mjs';
import { probeReflink } from './profile.mjs';
import { handleUpgrade } from './upgrade.mjs';
import { createShutdown } from './shutdown.mjs';
import { closeSettings } from './settings.mjs';
import { log } from './util.mjs';

export async function startGateway() {
  if (BROWSER_ENABLED && !CHROME_BIN) throw new Error('CHROME_BIN is not set');
  if (BROWSER_ENABLED) {
    // fail fast when the entrypoint did not write the flag files
    readFlags();
    readFlags(MAIN_FLAGS_FILE);
    await fs.mkdir(CONTEXTS_DIR, { recursive: true });
    log(`profile clones: ${await probeReflink()}`);
  }

  const sockets = new Set();
  let restartPending = false;
  const restart = () => {
    if (restartPending) return;
    restartPending = true;
    // Let nginx relay the completed 202 before closing its upstream socket.
    setTimeout(() => shutdown('console restart'), 100);
  };
  const server = http.createServer((req, res) => { handleHttp(req, res, restart); });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const shutdown = createShutdown({ server, sockets, contexts, mainBrowser });
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
    await fs.chmod(SOCKET_PATH, 0o666);
    log(`listening on ${SOCKET_PATH} (main browser on demand, max ${MAX_CONTEXTS} running contexts, overflow=${CONTEXTS_OVERFLOW}, max ${HIBERNATED_MAX} sleepers, data in ${CONTEXTS_DIR}; the browsers speak CDP on their pipes only)`);
  });

  process.on('SIGTERM', () => closeSettings().then(() => shutdown('SIGTERM')));
  process.on('SIGINT', () => closeSettings().then(() => shutdown('SIGINT')));
}
