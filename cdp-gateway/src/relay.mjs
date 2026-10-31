// /devtools/page/<id>: a plain relay to whichever chromium owns the target.

import WebSocket from 'ws';
import { WS_OPTIONS } from './config.mjs';

let relays = 0;

// open relays, for idle.mjs
export function openRelays() {
  return relays;
}

export function relay(client, upstreamUrl) {
  relays++;
  client.once('close', () => { relays--; });
  const upstream = new WebSocket(upstreamUrl, WS_OPTIONS);
  // what the client sent before the upstream was open; frames keep their
  // type (ws hands text over as a Buffer too, which it would send as binary
  // — and chromium ignores binary frames, so the command would never be
  // answered)
  const queue = [];
  upstream.on('open', () => {
    for (const [data, isBinary] of queue) upstream.send(data, { binary: isBinary });
    queue.length = 0;
  });
  client.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    else queue.push([data, isBinary]);
  });
  upstream.on('message', (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
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
