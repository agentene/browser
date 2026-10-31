// WebSocket upgrades:
//   /devtools/browser/<id>  a Mux on the main browser (mux.mjs)
//   /devtools/page/<id>     a relay to the chromium owning the target (relay.mjs)
//   /console/ws             the console's live state (console-live.mjs)

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { targetPort } from './browsers.mjs';
import { MAIN_PORT, WS_OPTIONS } from './config.mjs';
import { consoleDenied, consoleOriginDenied } from './console-auth.mjs';
import { subscribe } from './console-live.mjs';
import { fetchJson } from './devtools-http.mjs';
import { mainBrowser } from './main-browser.mjs';
import { Mux } from './mux.mjs';
import { relay } from './relay.mjs';
import { log } from './util.mjs';

const wss = new WebSocketServer({ noServer: true, ...WS_OPTIONS });

function clientAddress(req) {
  return req.headers['x-real-ip'] || req.socket.remoteAddress;
}

function refuse(socket, status) {
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\n\r\n`);
}

// What the upgrade connects to, or the HTTP status to refuse it with.
async function resolveTarget(req, p) {
  if (p.startsWith('/devtools/browser/')) {
    await mainBrowser.ensure();
    return { kind: 'browser', url: (await fetchJson(MAIN_PORT, '/json/version')).webSocketDebuggerUrl };
  }
  if (p.startsWith('/devtools/page/')) {
    const port = await targetPort(p.slice('/devtools/page/'.length));
    return { kind: 'page', url: `ws://127.0.0.1:${port}${p}` };
  }
  if (p === '/console/ws') {
    const denied = consoleDenied(req) ?? consoleOriginDenied(req);
    return denied ? { refuse: denied[0] } : { kind: 'console' };
  }
  return { refuse: 404 };
}

export async function handleUpgrade(req, socket, head) {
  const p = new URL(req.url, 'http://gateway').pathname;
  let target;
  try {
    target = await resolveTarget(req, p);
  } catch (err) {
    log(`upgrade ${p}: ${err.message}`);
    refuse(socket, 502);
    return;
  }
  if (target.refuse) {
    refuse(socket, target.refuse);
    return;
  }
  wss.handleUpgrade(req, socket, head, (client) => {
    if (target.kind === 'browser') new Mux(client, clientAddress(req), target.url);
    else if (target.kind === 'console') subscribe(client);
    else relay(client, target.url);
  });
}
