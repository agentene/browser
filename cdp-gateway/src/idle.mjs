// CHROMIUM_IDLE_TIMEOUT: close the main browser nobody has used for
// IDLE_TIMEOUT_MS. In use: a CDP client on it without an isolated context
// (browser WebSocket) or on one of its pages (page WebSocket), a Selkies
// viewer connected — and a client with an isolated context for as long as
// it keeps sending the main browser commands. The isolated contexts do not
// need it (their connections outlive it, mux.mjs).

import { IDLE_TIMEOUT_MS, VIEWER_SOCKET } from './config.mjs';
import { mainBrowser } from './main-browser.mjs';
import { lastMainUse, mainClients } from './mux.mjs';
import { openRelays } from './relay.mjs';
import { connectionsTo, log } from './util.mjs';

function busy() {
  return mainClients() > 0 || openRelays() > 0
    || (VIEWER_SOCKET !== '' && connectionsTo(VIEWER_SOCKET) > 0);
}

export function watchIdle() {
  if (!IDLE_TIMEOUT_MS) return;
  setInterval(() => {
    if (!mainBrowser.running) return;
    if (busy()) {
      mainBrowser.lastActive = Date.now();
    } else if (Date.now() - Math.max(mainBrowser.lastActive, lastMainUse()) >= IDLE_TIMEOUT_MS) {
      log(`main browser idle for ${IDLE_TIMEOUT_MS / 60_000} min (no CDP client using it, no viewer): closing it`);
      mainBrowser.stop();
    }
  }, Math.min(15_000, IDLE_TIMEOUT_MS / 4)).unref();
}
