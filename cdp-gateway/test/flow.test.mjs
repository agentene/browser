// Flow control between joined WebSockets (node --test).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HIGH, LOW, forward } from '../src/flow.mjs';

// A WebSocket as flow.mjs sees it: bufferedAmount, send(data, opts, cb),
// pause() / resume().
class FakeWs {
  bufferedAmount = 0;
  paused = false;
  callbacks = [];

  send(data, opts, cb) {
    this.bufferedAmount += data.length;
    this.callbacks.push([data.length, cb]);
  }

  // the oldest send is written out
  drainOne() {
    const [size, cb] = this.callbacks.shift();
    this.bufferedAmount -= size;
    cb();
  }

  pause() { this.paused = true; }

  resume() { this.paused = false; }
}

test('sources pause above HIGH and resume once the destination is down to LOW', () => {
  const dest = new FakeWs();
  const src = new FakeWs();
  const chunk = 'x'.repeat(8 * 1024 * 1024);
  for (let sent = 0; sent <= HIGH; sent += chunk.length) forward(dest, chunk, {}, [src]);
  assert.equal(src.paused, true);
  while (dest.bufferedAmount > LOW) {
    assert.equal(src.paused, true);
    dest.drainOne();
  }
  assert.equal(src.paused, false);
  while (dest.callbacks.length) dest.drainOne();
  assert.equal(src.paused, false);
});

test('a source feeding two blocked destinations resumes only when both drained', () => {
  const a = new FakeWs();
  const b = new FakeWs();
  const src = new FakeWs();
  const big = 'x'.repeat(HIGH + 1);
  forward(a, big, {}, [src]);
  forward(b, big, {}, [src]);
  assert.equal(src.paused, true);
  a.drainOne();
  assert.equal(src.paused, true, 'b is still full');
  b.drainOne();
  assert.equal(src.paused, false);
});

test('small traffic never pauses anything', () => {
  const dest = new FakeWs();
  const src = new FakeWs();
  for (let i = 0; i < 100; i++) forward(dest, '{"id":1}', {}, [src]);
  assert.equal(src.paused, false);
});
