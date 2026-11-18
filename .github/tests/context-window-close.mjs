// Run inside a disposable desktop container, with auth disabled and the same
// test-only Playwright installation as context-hibernation.mjs. Use the window
// manager's close request, just like Selkies' title-bar button (not Browser.close).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const endpoint = process.env.CDP_ENDPOINT;
const consoleEndpoint = process.env.CONSOLE_ENDPOINT;
const { chromium } = createRequire(process.env.PLAYWRIGHT_CLI_JS)('playwright');
const run = promisify(execFile);
const headers = { 'X-CDP-Console': '1' };

async function action(route, method = 'POST') {
  const response = await fetch(`${consoleEndpoint}/console/api/${route}`, { method, headers });
  const body = await response.json();
  assert.ok(response.ok, JSON.stringify(body));
  return body;
}

async function listing() {
  const ws = new WebSocket(consoleEndpoint.replace(/^http/, 'ws') + '/console/ws');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('console snapshot timed out')); }, 10000);
    ws.onerror = (err) => { clearTimeout(timer); reject(err); };
    ws.onmessage = ({ data }) => {
      const snapshot = JSON.parse(data).ops?.find((op) => op.t === 'snapshot');
      if (snapshot) { clearTimeout(timer); ws.close(); resolve(snapshot.browsers); }
    };
  });
}

async function until(check, label) {
  for (let i = 0; i < 150; i++) {
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`timed out: ${label}`);
}

async function state(name, expected) {
  return until(async () => {
    const card = (await listing()).find((b) => b.name === name);
    return card?.state === expected && card;
  }, `${name} ${expected}`);
}

async function closeWindow(card) {
  // docker exec does not inherit the entrypoint's dynamically chosen display.
  const env = { ...process.env };
  if (process.env.DISPLAY_BACKEND === 'wayland') {
    env.WAYLAND_DISPLAY = (await fs.readFile('/tmp/labwc-display', 'utf8')).trim();
    env.XDG_RUNTIME_DIR ??= '/tmp';
    await until(async () => (await run('wlrctl', ['toplevel', 'list'], { env })).stdout.includes(`cdp-${card.name}:`), 'window mapped');
    await run('wlrctl', ['toplevel', 'close', `app_id:cdp-${card.name}`], { env });
  } else {
    const sockets = (await fs.readdir('/tmp/.X11-unix')).filter((name) => /^X\d+$/.test(name));
    assert.equal(sockets.length, 1, 'the disposable X11 fixture must have one display');
    env.DISPLAY = `:${sockets[0].slice(1)}`;
    await run('python3', ['-c', `
import sys, time
from Xlib import X, display, protocol
d = display.Display()
pid = d.intern_atom('_NET_WM_PID')
role = d.intern_atom('WM_WINDOW_ROLE')
closed = 0
for attempt in range(150):
    for win in d.screen().root.query_tree().children:
        owner = win.get_full_property(pid, X.AnyPropertyType)
        kind = win.get_full_property(role, X.AnyPropertyType)
        if owner and int(owner.value[0]) == int(sys.argv[1]) and kind and kind.value == b'browser' and win.get_attributes().map_state == X.IsViewable:
            win.send_event(protocol.event.ClientMessage(window=win, client_type=d.intern_atom('WM_PROTOCOLS'),
                data=(32, [d.intern_atom('WM_DELETE_WINDOW'), X.CurrentTime, 0, 0, 0])))
            closed += 1
    d.sync()
    if closed:
        break
    time.sleep(0.1)
assert closed, 'no browser window found'
`, String(card.pid)], { env });
  }
}

async function assertClosed(name, pid) {
  const card = await state(name, 'stopped');
  assert.deepEqual(card.tabs, []);
  assert.equal(card.pid, null);
  assert.equal(card.occupied, false);
  await assert.rejects(fs.access(`/proc/${pid}`), { code: 'ENOENT' });
  await fs.access(`/browser/contexts/${name}/profile/Default/Preferences`);
  return card;
}

const created = new Set();
let browser;
try {
  const { name } = await action('browsers');
  created.add(name);
  for (let round = 0; round < 4; round++) {
    const before = await state(name, 'running');
    assert.equal(before.tabs.length, 1);
    await closeWindow(before);
    await assertClosed(name, before.pid);
    await Promise.all(Array.from({ length: 6 }, () => action(`${name}/focus`)));
    const after = await state(name, 'running');
    assert.notEqual(after.pid, before.pid);
    assert.deepEqual(after.tabs.map((t) => t.url), ['about:blank']);
  }
  await action(name, 'DELETE');
  created.delete(name);
  console.log('PASS console: repeated native window close, process exit, retained profile, concurrent Show opens one tab');

  const previous = new Set((await listing()).map((b) => b.name));
  browser = await chromium.connectOverCDP(endpoint);
  const context = await browser.newContext();
  const contextName = (await listing()).find((b) => !previous.has(b.name)).name;
  created.add(contextName);
  const url = endpoint + '/json/version';
  const first = await context.newPage();
  await first.goto(url);
  await first.evaluate(() => { localStorage.setItem('kept', 'yes'); sessionStorage.setItem('identity', 'first'); });
  await context.addCookies([{ name: 'session_kept', value: 'yes', url }]);
  const second = await context.newPage();
  await second.goto(url);
  await second.evaluate(() => sessionStorage.setItem('identity', 'second'));
  await action(`${contextName}/hibernate`);
  const sleeping = await state(contextName, 'hibernated');
  assert.equal(sleeping.pid, null);
  assert.equal(sleeping.tabs.length, 2);
  assert.deepEqual(context.pages(), [first, second]);
  await action(`${contextName}/focus`);
  assert.deepEqual(context.pages(), [first, second]);
  assert.equal(await first.evaluate(() => sessionStorage.getItem('identity')), 'first');
  assert.equal(await second.evaluate(() => sessionStorage.getItem('identity')), 'second');
  console.log('PASS hibernation: original Page objects, duplicate URLs and sessionStorage restored without extra tabs');

  for (let round = 0; round < 3; round++) {
    const before = await state(contextName, 'running');
    const pages = context.pages();
    await closeWindow(before);
    await assertClosed(contextName, before.pid);
    await until(() => pages.every((p) => p.isClosed()) && context.pages().length === 0, 'old Pages closed');
    assert.ok(browser.isConnected(), 'closing the window must preserve the owning CDP connection');
    if (round === 1) {
      await context.newPage(); // A CDP command reopens the same context too.
    } else {
      await Promise.all([action(`${contextName}/focus`), action(`${contextName}/focus`)]);
    }
    await until(() => context.pages().length === 1, 'one new Page');
    const after = await state(contextName, 'running');
    assert.notEqual(after.pid, before.pid);
    assert.deepEqual(after.tabs.map((t) => t.url), ['about:blank']);
    assert.equal((await context.cookies()).find((c) => c.name === 'session_kept')?.value, 'yes');
    const page = context.pages()[0];
    await page.goto(url);
    assert.equal(await page.evaluate(() => localStorage.getItem('kept')), 'yes');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('identity')), null, 'closed tabs must not return');
  }
  await context.close();
  created.delete(contextName);
  console.log('PASS Playwright: close after native wake, new Pages, same context, session cookies and localStorage retained');
} finally {
  await browser?.close();
  for (const name of created) await action(name, 'DELETE').catch(() => {});
}
