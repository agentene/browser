// Startup and shutdown: the HTTP server on the gateway's loopback port.

import fs from 'node:fs/promises';
import http from 'node:http';
import {
  CHROME_BIN, CONTEXTS_DIR, IDLE_TIMEOUT_MS, LISTEN_PORT, MAIN_AUTOSTART, MAIN_FLAGS_FILE, MAIN_PORT, MAX_CONTEXTS,
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
  server.listen(LISTEN_PORT, '127.0.0.1', () => {
    const idle = IDLE_TIMEOUT_MS ? `, closed after ${IDLE_TIMEOUT_MS / 60_000} idle min` : '';
    log(`listening on 127.0.0.1:${LISTEN_PORT} (main chromium on :${MAIN_PORT}, started ${MAIN_AUTOSTART ? 'now' : 'on demand'}${idle}, max ${MAX_CONTEXTS} contexts, data in ${CONTEXTS_DIR})`);
    // CHROMIUM_AUTOSTART=true: up right away. A failed start is no reason to
    // exit — the next client or the console's Start tries again.
    if (MAIN_AUTOSTART) mainBrowser.ensure().catch(() => { /* logged by launch() */ });
  });

  async function shutdown(signal) {
    log(`${signal}: destroying ${contexts.size} context(s)`);
    server.close();
    await Promise.all(contexts.values().map((s) => s.destroy('gateway shutdown')).concat(mainBrowser.stop()));
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
