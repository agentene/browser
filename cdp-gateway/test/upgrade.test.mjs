// WebSocket upgrades against a real HTTP server, with the main browser
// stubbed: it takes a while to start, and hands out a recorded stand-in for
// a connection on its pipe (node --test; each test file runs in its own
// process).

import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { after, before, test } from 'node:test';
import { mainBrowser } from '../src/main-browser.mjs';

const upstreams = []; // what the stubbed pipe handed out
let gateway;

before(async () => {
  // a stopped main browser takes seconds to start: 300 ms here, the window
  // in which a client may give up
  mainBrowser.ensure = () => new Promise((resolve) => setTimeout(resolve, 300));
  mainBrowser.pipe = {
    async connect() {
      const conn = new EventEmitter();
      conn.readyState = 1;
      conn.closed = false;
      conn.close = () => { conn.closed = true; conn.readyState = 3; conn.emit('close'); };
      upstreams.push(conn);
      return conn;
    },
  };
  const { handleUpgrade } = await import('../src/upgrade.mjs');
  gateway = http.createServer();
  gateway.on('upgrade', handleUpgrade);
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
});

after(() => gateway.close());

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

test('a client resetting its connection while the target resolves crashes nothing and leaks no upstream', async () => {
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
  // the connection opened for the client that left was closed again
  assert.equal(upstreams.length, 1);
  assert.equal(upstreams[0].closed, true);
});

test('a browser page (Origin header) is refused on the CDP WebSockets', async () => {
  assert.equal(await upgradeStatus('/devtools/browser/x', 'Origin: https://evil.example\r\n'), 403);
  assert.equal(await upgradeStatus('/devtools/page/x', 'Origin: http://127.0.0.1\r\n'), 403);
});

test('a page WebSocket for a target no browser has is a 404', async () => {
  // no browser runs here: nobody owns the target
  assert.equal(await upgradeStatus('/devtools/page/NOSUCH'), 404);
});
