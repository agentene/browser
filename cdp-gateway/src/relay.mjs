// /devtools/page/<id>: a plain relay to whichever chromium owns the target.

import WebSocket from 'ws';
import { REFUSED_MESSAGE, browserExitAction, mayEndBrowser } from './browser-exit.mjs';
import { WS_OPTIONS } from './config.mjs';
import { forward } from './flow.mjs';
import { log } from './util.mjs';

let relays = 0;

// open relays, for idle.mjs
export function openRelays() {
  return relays;
}

// A client's Browser.close / Browser.crash on a page WebSocket ends the whole
// browser just the same (browser-exit.mjs): answered here, never forwarded.
// Returns true when the frame was such a command.
function endsBrowser(client, data, isBinary) {
  if (isBinary || !mayEndBrowser(data)) return false;
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    return false;
  }
  const action = browserExitAction(msg.method);
  if (!action) return false;
  const answer = (body) => {
    if (msg.id !== undefined && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ id: msg.id, sessionId: msg.sessionId, ...body }), { binary: false });
    }
  };
  if (action === 'refuse') {
    log(`page relay: ${msg.method} refused`);
    answer({ error: { code: -32000, message: `${msg.method} ${REFUSED_MESSAGE}` } });
  } else {
    log('page relay: Browser.close: closing this client\'s connection, not the shared browser');
    answer({ result: {} });
    client.close(); // after the answer; its 'close' takes the upstream down
  }
  return true;
}

export function relay(client, upstreamUrl) {
  relays++;
  client.once('close', () => { relays--; });
  // nothing is read from the client until the upstream is open (the queue
  // below only holds what was already read)
  client.pause?.();
  const upstream = new WebSocket(upstreamUrl, WS_OPTIONS);
  // what the client sent before the upstream was open; frames keep their
  // type (ws hands text over as a Buffer too, which it would send as binary
  // — and chromium ignores binary frames, so the command would never be
  // answered)
  const queue = [];
  upstream.on('open', () => {
    for (const [data, isBinary] of queue) forward(upstream, data, { binary: isBinary }, [client]);
    queue.length = 0;
    client.resume?.();
  });
  client.on('message', (data, isBinary) => {
    if (endsBrowser(client, data, isBinary)) return;
    if (upstream.readyState === WebSocket.OPEN) forward(upstream, data, { binary: isBinary }, [client]);
    else queue.push([data, isBinary]);
  });
  upstream.on('message', (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) forward(client, data, { binary: isBinary }, [upstream]);
  });
  const closeBoth = () => {
    upstream.terminate();
    client.terminate();
  };
  upstream.on('close', closeBoth);
  client.on('close', closeBoth);
  upstream.on('error', closeBoth);
  client.on('error', closeBoth);
}
