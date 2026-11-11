// CHROMIUM_IDLE_TIMEOUT: close the main browser nobody has used for
// IDLE_TIMEOUT_MS. In use: a CDP client connected (browser or page
// WebSocket), an isolated context alive or starting, a Selkies viewer
// connected.

import { readFileSync } from 'node:fs';
import { IDLE_TIMEOUT_MS, VIEWER_SOCKET } from './config.mjs';
import { contexts } from './contexts.mjs';
import { mainBrowser } from './main-browser.mjs';
import { openMuxes } from './mux.mjs';
import { openRelays } from './relay.mjs';
import { log } from './util.mjs';

// Connected streams on a unix socket: the connections its server accepted
// are listed under its path too, in state 03 (connected); the listening
// socket itself is 01. nginx keeps no idle upstream connections, so outside
// a request only a viewer's stream WebSocket is open.
export function connectionsTo(socketPath, table = '/proc/net/unix') {
  let text = '';
  try {
    text = readFileSync(table, 'utf8');
  } catch {
    return 0;
  }
  let n = 0;
  for (const line of text.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields[5] === '03' && fields[7] === socketPath) n++;
  }
  return n;
}

function busy() {
  return openMuxes() > 0 || openRelays() > 0 || contexts.busy
    || (VIEWER_SOCKET !== '' && connectionsTo(VIEWER_SOCKET) > 0);
}

export function watchIdle() {
  if (!IDLE_TIMEOUT_MS) return;
  setInterval(() => {
    if (!mainBrowser.running) return;
    if (busy()) {
      mainBrowser.lastActive = Date.now();
    } else if (Date.now() - mainBrowser.lastActive >= IDLE_TIMEOUT_MS) {
      log(`main browser idle for ${IDLE_TIMEOUT_MS / 60_000} min (no CDP client, context or viewer): closing it`);
      mainBrowser.stop();
    }
  }, Math.min(15_000, IDLE_TIMEOUT_MS / 4)).unref();
}
