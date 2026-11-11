// /devtools/page/<id>: a client's page WebSocket, joined to a page session
// on the pipe of whichever browser owns the target (pipe.mjs) — what the
// page's own WebSocket on chromium's DevTools port was.

import WebSocket from 'ws';
import { guardFrame } from './client-frame.mjs';
import { forward } from './flow.mjs';
import { log } from './util.mjs';

let relays = 0;

// open relays, for idle.mjs
export function openRelays() {
  return relays;
}

// upstream: an open page connection (pipe.connect({ targetId })). Every
// client frame is checked (client-frame.mjs's guardFrame, the same decision
// as on a browser connection): a Browser.close / Browser.crash, which on a
// page WebSocket ends the whole browser just the same, a command naming
// local files (file-access.mjs), or one opening a CDP channel of its own.
// What passes goes upstream as the command the check read.
export function relay(client, upstream) {
  relays++;
  client.on('message', (raw) => {
    const checked = guardFrame(raw);
    if (checked.notes) for (const note of checked.notes) log(`page relay: ${note}`);
    if (checked.msg) {
      forward(upstream, checked.msg, {}, [client]);
      return;
    }
    if (checked.note) log(`page relay: ${checked.note}`);
    if (checked.answer && client.readyState === WebSocket.OPEN) client.send(JSON.stringify(checked.answer), { binary: false });
    if (checked.close) client.close(); // after the answer; its 'close' takes the upstream down
  });
  upstream.on('message', (data) => {
    if (client.readyState === WebSocket.OPEN) forward(client, data, { binary: false }, [upstream]);
  });
  let closed = false;
  const closeBoth = () => {
    if (closed) return;
    closed = true;
    relays--;
    upstream.close();
    client.terminate();
  };
  upstream.on('close', closeBoth);
  client.on('close', closeBoth);
  client.on('error', closeBoth);
}
