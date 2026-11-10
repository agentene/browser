// Flow control between the WebSockets the gateway joins (relay.mjs, mux.mjs).
//
// ws buffers whatever is sent, without limit: a client that reads slower than
// chromium writes (screenshots, screencasts, traces — up to WS_OPTIONS'
// maxPayload each) would grow the gateway's memory without bound. So once a
// destination has more than HIGH bytes waiting, the WebSockets feeding it are
// paused (no more reads, so TCP pushes back on the sender) until it is down to
// LOW again.

export const HIGH = 32 * 1024 * 1024;
export const LOW = 8 * 1024 * 1024;

const blockers = new WeakMap(); // source WebSocket -> destinations it is paused for

function block(source, dest) {
  let set = blockers.get(source);
  if (!set) blockers.set(source, set = new Set());
  if (set.has(dest)) return;
  set.add(dest);
  if (set.size === 1) source.pause?.();
}

function unblock(source, dest) {
  const set = blockers.get(source);
  if (!set?.delete(dest)) return;
  if (set.size === 0) source.resume?.();
}

// Send data to dest on behalf of sources (the WebSockets whose messages end
// up in dest). The send callback runs once the data is written out — or with
// an error once dest is closed —, so the last one always lifts the pause.
export function forward(dest, data, options, sources) {
  dest.send(data, options, () => {
    if (dest.bufferedAmount > LOW) return;
    for (const source of sources) unblock(source, dest);
  });
  if (dest.bufferedAmount > HIGH) {
    for (const source of sources) block(source, dest);
  }
}
