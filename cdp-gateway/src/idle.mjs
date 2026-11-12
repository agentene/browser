// CHROMIUM_IDLE_TIMEOUT: close the main browser nobody has used for
// IDLE_TIMEOUT_MS. In use: a CDP client connected (browser or page
// WebSocket), an isolated context alive or starting, a Selkies viewer
// connected.

import { IDLE_TIMEOUT_MS, VIEWER_SOCKET } from './config.mjs';
import { contexts } from './contexts.mjs';
import { mainBrowser } from './main-browser.mjs';
import { openMuxes } from './mux.mjs';
import { openRelays } from './relay.mjs';
import { connectionsTo, log } from './util.mjs';

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
