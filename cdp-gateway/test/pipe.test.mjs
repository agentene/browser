// A browser's DevTools pipe and the client connections on it (node --test),
// against a fake chromium on two in-memory streams in place of its fds 3
// and 4. The fake answers the way chromium does: a reply's id first, every
// sessionId last, an attach announced on the parent session before its reply.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { pipeArgs } from '../src/launch.mjs';
import { CLOSED, CdpPipe, OPEN } from '../src/pipe.mjs';
import { listEntry, pickCurrent, versionEntry } from '../src/targets.mjs';

// The fake chromium: what it got (parsed), and an answer per command.
function fakeBrowser() {
  const toChrome = new PassThrough();
  const fromChrome = new PassThrough();
  const got = [];
  let nextSession = 1;
  let nextContext = 1;
  const emit = (msg) => fromChrome.write(`${JSON.stringify(msg)}\0`);
  let buf = '';
  toChrome.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\0')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      got.push(msg);
      const { id, method, params = {}, sessionId } = msg;
      const reply = (result) => emit({ id, result, ...(sessionId ? { sessionId } : {}) });
      if (method === 'Target.attachToBrowserTarget' || method === 'Target.attachToTarget') {
        const child = `S${nextSession++}`;
        emit({ method: 'Target.attachedToTarget', params: { sessionId: child, targetInfo: { targetId: params.targetId ?? 'BROWSER', type: params.targetId ? 'page' : 'browser' } }, ...(sessionId ? { sessionId } : {}) });
        reply({ sessionId: child });
      } else if (method === 'Target.detachFromTarget') {
        emit({ method: 'Target.detachedFromTarget', params: { sessionId: params.sessionId }, ...(sessionId ? { sessionId } : {}) });
        reply({});
      } else if (method === 'Target.createBrowserContext') {
        reply({ browserContextId: `CTX${nextContext++}` });
      } else if (method === 'Fail.me') {
        emit({ id, error: { code: -32000, message: 'nope' }, ...(sessionId ? { sessionId } : {}) });
      } else {
        reply({ echo: method, params });
      }
    }
  });
  const pipe = new CdpPipe(toChrome, fromChrome, 'fake');
  return { pipe, got, emit, fromChrome };
}

// What a connection hands its client, parsed.
function inbox(conn) {
  const msgs = [];
  const waiters = [];
  conn.on('message', (data, isBinary) => {
    assert.equal(isBinary, false);
    assert.ok(Buffer.isBuffer(data));
    const msg = JSON.parse(data.toString());
    const i = waiters.findIndex((w) => w.match(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else msgs.push(msg);
  });
  return (match) => {
    const i = msgs.findIndex(match);
    if (i >= 0) return Promise.resolve(msgs.splice(i, 1)[0]);
    return new Promise((resolve) => waiters.push({ match, resolve }));
  };
}

test('the gateway\'s own commands: results and errors, frames split and joined anyhow', async () => {
  const { pipe, emit, fromChrome } = fakeBrowser();
  assert.deepEqual(await pipe.call('Browser.getVersion'), { echo: 'Browser.getVersion', params: {} });
  await assert.rejects(pipe.call('Fail.me'), /Fail\.me: nope/);
  // two frames in one chunk, one split over three
  const a = pipe.call('X.a');
  const b = pipe.call('X.b');
  await new Promise((resolve) => setImmediate(resolve));
  // the fake answered both already; now some unsolicited root traffic in odd chunks
  emit({ method: 'Target.targetCreated', params: {} });
  fromChrome.write('{"method":"Target.ta');
  fromChrome.write('rgetDestroyed","params":{}}');
  fromChrome.write('\0');
  assert.equal((await a).echo, 'X.a');
  assert.equal((await b).echo, 'X.b');
  pipe.close();
  await assert.rejects(pipe.call('X.c'), /the browser is gone/);
});

test('a connection: its own ids and session both ways, nothing else changed', async () => {
  const { pipe, got } = fakeBrowser();
  const conn = await pipe.connect();
  assert.equal(conn.readyState, OPEN);
  const next = inbox(conn);
  // a client id the pipe has used for something else already
  conn.send({ id: 1, method: 'Runtime.evaluate', params: { expression: '"\\u2603"' } });
  const reply = await next((m) => m.id === 1);
  assert.deepEqual(reply, { id: 1, result: { echo: 'Runtime.evaluate', params: { expression: '"\\u2603"' } } });
  assert.equal(reply.sessionId, undefined, 'its own session is implied');
  const sent = got.at(-1);
  assert.equal(sent.sessionId, conn.session, 'its own session added on the way');
  assert.notEqual(sent.id, 1, 'a pipe-wide id');
  // text frames are parsed too; a non-integer id comes back as it was
  conn.send(Buffer.from('{"id":"x","method":"A.b"}'));
  assert.deepEqual(await next((m) => m.id === 'x'), { id: 'x', result: { echo: 'A.b', params: {} } });
  conn.close();
  assert.equal(conn.readyState, CLOSED);
  pipe.close();
});

test('sessions attached through a connection are its own; nobody else can address them', async () => {
  const { pipe, got } = fakeBrowser();
  const a = await pipe.connect();
  const b = await pipe.connect();
  const nextA = inbox(a);
  const nextB = inbox(b);
  a.send({ id: 1, method: 'Target.attachToTarget', params: { targetId: 'T1', flatten: true } });
  const event = await nextA((m) => m.method === 'Target.attachedToTarget');
  assert.equal(event.sessionId, undefined, 'announced on a\'s own session');
  const child = (await nextA((m) => m.id === 1)).result.sessionId;
  assert.equal(child, event.params.sessionId);
  // a uses it: the session stays on the message
  a.send({ id: 2, sessionId: child, method: 'Runtime.evaluate', params: {} });
  assert.deepEqual(await nextA((m) => m.id === 2), { id: 2, result: { echo: 'Runtime.evaluate', params: {} }, sessionId: child });
  // b may not: answered as chromium answers an unknown session, never sent
  const before = got.length;
  b.send({ id: 3, sessionId: child, method: 'DOM.setFileInputFiles', params: {} });
  assert.deepEqual(await nextB((m) => m.id === 3), { id: 3, error: { code: -32001, message: 'Session with given id not found.' }, sessionId: child });
  b.send({ id: 4, sessionId: a.session, method: 'Browser.close', params: {} });
  assert.equal((await nextB((m) => m.id === 4)).error.code, -32001, 'nor a\'s own session');
  assert.equal(got.length, before);
  // detached: no longer a's either
  a.send({ id: 5, method: 'Target.detachFromTarget', params: { sessionId: child } });
  await nextA((m) => m.id === 5);
  a.send({ id: 6, sessionId: child, method: 'Runtime.evaluate', params: {} });
  assert.equal((await nextA((m) => m.id === 6)).error.code, -32001);
  pipe.close();
});

test('a page connection closes with its target, like the page\'s WebSocket', async () => {
  const { pipe, emit } = fakeBrowser();
  const conn = await pipe.connect({ targetId: 'P1' });
  const closed = once(conn, 'close');
  emit({ method: 'Target.detachedFromTarget', params: { sessionId: conn.session, targetId: 'P1' } });
  await closed;
  assert.equal(conn.readyState, CLOSED);
  pipe.close();
});

test('closing a connection detaches its session and disposes its contexts (disposeOnDetach)', async () => {
  const { pipe, got } = fakeBrowser();
  const conn = await pipe.connect();
  const next = inbox(conn);
  conn.send({ id: 1, method: 'Target.createBrowserContext', params: {} });
  conn.send({ id: 2, method: 'Target.createBrowserContext', params: { disposeOnDetach: false } });
  conn.send({ id: 3, method: 'Target.createBrowserContext', params: {} });
  const [kept, , disposedByClient] = await Promise.all([1, 2, 3].map((id) => next((m) => m.id === id)));
  conn.send({ id: 4, method: 'Target.disposeBrowserContext', params: { browserContextId: disposedByClient.result.browserContextId } });
  await next((m) => m.id === 4);
  const session = conn.session;
  conn.close();
  await new Promise((resolve) => setImmediate(resolve));
  const after = got.slice(-2);
  assert.deepEqual(after.map((m) => [m.method, m.params, m.sessionId]), [
    ['Target.detachFromTarget', { sessionId: session }, undefined],
    ['Target.disposeBrowserContext', { browserContextId: kept.result.browserContextId }, undefined],
  ]);
  pipe.close();
});

test('the browser going away closes every connection', async () => {
  const { pipe } = fakeBrowser();
  const conns = [await pipe.connect(), await pipe.connect({ targetId: 'P1' })];
  const closed = conns.map((c) => once(c, 'close'));
  pipe.close();
  await Promise.all(closed);
  assert.ok(conns.every((c) => c.readyState === CLOSED));
});

test('a connection whose client cannot keep up stops the pipe being read, and lets go', async () => {
  const { pipe, fromChrome } = fakeBrowser();
  const conn = await pipe.connect();
  conn.pause();
  assert.equal(fromChrome.isPaused(), true);
  conn.resume();
  assert.equal(fromChrome.isPaused(), false);
  conn.pause();
  conn.close(); // its client left: nothing waits for it any more
  assert.equal(fromChrome.isPaused(), false);
  pipe.close();
});

test('pipeArgs: the pipe, and navigator.webdriver kept false whatever the flags say', () => {
  assert.deepEqual(pipeArgs(['--a']), ['--a', '--disable-blink-features=AutomationControlled', '--remote-debugging-pipe']);
  // merged into the last occurrence, the one chromium honors
  assert.deepEqual(pipeArgs(['--disable-blink-features=X', '--b', '--disable-blink-features=Y,Z']),
    ['--disable-blink-features=X', '--b', '--disable-blink-features=Y,Z,AutomationControlled', '--remote-debugging-pipe']);
  assert.deepEqual(pipeArgs(['--disable-blink-features=AutomationControlled']),
    ['--disable-blink-features=AutomationControlled', '--remote-debugging-pipe']);
});

test('listEntry / versionEntry: chromium\'s /json shapes on the public host', () => {
  assert.deepEqual(listEntry({ targetId: 'F1', type: 'iframe', title: 't', url: 'https://x/', parentFrameId: 'P1' }, 'h:9222', '@rev'), {
    description: '',
    devtoolsFrontendUrl: 'https://chrome-devtools-frontend.appspot.com/serve_rev/@rev/inspector.html?ws=h:9222/devtools/page/F1',
    id: 'F1',
    parentId: 'P1',
    title: 't',
    type: 'iframe',
    url: 'https://x/',
    webSocketDebuggerUrl: 'ws://h:9222/devtools/page/F1',
  });
  assert.equal(listEntry({ targetId: 'P', type: 'page', title: '', url: '' }, 'h', '@r').parentId, undefined);
  assert.deepEqual(versionEntry({ product: 'Chrome/1', protocolVersion: '1.3', userAgent: 'UA', jsVersion: '9', revision: '@r' }, 'h:9222', 'B1'), {
    Browser: 'Chrome/1',
    'File-Path-Style': 'posix',
    'Protocol-Version': '1.3',
    'User-Agent': 'UA',
    'V8-Version': '9',
    'WebKit-Version': '537.36 (@r)',
    webSocketDebuggerUrl: 'ws://h:9222/devtools/browser/B1',
  });
});

test('pickCurrent: the focused tab; of several, the one that just became so', () => {
  const memo = {};
  assert.equal(pickCurrent(memo, []), null);
  // headed: one tab is visible and focused
  assert.equal(pickCurrent(memo, [['A', 0], ['B', 2], ['C', 1]]), 'B');
  // the user switched tabs
  assert.equal(pickCurrent(memo, [['A', 2], ['B', 0], ['C', 1]]), 'A');
  // headless: every window's front tab counts as focused — the new one wins,
  // and stays current while nothing changes
  assert.equal(pickCurrent(memo, [['A', 2], ['B', 0], ['C', 2]]), 'C');
  assert.equal(pickCurrent(memo, [['A', 2], ['B', 0], ['C', 2]]), 'C');
  // no answers (a dialog open everywhere): the last current stays while it exists
  assert.equal(pickCurrent(memo, [['A', null], ['C', null]]), 'C');
  assert.equal(pickCurrent(memo, [['A', null]]), 'A');
});
