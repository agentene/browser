// The context registry against a fake chromium (node --test): a Node script
// that speaks CDP on its DevTools pipe (fds 3 and 4) the way chromium does
// and then lives until it is killed (or, while an exit-after file holds a
// number of seconds, exits on its own after that long). It records its
// command line under the context's name.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-contexts-'));
const fakeChrome = path.join(tmp, 'chrome.mjs');
fs.writeFileSync(fakeChrome, `#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
const args = process.argv.slice(2);
if (fs.existsSync(${JSON.stringify(path.join(tmp, 'fail-start'))})) process.exit(1);
const dir = args.find((a) => a.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
const targetsFile = path.join(dir, 'test-targets.json');
fs.writeFileSync(path.join(${JSON.stringify(tmp)}, 'args-' + path.basename(path.dirname(dir))), args.join('\\n'));
// sockets, not fs streams: a blocking read of a pipe in the thread pool
// would hold up process.exit
const out = new net.Socket({ fd: 4, readable: false });
let nextSession = 0;
const discoverers = new Set();
const targets = () => fs.existsSync(targetsFile) ? JSON.parse(fs.readFileSync(targetsFile, 'utf8')) : [];
const emit = (method, params, sessionId) => out.write(JSON.stringify({ method, params, sessionId }) + '\\0');
let buf = '';
new net.Socket({ fd: 3, writable: false }).on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\0')) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.method === 'Target.setDiscoverTargets') {
      discoverers.add(msg.sessionId);
      for (const targetInfo of targets().filter((t) => t.type === 'page')) emit('Target.targetCreated', { targetInfo }, msg.sessionId);
    }
    if (msg.method === 'Test.setTargets') {
      const before = targets();
      fs.writeFileSync(targetsFile, JSON.stringify(msg.params.targets));
      for (const sessionId of discoverers) {
        for (const t of before) if (!msg.params.targets.some((v) => v.targetId === t.targetId)) emit('Target.targetDestroyed', { targetId: t.targetId }, sessionId);
        for (const targetInfo of msg.params.targets) if (!before.some((t) => t.targetId === targetInfo.targetId) && targetInfo.type === 'page') emit('Target.targetCreated', { targetInfo }, sessionId);
      }
    }
    const result = msg.method === 'Target.attachToBrowserTarget' ? { sessionId: 'browser-' + ++nextSession }
      : msg.method === 'Browser.getVersion' ? { product: 'Fake/1', revision: '@fake' }
      : msg.method === 'Storage.getCookies' ? { cookies: [] }
      : msg.method === 'Target.getTargets' ? { targetInfos: targets() } : {};
    out.write(JSON.stringify({ id: msg.id, result, sessionId: msg.sessionId }) + '\\0');
    if (msg.method === 'Browser.close' && !fs.existsSync(${JSON.stringify(path.join(tmp, 'hang-close'))})) setImmediate(() => process.exit(0));
  }
});
const exitAfter = path.join(${JSON.stringify(tmp)}, 'exit-after');
setTimeout(() => process.exit(0), fs.existsSync(exitAfter) ? Number(fs.readFileSync(exitAfter, 'utf8')) * 1000 : 60_000);
`, { mode: 0o755 });
fs.mkdirSync(path.join(tmp, 'main', 'Default'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'main', 'Default', 'Preferences'), '{}');
fs.writeFileSync(path.join(tmp, 'flags'), '--fake\0');

let contexts;
let mainBrowser;

before(async () => {
  fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ contexts: { maxRunning: 2, overflow: 'hibernate', maxHibernated: 2 } }));
  fs.writeFileSync(path.join(tmp, 'protocol.json'), JSON.stringify({ domains: [] }));
  Object.assign(process.env, {
    CHROME_BIN: fakeChrome,
    CDP_CONTEXTS_DIR: path.join(tmp, 'contexts'),
    CHROMIUM_USER_DATA_DIR: path.join(tmp, 'main'),
    CDP_GATEWAY_FLAGS_FILE: path.join(tmp, 'flags'),
    CDP_GATEWAY_SETTINGS_FILE: path.join(tmp, 'settings.json'),
    CDP_GATEWAY_PROTOCOL_FILE: path.join(tmp, 'protocol.json'),
  });
  ({ contexts } = await import('../src/contexts.mjs'));
  ({ mainBrowser } = await import('../src/main-browser.mjs'));
});

// The command line the fake chromium of a context was started with.
const argsOf = (context) => fs.readFileSync(path.join(tmp, `args-${context.name}`), 'utf8').split('\n');
const setTargets = (context, types) => fs.writeFileSync(path.join(context.profile, 'test-targets.json'), JSON.stringify(types.map((type, i) => ({ targetId: `target-${i}`, type, title: type, url: 'about:blank' }))));
const changePages = (context, ids) => context.pipe.call('Test.setTargets', {
  targets: ids.map((targetId) => ({ targetId, type: 'page', title: targetId, url: 'about:blank' })),
});

after(async () => {
  await Promise.all(contexts.values().map((c) => c.destroy('test over')));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a context whose chromium exits during startup is not registered and holds no slot', async () => {
  // the cookie sync with a slow running main browser takes 500ms (and
  // fails); the fake chromium exits 300ms after it started
  fs.writeFileSync(path.join(tmp, 'exit-after'), '0.3');
  mainBrowser.state = 'running';
  mainBrowser.pipe = {
    async call(method) {
      if (method === 'Target.getTargets') return { targetInfos: [] }; // the localStorage snapshot
      await new Promise((resolve) => setTimeout(resolve, 500));
      throw new Error(`${method}: the main browser is slow`);
    },
  };
  try {
    for (let i = 0; i < 3; i++) {
      await assert.rejects(contexts.create('t'), /exited during startup/);
    }
    assert.equal(contexts.size, 0);
    assert.equal(contexts.busy, false);
  } finally {
    fs.rmSync(path.join(tmp, 'exit-after'));
    mainBrowser.state = 'stopped';
    mainBrowser.pipe = null;
  }
  // every slot is free again (CDP_CONTEXTS_MAX=2)
  const [a, b] = await Promise.all([contexts.create('t'), contexts.create('t')]);
  assert.equal(contexts.size, 2);
  await Promise.all([a.destroy('test'), b.destroy('test')]);
});

test('a context log that cannot be opened fails that context, not the gateway', async () => {
  // the next context's name: one after a context created right now
  const probe = await contexts.create('t');
  const next = Number(probe.name.replace(/\D/g, '')) + 1;
  await probe.destroy('test');
  const logDir = path.join(tmp, 'contexts', `context-${next}`, 'chromium.log');
  fs.mkdirSync(logDir, { recursive: true }); // a directory: opening it for writing fails
  await assert.rejects(contexts.create('t'), /EISDIR/);
  assert.equal(contexts.size, 0);
  const ok = await contexts.create('t'); // the failed one holds no slot
  assert.equal(contexts.size, 1);
  await ok.destroy('test');
});

test('proxyFlags: the client\'s context proxy as chromium flags, junk refused', async () => {
  const { proxyFlags } = await import('../src/contexts.mjs');
  assert.deepEqual(proxyFlags(), []);
  assert.deepEqual(proxyFlags({ proxyServer: '' }), []);
  assert.deepEqual(proxyFlags({ proxyServer: 'http://proxy:3128' }), ['--proxy-server=http://proxy:3128']);
  assert.deepEqual(proxyFlags({ proxyServer: 'socks5://p:1080', proxyBypassList: '<-loopback>, *.internal' }),
    ['--proxy-server=socks5://p:1080', '--proxy-bypass-list=<-loopback>, *.internal']);
  assert.throws(() => proxyFlags({ proxyServer: 'http://p:1 --no-sandbox' }), /not a valid proxy server/);
  assert.throws(() => proxyFlags({ proxyServer: 42 }), /not a valid proxy server/);
  assert.throws(() => proxyFlags({ proxyServer: 'p:1', proxyBypassList: 'a\nb' }), /not a valid bypass list/);
  assert.throws(() => proxyFlags({ proxyBypassList: 'a' }), /needs a proxyServer/);
});

test('a context gets its client\'s proxy on its command line; a bad one starts nothing', async () => {
  const c = await contexts.create('t', { proxyServer: 'http://proxy.test:3128', proxyBypassList: 'localhost' });
  const args = argsOf(c);
  assert.ok(args.includes('--proxy-server=http://proxy.test:3128'), args.join(' '));
  assert.ok(args.includes('--proxy-bypass-list=localhost'));
  await c.destroy('test');
  const plain = await contexts.create('t');
  assert.ok(!argsOf(plain).some((a) => a.startsWith('--proxy-')), 'no proxy, no flag');
  await plain.destroy('test');
  await assert.rejects(contexts.create('t', { proxyServer: 'a b' }), /not a valid proxy server/);
  assert.equal(contexts.busy, false);
});

test('a context browser is driven over its pipe: no DevTools port, webdriver hidden', async () => {
  const c = await contexts.create('t');
  try {
    const args = argsOf(c);
    assert.ok(args.includes('--remote-debugging-pipe'), args.join(' '));
    assert.ok(!args.some((a) => a.startsWith('--remote-debugging-port')));
    assert.ok(args.includes('--disable-blink-features=AutomationControlled'));
    assert.equal(c.pipe.version.product, 'Fake/1');
    assert.deepEqual(await c.pipe.call('Target.getTargets'), { targetInfos: [] });
  } finally {
    await c.destroy('test');
  }
});

test('last-page closure stops the process, retains the context and restarts without old sessions', async () => {
  const c = await contexts.create('window-close');
  try {
    assert.equal(c.state, 'running', 'a newly created empty context must stay usable');
    const session = await c.connect();
    const prefs = fs.readFileSync(path.join(c.profile, 'Default', 'Preferences'), 'utf8');
    for (let round = 0; round < 3; round++) {
      const proc = c.proc;
      await changePages(c, ['first', 'second']);
      await changePages(c, ['second']);
      assert.equal(c.proc, proc, 'closing one window/tab must spare the others');
      await changePages(c, []);
      await c.closing;
      assert.equal(c.state, 'stopped');
      assert.equal(c.proc, null);
      assert.equal(c.pipe, null);
      assert.equal(proc.exitCode, 0);
      assert.equal(c.slot, false);
      assert.equal(contexts.get(c.name), c);
      assert.equal(session.readyState, 1);
      assert.deepEqual(c.snapshot.tabs, []);
      assert.equal(fs.readFileSync(path.join(c.profile, 'Default', 'Preferences'), 'utf8'), prefs);
      const oldSession = path.join(c.profile, 'Default', 'Sessions');
      fs.mkdirSync(oldSession, { recursive: true });
      fs.writeFileSync(path.join(oldSession, 'Session_closed'), 'closed windows');
      await Promise.all([c.wake(), c.wake()]);
      assert.notEqual(c.proc.pid, proc.pid);
      assert.equal(c.session, session);
      assert.equal(session.mode, 'running');
      assert.ok(!fs.existsSync(oldSession), 'closed tabs must not trigger deferred native restoration');
      assert.ok(!argsOf(c).includes('--restore-last-session'));
    }
  } finally { await c.destroy('test'); }
});

test('a page opened while last-page closure is queued cancels the stop', async () => {
  const c = await contexts.create('racing-page');
  try {
    const pid = c.proc.pid;
    await changePages(c, ['old']);
    await changePages(c, ['new']); // destruction and creation in the same event batch
    await c.closing;
    assert.equal(c.state, 'running');
    assert.equal(c.proc.pid, pid);
    assert.equal((await c.pipe.call('Target.getTargets')).targetInfos[0].targetId, 'new');
  } finally { await c.destroy('test'); }
});

test('capacity waits for an empty browser to close; deletion wins over reopening', async () => {
  const a = await contexts.create('closing');
  const b = await contexts.create('other');
  let next;
  try {
    await changePages(a, ['last']);
    a.holds++;
    await changePages(a, []);
    const creating = contexts.create('replacement');
    a.holds--;
    next = await creating;
    assert.equal(a.state, 'stopped');
    assert.equal(b.state, 'running', 'a closing browser frees capacity without hibernating another');
    assert.equal(contexts.running, 2);
    const waking = assert.rejects(a.wake(), /gone/);
    await a.destroy('deleted while reopening');
    await waking;
    assert.ok(!fs.existsSync(a.dir));
  } finally { await Promise.all([a, b, next].filter(Boolean).map((c) => c.destroy('test'))); }
});

test('failed reopen retains a stopped profile for retry, outside sleeper eviction', async () => {
  const c = await contexts.create('failed-reopen');
  const marker = path.join(tmp, 'fail-start');
  try {
    await changePages(c, ['last']);
    await changePages(c, []);
    await c.closing;
    fs.writeFileSync(marker, '1');
    await assert.rejects(c.wake());
    assert.equal(c.state, 'stopped');
    assert.equal(c.slot, false);
    assert.ok(fs.existsSync(c.profile));
    fs.rmSync(marker);
    await c.wake();
    assert.equal(c.state, 'running');
  } finally { fs.rmSync(marker, { force: true }); await c.destroy('test'); }
});

test('LRU releases a real process before replacement; waking reuses its profile', async () => {
  const a = await contexts.create('a');
  const b = await contexts.create('b');
  a.lastUsedAt = 1; b.lastUsedAt = 2;
  fs.writeFileSync(path.join(a.profile, 'kept'), 'context data');
  const c = await contexts.create('c');
  assert.equal(a.state, 'hibernated');
  assert.equal(a.proc, null);
  assert.equal(contexts.running, 2);
  assert.equal(contexts.size, 3);
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) fs.symlinkSync(path.join(tmp, 'flags'), path.join(a.profile, name));
  await Promise.all([a.wake(), a.wake(), a.wake()]);
  assert.equal(a.state, 'running');
  assert.equal(b.state, 'hibernated');
  assert.equal(contexts.running, 2);
  assert.equal(fs.readFileSync(path.join(a.profile, 'kept'), 'utf8'), 'context data');
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) assert.equal(fs.lstatSync(path.join(a.profile, name), { throwIfNoEntry: false }), undefined);
  await Promise.all([a, b, c].map((c) => c.destroy('test')));
});

for (const { name, targets, ages, blocked, victim } of [
  { name: 'a newer empty browser is hibernated before an older browser with tabs', targets: [['page'], []], ages: [1, 2], victim: 1 },
  { name: 'multiple empty browsers are ordered by activity, not creation', targets: [[], []], ages: [2, 1], victim: 1 },
  { name: 'browsers with tabs use LRU regardless of their tab counts', targets: [['page', 'page'], ['page']], ages: [1, 2], victim: 0 },
  { name: 'worker and iframe targets do not count as open tabs', targets: [['page'], ['service_worker', 'iframe']], ages: [1, 2], victim: 1 },
  { name: 'an empty browser with a direct page connection remains ineligible', targets: [['page'], []], ages: [2, 1], blocked: 1, victim: 0 },
]) {
  test(name, async () => {
    const made = [await contexts.create('a'), await contexts.create('b')];
    try {
      for (const [i, c] of made.entries()) { setTargets(c, targets[i]); c.lastUsedAt = ages[i]; }
      if (blocked !== undefined) made[blocked].relays = 1;
      const survivorPid = made[1 - victim].proc.pid;
      made.push(await contexts.create('c'));
      assert.equal(made[victim].state, 'hibernated');
      assert.equal(made[victim].proc, null);
      assert.equal(made[1 - victim].state, 'running');
      assert.equal(made[1 - victim].proc.pid, survivorPid);
      assert.deepEqual(made.slice(0, 2).map((c) => c.lastUsedAt), ages, 'internal tab queries must not change LRU activity');
      assert.equal(contexts.running, 2);
    } finally { await Promise.all(made.map((c) => c.destroy('test'))); }
  });
}

for (const change of ['query failure', 'new blocker', 'disconnect']) {
  test(`tab selection handles ${change} while probing a candidate`, async (t) => {
    const made = [await contexts.create('a'), await contexts.create('b')];
    const [a, b] = made;
    setTargets(a, ['page']);
    a.lastUsedAt = 1; b.lastUsedAt = 2;
    const call = b.pipe.call.bind(b.pipe);
    t.mock.method(b.pipe, 'call', async (method, ...args) => {
      if (method !== 'Target.getTargets') return call(method, ...args);
      if (change === 'query failure') throw new Error('target query failed');
      if (change === 'new blocker') b.relays = 1;
      if (change === 'disconnect') await b.destroy('owner disconnected while probing');
      return { targetInfos: [] };
    });
    try {
      made.push(await contexts.create('c'));
      assert.equal(a.state, change === 'disconnect' ? 'running' : 'hibernated');
      assert.equal(b.state, change === 'disconnect' ? 'destroying' : 'running');
      assert.equal(contexts.running, 2);
      assert.equal(made[2].state, 'running');
    } finally { await Promise.all(made.map((c) => c.destroy('test'))); }
  });
}

test('concurrent creation respects running and retained limits; deletion removes sleepers', async () => {
  let peak = 0;
  const sample = setInterval(() => { peak = Math.max(peak, contexts.running); }, 1);
  const made = await Promise.all(Array.from({ length: 6 }, () => contexts.create('concurrent')));
  clearInterval(sample);
  assert.ok(peak <= 2, `peak occupied slots: ${peak}`);
  assert.equal(contexts.running, 2);
  assert.equal(contexts.size, 4);
  assert.equal(made.filter((c) => c.destroyed).length, 2);
  for (const c of made.filter((c) => c.destroyed)) assert.equal(fs.existsSync(c.dir), false);
  await Promise.all(made.map((c) => c.destroy('test')));
  assert.equal(contexts.busy, false);
});

test('inner incognito contexts prevent hibernation and do not lose a slot', async () => {
  const a = await contexts.create('a');
  const b = await contexts.create('b');
  for (const c of [a, b]) c.mux = { innerContexts: new Set(['inner']), contextGone() {} };
  await assert.rejects(contexts.create('blocked'), /no hibernatable browser/);
  await assert.rejects(a.hibernate(), /incognito/);
  assert.equal(contexts.running, 2);
  await Promise.all([a, b].map((c) => c.destroy('test')));
});

test('delete wins over a queued wake and never resurrects a removed profile', async () => {
  const c = await contexts.create('a');
  await c.hibernate();
  const waking = c.wake();
  const deleting = c.destroy('test');
  await assert.rejects(waking, /gone|deleted/);
  await deleting;
  assert.equal(fs.existsSync(c.dir), false);
  assert.equal(contexts.size, 0);
});

test('client commands arriving during capture and process exit cannot queue a wake', async () => {
  const c = await contexts.create('hibernate-race');
  try {
    const session = await c.connect();
    const replies = [];
    session.on('message', (data) => replies.push(JSON.parse(data)));
    const pipe = c.pipe;
    const call = pipe.call.bind(pipe);
    const phases = [];
    pipe.call = (method, ...args) => {
      if (c.state === 'hibernating' && ['Target.getTargets', 'Browser.close'].includes(method)) {
        phases.push(session.mode);
        session.send({ id: phases.length, method: 'Storage.getCookies' });
      }
      return call(method, ...args);
    };

    await c.hibernate();
    await c.waking;
    assert.deepEqual(phases, ['quiescing', 'suspended']);
    assert.equal(c.state, 'hibernated');
    assert.equal(c.proc, null);
    assert.deepEqual(replies.map((r) => r.id), [1, 2]);
    for (const r of replies) assert.match(r.error.message, /hibernating/);
    assert.equal(session.queue.length, 0);

    const reply = new Promise((resolve) => session.once('message', (data) => resolve(JSON.parse(data))));
    session.send({ id: 3, method: 'Storage.getCookies' });
    assert.deepEqual(await reply, { id: 3, result: { cookies: [] } });
    assert.equal(c.state, 'running');
  } finally { await c.destroy('test'); }
});

test('forced hibernation retains its profile and reports reduced durability after waking', async () => {
  const c = await contexts.create('forced-close');
  const marker = path.join(tmp, 'hang-close');
  fs.writeFileSync(marker, '1');
  try {
    await c.hibernate();
    assert.equal(c.state, 'hibernated');
    assert.equal(c.snapshot.forced, true);
    assert.match(c.restoreWarning, /signal/);
    assert.ok(fs.existsSync(c.profile));
    fs.rmSync(marker);
    await c.wake();
    assert.match(c.restoreWarning, /signal/);
  } finally {
    fs.rmSync(marker, { force: true });
    await c.destroy('test');
  }
});

test('reject restores the original capacity error; a zero sleep limit deletes the victim', () => {
  for (const mode of ['reject', 'hibernate']) {
    const code = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { contexts } from ${JSON.stringify(new URL('../src/contexts.mjs', import.meta.url).href)};
      try {
        const a = await contexts.create('a');
        if (${JSON.stringify(mode)} === 'reject') {
          await assert.rejects(contexts.create('b'), /CDP context limit reached/);
          assert.equal(a.state, 'running');
        } else {
          await contexts.create('b');
          assert.equal(a.destroyed, true);
          assert.equal(fs.existsSync(a.dir), false);
          assert.equal(contexts.size, 1);
        }
      } finally { await Promise.all(contexts.values().map(c => c.destroy('test'))); }
    `;
    const settingsFile = path.join(tmp, `settings-${mode}.json`);
    fs.writeFileSync(settingsFile, JSON.stringify({ contexts: { maxRunning: 1, overflow: mode, maxHibernated: 0 } }));
    execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env,
      CDP_CONTEXTS_DIR: path.join(tmp, mode), CDP_GATEWAY_SETTINGS_FILE: settingsFile,
    }, timeout: 15000 });
  }
});

test('a failed wake keeps its profile while enforcing the retained sleep limit', async () => {
  const made = [];
  for (let i = 0; i < 4; i++) made.push(await contexts.create('failure'));
  const [a, b] = made;
  fs.writeFileSync(path.join(tmp, 'fail-start'), '');
  try {
    await assert.rejects(a.wake());
    assert.equal(a.state, 'hibernated');
    assert.ok(fs.existsSync(a.profile));
    assert.equal(contexts.values().filter((c) => c.state === 'hibernated').length, 2);
    assert.equal(b.destroyed, true);
    fs.rmSync(path.join(tmp, 'fail-start'));
    await a.wake();
    assert.equal(a.state, 'running');
  } finally {
    fs.rmSync(path.join(tmp, 'fail-start'), { force: true });
    await Promise.all(made.map((c) => c.destroy('test')));
  }
});

test('evicting a queued wake cancels it without deadlocking the registry', { timeout: 10000 }, async () => {
  const made = [];
  for (let i = 0; i < 4; i++) made.push(await contexts.create('queued'));
  const next = contexts.create('newer request');
  const wake = made[0].wake();
  const settled = await Promise.allSettled([next, wake]);
  assert.equal(settled[0].status, 'fulfilled');
  assert.equal(settled[1].status, 'rejected');
  assert.equal(made[0].destroyed, true);
  assert.equal(contexts.size, 4);
  await Promise.all([...made, settled[0].value].map((c) => c.destroy('test')));
});

test('disconnected queued owners and shutdown never launch new browsers', async () => {
  let alive = true;
  const queued = contexts.create('departed', {}, { alive: () => alive });
  alive = false;
  await assert.rejects(queued, /disconnected/);
  assert.equal(contexts.size, 0);
  const { ContextRegistry } = await import('../src/contexts.mjs');
  const registry = new ContextRegistry();
  const c = await registry.create('shutdown');
  try {
    await c.hibernate();
    registry.close();
    await assert.rejects(registry.create('too late'), /shutting down/);
    await assert.rejects(c.wake(), /shutting down/);
    assert.equal(c.proc, null);
  } finally { await c.destroy('test'); }
});
