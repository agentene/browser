import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { closeServers, listenAll } from '../src/listeners.mjs';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-listeners-'));
process.env.CDP_GATEWAY_SETTINGS_FILE = path.join(dir, 'settings.json');
const { handleCdpHttp, handleConsoleHttp } = await import('../src/http.mjs');
const { handleCdpUpgrade, handleConsoleUpgrade } = await import('../src/upgrade.mjs');
const { mainBrowser } = await import('../src/main-browser.mjs');
after(() => fs.rm(dir, { recursive: true, force: true }));

function request(socketPath, target, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: target, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function upgrade(socketPath, target, headers = '') {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath, () => socket.write(
      `GET ${target} HTTP/1.1\r\nHost: gateway\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
      + `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${headers}\r\n`,
    ));
    socket.setTimeout(3000, () => socket.destroy(new Error('upgrade timed out')));
    let response = '';
    socket.on('data', (data) => {
      response += data;
      if (!response.includes('\r\n')) return;
      resolve(Number(response.split(' ')[1]));
      socket.destroy();
    });
    socket.on('error', reject);
  });
}

async function endpoints(t) {
  const sockets = new Set();
  const listeners = [
    { path: path.join(dir, 'console.sock'), server: http.createServer(handleConsoleHttp).on('upgrade', handleConsoleUpgrade) },
    { path: path.join(dir, 'cdp.sock'), server: http.createServer(handleCdpHttp).on('upgrade', handleCdpUpgrade) },
  ];
  for (const { server } of listeners) server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  t.after(() => closeServers(listeners.map(({ server }) => server), sockets));
  await listenAll(listeners, sockets);
  return listeners.map(({ path: socketPath }) => socketPath);
}

test('Unix HTTP listeners expose only their own routes and never start a browser for probes', async (t) => {
  const [consoleSocket, cdpSocket] = await endpoints(t);
  assert.equal((await request(consoleSocket, '/console/')).status, 200);
  assert.equal((await request(consoleSocket, '/console')).headers.location, '/console/');
  assert.equal((await request(consoleSocket, '/console/api/settings')).status, 200);
  assert.equal((await request(consoleSocket, '/console/api/nope', { method: 'DELETE' })).status, 403);
  assert.equal((await request(cdpSocket, '/json/list')).body, '[]');
  for (const target of ['/console', '/console/', '/console/api/settings', '/__auth/api/state']) {
    assert.equal((await request(cdpSocket, target, { headers: { 'X-CDP-Console': '1' } })).status, 404);
  }
  assert.equal((await request(cdpSocket, '/console/api/main/start', { method: 'POST', headers: { 'X-CDP-Console': '1' } })).status, 404);
  for (const target of ['/json/list', '/console/../json/list', '/console/%2e%2e/json/list', '/devtools/browser/x']) {
    assert.equal((await request(consoleSocket, target)).status, 404);
  }
  for (const socket of [consoleSocket, cdpSocket]) {
    assert.equal((await fs.stat(socket)).mode & 0o777, 0o666);
    for (const target of ['//console/json/list', '/console/..\\json/list']) {
      assert.equal((await request(socket, target)).status, 400);
    }
  }
  assert.equal(mainBrowser.state, 'stopped');
});

test('Unix WebSocket listeners reject cross-routing and malformed targets', async (t) => {
  const [consoleSocket, cdpSocket] = await endpoints(t);
  assert.equal(await upgrade(consoleSocket, '/console/ws', 'Origin: http://gateway\r\n'), 101);
  assert.equal(await upgrade(consoleSocket, '/console/ws', 'Origin: https://evil.example\r\n'), 403);
  assert.equal(await upgrade(consoleSocket, '/console/overlay'), 404); // no stream
  assert.equal(await upgrade(cdpSocket, '/devtools/browser/x'), 101);
  for (const target of ['/console/ws', '/console/overlay']) assert.equal(await upgrade(cdpSocket, target), 404);
  for (const target of ['/devtools/browser/x', '/devtools/page/x', '/console/../devtools/browser/x']) {
    assert.equal(await upgrade(consoleSocket, target), 404);
  }
  for (const socket of [consoleSocket, cdpSocket]) {
    for (const target of ['//console/devtools/browser/x', '/console/..\\devtools/browser/x']) {
      assert.equal(await upgrade(socket, target), 400);
    }
  }
  assert.equal(mainBrowser.state, 'stopped');
});

test('failure to open a second listener rolls back the first socket', async () => {
  const socketPath = path.join(dir, 'rollback.sock');
  const servers = [http.createServer(), http.createServer()];
  await assert.rejects(listenAll([
    { server: servers[0], path: socketPath },
    { server: servers[1], path: path.join(dir, 'missing', 'cdp.sock') },
  ], new Set()), (err) => ['ENOENT', 'EACCES'].includes(err.code));
  assert.ok(servers.every((server) => !server.listening));
  await assert.rejects(fs.stat(socketPath), { code: 'ENOENT' });
});

test('settings-only gateway creates only the console socket and removes it on shutdown', async (t) => {
  const consoleSocket = path.join(dir, 'settings-only.sock');
  const cdpSocket = path.join(dir, 'disabled-cdp.sock');
  const child = spawn(process.execPath, [new URL('../gateway.mjs', import.meta.url).pathname], {
    env: { ...process.env, CDP_GATEWAY_BROWSER_ENABLED: 'false', CONSOLE_SOCKET: consoleSocket, CDP_GATEWAY_SOCKET: cdpSocket },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`gateway startup timed out: ${stderr}`)), 5000);
    child.stdout.on('data', (data) => { if (String(data).includes('listening on')) { clearTimeout(timer); resolve(); } });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`gateway exited ${code}: ${stderr}`)); });
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
  assert.equal((await request(consoleSocket, '/console/api/settings')).status, 200);
  assert.equal((await request(consoleSocket, '/console/api/main/start', { method: 'POST', headers: { 'X-CDP-Console': '1' } })).status, 403);
  await assert.rejects(fs.stat(cdpSocket), { code: 'ENOENT' });
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  assert.deepEqual(await exited, [0, null]);
  await assert.rejects(fs.stat(consoleSocket), { code: 'ENOENT' });
});
