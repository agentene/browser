// The context registry against a fake chromium (node --test): a shell
// script that announces its DevTools endpoint the way chromium does and
// then lives until it is killed (or, while an exit-after file holds a
// number of seconds, exits on its own after that long).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-contexts-'));
const fakeChrome = path.join(tmp, 'chrome.sh');
fs.writeFileSync(fakeChrome, `#!/bin/sh
for a in "$@"; do case "$a" in --remote-debugging-port=*) p="\${a#*=}" ;; esac; done
echo "DevTools listening on ws://127.0.0.1:$p/devtools/browser/fake" >&2
printf '%s\n' "$@" > "${tmp}/args-$p"
if [ -f "${tmp}/exit-after" ]; then sleep "$(cat "${tmp}/exit-after")"; exit 0; fi
exec sleep 60
`, { mode: 0o755 });
fs.mkdirSync(path.join(tmp, 'main', 'Default'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'main', 'Default', 'Preferences'), '{}');
fs.writeFileSync(path.join(tmp, 'flags'), '--fake\0');

// A slow "main browser" DevTools endpoint: /json/version answers after
// 500ms with a WebSocket nothing listens on, so a context's cookie sync
// fails late — the window in which its chromium can exit during startup.
const main = http.createServer((req, res) => {
  if (req.url.startsWith('/json/list')) {
    res.end('[]');
    return;
  }
  setTimeout(() => res.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/x' })), 500);
});

let contexts;
let mainBrowser;

before(async () => {
  await new Promise((resolve) => main.listen(0, '127.0.0.1', resolve));
  Object.assign(process.env, {
    CHROME_BIN: fakeChrome,
    CDP_CONTEXTS_DIR: path.join(tmp, 'contexts'),
    CHROMIUM_USER_DATA_DIR: path.join(tmp, 'main'),
    CDP_GATEWAY_FLAGS_FILE: path.join(tmp, 'flags'),
    CDP_GATEWAY_SETTINGS_FILE: path.join(tmp, 'settings.json'),
    CDP_INTERNAL_PORT: String(main.address().port),
    CDP_CONTEXTS_MAX: '2',
  });
  ({ contexts } = await import('../src/contexts.mjs'));
  ({ mainBrowser } = await import('../src/main-browser.mjs'));
});

after(async () => {
  await Promise.all(contexts.values().map((c) => c.destroy('test over')));
  main.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a context whose chromium exits during startup is not registered and holds no slot', async () => {
  // the sync with the (slow) running main browser takes 500ms; the fake
  // chromium exits 100ms after announcing itself
  fs.writeFileSync(path.join(tmp, 'exit-after'), '0.1');
  mainBrowser.state = 'running';
  try {
    for (let i = 0; i < 3; i++) {
      await assert.rejects(contexts.create('t'), /exited during startup/);
    }
    assert.equal(contexts.size, 0);
    assert.equal(contexts.busy, false);
  } finally {
    fs.rmSync(path.join(tmp, 'exit-after'));
    mainBrowser.state = 'stopped';
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
  const args = fs.readFileSync(path.join(tmp, `args-${c.port}`), 'utf8').split('\n');
  assert.ok(args.includes('--proxy-server=http://proxy.test:3128'), args.join(' '));
  assert.ok(args.includes('--proxy-bypass-list=localhost'));
  await c.destroy('test');
  const plain = await contexts.create('t');
  assert.ok(!fs.readFileSync(path.join(tmp, `args-${plain.port}`), 'utf8').includes('--proxy-'), 'no proxy, no flag');
  await plain.destroy('test');
  await assert.rejects(contexts.create('t', { proxyServer: 'a b' }), /not a valid proxy server/);
  assert.equal(contexts.busy, false);
});
