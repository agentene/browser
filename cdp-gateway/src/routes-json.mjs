// /json/*: chromium's DevTools HTTP endpoints, over all browsers, with URLs
// rewritten to the public host:port the client dialed.

import { targetPort } from './browsers.mjs';
import { cdpOriginDenied } from './cdp-origin.mjs';
import { MAIN_PORT } from './config.mjs';
import { contexts } from './contexts.mjs';
import { devtoolsFetch, fetchJson, rewriteHost } from './devtools-http.mjs';
import { mainBrowser } from './main-browser.mjs';
import { publicHost, send } from './respond.mjs';

// Answers the request and returns true if it is one of these routes.
export async function jsonRoute(req, res, url) {
  const p = url.pathname;
  if (!/^\/json(\/|$)/.test(p)) return false;
  const isNew = p === '/json/new' || p === '/json/new/';
  const denied = cdpOriginDenied(req);
  if (denied) {
    send(res, denied[0], { error: denied[1] });
    return true;
  }
  // chromium takes /json/new by PUT only, so that no page can open tabs with
  // a mere <img> or link (and answers a GET with this 405); the gateway calls
  // chromium with PUT itself, so it has to keep that rule
  if (isNew && req.method !== 'PUT') {
    send(res, 405, `Using unsafe HTTP verb ${req.method} to invoke /json/new. This action supports only PUT verb.`, 'text/plain; charset=UTF-8');
    return true;
  }
  const host = publicHost(req);
  // what a CDP client connects with starts an on-demand main browser; mere
  // listings and target lookups do not
  if (/^\/json\/(version|protocol)\/?$/.test(p) || isNew) await mainBrowser.ensure();
  if (p === '/json/version' || p === '/json/version/') {
    send(res, 200, rewriteHost(await fetchJson(MAIN_PORT, '/json/version'), MAIN_PORT, host));
    return true;
  }
  if (['/json', '/json/', '/json/list', '/json/list/'].includes(p)) {
    // all browsers at once; a context shutting down lists nothing
    const lists = await Promise.all([
      mainBrowser.running ? fetchJson(MAIN_PORT, '/json/list').then((l) => rewriteHost(l, MAIN_PORT, host)) : [],
      ...contexts.values().map((c) => fetchJson(c.port, '/json/list').then((l) => rewriteHost(l, c.port, host), () => [])),
    ]);
    send(res, 200, lists.flat());
    return true;
  }
  if (p === '/json/protocol' || p === '/json/protocol/') {
    send(res, 200, await fetchJson(MAIN_PORT, '/json/protocol'));
    return true;
  }
  if (isNew) {
    send(res, 200, rewriteHost(await fetchJson(MAIN_PORT, `/json/new${url.search}`, 'PUT'), MAIN_PORT, host));
    return true;
  }
  const m = p.match(/^\/json\/(activate|close)\/([^/]+)$/);
  if (m) {
    const port = await targetPort(m[2]);
    const r = await devtoolsFetch(port, `/json/${m[1]}/${m[2]}`);
    send(res, r.status, await r.text(), 'text/plain; charset=UTF-8');
    return true;
  }
  return false;
}
