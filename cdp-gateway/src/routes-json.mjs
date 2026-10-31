// /json/*: chromium's DevTools HTTP endpoints, over all browsers, with URLs
// rewritten to the public host:port the client dialed.

import { targetPort } from './browsers.mjs';
import { MAIN_PORT } from './config.mjs';
import { contexts } from './contexts.mjs';
import { fetchJson, rewriteHost } from './devtools-http.mjs';
import { mainBrowser } from './main-browser.mjs';
import { publicHost, send } from './respond.mjs';

// Answers the request and returns true if it is one of these routes.
export async function jsonRoute(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith('/json')) return false;
  const host = publicHost(req);
  // what a CDP client connects with starts an on-demand main browser; mere
  // listings and target lookups do not
  if (/^\/json\/(version|protocol)\/?$/.test(p) || p.startsWith('/json/new')) await mainBrowser.ensure();
  if (p === '/json/version' || p === '/json/version/') {
    send(res, 200, rewriteHost(await fetchJson(MAIN_PORT, '/json/version'), MAIN_PORT, host));
    return true;
  }
  if (['/json', '/json/', '/json/list', '/json/list/'].includes(p)) {
    let list = mainBrowser.running ? rewriteHost(await fetchJson(MAIN_PORT, '/json/list'), MAIN_PORT, host) : [];
    for (const s of contexts.values()) {
      try {
        list = list.concat(rewriteHost(await fetchJson(s.port, '/json/list'), s.port, host));
      } catch { /* context shutting down */ }
    }
    send(res, 200, list);
    return true;
  }
  if (p === '/json/protocol' || p === '/json/protocol/') {
    send(res, 200, await fetchJson(MAIN_PORT, '/json/protocol'));
    return true;
  }
  if (p.startsWith('/json/new')) {
    send(res, 200, rewriteHost(await fetchJson(MAIN_PORT, `/json/new${url.search}`, 'PUT'), MAIN_PORT, host));
    return true;
  }
  const m = p.match(/^\/json\/(activate|close)\/([^/]+)$/);
  if (m) {
    const port = await targetPort(m[2]);
    const r = await fetch(`http://127.0.0.1:${port}/json/${m[1]}/${m[2]}`);
    send(res, r.status, await r.text(), 'text/plain; charset=UTF-8');
    return true;
  }
  return false;
}
