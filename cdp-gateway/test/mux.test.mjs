// Mux pass-through against a fake main chromium (node --test). Isolated
// contexts need a real chromium; the e2e smoke tests in ci.yaml cover those.

import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { after, before, test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { Mux, openMuxes } from '../src/mux.mjs';

// The fake main browser: answers every command, fails disposals of unknown
// contexts like chromium does, and records what it got.
let server;
let mainUrl;
const received = [];

before(async () => {
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  mainUrl = `ws://127.0.0.1:${server.address().port}/devtools/browser/fake`;
  server.on('connection', (ws) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      received.push(msg);
      if (msg.method === 'Target.disposeBrowserContext') {
        ws.send(JSON.stringify({ id: msg.id, error: { code: -32602, message: 'Failed to find context with id' } }));
      } else if (msg.method === 'Target.attachToTarget') {
        ws.send(JSON.stringify({ method: 'Target.attachedToTarget', params: { sessionId: 'S1', targetInfo: { targetId: msg.params.targetId, type: 'page' } } }));
        ws.send(JSON.stringify({ id: msg.id, result: { sessionId: 'S1' } }));
      } else {
        ws.send(JSON.stringify({ id: msg.id, sessionId: msg.sessionId, result: { echo: msg.method } }));
      }
    });
  });
});

after(() => server.close());

// A client WebSocket as the Mux sees it.
class FakeClient extends EventEmitter {
  readyState = WebSocket.OPEN;
  inbox = [];
  waiters = [];

  send(text) {
    const msg = JSON.parse(text);
    const i = this.waiters.findIndex((w) => w.match(msg));
    if (i >= 0) this.waiters.splice(i, 1)[0].resolve(msg);
    else this.inbox.push(msg);
  }

  next(match) {
    const i = this.inbox.findIndex(match);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]);
    return new Promise((resolve) => this.waiters.push({ match, resolve }));
  }

  command(msg) {
    this.emit('message', Buffer.from(JSON.stringify(msg)));
    return this.next((m) => m.id === msg.id);
  }

  close() {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
}

test('default-context traffic passes through verbatim, queued until the upstream is open', async () => {
  const client = new FakeClient();
  const mux = new Mux(client, 'test', mainUrl);
  assert.equal(mux.queue.length, 0);
  const reply = client.command({ id: 1, method: 'Browser.getVersion', params: {} });
  assert.equal(mux.queue.length, 1, 'queued before open');
  assert.deepEqual(await reply, { id: 1, result: { echo: 'Browser.getVersion' } });
  const sent = received.find((m) => m.id === 1);
  assert.deepEqual(sent, { id: 1, method: 'Browser.getVersion', params: {} });
  client.close();
});

test('sessions attached on main stay on main', async () => {
  const client = new FakeClient();
  const mux = new Mux(client, 'test', mainUrl);
  const attached = client.next((m) => m.method === 'Target.attachedToTarget');
  assert.equal((await client.command({ id: 2, method: 'Target.attachToTarget', params: { targetId: 'T1', flatten: true } })).result.sessionId, 'S1');
  await attached;
  assert.equal(mux.sessionOwner.get('S1'), 'main');
  const ev = await client.command({ id: 3, sessionId: 'S1', method: 'Runtime.evaluate', params: { expression: '1' } });
  assert.deepEqual(ev, { id: 3, sessionId: 'S1', result: { echo: 'Runtime.evaluate' } });
  client.close();
});

test('disposing an unknown context succeeds instead of failing', async () => {
  const client = new FakeClient();
  new Mux(client, 'test', mainUrl);
  assert.deepEqual(await client.command({ id: 4, method: 'Target.disposeBrowserContext', params: { browserContextId: 'GONE' } }), { id: 4, result: {} });
  client.close();
});

test('setAutoAttach / setDiscoverTargets are remembered for a later context', async () => {
  const client = new FakeClient();
  const mux = new Mux(client, 'test', mainUrl);
  const auto = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };
  await client.command({ id: 5, method: 'Target.setAutoAttach', params: auto });
  await client.command({ id: 6, method: 'Target.setDiscoverTargets', params: { discover: true } });
  assert.deepEqual(mux.autoAttach, auto);
  assert.deepEqual(mux.discover, { discover: true });
  client.close();
});

test('a closed client closes its mux and the upstream connection', async () => {
  const client = new FakeClient();
  const before = openMuxes();
  const mux = new Mux(client, 'test', mainUrl);
  assert.equal(openMuxes(), before + 1);
  await client.command({ id: 7, method: 'Browser.getVersion', params: {} });
  const upstreamGone = once(mux.main, 'close');
  client.close();
  await upstreamGone;
  assert.equal(mux.closed, true);
  assert.equal(openMuxes(), before);
});
