import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { consoleRoute } from '../src/routes-console.mjs';
import { contexts } from '../src/contexts.mjs';
import { mainBrowser } from '../src/main-browser.mjs';

async function request(method, path, headers = { 'x-cdp-console': '1' }) {
  const res = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
  await consoleRoute({ method, headers }, res, new URL(`http://gateway/console/api/${path}`));
  return res;
}

test('console actions reject writes without the console header', async () => {
  assert.equal((await request('POST', 'browsers', {})).status, 403);
  assert.equal((await request('DELETE', 'main/tabs/a', {})).status, 403);
});

test('tab closure checks the named browser and page type before sending close', async () => {
  const calls = [];
  mainBrowser.state = 'running';
  mainBrowser.pipe = { async call(method, { targetId }) {
    calls.push([method, targetId]);
    if (method === 'Target.getTargetInfo') {
      if (targetId === 'missing') throw new Error('missing');
      return { targetInfo: { type: targetId === 'worker' ? 'worker' : 'page' } };
    }
    return { success: targetId !== 'refused' };
  } };
  try {
    assert.equal((await request('DELETE', 'context-missing/tabs/page')).status, 404);
    assert.equal((await request('DELETE', 'main/tabs/missing')).status, 404);
    assert.equal((await request('DELETE', 'main/tabs/worker')).status, 404);
    assert.equal((await request('DELETE', 'main/tabs/page')).status, 200);
    assert.equal((await request('DELETE', 'main/tabs/refused')).status, 409);
    assert.deepEqual(calls.filter(([m]) => m === 'Target.closeTarget'), [['Target.closeTarget', 'page'], ['Target.closeTarget', 'refused']]);
  } finally { mainBrowser.state = 'stopped'; mainBrowser.pipe = null; }
});

test('console creation opens a blank page and cleans up a failed creation', async () => {
  const original = contexts.create;
  let fail = false, destroyed = false;
  contexts.create = async (owner) => {
    assert.equal(owner, 'console');
    return { name: 'context-test', pipe: { async call(method, params) {
      assert.equal(method, 'Target.createTarget');
      assert.deepEqual(params, { url: 'about:blank' });
      if (fail) throw new Error('startup failed');
    } }, async destroy() { destroyed = true; } };
  };
  try {
    assert.equal((await request('POST', 'browsers')).status, 201);
    assert.equal(destroyed, false);
    fail = true;
    await assert.rejects(request('POST', 'browsers'), /startup failed/);
    assert.equal(destroyed, true);
    assert.equal((await request('PUT', 'browsers')).status, 405);
  } finally { contexts.create = original; }
});

test('disabled console actions advertise no controls and refuse both writes', () => {
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { consoleRoute } from ${JSON.stringify(new URL('../src/routes-console.mjs', import.meta.url).href)};
    for (const [method, path, expected] of [['GET', 'browsers', 200], ['POST', 'browsers', 403], ['DELETE', 'main/tabs/a', 403]]) {
      const res = { writeHead(status) { assert.equal(status, expected); }, end(body) {
        if (method === 'GET') assert.equal(JSON.parse(body).enabled, false);
      } };
      await consoleRoute({ method, headers: { 'x-cdp-console': '1' } }, res, new URL('http://gateway/console/api/' + path));
    }
  `], { env: { ...process.env, CDP_CONSOLE_ACTIONS: 'false' } });
});
