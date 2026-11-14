// Real, unmodified Playwright/CLI regression. Run against a disposable
// container with MAX=2, HIBERNATED_MAX=2 and auth disabled. Dependencies are
// test-only; neither Playwright nor this file ships in the image.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const endpoint = process.env.CDP_ENDPOINT;
if (!endpoint || !process.env.PLAYWRIGHT_CLI_JS) throw new Error('CDP_ENDPOINT and PLAYWRIGHT_CLI_JS are required');
const cliFile = path.resolve(process.env.PLAYWRIGHT_CLI_JS);
const require = createRequire(cliFile);
const { chromium } = require('playwright');
const run = promisify(execFile);
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'context-hibernation-'));
const clients = [];
const cliName = `hibernate-${process.pid}`;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function listing() {
  const ws = new WebSocket(endpoint.replace(/^http/, 'ws') + '/console/ws');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('console snapshot timed out')); }, 10000);
    ws.onerror = reject;
    ws.onmessage = ({ data }) => {
      const snapshot = JSON.parse(data).ops?.find((op) => op.t === 'snapshot');
      if (snapshot) { clearTimeout(timer); ws.close(); resolve(snapshot); }
    };
  });
}

async function state(name, expected) {
  for (let n = 0; n < 100; n++) {
    const b = (await listing()).browsers.find((b) => b.name === name);
    if (expected === null ? !b : b?.state === expected) return b;
    await delay(100);
  }
  throw new Error(`${name} did not become ${expected}`);
}

async function action(name, verb) {
  const r = await fetch(`${endpoint}/console/api/${name}/${verb}`, { method: 'POST', headers: { 'X-CDP-Console': '1' } });
  const body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body));
  return body;
}

async function connect() {
  const before = new Set((await listing()).browsers.map((b) => b.name));
  const b = await chromium.connectOverCDP(endpoint);
  clients.push(b);
  const c = await b.newContext();
  const name = (await listing()).browsers.find((v) => !v.main && !before.has(v.name)).name;
  return { b, c, name };
}

async function cli(...args) {
  const { stdout, stderr } = await run(process.execPath, [cliFile, '-s=' + cliName, ...args], {
    cwd: tmp, timeout: 45000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.ok(!stdout.includes('### Error'), stdout + stderr);
  return stdout;
}

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 10000); })]);
  } finally { clearTimeout(timer); }
}

try {
  const a = await connect();
  const page = await a.c.newPage();
  await page.goto('data:text/html,<title>First</title><button>Before</button>');
  await page.locator('button').click(); // cache the injected helper before sleep
  assert.equal(await page.title(), 'First');
  await a.c.addCookies([{ name: 'kept', value: 'yes', domain: 'example.test', path: '/' }]);
  const second = await a.c.newPage();
  await second.goto('data:text/html,<title>Second</title>Second');
  await page.bringToFront();
  let pageEvents = 0;
  a.c.on('page', () => pageEvents++);
  const b = await connect();
  await b.c.newPage();
  const c = await connect();
  await c.c.newPage();
  await state(a.name, 'hibernated');
  assert.equal(page.isClosed(), false);
  assert.deepEqual(a.c.pages(), [page, second]);
  assert.equal(await page.title(), 'First');
  assert.equal(await page.locator('button').textContent(), 'Before');
  assert.deepEqual(a.c.pages(), [page, second]);
  assert.equal(pageEvents, 0, 'restoration must not emit new Pages');
  assert.equal((await a.c.cookies()).find((c) => c.name === 'kept').value, 'yes');
  const view = await listing();
  assert.ok(view.browsers.filter((v) => !v.main && v.state === 'running').length <= 2);
  await action(a.name, 'hibernate');
  const created = await a.c.newPage();
  assert.equal(a.c.pages().length, 3, 'ordinary newPage always creates');
  assert.equal(created.url(), 'about:blank');
  await action(a.name, 'hibernate');
  await a.b.close();
  await state(a.name, null);
  await Promise.all([b.b.close(), c.b.close()]);
  await state(b.name, null); await state(c.name, null);
  console.log('PASS logical Page identity, cached helpers, LRU, newPage and disconnect cleanup');

  const native = await connect();
  const fixture = (process.env.CDP_FIXTURE_URL ?? endpoint) + '/json/version';
  const nativePages = [];
  for (const marker of ['one', 'two']) {
    const p = await native.c.newPage();
    await p.goto(fixture);
    await p.evaluate((marker) => {
      sessionStorage.setItem('identity', marker);
      window.volatileState = 42;
      history.pushState({}, '', '#first');
      history.pushState({}, '', '#second');
    }, marker);
    await p.goBack();
    nativePages.push(p);
  }
  await native.c.addCookies([{ name: 'session_kept', value: 'yes', url: fixture }]);
  const oldHandle = await nativePages[0].evaluateHandle(() => ({ old: true }));
  await action(native.name, 'hibernate');
  assert.equal((await native.c.cookies()).find((c) => c.name === 'session_kept').value, 'yes');
  assert.equal((await state(native.name, 'running')).restoreWarning, '');
  assert.deepEqual(native.c.pages(), nativePages);
  for (const [i, p] of nativePages.entries()) {
    assert.equal(await p.evaluate(() => sessionStorage.getItem('identity')), ['one', 'two'][i]);
    assert.equal(await p.evaluate(() => typeof window.volatileState), 'undefined');
    assert.ok(p.url().endsWith('#first'));
    await p.goForward(); assert.ok(p.url().endsWith('#second'));
    await p.goBack(); assert.ok(p.url().endsWith('#first'));
    assert.equal(await p.evaluate(() => Object.keys(sessionStorage).some((k) => k.startsWith('__agentene_restore_'))), false);
  }
  await assert.rejects(oldHandle.jsonValue());
  await native.b.close(); await state(native.name, null);
  console.log('PASS native restoration: same-URL identity, sessionStorage, history, session cookie, stale handles');

  const routed = await connect();
  await routed.c.setExtraHTTPHeaders({ 'x-restore-test': 'kept' });
  await routed.c.addInitScript(() => { window.initRuns = (window.initRuns || 0) + 1; });
  let requests = 0;
  await routed.c.route('http://restore.test/**', async (route) => {
    requests++;
    assert.equal(route.request().headers()['x-restore-test'], 'kept');
    await route.fulfill({ contentType: 'text/html', body: '<title>Routed</title><button>Restored</button><iframe srcdoc="<button>Child</button>"></iframe>' });
  });
  const routedPage = await routed.c.newPage();
  await routedPage.goto('http://restore.test/page');
  await routedPage.locator('button').click();
  assert.equal(await routedPage.frameLocator('iframe').locator('button').textContent(), 'Child');
  await routedPage.evaluate(() => { localStorage.businessCalls = String(Number(localStorage.businessCalls || 0) + 1); });
  await action(routed.name, 'hibernate');
  await routed.c.cookies();
  assert.equal(await routedPage.title(), 'Routed');
  assert.equal(await routedPage.locator('button').textContent(), 'Restored');
  assert.equal(await routedPage.frameLocator('iframe').locator('button').textContent(), 'Child');
  assert.equal(await routedPage.evaluate(() => window.initRuns), 1);
  assert.equal(await routedPage.evaluate(() => localStorage.businessCalls), '1', 'business evaluation must not replay');
  assert.equal(requests, 2, 'one navigation before and one after sleep');
  const target = (await (await fetch(endpoint + '/json/list')).json()).find((t) => t.url === 'http://restore.test/page');
  const direct = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { direct.onopen = resolve; direct.onerror = reject; });
  const denied = await fetch(`${endpoint}/console/api/${routed.name}/hibernate`, { method: 'POST', headers: { 'X-CDP-Console': '1' } });
  assert.equal(denied.status, 409, 'a direct page relay pins its browser');
  direct.close();
  await routed.b.close(); await state(routed.name, null);
  console.log('PASS controlled restore: request interception, headers, init scripts, cached locator, iframe, no business replay, direct relay pin');

  for (const cause of ['console', 'capacity']) {
    const delayed = await connect();
    const gates = new Map(['fulfill', 'continue', 'abort'].map((method) => [method, {
      paused: Promise.withResolvers(), release: Promise.withResolvers(), finished: Promise.withResolvers(),
    }]));
    let navigations = 0;
    await delayed.c.route('http://late-route.test/**', async (route) => {
      const method = new URL(route.request().url()).pathname.slice(1);
      const gate = gates.get(method);
      if (!gate) {
        navigations++;
        await route.fulfill({ contentType: 'text/html', body: '<title>Delayed routes</title>' });
        return;
      }
      gate.paused.resolve();
      await gate.release.promise;
      try {
        if (method === 'fulfill') await route.fulfill({ body: 'late response' });
        else await route[method]();
      } catch { /* The original request no longer exists after hibernation. */ }
      finally { gate.finished.resolve(); }
    });
    try {
      const p = await delayed.c.newPage();
      await p.goto('http://late-route.test/page');
      await p.evaluate((methods) => { for (const method of methods) void fetch('/' + method).catch(() => {}); }, [...gates.keys()]);
      await bounded(Promise.all([...gates.values()].map((gate) => gate.paused.promise)), 'request interception');
      if (cause === 'console') await action(delayed.name, 'hibernate');
      const peers = [await connect(), await connect()];
      await state(delayed.name, 'hibernated');
      const pids = new Map();
      for (const peer of peers) pids.set(peer.name, (await state(peer.name, 'running')).pid);
      for (const gate of gates.values()) gate.release.resolve();
      await bounded(Promise.all([...gates.values()].map((gate) => gate.finished.promise)), 'late interception replies');
      const after = await listing();
      assert.equal(after.browsers.find((v) => v.name === delayed.name)?.state, 'hibernated', `${cause}: late route replies must not wake the context`);
      for (const peer of peers) {
        const current = after.browsers.find((v) => v.name === peer.name);
        assert.equal(current.state, 'running', 'late replies must not evict another browser at capacity');
        assert.equal(current.pid, pids.get(peer.name), 'late replies must not restart another browser');
      }
      await delayed.c.cookies();
      await state(delayed.name, 'running');
      assert.equal(await p.title(), 'Delayed routes', 'interception during explicit restoration must still complete');
      assert.equal(navigations, 2);
      await Promise.all([delayed.b.close(), ...peers.map((peer) => peer.b.close())]);
      for (const client of [delayed, ...peers]) await state(client.name, null);
    } finally { for (const gate of gates.values()) gate.release.resolve(); }
  }
  console.log('PASS delayed asynchronous route replies: console and LRU sleep stay asleep at capacity; explicit wake still restores intercepted navigation');

  const config = path.join(tmp, 'config.json');
  await fs.writeFile(config, JSON.stringify({ browser: { cdpEndpoint: endpoint, isolated: true } }));
  await cli('open', '--config=' + config);
  await cli('goto', 'data:text/html,<title>First</title>First');
  await cli('tab-new', 'data:text/html,<title>Selected</title>Selected');
  await cli('tab-new', 'data:text/html,<title>Duplicate</title>Duplicate');
  await cli('tab-new', 'data:text/html,<title>Duplicate</title>Duplicate');
  await cli('tab-new');
  await cli('tab-select', '1');
  const before = await cli('tab-list');
  const name = (await listing()).browsers.find((v) => !v.main).name;
  assert.ok(before.split('\n').find((l) => l.includes('(current)'))?.includes('Selected'), before);

  await action(name, 'hibernate');
  const after = await cli('tab-list');
  assert.equal((await state(name, 'running')).tabs.length, 5, 'tab-list from sleep must not add a page');
  assert.ok(after.split('\n').find((l) => l.includes('(current)'))?.includes('Selected'), after);
  assert.equal(after.split('\n').filter((l) => l.includes('Duplicate')).length, 2, after);

  await action(name, 'hibernate');
  await cli('tab-new');
  assert.equal((await state(name, 'running')).tabs.length, 6, 'blank tab-new directly from sleep creates exactly one');

  await action(name, 'hibernate');
  await cli('tab-new', 'data:text/html,<title>New</title>New');
  const final = await state(name, 'running');
  assert.equal(final.tabs.length, 7, 'tab-new URL directly from sleep creates exactly one');
  assert.equal(final.tabs.filter((t) => t.url.includes('<title>New</title>')).length, 1);
  await action(name, 'hibernate');
  await action(name, 'wake');
  assert.equal((await state(name, 'running')).tabs.length, 7);
  await cli('close');
  await state(name, null);
  console.log('PASS real CLI: tab-list, tab-new, tab-new URL each directly from sleep; duplicate and blank tabs; selected tab; console wake');
} finally {
  await cli('close').catch(() => {});
  await Promise.all(clients.map((b) => b.close().catch(() => {})));
  await fs.rm(tmp, { recursive: true, force: true });
}
