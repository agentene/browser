// CHROMIUM_IDLE_TIMEOUT: close an on-demand main browser nobody has used for
// IDLE_TIMEOUT_MS. In use: a CDP client connected (browser or page
// WebSocket), an isolated context alive or starting, a Selkies viewer
// connected.

import { readFileSync } from 'node:fs';
import { IDLE_TIMEOUT_MS, VIEWER_PORT } from './config.mjs';
import { contexts } from './contexts.mjs';
import { mainBrowser } from './main-browser.mjs';
import { openMuxes } from './mux.mjs';
import { openRelays } from './relay.mjs';
import { log } from './util.mjs';

// Established TCP connections to a local port (both directions of a loopback
// connection appear; any > 0 is what counts). nginx keeps no idle upstream
// connections, so outside a request only a viewer's stream WebSocket is open.
export function connectionsTo(port, tables = ['/proc/net/tcp', '/proc/net/tcp6']) {
  const hex = `:${port.toString(16).toUpperCase().padStart(4, '0')}`;
  let n = 0;
  for (const file of tables) {
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const [, local, , state] = line.trim().split(/\s+/);
      if (state === '01' && local?.endsWith(hex)) n++;
    }
  }
  return n;
}

function busy() {
  return openMuxes() > 0 || openRelays() > 0 || contexts.busy
    || (VIEWER_PORT > 0 && connectionsTo(VIEWER_PORT) > 0);
}

export function watchIdle() {
  if (!mainBrowser.onDemand || !IDLE_TIMEOUT_MS) return;
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
