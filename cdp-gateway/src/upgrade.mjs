// WebSocket upgrades:
//   /devtools/browser/<id>  a Mux on the main browser (mux.mjs)
//   /devtools/page/<id>     a relay to the chromium owning the target (relay.mjs)
//   /console/ws             the console's live state (console-live.mjs)

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { targetPort } from './browsers.mjs';
import { cdpOriginDenied } from './cdp-origin.mjs';
import { MAIN_PORT, WS_OPTIONS } from './config.mjs';
import { consoleDenied, consoleOriginDenied } from './console-auth.mjs';
import { subscribe } from './console-live.mjs';
import { fetchJson } from './devtools-http.mjs';
import { mainBrowser } from './main-browser.mjs';
import { Mux } from './mux.mjs';
import { relay } from './relay.mjs';
import { requestPath, viaWeb } from './respond.mjs';
import { log } from './util.mjs';

const wss = new WebSocketServer({ noServer: true, ...WS_OPTIONS });

function clientAddress(req) {
  return req.headers['x-real-ip'] || req.socket.remoteAddress;
}

function refuse(socket, status) {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

// What the upgrade connects to, or the HTTP status to refuse it with.
async function resolveTarget(req, p) {
  if (p === null) return { refuse: 400 };
  // from the web UI port: the console's WebSocket only (respond.mjs)
  if (viaWeb(req) && p !== '/console/ws') return { refuse: 404 };
  if (p.startsWith('/devtools/')) {
    const denied = cdpOriginDenied(req);
    if (denied) {
      log(`upgrade ${p} from ${clientAddress(req)}: ${denied[1]}`);
      return { refuse: denied[0] };
    }
  }
  if (p.startsWith('/devtools/browser/')) {
    await mainBrowser.ensure();
    return { kind: 'browser', url: (await fetchJson(MAIN_PORT, '/json/version')).webSocketDebuggerUrl };
  }
  if (p.startsWith('/devtools/page/')) {
    const port = await targetPort(p.slice('/devtools/page/'.length));
    return { kind: 'page', url: `ws://127.0.0.1:${port}${p}` };
  }
  if (p === '/console/ws') {
    const denied = (await consoleDenied(req)) ?? consoleOriginDenied(req);
    return denied ? { refuse: denied[0] } : { kind: 'console' };
  }
  return { refuse: 404 };
}

export async function handleUpgrade(req, socket, head) {
  // node's HTTP server drops its own error listener from an upgraded socket,
  // and resolving the target may take a while (an on-demand main browser
  // starts): a connection reset meanwhile would be an unhandled 'error'
  // event, which takes the whole gateway (and so the container) down
  const onError = () => socket.destroy();
  socket.on('error', onError);
  const p = requestPath(req);
  let target;
  try {
    target = await resolveTarget(req, p);
  } catch (err) {
    log(`upgrade ${p}: ${err.message}`);
    target = { refuse: 502 };
  }
  if (target.refuse) {
    refuse(socket, target.refuse);
    return;
  }
  if (socket.destroyed) return; // the client gave up while we waited
  socket.removeListener('error', onError); // ws has its own from here on
  wss.handleUpgrade(req, socket, head, (client) => {
    if (target.kind === 'browser') new Mux(client, clientAddress(req), target.url);
    else if (target.kind === 'console') subscribe(client);
    else relay(client, target.url);
  });
}
