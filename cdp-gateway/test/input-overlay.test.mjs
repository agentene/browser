// The input overlay (node --test): the pure helpers, then the whole way from
// a client's Input.* command on a browser's pipe to the ops an overlay page
// gets, against a fake chromium (each test file runs in its own process, so
// the environment set here is the gateway's).

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

process.env.CDP_INPUT_OVERLAY = 'text';
process.env.DISPLAY_BACKEND = 'wayland';

const {
  addOp, keyAction, keyCombo, keyText, overlayState, pointerActions, subscribeOverlay, tabLabel, textOp, toDesktop, viewportGeometry,
} = await import('../src/input-overlay.mjs');
const { CdpPipe } = await import('../src/pipe.mjs');
const { mainBrowser } = await import('../src/main-browser.mjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('keys: text typed, combos pressed, lone modifiers and key-ups say nothing', () => {
  assert.deepEqual(keyAction({ type: 'keyDown', key: 'h', text: 'h' }), { text: 'h' });
  assert.deepEqual(keyAction({ type: 'keyDown', key: 'A', text: 'A', modifiers: 8 }), { text: 'A' }, 'Shift is part of the text');
  assert.deepEqual(keyAction({ type: 'keyDown', key: '世' }), { text: '世' }, 'a keyDown without text types its key');
  assert.deepEqual(keyAction({ type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 }), { combo: 'Ctrl+A', key: 'a' });
  assert.deepEqual(keyAction({ type: 'keyDown', key: 't', modifiers: 2 | 8 }), { combo: 'Ctrl+Shift+T', key: 't' });
  assert.deepEqual(keyAction({ type: 'keyDown', key: 'Enter', text: '\r' }), { combo: 'Enter', key: 'Enter' });
  assert.deepEqual(keyAction({ type: 'rawKeyDown', key: 'Tab', modifiers: 8 }), { combo: 'Shift+Tab', key: 'Tab' });
  assert.deepEqual(keyAction({ type: 'rawKeyDown', key: 'ArrowLeft' }), { combo: '←', key: 'ArrowLeft' });
  assert.deepEqual(keyAction({ type: 'rawKeyDown', key: ' ', modifiers: 2 }), { combo: 'Ctrl+Space', key: ' ' });
  // rawKeyDown + char: the char types
  assert.equal(keyAction({ type: 'rawKeyDown', key: 'x' }), null);
  assert.deepEqual(keyAction({ type: 'char', text: 'x' }), { text: 'x' });
  assert.equal(keyAction({ type: 'keyDown', key: 'Control', modifiers: 2 }), null);
  assert.equal(keyAction({ type: 'keyUp', key: 'a', text: 'a' }), null);
  assert.equal(keyText({ type: 'keyDown', key: 'a', text: 'a', modifiers: 1 }), null, 'Alt+a types nothing here');
  assert.equal(keyCombo({ type: 'keyUp', key: 'Enter' }), null);
});

test('geometry: the viewport fills the window\'s bottom left; page zoom scales CSS pixels', () => {
  // measured: a maximized window on labwc, 88 DIP of browser chrome above the viewport
  const bounds = { left: 0, top: 0, width: 2552, height: 1274 };
  const geo = viewportGeometry(bounds, { w: 2552, h: 1186 }, 1);
  assert.deepEqual(toDesktop(geo, 170, 70), { x: 170, y: 158 });
  const zoomed = viewportGeometry(bounds, { w: 2552 / 1.5, h: 1186 / 1.5 }, 1.5);
  assert.deepEqual(toDesktop(zoomed, 100, 100), { x: 150, y: 238 });
  // a window elsewhere on an X11 screen
  assert.deepEqual(toDesktop(viewportGeometry({ left: 300, top: 50, width: 800, height: 600 }, { w: 800, h: 520 }), 0, 0), { x: 300, y: 130 });
  // an emulated viewport is drawn from the top, below the chrome measured before
  const emulated = viewportGeometry(bounds, { w: 800, h: 600 }, 1, { emulated: true, top: 88 });
  assert.deepEqual(toDesktop(emulated, 10, 10), { x: 10, y: 98 });
});

test('pointer actions of every Input command that points', () => {
  assert.deepEqual(pointerActions('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 2, button: 'right', clickCount: 2 }),
    [{ kind: 'down', x: 1, y: 2, button: 'right', n: 2 }]);
  assert.deepEqual(pointerActions('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 1, y: 2, deltaY: 120 }),
    [{ kind: 'wheel', x: 1, y: 2, dx: 0, dy: 120 }]);
  assert.deepEqual(pointerActions('Input.synthesizeTapGesture', { x: 5, y: 6 }).map((a) => a.kind), ['down', 'up']);
  assert.deepEqual(pointerActions('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 3, y: 4 }] }),
    [{ kind: 'down', x: 3, y: 4, button: 'touch', n: 1 }]);
  assert.deepEqual(pointerActions('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }), []);
  assert.deepEqual(pointerActions('Input.dispatchDragEvent', { type: 'drop', x: 7, y: 8 }), [{ kind: 'up', x: 7, y: 8, button: 'drag', n: 1 }]);
  assert.deepEqual(pointerActions('Input.dispatchKeyEvent', {}), []);
});

test('text ops: the text, a count, or a masked count', () => {
  assert.deepEqual(textOp('hello 世界', { mode: 'text', sensitive: false }), { s: 'hello 世界' });
  assert.deepEqual(textOp('hello 世界', { mode: 'keys', sensitive: false }), { n: 8 });
  assert.deepEqual(textOp('secret', { mode: 'text', sensitive: true }), { n: 6, masked: true });
});

test('a batch: moves replace, wheels add up, text joins — only back to back and per connection', () => {
  const batch = [];
  addOp(batch, { t: 'move', c: 1, b: 'main', x: 1, y: 1 });
  addOp(batch, { t: 'move', c: 1, b: 'main', x: 2, y: 2 });
  addOp(batch, { t: 'move', c: 2, b: 'main', x: 9, y: 9 });
  addOp(batch, { t: 'wheel', c: 1, b: 'main', x: 2, y: 2, dx: 0, dy: 100 });
  addOp(batch, { t: 'wheel', c: 1, b: 'main', x: 3, y: 3, dx: 0, dy: 50 });
  addOp(batch, { t: 'text', c: 1, b: 'main', s: 'he' });
  addOp(batch, { t: 'text', c: 1, b: 'main', s: 'llo' });
  addOp(batch, { t: 'text', c: 1, b: 'main', n: 3, masked: true });
  addOp(batch, { t: 'text', c: 1, b: 'main', n: 2, masked: true });
  addOp(batch, { t: 'text', c: 1, b: 'main', s: 'a', away: 'background' });
  addOp(batch, { t: 'text', c: 1, b: 'main', s: 'b' }); // the tab came to the front: its own op
  assert.deepEqual(batch, [
    { t: 'move', c: 1, b: 'main', x: 2, y: 2 },
    { t: 'move', c: 2, b: 'main', x: 9, y: 9 },
    { t: 'wheel', c: 1, b: 'main', x: 3, y: 3, dx: 0, dy: 150 },
    { t: 'text', c: 1, b: 'main', s: 'hello' },
    { t: 'text', c: 1, b: 'main', n: 5, masked: true },
    { t: 'text', c: 1, b: 'main', s: 'a', away: 'background' },
    { t: 'text', c: 1, b: 'main', s: 'b' },
  ]);
});

test('a tab label: its title, its host when it has none, both when another tab shares the title', () => {
  const infos = [
    { targetId: 'A', type: 'page', title: 'Pull requests', url: 'https://github.com/pulls' },
    { targetId: 'B', type: 'page', title: 'Inbox', url: 'https://mail.example/' },
    { targetId: 'C', type: 'page', title: 'Inbox', url: 'https://other.example/' },
    { targetId: 'D', type: 'page', title: 'example.com/a', url: 'https://example.com/a' },
    { targetId: 'E', type: 'page', title: '', url: 'about:blank' },
    { targetId: 'F', type: 'page', title: 'x'.repeat(50), url: 'https://long.example/' },
    { targetId: 'W', type: 'service_worker', title: 'Inbox', url: 'https://sw.example/' },
  ];
  assert.deepEqual(tabLabel('A', infos), { tab: 'Pull requests' });
  assert.deepEqual(tabLabel('B', infos), { tab: 'Inbox', host: 'mail.example' });
  assert.deepEqual(tabLabel('D', infos), { tab: 'example.com' }); // no title: chromium shows the URL
  assert.deepEqual(tabLabel('E', infos), { tab: 'about:blank' });
  assert.equal(tabLabel('F', infos).tab, `${'x'.repeat(39)}…`);
  assert.deepEqual(tabLabel('Z', infos), {});
});

// A fake chromium on a pipe: attaches announce the target, the window and
// page questions get the measured answers; page.sensitive is what the
// focused field says of itself.
function fakeChromium(page) {
  const toChrome = new PassThrough();
  const fromChrome = new PassThrough();
  const got = [];
  let nextSession = 1;
  const emit = (msg) => fromChrome.write(`${JSON.stringify(msg)}\0`);
  let buf = '';
  toChrome.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\0')) >= 0) {
      const { id, method, params = {}, sessionId } = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      got.push({ method, params, sessionId });
      const on = sessionId ? { sessionId } : {};
      const reply = (result) => emit({ id, result, ...on });
      if (method === 'Target.attachToBrowserTarget' || method === 'Target.attachToTarget') {
        const child = `S${nextSession++}`;
        const targetInfo = { targetId: params.targetId ?? 'BROWSER', type: params.targetId ? 'page' : 'browser' };
        emit({ method: 'Target.attachedToTarget', params: { sessionId: child, targetInfo }, ...on });
        reply({ sessionId: child });
      } else if (method === 'Browser.getWindowForTarget') {
        reply({ windowId: 1, bounds: { left: 0, top: 0, width: 2552, height: 1274, windowState: 'maximized' } });
      } else if (method === 'Page.getLayoutMetrics') {
        reply({ cssVisualViewport: { zoom: 1 }, cssLayoutViewport: { clientWidth: 2552, clientHeight: 1186 } });
      } else if (method === 'Target.getTargets') {
        reply({ targetInfos: [
          { targetId: 'T1', type: 'page', title: page.title ?? 'Inbox', url: 'https://mail.example/' },
          { targetId: 'T2', type: 'page', title: 'Inbox', url: 'https://other.example/' },
        ] });
      } else if (method === 'Runtime.evaluate') {
        reply({ result: { type: 'object', value: { w: 2552, h: 1186, vis: page.vis, sensitive: page.sensitive } } });
      } else {
        reply({});
      }
    }
  });
  return { pipe: new CdpPipe(toChrome, fromChrome, 'fake'), got };
}

// An overlay page's WebSocket, as the gateway sees it.
function fakeViewer() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.bufferedAmount = 0;
  ws.sent = [];
  ws.send = (data) => ws.sent.push(JSON.parse(data));
  ws.ops = () => ws.sent.flatMap((m) => m.ops ?? []);
  ws.close = () => {
    ws.readyState = 3;
    ws.emit('close');
  };
  return ws;
}

// A client's page session on its connection.
async function pageSession(conn, targetId) {
  const attached = new Promise((resolve) => conn.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id === 1) resolve(msg.result.sessionId);
  }));
  conn.send({ id: 1, method: 'Target.attachToTarget', params: { targetId, flatten: true } });
  return attached;
}

test('a client\'s input reaches the overlay as desktop ops; sensitive text is masked; nobody watching, nothing listens', async () => {
  const page = { vis: 'visible', sensitive: false };
  const { pipe, got } = fakeChromium(page);
  mainBrowser.state = 'running';
  mainBrowser.pipe = pipe;
  const conn = await pipe.connect();
  const session = await pageSession(conn, 'T1');

  // no overlay open: the pipe reports nothing, the gateway asks nothing
  assert.equal(pipe.listenerCount('input'), 0);
  conn.send({ id: 2, sessionId: session, method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: 1, y: 1 } });
  await sleep(50);
  assert.equal(got.filter((m) => m.method === 'Runtime.evaluate').length, 0);

  const viewer = fakeViewer();
  subscribeOverlay(viewer);
  assert.deepEqual(viewer.sent[0], { t: 'hello', v: 1, mode: 'text' });
  assert.equal(pipe.listenerCount('input'), 1);

  const input = (id, method, params) => conn.send({ id, sessionId: session, method, params });
  input(3, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 160, y: 60 });
  input(4, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 170, y: 70 });
  input(5, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 170, y: 70, button: 'left', clickCount: 1 });
  input(6, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: 170, y: 70, button: 'left', clickCount: 1 });
  input(7, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'h', text: 'h' });
  input(8, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'h' });
  input(9, 'Input.insertText', { text: 'i 世界' });
  input(10, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', modifiers: 2 });
  await sleep(150);
  const ops = viewer.ops();
  assert.deepEqual(ops.find((op) => op.t === 'screen'), { t: 'screen', w: 2552, h: 1274 });
  const moves = ops.filter((op) => op.t === 'move');
  assert.deepEqual(moves.at(-1), { t: 'move', c: 1, b: 'main', x: 170, y: 158 });
  assert.deepEqual(ops.find((op) => op.t === 'down'), { t: 'down', c: 1, b: 'main', x: 170, y: 158, button: 'left', n: 1 });
  assert.deepEqual(ops.filter((op) => op.t === 'text'), [{ t: 'text', c: 1, b: 'main', s: 'hi 世界' }]);
  assert.deepEqual(ops.filter((op) => op.t === 'key'), [{ t: 'key', c: 1, b: 'main', combo: 'Ctrl+A' }]);
  // the gateway asked through a session of its own, never the client's
  const asked = got.filter((m) => m.method === 'Runtime.evaluate');
  assert.ok(asked.length >= 1);
  assert.ok(asked.every((m) => m.sessionId && m.sessionId !== session));

  // a click moves the focus: the next text asks again, and a password field masks it
  viewer.sent.length = 0;
  page.sensitive = true;
  input(11, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 10, y: 10, button: 'left', clickCount: 1 });
  input(12, 'Input.insertText', { text: 'secret' });
  await sleep(150);
  assert.deepEqual(viewer.ops().filter((op) => op.t === 'text'), [{ t: 'text', c: 1, b: 'main', n: 6, masked: true }]);

  // a background tab: no pointer, one badge
  viewer.sent.length = 0;
  page.vis = 'hidden';
  await sleep(1100); // what the page said holds a second
  input(13, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
  input(14, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 5, button: 'left', clickCount: 1 });
  await sleep(150);
  // (two tabs are titled 'Inbox': the host tells them apart)
  assert.deepEqual(viewer.ops(), [{ t: 'off', c: 1, b: 'main', why: 'background', tab: 'Inbox', host: 'mail.example' }]);

  // keys still show, named as going where the stream does not show them
  viewer.sent.length = 0;
  page.sensitive = false;
  input(15, 'Input.insertText', { text: 'ok' });
  input(16, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
  await sleep(150);
  assert.deepEqual(viewer.ops(), [
    { t: 'text', c: 1, b: 'main', s: 'ok', away: 'background', tab: 'Inbox', host: 'mail.example' },
    { t: 'key', c: 1, b: 'main', combo: 'Enter', away: 'background', tab: 'Inbox', host: 'mail.example' },
  ]);

  // another hidden tab (its title changed): the badge says so again
  viewer.sent.length = 0;
  page.title = 'Drafts';
  await sleep(1100);
  input(17, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 6, y: 6 });
  input(18, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 7, y: 7 });
  await sleep(150);
  assert.deepEqual(viewer.ops(), [{ t: 'off', c: 1, b: 'main', why: 'background', tab: 'Drafts' }]);

  // the client leaves
  viewer.sent.length = 0;
  conn.close();
  await sleep(80);
  assert.deepEqual(viewer.ops(), [{ t: 'bye', c: 1 }]);

  // the last overlay closes: nothing listens, the gateway's sessions are detached
  viewer.close();
  assert.equal(pipe.listenerCount('input'), 0);
  assert.deepEqual(overlayState(), { subscribers: 0, watched: 0, clients: 0 });
  await sleep(20);
  assert.ok(got.some((m) => m.method === 'Target.detachFromTarget' && m.params.sessionId !== session));
  pipe.close();
  mainBrowser.state = 'stopped';
  mainBrowser.pipe = null;
});
