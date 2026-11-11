// The auth service over HTTP (node --test): server.mjs on a unix socket of
// its own with a throw-away AUTH_FILE, the way nginx talks to it.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const SERVER = path.resolve(import.meta.dirname, '../server.mjs');
const CODE = 'test-setup-code';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-server-'));
const SOCKET = path.join(dir, 'auth.sock');
const base = 'http://auth';
let proc;

// fetch's shape (status, headers.get, json) over the socket
function fetch(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: SOCKET, path: new URL(url).pathname, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({
          status: res.statusCode,
          headers: { get: (name) => [res.headers[name.toLowerCase()]].flat().join(', ') || null },
          json: async () => JSON.parse(text),
          text: async () => text,
        });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

before(async () => {
  proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, AUTH_SOCKET: SOCKET, AUTH_FILE: path.join(dir, 'auth.json'), AUTH_SETUP_CODE: CODE },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${base}/api/state`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error('auth server did not start');
});

after(() => {
  proc?.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

const call = (method, name, body) => fetch(`${base}/api/${name}`, {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

// A raw request target, as a client could send it past nginx.
function rawStatus(target) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(SOCKET, () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => resolve(Number(data.split(' ')[1])));
    socket.on('error', reject);
  });
}

test('request targets that nginx would read differently are refused', async () => {
  assert.equal(await rawStatus('/x/..\\check/cdp'), 400);
  assert.equal(await rawStatus('//x/check/cdp'), 400); // a host to the WHATWG parser
  assert.equal(await rawStatus('/api/state'), 200);
});

test('setup needs the setup code; with the login skipped, the API key guards changes', async () => {
  // no code, a wrong one: refused (and nothing is set up)
  assert.equal((await call('POST', 'setup', { skip: true })).status, 403);
  assert.equal((await call('POST', 'setup', { skip: true, code: 'nope' })).status, 403);
  assert.equal((await (await fetch(`${base}/api/state`)).json()).setUp, false);
  // the right one
  assert.equal((await call('POST', 'setup', { skip: true, code: CODE })).status, 200);
  assert.equal((await call('POST', 'setup', { skip: true, code: CODE })).status, 409);

  // no key yet: anyone (the login is off) may set one
  assert.equal((await call('PUT', 'apikey', { apiKey: 'first-key-123' })).status, 200);
  // from now on the key is needed to change it, remove it or set a login
  assert.equal((await call('PUT', 'apikey', { apiKey: '' })).status, 403);
  assert.equal((await call('PUT', 'apikey', { apiKey: '', currentApiKey: 'wrong-key-123' })).status, 403);
  assert.equal((await call('PUT', 'credentials', { username: 'mallory', password: 'password1' })).status, 403);
  assert.equal((await fetch(`${base}/check/cdp`)).status, 401, 'the key is still set');
  assert.equal((await call('PUT', 'apikey', { apiKey: 'second-key-123', currentApiKey: 'first-key-123' })).status, 200);
  assert.equal((await fetch(`${base}/check/cdp`, { headers: { 'X-API-Key': 'second-key-123' } })).status, 204);
  const login = await call('PUT', 'credentials', { username: 'admin', password: 'password1', currentApiKey: 'second-key-123' });
  assert.equal(login.status, 200);
  // with the login on, a session AND the current password are needed: a
  // session alone (a stolen or forged cookie) cannot set a key of its own
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const withSession = (method, name, body) => fetch(`${base}/api/${name}`, {
    method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body),
  });
  assert.equal((await call('PUT', 'apikey', { apiKey: '', currentPassword: 'password1' })).status, 401, 'no session');
  assert.equal((await withSession('PUT', 'apikey', { apiKey: 'mallory-key-123' })).status, 403, 'no password');
  assert.equal((await withSession('PUT', 'apikey', { apiKey: 'mallory-key-123', currentPassword: 'wrong-pass' })).status, 403, 'wrong password');
  assert.equal((await withSession('PUT', 'apikey', { apiKey: 'mallory-key-123', currentApiKey: 'second-key-123' })).status, 403, 'the key does not stand in for the password');
  assert.equal((await fetch(`${base}/check/cdp`, { headers: { 'X-API-Key': 'second-key-123' } })).status, 204, 'the key is unchanged');
  assert.equal((await withSession('PUT', 'apikey', { apiKey: '', currentPassword: 'password1' })).status, 200);
  assert.equal((await fetch(`${base}/check/cdp`)).status, 204, 'no key: the CDP API is open');
  // the same for the login itself (turning it off included)
  assert.equal((await withSession('PUT', 'credentials', { username: '', password: '' })).status, 403);
  assert.equal((await withSession('PUT', 'credentials', { username: 'mallory', password: 'password2' })).status, 403);
});
