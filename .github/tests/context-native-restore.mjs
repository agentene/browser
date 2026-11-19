// Native tab selection and session restore with Chrome's default extensions.
// Only the duplicate-tab fixture enables focus emulation.
// Run in a disposable container with ENABLE_AUTH=false and CDP enabled.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const endpoint = process.env.CDP_ENDPOINT;
const consoleEndpoint = process.env.CONSOLE_ENDPOINT;
if (!endpoint || !consoleEndpoint) throw new Error('CDP_ENDPOINT and CONSOLE_ENDPOINT are required');
let slowPath = null;
let delayedRequests = 0;
const fixture = http.createServer(async (req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (req.url === slowPath) {
    slowPath = null;
    delayedRequests++;
    await delay(6500); // Beyond the original five-second identity deadline.
  }
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  res.end(`<script>
    document.title = sessionStorage.getItem('identity') || 'Fixture';
    const key = 'loads:' + location.pathname;
    localStorage.setItem(key, String(Number(localStorage.getItem(key) || 0) + 1));
  </script>`);
});
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${fixture.address().port}`;
const version = await (await fetch(endpoint + '/json/version')).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();
ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data);
  const call = pending.get(msg.id);
  if (!call) return;
  pending.delete(msg.id);
  clearTimeout(call.timer);
  if (msg.error) call.reject(new Error(JSON.stringify(msg.error)));
  else call.resolve(msg.result);
};
ws.onclose = () => {
  for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('CDP connection closed')); }
  pending.clear();
};

function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 30000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

async function listing() {
  const socket = new WebSocket(consoleEndpoint.replace(/^http/, 'ws') + '/console/ws');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('console snapshot timed out')); }, 10000);
    socket.onerror = (err) => { clearTimeout(timer); reject(err); };
    socket.onmessage = ({ data }) => {
      const snapshot = JSON.parse(data).ops?.find((op) => op.t === 'snapshot');
      if (snapshot) { clearTimeout(timer); socket.close(); resolve(snapshot); }
    };
  });
}

// Observe the same incremental feed used by both consoles. A final snapshot
// alone misses a delete/reinsert flicker and the resulting change of order.
async function watchTabs(name) {
  const socket = new WebSocket(consoleEndpoint.replace(/^http/, 'ws') + '/console/ws');
  const ready = Promise.withResolvers();
  const rows = new Map();
  const changes = [];
  let before;
  let current;
  socket.onerror = ready.reject;
  socket.onmessage = ({ data }) => {
    for (const op of JSON.parse(data).ops ?? []) {
      if (op.t === 'snapshot') {
        const card = op.browsers.find((b) => b.name === name);
        if (!card) { ready.reject(new Error('console snapshot missing ' + name)); return; }
        for (const tab of card.tabs) rows.set(tab.id, tab);
        before = [...rows.keys()];
        current = card.current;
        ready.resolve();
      } else if (op.name === name && op.t === 'current') {
        current = op.id;
      } else if (op.name === name && op.t === 'tabs') {
        for (const tab of op.set) rows.set(tab.id, tab);
        for (const id of op.del) rows.delete(id);
        changes.push([...rows.keys()]);
      }
    }
  };
  const timer = setTimeout(() => ready.reject(new Error('console observer timed out')), 10000);
  try { await ready.promise; }
  catch (err) { socket.close(); throw err; }
  finally { clearTimeout(timer); }
  return {
    async expectCurrent(id) {
      for (let i = 0; i < 100 && current !== id; i++) await delay(50);
      assert.equal(current, id, 'the console must select the exact page ID');
      assert.ok(rows.has(id));
    },
    check() {
      for (const ids of changes) assert.deepEqual(ids, before, 'console tab rows/order must remain stable throughout hibernation and wake');
      changes.length = 0;
    },
    close() { socket.close(); },
  };
}

async function evaluate(page, expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, page.sessionId);
  assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}

// A direct page connection bypasses the context session's record of the
// last tab its client activated. Only Chrome knows about this switch.
async function bringPageToFront(id) {
  const ws = new WebSocket(endpoint.replace(/^http/, 'ws') + '/devtools/page/' + id);
  const signal = AbortSignal.timeout(5000);
  try {
    await once(ws, 'open', { signal });
    const reply = once(ws, 'message', { signal });
    ws.send(JSON.stringify({ id: 1, method: 'Page.bringToFront' }));
    const [{ data }] = await reply;
    assert.deepEqual(JSON.parse(data), { id: 1, result: {} });
  } finally { ws.close(); }
}

// Both UIs use this live feed. Keep every renderer artificially focused while
// Chrome switches between pages that are indistinguishable by title and URL.
async function checkDuplicateSelection() {
  const { browserContextId } = await send('Target.createBrowserContext');
  let observer;
  try {
    const pages = [];
    for (let i = 0; i < 2; i++) {
      const { targetId } = await send('Target.createTarget', { browserContextId, url: 'chrome://newtab/', newWindow: i === 0 });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      await send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
      pages.push({ targetId, sessionId });
    }
    const name = (await listing()).browsers.find(b => b.tabs.some(t => t.id === pages[0].targetId)).name;
    observer = await watchTabs(name);
    for (const url of ['chrome://newtab/', origin + '/same']) {
      if (url.startsWith(origin)) {
        for (const page of pages) await send('Page.navigate', { url }, page.sessionId);
      }
      for (let i = 0; ; i++) {
        const infos = await Promise.all(pages.map(p => send('Target.getTargetInfo', { targetId: p.targetId })));
        const [a, b] = infos.map(r => r.targetInfo);
        if (a.title && a.title === b.title && a.url === url && b.url === url) break;
        assert.ok(i < 100, 'both tabs must have the same title and URL');
        await delay(50);
      }
      const focused = await fetch(`${consoleEndpoint}/console/api/${name}/focus/${pages[1].targetId}`, {
        method: 'POST', headers: { 'X-CDP-Console': '1' },
      });
      assert.equal(focused.status, 200, await focused.text());
      await observer.expectCurrent(pages[1].targetId);
      await bringPageToFront(pages[0].targetId);
      await observer.expectCurrent(pages[0].targetId);
      observer.check();
    }

    // Each window now has a selected tab with the same title and URL.
    const { targetId } = await send('Target.createTarget', { browserContextId, url: origin + '/same', newWindow: true });
    await observer.expectCurrent(targetId);
    // Disconnect while both windows are still open. The observer belongs
    // only to the console, and reopening must get the same exact selection.
    const { targetInfos } = await send('Target.getTargets');
    const reader = targetInfos.find(t => t.type === 'other' && t.url === 'chrome://bookmarks/strings.m.js');
    assert.ok(reader, 'the window reader must stay outside the tab strip');
    observer.close();
    for (let i = 0; ; i++) {
      const { targetInfos: remaining } = await send('Target.getTargets');
      if (!remaining.some(t => t.targetId === reader.targetId)) break;
      assert.ok(i < 100, 'closing the last console must release its window reader');
      await delay(50);
    }
    observer = await watchTabs(name);
    await observer.expectCurrent(targetId);
    await send('Target.closeTarget', { targetId });
    await observer.expectCurrent(pages[0].targetId);
    const incognito = (await send('Target.createBrowserContext')).browserContextId;
    try {
      const other = await send('Target.createTarget', { browserContextId: incognito, url: origin + '/same', newWindow: true });
      await observer.expectCurrent(other.targetId);
    } finally { await send('Target.disposeBrowserContext', { browserContextId: incognito }); }
    await observer.expectCurrent(pages[0].targetId);
    console.log('PASS live console IDs for duplicate tabs with focus emulation, multiple windows and incognito');
  } finally {
    observer?.close();
    await send('Target.disposeBrowserContext', { browserContextId });
  }
}

async function checkWindows(titles, windowSize, selections, slow = false) {
  const { browserContextId } = await send('Target.createBrowserContext');
  const pages = [];
  for (const [index, title] of titles.entries()) {
    const { targetId } = await send('Target.createTarget', {
      url: `${origin}/${title}`, browserContextId, newWindow: index % windowSize === 0,
    });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const { windowId } = await send('Browser.getWindowForTarget', { targetId });
    const page = { title, targetId, sessionId, windowId };
    await send('Runtime.enable', {}, sessionId);
    for (let n = 0; ; n++) {
      if (await evaluate(page, `document.readyState === 'complete' && location.pathname === '/${title}'`)) break;
      assert.ok(n < 100, `${title} did not load`);
      await delay(50);
    }
    await evaluate(page, `sessionStorage.setItem('identity', '${title}'); document.title = '${title}';
      history.pushState({}, '', '#first'); history.pushState({}, '', '#second');
      new Promise((resolve) => { addEventListener('popstate', resolve, { once: true }); history.back(); })`);
    await evaluate(page, 'window.volatileState = 42');
    pages.push(page);
  }
  const windows = Map.groupBy(pages, (p) => p.windowId);
  assert.deepEqual([...windows.values()].map((tabs) => tabs.length), [windowSize, windowSize]);
  await send('Storage.setCookies', { browserContextId, cookies: [{ name: 'kept', value: 'yes', url: origin }] });

  const name = (await listing()).browsers.find(b => b.tabs.some(t => t.id === pages[0].targetId)).name;
  const observer = await watchTabs(name);
  try {
    // Exercise both possible selections in both windows. The left window is
    // the global selection; the right window must keep its selection as well.
    for (const [round, selected] of selections.entries()) {
      for (const title of [...selected].reverse()) {
        await send('Target.activateTarget', { targetId: pages.find((p) => p.title === title).targetId });
      }
      const before = [];
      const loads = new Map();
      for (const page of pages) {
        const state = await evaluate(page, "({ visible: document.visibilityState === 'visible', loads: Number(localStorage.getItem('loads:' + location.pathname)) })");
        if (state.visible) before.push(page.title);
        loads.set(page.title, state.loads);
      }
      assert.deepEqual(before, selected, 'fixture must have one selected tab in each window');
      const response = await fetch(`${consoleEndpoint}/console/api/${name}/hibernate`, {
        method: 'POST', headers: { 'X-CDP-Console': '1' },
      });
      assert.equal(response.status, 200, await response.text());
      if (slow && round === 0) slowPath = `/${titles[0]}`;
      const { cookies } = await send('Storage.getCookies', { browserContextId });
      assert.equal(cookies.find((c) => c.name === 'kept')?.value, 'yes');
      assert.equal((await listing()).browsers.find((b) => b.name === name).restoreWarning, '');
      // Identity probes must preserve the selected tab of every window.
      const visible = [];
      for (const page of pages) {
        const state = await evaluate(page, `({
          identity: sessionStorage.getItem('identity'), visible: document.visibilityState,
          url: location.href, volatile: typeof window.volatileState,
          loads: Number(localStorage.getItem('loads:' + location.pathname)),
          markers: Object.keys(sessionStorage).filter((k) => k.startsWith('__agentene_restore_')),
        })`);
        assert.equal(state.identity, page.title);
        assert.equal(state.volatile, 'undefined');
        assert.equal(state.loads, loads.get(page.title) + 1, `${page.title}: restore must load the document once, without a second reload`);
        assert.deepEqual(state.markers, []);
        assert.equal(state.url, `${origin}/${page.title}#first`);
        if (state.visible === 'visible') visible.push(page.title);
        assert.equal((await send('Browser.getWindowForTarget', { targetId: page.targetId })).windowId, page.windowId);
        const history = await send('Page.getNavigationHistory', {}, page.sessionId);
        assert.ok(history.entries[history.currentIndex + 1].url.endsWith('#second'));
      }
      assert.deepEqual(visible, selected, 'native restoration must preserve every window selection');
      observer.check();
      console.log(`PASS native multi-window restore: tabs=${titles.length} selected=${selected.join(',')}; stable console rows/order; one load per document; history, storage and window identity preserved`);
    }
  } finally { observer.close(); }
  await send('Target.disposeBrowserContext', { browserContextId });
  for (let n = 0; ; n++) {
    if (!(await listing()).browsers.some((b) => b.name === name)) break;
    assert.ok(n < 100, 'disposed context was not removed');
    await delay(50);
  }
}

try {
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  await checkDuplicateSelection();
  await checkWindows(['A', 'B', 'C', 'D'], 2, [['A', 'C'], ['A', 'D'], ['B', 'C'], ['B', 'D']], true);
  // More tabs than Chrome eagerly loads after a session restore: all must
  // retain their sessionStorage/history without selecting background tabs.
  const many = Array.from({ length: 24 }, (_, i) => String(i));
  await checkWindows(many, 12, [['0', '23'], ['11', '12']]);
  assert.equal(delayedRequests, 1, 'the slow native navigation must have been exercised');
} finally {
  ws.close();
  fixture.closeAllConnections();
  fixture.close();
}
