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
const rawReceived = []; // the frames as they came, for re-serialization checks
const arrivals = []; // [upstream, method, sessionId] across both fake chromiums, in arrival order

// What the fake main answers the list commands with (its "own" targets).
const MAIN_TARGET_INFOS = [{ targetId: 'MT1', type: 'page', url: 'about:main', attached: false, browserContextId: 'MAINCTX' }];

before(async () => {
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  mainUrl = `ws://127.0.0.1:${server.address().port}/devtools/browser/fake`;
  server.on('connection', (ws) => {
    ws.on('message', (data) => {
      rawReceived.push(data.toString());
      const msg = JSON.parse(data.toString());
      received.push(msg);
      arrivals.push(['main', msg.method, msg.sessionId]);
      if (msg.method === 'Target.disposeBrowserContext') {
        ws.send(JSON.stringify({ id: msg.id, error: { code: -32602, message: 'Failed to find context with id' } }));
      } else if (msg.method === 'Target.attachToTarget') {
        ws.send(JSON.stringify({ method: 'Target.attachedToTarget', params: { sessionId: 'S1', targetInfo: { targetId: msg.params.targetId, type: 'page' } } }));
        ws.send(JSON.stringify({ id: msg.id, result: { sessionId: 'S1' } }));
      } else if (msg.method === 'Target.getTargets') {
        ws.send(JSON.stringify({ id: msg.id, result: { targetInfos: MAIN_TARGET_INFOS } }));
      } else if (msg.method === 'Target.getBrowserContexts') {
        ws.send(JSON.stringify({ id: msg.id, result: { browserContextIds: ['MAINCTX'], defaultBrowserContextId: 'MAINDEFAULT' } }));
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
const contextReceived = []; // what the fake context chromium got

// What the fake context answers with: its default context's page, under the
// id the gateway must never let a client see (CTXDEFAULT).
const CTX_TARGET_INFOS = [{ targetId: 'CT1', type: 'page', url: 'about:ctx', attached: true, browserContextId: 'CTXDEFAULT' }];
const CTX_RESULTS = {
  'Target.createBrowserContext': { browserContextId: 'INNER1' },
  'Target.createTarget': { targetId: 'CT1' },
  'Target.attachToBrowserTarget': { sessionId: 'CTXB' },
  'Target.getTargets': { targetInfos: CTX_TARGET_INFOS },
  'Target.getTargetInfo': { targetInfo: CTX_TARGET_INFOS[0] },
};

before(async () => {
  contextServer = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(contextServer, 'listening');
  contextUrl = `ws://127.0.0.1:${contextServer.address().port}/devtools/browser/ctx`;
  contextServer.on('connection', (ws) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      contextReceived.push(msg);
      arrivals.push(['context', msg.method, msg.sessionId]);
      // like chromium: a detach reports the session gone before its reply
      if (msg.method === 'Target.detachFromTarget') {
        ws.send(JSON.stringify({ method: 'Target.detachedFromTarget', params: { sessionId: msg.params.sessionId } }));
      }
      ws.send(JSON.stringify({ id: msg.id, sessionId: msg.sessionId, result: CTX_RESULTS[msg.method] ?? {} }));
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
    assert.match(first.result.browserContextId, /^CONTEXT1/);
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
    assert.deepEqual(internalReply, CTX_RESULTS['Target.getTargets']);
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
    // the alias goes to the context chromium (the field stripped), whose
    // reply ({}) needs no rewriting
    await client.command({ id: 81, method: 'Storage.getCookies', params: { browserContextId } });
    assert.ok(raw.some((d) => Buffer.isBuffer(d) && d.toString() === '{"id":81,"result":{}}'), 'forwarded as it came');
    assert.equal(mux.pending.size, 0);
    const last = contextReceived[contextReceived.length - 1];
    assert.deepEqual(last.params, {}, 'the alias stripped on the way there');
    // one that names a target is parsed and tracked
    await client.command({ id: 82, method: 'Target.createTarget', params: { url: 'about:blank', browserContextId } });
    assert.ok(mux.contextTargets.has('CT1'));
  } finally {
    client.close();
    stub.restore();
  }
});

test('a frame JSON.parse rejects is answered with a parse error, never forwarded', async () => {
  const client = new FakeClient();
  const mux = new Mux(client, 'test', mainUrl);
  try {
    // chromium reads a raw TAB in a string; JSON.parse does not, so the
    // gateway could not have checked it: before the fix this closed the browser
    const reply = client.next((m) => m.error?.code === -32700);
    client.emit('message', Buffer.from('{"id":11,"method":"Browser.close","params":{"a":"\t"}}'));
    assert.match((await reply).error.message, /^JSON: /);
    const notObject = client.next((m) => m.error?.code === -32600);
    client.emit('message', Buffer.from('["Browser.close"]'));
    await notObject;
    // the connection is still there, and nothing of it reached chromium
    assert.deepEqual(await client.command({ id: 12, method: 'Browser.getVersion' }), { id: 12, result: { echo: 'Browser.getVersion' } });
    assert.equal(received.some((m) => m.id === 11), false);
    assert.equal(mux.closed, false);
  } finally {
    client.close();
  }
});

test('file paths outside CDP_FILE_DIRS are refused; download directories redirected', async () => {
  const client = new FakeClient();
  const mux = new Mux(client, 'test', mainUrl);
  try {
    const refused = await client.command({ id: 21, sessionId: 'S9', method: 'DOM.setFileInputFiles', params: { files: ['/browser/settings/auth.json'], nodeId: 3 } });
    assert.equal(refused.sessionId, 'S9');
    assert.match(refused.error.message, /outside CDP_FILE_DIRS/);
    const drop = await client.command({ id: 22, sessionId: 'S9', method: 'Input.dispatchDragEvent', params: { type: 'drop', x: 1, y: 1, data: { items: [], files: ['/proc/1/environ'], dragOperationsMask: 1 } } });
    assert.match(drop.error.message, /outside CDP_FILE_DIRS/);
    assert.equal(received.some((m) => m.id === 21 || m.id === 22), false, 'never reached chromium');
    // Playwright's connectOverCDP: a temp dir of the client machine
    await client.command({ id: 23, method: 'Browser.setDownloadBehavior', params: { behavior: 'allowAndName', downloadPath: '/tmp/playwright-artifacts-x', eventsEnabled: true } });
    assert.equal(received.find((m) => m.id === 23).params.downloadPath, '/browser/downloads');
    // inside the dirs: forwarded (re-serialized: a duplicate key collapses
    // to the value the gateway checked, the last, as JSON.parse reads it)
    const frame = '{"id":24,"sessionId":"S9","method":"DOM.setFileInputFiles","params":{"files":["/etc/passwd"],"files":["/browser/downloads/a.txt"],"nodeId":3}}';
    client.emit('message', Buffer.from(frame));
    await client.next((m) => m.id === 24);
    assert.equal(rawReceived.find((r) => r.includes('"id":24')), '{"id":24,"sessionId":"S9","method":"DOM.setFileInputFiles","params":{"files":["/browser/downloads/a.txt"],"nodeId":3}}');
    // an escaped method name is caught too
    const escaped = client.next((m) => m.id === 25);
    client.emit('message', Buffer.from('{"id":25,"method":"DOM.\\u0073etFileInputFiles","params":{"files":["/etc/passwd"]}}'));
    assert.match((await escaped).error.message, /outside CDP_FILE_DIRS/);
    assert.equal(mux.closed, false);
  } finally {
    client.close();
  }
});

test('a non-object params does not take the gateway down', async () => {
  const client = new FakeClient();
  new Mux(client, 'test', mainUrl);
  try {
    for (const [id, params] of [[31, null], [32, 'x'], [33, 7]]) {
      const reply = await client.command({ id, method: 'Runtime.evaluate', params });
      assert.equal(reply.result.echo, 'Runtime.evaluate');
    }
  } finally {
    client.close();
  }
});

// --- B1–B3: the alias covers results and commands, not just events -----------

// A connection with one isolated context (and a page in it) on the fakes.
async function contextConnection() {
  const stub = stubContexts();
  const client = new FakeClient();
  const mux = new Mux(client, 'test', mainUrl);
  const { result: { browserContextId } } = await client.command({ id: 200, method: 'Target.createBrowserContext', params: {} });
  await client.command({ id: 201, method: 'Target.createTarget', params: { url: 'about:blank', browserContextId } });
  return { stub, client, mux, alias: browserContextId };
}

test('B1: a getTargetInfo result carries the alias, not the context chromium\'s id', async () => {
  const { stub, client, mux, alias } = await contextConnection();
  try {
    const info = await client.command({ id: 210, method: 'Target.getTargetInfo', params: { targetId: 'CT1' } });
    assert.deepEqual(info.result.targetInfo, { targetId: 'CT1', type: 'page', url: 'about:ctx', attached: true, browserContextId: alias });
    assert.ok(mux.contextTargets.has('CT1'));
    // the same for a getTargets answered by the context chromium (addressed
    // by the alias, so the merge does not step in)
    const listed = await client.command({ id: 211, method: 'Target.getTargets', params: { browserContextId: alias } });
    assert.equal(listed.result.targetInfos[0].browserContextId, alias);
  } finally {
    client.close();
    stub.restore();
  }
});

test('B2: getTargets and getBrowserContexts list the isolated context too', async () => {
  const { stub, client, mux, alias } = await contextConnection();
  try {
    const listed = await client.command({ id: 220, method: 'Target.getTargets', params: {} });
    // the main chromium's part unchanged, the context's appended under the alias
    assert.deepEqual(listed.result.targetInfos, [...MAIN_TARGET_INFOS, { targetId: 'CT1', type: 'page', url: 'about:ctx', attached: true, browserContextId: alias }]);
    assert.ok(mux.contextTargets.has('CT1'), 'the merged ids are tracked, so they route back');
    // a second context created inside the context chromium joins the list
    await client.command({ id: 221, method: 'Target.createBrowserContext', params: {} });
    const contexts = await client.command({ id: 222, method: 'Target.getBrowserContexts', params: {} });
    assert.deepEqual(contexts.result.browserContextIds, ['MAINCTX', alias, 'INNER1']);
    assert.equal(contexts.result.defaultBrowserContextId, 'MAINDEFAULT');
  } finally {
    client.close();
    stub.restore();
  }
});

test('B2: a context that dies mid-question does not take the list down with it', async () => {
  const { stub, client, mux, alias } = await contextConnection();
  try {
    const context = mux.context;
    // the context chromium answers nothing any more: its connection is gone
    mux.contextWs.terminate();
    await new Promise((resolve) => setImmediate(resolve));
    const listed = await client.command({ id: 230, method: 'Target.getTargets', params: {} });
    assert.deepEqual(listed.result.targetInfos, MAIN_TARGET_INFOS);
    assert.equal(listed.error, undefined);
    assert.equal(alias.length > 0, true);
  } finally {
    client.close();
    stub.restore();
  }
});

test('B3: a browser-target session addresses the context by the alias', async () => {
  const { stub, client, alias } = await contextConnection();
  try {
    // a browser-target session on main (the client picks its id: MB)
    await client.command({ id: 240, method: 'Target.attachToBrowserTarget', params: {} });
    arrivals.length = 0;
    contextReceived.length = 0;
    const reply = await client.command({ id: 241, sessionId: 'MB', method: 'Storage.getCookies', params: { browserContextId: alias } });
    assert.deepEqual(reply, { id: 241, sessionId: 'MB', result: {} });
    // through the stand-in browser session there, the alias stripped as on a root connection
    assert.deepEqual(arrivals, [
      ['context', 'Target.attachToBrowserTarget', undefined],
      ['context', 'Storage.getCookies', 'CTXB'],
    ]);
    assert.deepEqual(contextReceived.find((m) => m.method === 'Storage.getCookies').params, {});
    // an inner context keeps its id on the way there
    await client.command({ id: 242, method: 'Target.createBrowserContext', params: {} });
    await client.command({ id: 243, sessionId: 'MB', method: 'Storage.getCookies', params: { browserContextId: 'INNER1' } });
    assert.deepEqual(contextReceived.filter((m) => m.method === 'Storage.getCookies').at(-1).params, { browserContextId: 'INNER1' });
  } finally {
    client.close();
    stub.restore();
  }
});

// --- Q3: a detached browser session takes its stand-in down with it ---------

test('Q3: detaching a browser-target session retires its stand-in and both maps', async () => {
  const { stub, client, mux, alias } = await contextConnection();
  try {
    // a stand-in exists once a command on the browser session reached the context
    await client.command({ id: 250, method: 'Target.attachToBrowserTarget', params: {} });
    await client.command({ id: 251, sessionId: 'MB', method: 'Storage.getCookies', params: { browserContextId: alias } });
    assert.equal(mux.browserSessions.size, 1);
    assert.equal(mux.browserSessionOf.size, 1);
    contextReceived.length = 0;
    // the client ends its browser session (Puppeteer's CDPSession.detach)
    assert.equal((await client.command({ id: 252, method: 'Target.detachFromTarget', params: { sessionId: 'MB' } })).id, 252);
    // the command reached the main chromium, which owns the session...
    assert.ok(received.some((m) => m.id === 252 && m.method === 'Target.detachFromTarget'));
    // ...and the stand-in was detached in the context chromium
    assert.ok(contextReceived.some((m) => m.method === 'Target.detachFromTarget' && m.params.sessionId === 'CTXB'));
    // the stand-in's own detach report is swallowed, and the maps forget the
    // pair (the report lands asynchronously)
    const deadline = Date.now() + 500;
    while (mux.browserSessionOf.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(mux.browserSessions.size, 0);
    assert.equal(mux.browserSessionOf.size, 0);
    assert.ok(!client.inbox.some((m) => m.method === 'Target.detachedFromTarget' && m.params?.sessionId === 'CTXB'),
      'the stand-in id never reaches the client');
  } finally {
    client.close();
    stub.restore();
  }
});

test('Q3: nothing accumulates across browser sessions, and a fresh one works', async () => {
  const { stub, client, mux, alias } = await contextConnection();
  try {
    for (let i = 0; i < 3; i++) {
      await client.command({ id: 260 + i * 3, method: 'Target.attachToBrowserTarget', params: {} });
      await client.command({ id: 261 + i * 3, sessionId: 'MB', method: 'Storage.getCookies', params: { browserContextId: alias } });
      await client.command({ id: 262 + i * 3, method: 'Target.detachFromTarget', params: { sessionId: 'MB' } });
      // the stand-in's own detach report lands before the next round starts
      const deadline = Date.now() + 500;
      while (mux.browserSessionOf.size > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(mux.browserSessions.size, 0, `round ${i}`);
      assert.equal(mux.browserSessionOf.size, 0, `round ${i}`);
    }
    // the round-trip still works on a fresh stand-in
    const reply = await client.command({ id: 271, sessionId: 'MB', method: 'Storage.getCookies', params: { browserContextId: alias } });
    assert.deepEqual(reply, { id: 271, sessionId: 'MB', result: {} });
  } finally {
    client.close();
    stub.restore();
  }
});
