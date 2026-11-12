// Screencast pacing: acks and sent frames (node --test).

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mock, test } from 'node:test';
import { ACK_LEAD_MS, Screencast } from '../src/screencast.mjs';

// A page connection as CdpClient sees it; answers every command at once.
class FakeConn extends EventEmitter {
  readyState = 1;
  acks = [];

  send(msg) {
    if (msg.method === 'Page.screencastFrameAck') this.acks.push(Date.now());
    queueMicrotask(() => this.emit('message', JSON.stringify({ id: msg.id, result: {} })));
  }

  close() { this.readyState = 3; }

  frame(data) {
    this.emit('message', JSON.stringify({ method: 'Page.screencastFrame', params: { data, sessionId: 1 } }));
  }
}

const settle = () => new Promise(setImmediate);

// mock.timers.tick(ms) moves the clock before it runs the timers due: small
// steps keep the times the timers see close to their own
function advance(ms, each = () => {}) {
  for (let t = 0; t < ms; t += 10) {
    mock.timers.tick(10);
    each();
  }
}

async function setup(every) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const conn = new FakeConn();
  const sent = [];
  const cast = new Screencast({ connect: async () => conn }, 'T', {
    interval: () => every.value,
    onFrame: (jpeg) => { sent.push([Date.now(), jpeg]); },
    onEnd: () => {},
  });
  await settle();
  return { conn, sent, cast };
}

test('a repainting page gets one ack, and one frame encoded, per interval', async (t) => {
  t.after(() => mock.timers.reset());
  const every = { value: 2000 };
  const { conn, sent, cast } = await setup(every);
  const start = Date.now();
  // chromium: two frames in flight, a new one right after every ack
  conn.frame('f0');
  conn.frame('f1');
  let n = 2;
  let acked = 0;
  advance(20000, () => {
    while (conn.acks.length > acked) {
      acked++;
      conn.frame(`f${n++}`);
    }
  });
  cast.close();
  assert.equal(sent[0][1], 'f1'); assert.ok(sent[0][0] - start <= 10); // the latest of the first burst goes at once
  assert.ok(sent.length >= 9 && sent.length <= 11, `sent ${sent.length}`);
  assert.ok(n - sent.length <= 2, `encoded ${n}, sent ${sent.length}`);
  for (const [i, at] of conn.acks.entries()) {
    if (i) assert.ok(at - conn.acks[i - 1] >= every.value);
  }
  // each sent frame after the first was asked for ACK_LEAD_MS before it went
  for (const [at] of sent.slice(1)) {
    assert.ok(conn.acks.some((a) => at - a >= 0 && at - a <= ACK_LEAD_MS), `frame at ${at - start}`);
  }
});

test('a page that stops repainting has its frames acked and is left alone', async (t) => {
  t.after(() => mock.timers.reset());
  const every = { value: 2000 };
  const { conn, sent, cast } = await setup(every);
  conn.frame('a');
  conn.frame('b');
  advance(60000);
  cast.close();
  assert.deepEqual(sent.map(([, j]) => j), ['b']); // the latest of a burst
  assert.equal(conn.acks.length, 2); // chromium has its slots back for the next repaint
});

test('coming to the front pulls a waiting ack in', async (t) => {
  t.after(() => mock.timers.reset());
  const every = { value: 20000 };
  const { conn, cast } = await setup(every);
  conn.frame('a');
  advance(1000);
  assert.equal(conn.acks.length, 0);
  every.value = 2000;
  cast.reschedule();
  advance(1000);
  cast.close();
  assert.equal(conn.acks.length, 1);
});
