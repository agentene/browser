// HTTP requests (WebSocket upgrades: upgrade.mjs).

import { log } from './util.mjs';
import { HttpError, requestPath, send } from './respond.mjs';
import { consoleRoute } from './routes-console.mjs';
import { jsonRoute } from './routes-json.mjs';
import { withRequestLanguage } from './language.mjs';

export function handleCdpHttp(req, res) {
  return withRequestLanguage(req.headers['accept-language'], () => handleRequest(req, res, jsonRoute));
}

export function handleConsoleHttp(req, res, restart) {
  return withRequestLanguage(req.headers['accept-language'], () => handleRequest(req, res, consoleRoute, restart));
}

async function handleRequest(req, res, route, restart) {
  if (requestPath(req) === null) {
    send(res, 400, { error: 'malformed request path' });
    return;
  }
  const url = new URL(req.url, 'http://gateway');
  try {
    if (await route(req, res, url, restart)) return;
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
