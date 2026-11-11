// HTTP requests (WebSocket upgrades: upgrade.mjs).

import { log } from './util.mjs';
import { HttpError, requestPath, send, viaWeb } from './respond.mjs';
import { consoleRoute } from './routes-console.mjs';
import { jsonRoute } from './routes-json.mjs';

export async function handleHttp(req, res) {
  if (requestPath(req) === null) {
    send(res, 400, { error: 'malformed request path' });
    return;
  }
  const url = new URL(req.url, 'http://gateway');
  try {
    if (viaWeb(req) ? await consoleRoute(req, res, url) : await jsonRoute(req, res, url) || await consoleRoute(req, res, url)) return;
    send(res, 404, { error: `not found: ${url.pathname}` });
  } catch (err) {
    log(`HTTP ${req.method} ${url.pathname}: ${err.message}`);
    if (res.headersSent) {
      res.destroy();
    } else if (err instanceof HttpError) {
      send(res, err.status, { error: err.message });
    } else {
      // the details (chromium's answers) stay in the log
      send(res, 502, { error: 'the browser did not answer' });
    }
  }
}
