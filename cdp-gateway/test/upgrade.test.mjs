// WebSocket upgrades against a real HTTP server and a slow fake main chromium
// (node --test; each test file runs in its own process, so the environment
// set here reaches config.mjs).

import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { after, before, test } from 'node:test';

// the fake main chromium's DevTools HTTP endpoint answers after 300 ms — the
// window in which a client may give up (an on-demand browser takes seconds)
const fakeMain = http.createServer((req, res) => {
  setTimeout(() => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${fakeMain.address().port}/devtools/browser/fake` }));
  }, 300);
});
let gateway;

before(async () => {
  fakeMain.listen(0, '127.0.0.1');
  await once(fakeMain, 'listening');
  process.env.CDP_INTERNAL_PORT = String(fakeMain.address().port);
  const { handleUpgrade } = await import('../src/upgrade.mjs');
  gateway = http.createServer();
  gateway.on('upgrade', handleUpgrade);
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
});

after(() => {
  gateway.close();
  fakeMain.close();
});

function handshake(path, extra = '') {
  return `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
    + `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`;
}

// The raw HTTP answer to a handshake.
function upgradeStatus(path, extra) {
  return new Promise((resolve, reject) => {
    const c = net.connect(gateway.address().port, '127.0.0.1', () => c.write(handshake(path, extra)));
    let text = '';
    c.on('data', (d) => {
      text += d;
      if (text.includes('\r\n')) {
        c.destroy();
        resolve(Number(text.split(' ')[1]));
      }
    });
    c.on('error', reject);
  });
}

test('a client resetting its connection while the target resolves does not crash the gateway', async () => {
  // the test runner would catch what kills the real gateway: count it here
  const uncaught = [];
  const onUncaught = (err) => uncaught.push(err);
  process.on('uncaughtException', onUncaught);
  const c = net.connect(gateway.address().port, '127.0.0.1', () => c.write(handshake('/devtools/browser/x')));
  c.on('error', () => {});
  await once(c, 'connect');
  await new Promise((resolve) => setTimeout(resolve, 50));
  c.resetAndDestroy(); // RST, mid-resolve
  await new Promise((resolve) => setTimeout(resolve, 500)); // the resolve finishes
  // still serving: an unhandled socket 'error' would have killed this process
  assert.equal(await upgradeStatus('/nope'), 404);
  process.off('uncaughtException', onUncaught);
  assert.deepEqual(uncaught.map((e) => e.message), []);
});

test('a browser page (Origin header) is refused on the CDP WebSockets', async () => {
  assert.equal(await upgradeStatus('/devtools/browser/x', 'Origin: https://evil.example\r\n'), 403);
  assert.equal(await upgradeStatus('/devtools/page/x', 'Origin: http://127.0.0.1\r\n'), 403);
});
