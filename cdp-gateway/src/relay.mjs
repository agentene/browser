// /devtools/page/<id>: a plain relay to whichever chromium owns the target.

import WebSocket from 'ws';
import { answerFor, guardCommand, needsGuard, parseCommand } from './client-frame.mjs';
import { WS_OPTIONS } from './config.mjs';
import { forward } from './flow.mjs';
import { log } from './util.mjs';

let relays = 0;

// open relays, for idle.mjs
export function openRelays() {
  return relays;
}

// A client frame the gateway has to check (client-frame.mjs): a
// Browser.close / Browser.crash, which on a page WebSocket ends the whole
// browser just the same (browser-exit.mjs), or a command naming local files
// (file-access.mjs). Returns what goes upstream instead of the frame: the
// re-serialized command, or null when the gateway answered it itself.
// Binary frames go as they came: chromium executes none (it drops the
// connection on one).
function guardFrame(client, data, isBinary) {
  if (isBinary || !needsGuard(data)) return data;
  const parsed = parseCommand(data);
  let answer = parsed.answer;
  let close = false;
  if (parsed.msg) {
    const guarded = guardCommand(parsed.msg);
    if (guarded.msg) {
      for (const note of guarded.notes) log(`page relay: ${note}`);
      return JSON.stringify(guarded.msg);
    }
    log(`page relay: ${guarded.note}`);
    ({ close } = guarded);
    if (parsed.msg.id === undefined) answer = null;
    else answer = answerFor(parsed.msg, guarded.answer);
  }
  if (answer && client.readyState === WebSocket.OPEN) client.send(JSON.stringify(answer), { binary: false });
  if (close) client.close(); // after the answer; its 'close' takes the upstream down
  return null;
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
  client.on('message', (raw, isBinary) => {
    const data = guardFrame(client, raw, isBinary);
    if (data === null) return;
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
