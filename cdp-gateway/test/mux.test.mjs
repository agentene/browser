// Mux pass-through against a fake main chromium (node --test). Isolated
// contexts need a real chromium; the e2e smoke tests in ci.yaml cover those.

import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { after, before, test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { REFUSED_MESSAGE } from '../src/browser-exit.mjs';
import { INTERNAL_ID_BASE } from '../src/config.mjs';
import { contexts } from '../src/contexts.mjs';
import { Mux, openMuxes } from '../src/mux.mjs';

// The fake main browser: answers every command, fails disposals of unknown
// contexts like chromium does, and records what it got.
let server;
let mainUrl;
const received = [];
const arrivals = []; // [upstream, method, sessionId] across both fake chromiums, in arrival order

before(async () => {
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  mainUrl = `ws://127.0.0.1:${server.address().port}/devtools/browser/fake`;
  server.on('connection', (ws) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      received.push(msg);
      arrivals.push(['main', msg.method, msg.sessionId]);
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
  try {
    const attached = client.next((m) => m.method === 'Target.attachedToTarget');
    assert.equal((await client.command({ id: 2, method: 'Target.attachToTarget', params: { targetId: 'T1', flatten: true } })).result.sessionId, 'S1');
    await attached;
    // only context sessions are tracked; anything else is main's
    assert.equal(mux.sessionOwner.size, 0);
    const ev = await client.command({ id: 3, sessionId: 'S1', method: 'Runtime.evaluate', params: { expression: '1' } });
    assert.deepEqual(ev, { id: 3, sessionId: 'S1', result: { echo: 'Runtime.evaluate' } });
  } finally {
    client.close();
  }
});

test('client ids in the gateway\'s own id range still get their replies', async () => {
  const client = new FakeClient();
  new Mux(client, 'test', mainUrl);
  try {
    const id = INTERNAL_ID_BASE + 5;
    assert.deepEqual(await client.command({ id, method: 'Browser.getVersion', params: {} }), { id, result: { echo: 'Browser.getVersion' } });
  } finally {
    client.close();
  }
});

test('main chromium replies are passed on as they came while nothing is awaited', async () => {
  const client = new FakeClient();
  const mux = new Mux(client, 'test', mainUrl);
  try {
    const big = 'x'.repeat(1024 * 1024);
    const reply = await client.command({ id: 8, method: 'Runtime.evaluate', params: { expression: big } });
    assert.deepEqual(reply, { id: 8, result: { echo: 'Runtime.evaluate' } });
    assert.equal(received.find((m) => m.id === 8).params.expression.length, big.length);
    assert.equal(mux.pending.size, 0);
  } finally {
    client.close();
  }
});

// --- isolated contexts, with contexts.create() stubbed: a fake context
// chromium instead of a real one -------------------------------------------
let contextServer;
let contextUrl;
before(async () => {
  contextServer = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(contextServer, 'listening');
  contextUrl = `ws://127.0.0.1:${contextServer.address().port}/devtools/browser/ctx`;
  contextServer.on('connection', (ws) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      arrivals.push(['context', msg.method, msg.sessionId]);
      const result = {
        'Target.createBrowserContext': { browserContextId: 'INNER1' },
        'Target.createTarget': { targetId: 'CT1' },
        'Target.attachToBrowserTarget': { sessionId: 'CTXB' },
      }[msg.method] ?? {};
      ws.send(JSON.stringify({ id: msg.id, sessionId: msg.sessionId, result }));
    });
  });
});
after(() => contextServer.close());

function stubContexts(onCreate = () => {}) {
  const made = [];
  const realCreate = contexts.create;
  contexts.create = async () => {
    const context = {
      name: `context-${made.length + 1}`,
      destroyed: false,
      mux: null,
      browserWsUrl: () => contextUrl,
      async destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.mux?.contextGone(this);
      },
    };
    made.push(context);
    await new Promise((resolve) => setTimeout(resolve, 20)); // a startup takes a while
    onCreate(context);
    return context;
  };
  return { made, restore: () => { contexts.create = realCreate; } };
}

test('concurrent createBrowserContext: one context chromium, the second inside it', async () => {
  const stub = stubContexts();
  const client = new FakeClient();
  new Mux(client, 'test', mainUrl);
  try {
    const [first, second] = await Promise.all([
      client.command({ id: 20, method: 'Target.createBrowserContext', params: {} }),
      client.command({ id: 21, method: 'Target.createBrowserContext', params: {} }),
    ]);
    assert.equal(stub.made.length, 1, 'only one context chromium started');
    assert.match(first.result.browserContextId, /^CONTEXTCONTEXT1/);
    assert.deepEqual(second.result, { browserContextId: 'INNER1' });
  } finally {
    client.close();
    stub.restore();
  }
  assert.equal(stub.made[0].destroyed, true, 'destroyed with its client');
});

test('a client leaving while its context starts leaves no context behind', async () => {
  const client = new FakeClient();
  // the client goes away right after the chromium is up, while the gateway
  // still opens its connection to it
  const stub = stubContexts(() => setImmediate(() => client.close()));
  const mux = new Mux(client, 'test', mainUrl);
  try {
    client.emit('message', Buffer.from(JSON.stringify({ id: 30, method: 'Target.createBrowserContext', params: {} })));
    while (mux.attaching || !stub.made.length) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(stub.made.length, 1);
    assert.equal(stub.made[0].destroyed, true);
    assert.equal(mux.context, null);
  } finally {
    stub.restore();
  }
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

test('Browser.close ends only this client\'s connection; the crash commands are refused', async () => {
  const client = new FakeClient();
  const mux = new Mux(client, 'test', mainUrl);
  await client.command({ id: 40, method: 'Browser.getVersion', params: {} });
  assert.deepEqual(await client.command({ id: 41, method: 'Browser.crash', params: {} }),
    { id: 41, error: { code: -32000, message: `Browser.crash ${REFUSED_MESSAGE}` } });
  assert.equal(mux.closed, false);
  const closed = once(client, 'close');
  // on a browser-target session too
  assert.deepEqual(await client.command({ id: 42, sessionId: 'S9', method: 'Browser.close', params: {} }),
    { id: 42, sessionId: 'S9', result: {} });
  await closed;
  assert.equal(mux.closed, true);
  assert.ok(!received.some((m) => m.method === 'Browser.close' || m.method === 'Browser.crash'), 'never reached chromium');
});

test('a browser-target session keeps its command order while its stand-in opens', async () => {
  const stub = stubContexts();
  const client = new FakeClient();
  new Mux(client, 'test', mainUrl);
  try {
    const { result: { browserContextId } } = await client.command({ id: 50, method: 'Target.createBrowserContext', params: {} });
    await client.command({ id: 51, method: 'Target.createTarget', params: { url: 'about:blank', browserContextId } });
    arrivals.length = 0;
    // MB: a browser-target session on main; the first command addresses the
    // context's target (needs the stand-in), the second one is main's
    const first = client.command({ id: 52, sessionId: 'MB', method: 'Target.attachToTarget', params: { targetId: 'CT1', flatten: true } });
    const second = client.command({ id: 53, sessionId: 'MB', method: 'Runtime.evaluate', params: { expression: '1' } });
    assert.deepEqual(await first, { id: 52, sessionId: 'MB', result: {} });
    await second;
    assert.deepEqual(arrivals, [
      ['context', 'Target.attachToBrowserTarget', undefined],
      ['context', 'Target.attachToTarget', 'CTXB'],
      ['main', 'Runtime.evaluate', 'MB'],
    ]);
  } finally {
    client.close();
    stub.restore();
  }
});

test('an escaped Browser.close is caught all the same', async () => {
  const client = new FakeClient();
  const mux = new Mux(client, 'test', mainUrl);
  await client.command({ id: 60, method: 'Browser.getVersion', params: {} });
  const closed = once(client, 'close');
  client.emit('message', Buffer.from(String.raw`{"id":61,"method":"Browser.close","params":{}}`));
  assert.deepEqual(await client.next((m) => m.id === 61), { id: 61, result: {} });
  await closed;
  assert.equal(mux.closed, true);
  assert.ok(!received.some((m) => m.id === 61), 'never reached chromium');
});

test('an escaped Target.createBrowserContext still gets an isolated context', async () => {
  const stub = stubContexts();
  const client = new FakeClient();
  new Mux(client, 'test', mainUrl);
  try {
    client.emit('message', Buffer.from(String.raw`{"id":62,"method":"Target.createBrowserContext","params":{}}`));
    const reply = await client.next((m) => m.id === 62);
    assert.match(reply.result.browserContextId, /^CONTEXT/);
    assert.equal(stub.made.length, 1);
  } finally {
    client.close();
    stub.restore();
  }
});

test('a client id that is one of the gateway\'s own in flight on the context gets its own reply', async () => {
  const stub = stubContexts();
  const client = new FakeClient();
  const mux = new Mux(client, 'test', mainUrl);
  try {
    const { result: { browserContextId } } = await client.command({ id: 70, method: 'Target.createBrowserContext', params: {} });
    // an internal command of the gateway's, in flight under that id
    const id = mux.nextInternalId;
    let internalReply = null;
    mux.internalSend('context', 'Target.getTargets', {}).then((r) => { internalReply = r; });
    const reply = await client.command({ id, method: 'Target.createTarget', params: { url: 'about:blank', browserContextId } });
    assert.deepEqual(reply, { id, result: { targetId: 'CT1' } });
    while (!internalReply) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(internalReply, {});
    assert.equal(mux.pending.size, 0);
    assert.equal(mux.internal.size, 0);
  } finally {
    client.close();
    stub.restore();
  }
});

test('context replies with nothing to track pass as they came, their bookkeeping done', async () => {
  const stub = stubContexts();
  const client = new FakeClient();
  const mux = new Mux(client, 'test', mainUrl);
  try {
    const { result: { browserContextId } } = await client.command({ id: 80, method: 'Target.createBrowserContext', params: {} });
    const raw = [];
    const toClient = mux.toClient.bind(mux);
    mux.toClient = (data) => { raw.push(data); toClient(data); };
    // the alias goes to the context chromium, whose reply ({}) needs no rewriting
    await client.command({ id: 81, method: 'Target.getTargets', params: { filter: [{}], browserContextId } });
    assert.ok(raw.some((d) => Buffer.isBuffer(d) && d.toString() === '{"id":81,"result":{}}'), 'forwarded as it came');
    assert.equal(mux.pending.size, 0);
    // one that names a target is parsed and tracked
    await client.command({ id: 82, method: 'Target.createTarget', params: { url: 'about:blank', browserContextId } });
    assert.ok(mux.contextTargets.has('CT1'));
  } finally {
    client.close();
    stub.restore();
  }
});
