// HTTP requests (WebSocket upgrades: upgrade.mjs).

import { log } from './util.mjs';
import { send } from './respond.mjs';
import { consoleRoute } from './routes-console.mjs';
import { jsonRoute } from './routes-json.mjs';

export async function handleHttp(req, res) {
  const url = new URL(req.url, 'http://gateway');
  try {
    if (await jsonRoute(req, res, url) || await consoleRoute(req, res, url)) return;
    send(res, 404, { error: `not found: ${url.pathname}` });
  } catch (err) {
    log(`HTTP ${req.method} ${url.pathname}: ${err.message}`);
    send(res, 502, { error: err.message });
  }
}
