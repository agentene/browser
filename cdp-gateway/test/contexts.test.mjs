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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-contexts-'));
const fakeChrome = path.join(tmp, 'chrome.mjs');
fs.writeFileSync(fakeChrome, `#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
const args = process.argv.slice(2);
const dir = args.find((a) => a.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
fs.writeFileSync(path.join(${JSON.stringify(tmp)}, 'args-' + path.basename(path.dirname(dir))), args.join('\\n'));
// sockets, not fs streams: a blocking read of a pipe in the thread pool
// would hold up process.exit
const out = new net.Socket({ fd: 4, readable: false });
let buf = '';
new net.Socket({ fd: 3, writable: false }).on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\0')) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    const result = msg.method === 'Browser.getVersion' ? { product: 'Fake/1', revision: '@fake' }
      : msg.method === 'Storage.getCookies' ? { cookies: [] } : {};
    out.write(JSON.stringify({ id: msg.id, result, sessionId: msg.sessionId }) + '\\0');
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
  Object.assign(process.env, {
    CHROME_BIN: fakeChrome,
    CDP_CONTEXTS_DIR: path.join(tmp, 'contexts'),
    CHROMIUM_USER_DATA_DIR: path.join(tmp, 'main'),
    CDP_GATEWAY_FLAGS_FILE: path.join(tmp, 'flags'),
    CDP_GATEWAY_SETTINGS_FILE: path.join(tmp, 'settings.json'),
    CDP_CONTEXTS_MAX: '2',
  });
  ({ contexts } = await import('../src/contexts.mjs'));
  ({ mainBrowser } = await import('../src/main-browser.mjs'));
});

// The command line the fake chromium of a context was started with.
const argsOf = (context) => fs.readFileSync(path.join(tmp, `args-${context.name}`), 'utf8').split('\n');

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
    assert.deepEqual(await c.pipe.call('Target.getTargets'), {});
  } finally {
    await c.destroy('test');
  }
});
