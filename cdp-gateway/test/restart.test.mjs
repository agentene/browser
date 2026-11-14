import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { consoleRoute } from '../src/routes-console.mjs';
import { createShutdown } from '../src/shutdown.mjs';

async function request(method, { headers = { 'x-cdp-console': '1' }, restart } = {}) {
  const res = Object.assign(new EventEmitter(), {
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); },
  });
  await consoleRoute({ method, headers }, res, new URL('http://gateway/console/api/restart'), restart);
  return res;
}

test('restart advertises availability and requires a POST with the console header', async () => {
  assert.deepEqual((await request('GET')).body, { enabled: true });
  assert.equal((await request('POST', { headers: {} })).status, 403);
  assert.equal((await request('DELETE')).status, 405);
  assert.equal((await request('POST')).status, 503);
});

test('restart is requested only after the accepted response finishes', async () => {
  let called = 0;
  const res = await request('POST', { restart: () => { called++; } });
  assert.equal(res.status, 202);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(called, 0);
  res.emit('finish');
  res.emit('finish');
  assert.equal(called, 1);
});

test('disabled restart advertises no button and rejects the write', () => {
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { consoleRoute } from ${JSON.stringify(new URL('../src/routes-console.mjs', import.meta.url).href)};
    for (const method of ['GET', 'POST']) {
      const res = { writeHead(status) { assert.equal(status, method === 'GET' ? 200 : 403); }, end(body) {
        if (method === 'GET') assert.equal(JSON.parse(body).enabled, false);
      } };
      await consoleRoute({ method, headers: { 'x-cdp-console': '1' } }, res,
        new URL('http://gateway/console/api/restart'), () => assert.fail('must not restart'));
    }
  `], { env: { ...process.env, CDP_CONSOLE_RESTART: 'false' } });
});

test('concurrent shutdowns drain connections once and wait for every browser', async () => {
  const calls = [];
  let finishMain, finishContext;
  const main = new Promise((r) => { finishMain = r; });
  const context = new Promise((r) => { finishContext = r; });
  const shutdown = createShutdown({
    server: { close() { calls.push('server'); } },
    sockets: new Set([{ destroy() { calls.push('socket'); } }]),
    contexts: {
      size: 1,
      close() { calls.push('contexts'); },
      values() { return [{ destroy() { return context; } }]; },
    },
    mainBrowser: { close() { calls.push('main'); return main; } },
    exit: (code) => calls.push(code),
  });
  const first = shutdown('console restart');
  assert.equal(shutdown('SIGTERM'), first);
  assert.deepEqual(calls, ['contexts', 'main', 'server', 'socket']);
  finishContext();
  await Promise.resolve();
  assert.equal(calls.includes(0), false);
  finishMain();
  await first;
  assert.deepEqual(calls, ['contexts', 'main', 'server', 'socket', 0]);
});

test('a failed context cleanup does not skip the main browser or prevent exit', async () => {
  let mainClosed = false, exitCode;
  const shutdown = createShutdown({
    server: { close() {} }, sockets: [],
    contexts: { size: 1, close() {}, values: () => [{ destroy: async () => { throw new Error('cleanup failed'); } }] },
    mainBrowser: { async close() { mainClosed = true; } },
    exit: (code) => { exitCode = code; },
  });
  await shutdown('console restart');
  assert.equal(mainClosed, true);
  assert.equal(exitCode, 1);
});
