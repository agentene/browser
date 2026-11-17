// One browser manager, with separate CDP and console Unix listeners.

import fs from 'node:fs/promises';
import http from 'node:http';
import {
  BROWSER_ENABLED, CDP_SOCKET_PATH, CHROME_BIN, CONSOLE_SOCKET_PATH, CONTEXTS_DIR, CONTEXTS_OVERFLOW, HIBERNATED_MAX, MAIN_FLAGS_FILE, MAX_CONTEXTS,
  readFlags,
} from './config.mjs';
import { contexts } from './contexts.mjs';
import { handleCdpHttp, handleConsoleHttp } from './http.mjs';
import { listenAll } from './listeners.mjs';
import { mainBrowser } from './main-browser.mjs';
import { probeReflink } from './profile.mjs';
import { handleCdpUpgrade, handleConsoleUpgrade } from './upgrade.mjs';
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
  const consoleServer = http.createServer((req, res) => { handleConsoleHttp(req, res, restart); });
  consoleServer.on('upgrade', handleConsoleUpgrade);
  const listeners = [{ server: consoleServer, path: CONSOLE_SOCKET_PATH }];
  if (BROWSER_ENABLED) {
    const cdpServer = http.createServer(handleCdpHttp);
    cdpServer.on('upgrade', handleCdpUpgrade);
    listeners.push({ server: cdpServer, path: CDP_SOCKET_PATH });
  }
  const servers = listeners.map(({ server }) => server);
  for (const server of servers) {
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
  }
  const shutdown = createShutdown({ servers, sockets, contexts, mainBrowser });
  await listenAll(listeners, sockets);
  log(`listening on ${listeners.map(({ path }) => path).join(', ')} (main browser on demand, max ${MAX_CONTEXTS} running contexts, overflow=${CONTEXTS_OVERFLOW}, max ${HIBERNATED_MAX} sleepers, data in ${CONTEXTS_DIR}; the browsers speak CDP on their pipes only)`);

  process.on('SIGTERM', () => closeSettings().then(() => shutdown('SIGTERM')));
  process.on('SIGINT', () => closeSettings().then(() => shutdown('SIGINT')));
}
