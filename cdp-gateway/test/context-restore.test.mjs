import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { restoreTabs } from '../src/context-restore.mjs';

// Restored targets may exist before their documents load. Advance the clock
// on discovery to exercise deferred tabs and slow navigation in short tests.
function restoredBrowser(t, { deferred = false, readyAt = 0, missing = false } = {}) {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const key = '__agentene_restore_test';
  const url = 'http://fixture.test/same';
  const tabs = ['first', 'second'].map((id) => ({ id, url, marked: true }));
  const pages = new Map([...tabs].reverse().map((tab) => [`physical-${tab.id}`, {
    active: !deferred,
    storage: new Map([['business', tab.id], ...(missing && tab.id === 'second' ? [] : [[key, tab.id]])]),
  }]));
  const sessions = new Map();
  const attached = [];
  const closed = [];
  let serial = 0;
  const pipe = {
    async call(method, params = {}, options = {}) {
      if (method === 'Target.createTarget') {
        pages.set('bootstrap', { active: true, storage: new Map() });
        return { targetId: 'bootstrap' };
      }
      if (method === 'Target.getTargets') {
        now += 1000;
        return { targetInfos: [...pages.keys()].map((targetId) => ({ targetId, type: 'page', url })) };
      }
      if (method === 'Target.activateTarget') { pages.get(params.targetId).active = true; return {}; }
      if (method === 'Target.attachToTarget') {
        const sessionId = `session-${++serial}`;
        sessions.set(sessionId, params.targetId);
        attached.push(params.targetId);
        return { sessionId };
      }
      if (method === 'Target.detachFromTarget') { sessions.delete(params.sessionId); return {}; }
      if (method === 'Target.closeTarget') { closed.push(params.targetId); pages.delete(params.targetId); return { success: true }; }
      assert.equal(method, 'Runtime.evaluate');
      const page = pages.get(sessions.get(options.sessionId));
      if (now < readyAt) throw new Error('Cannot find context with specified id');
      const value = runInNewContext(params.expression, { sessionStorage: {
        getItem: (name) => page.active ? page.storage.get(name) ?? null : null,
        removeItem: (name) => page.storage.delete(name),
      } });
      return { result: { value } };
    },
  };
  return { context: { pipe, snapshot: { key, tabs } }, pages, sessions, attached, closed, time: () => now };
}

test('native restore loads deferred tabs and matches duplicate URLs by identity', async (t) => {
  const browser = restoredBrowser(t, { deferred: true });
  const pages = await restoreTabs(browser.context, true);
  assert.deepEqual(pages.map((p) => [p.id, p.physical, p.navigate]), [
    ['first', 'physical-first', false], ['second', 'physical-second', false],
  ]);
  assert.ok(!browser.attached.includes('bootstrap'), 'the bootstrap tab is not a saved tab');
  assert.deepEqual(browser.closed, ['bootstrap']);
  assert.equal(browser.sessions.size, 0);
  for (const [id, page] of browser.pages) {
    assert.deepEqual([...page.storage], [['business', id.slice('physical-'.length)]]);
  }
});

test('native restore waits for documents that become readable after five seconds', async (t) => {
  const browser = restoredBrowser(t, { readyAt: 7000 });
  const pages = await restoreTabs(browser.context, true);
  assert.equal(pages.length, 2);
  assert.ok(pages.every((p) => !p.navigate));
  assert.equal(browser.sessions.size, 0, 'failed probes detach their sessions too');
});

test('native restore still rejects missing identity on an identical URL within a bounded wait', async (t) => {
  const browser = restoredBrowser(t, { missing: true });
  await assert.rejects(restoreTabs(browser.context, true), /native tab identity could not be verified/);
  assert.ok(browser.time() <= 20_000, 'a missing marker must not wait forever');
  assert.deepEqual(browser.closed, ['bootstrap']);
  assert.equal(browser.sessions.size, 0);
});
