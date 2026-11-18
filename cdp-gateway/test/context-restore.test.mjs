import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { restoreTabs } from '../src/context-restore.mjs';

// Restored targets may exist before their documents load. Advance the clock
// on discovery to exercise slow navigation without changing tab selection.
function restoredBrowser(t, { readyAt = 0, missing = false, loaded = false } = {}) {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const key = '__agentene_restore_test';
  const url = 'http://fixture.test/same';
  const tabs = ['first', 'second', 'third', 'fourth'].map((id, i) => ({ id, url, window: Math.floor(i / 2), marked: true }));
  const selected = new Map([[0, 'physical-first'], [1, 'physical-fourth']]);
  const activations = [];
  const pages = new Map([...tabs].reverse().map((tab) => [`physical-${tab.id}`, {
    window: tab.window,
    loaded,
    storage: new Map([['business', tab.id], ...(missing && tab.id === 'second' ? [] : [[key, tab.id]])]),
  }]));
  const sessions = new Map();
  const closed = [];
  const loads = [];
  let serial = 0;
  const pipe = {
    async call(method, params = {}, options = {}) {
      assert.notEqual(method, 'Target.createTarget', 'native restoration must not open a temporary page');
      if (method === 'Target.getTargets') {
        now += 1000;
        if (params.filter?.some((rule) => rule.type === 'tab')) {
          return { targetInfos: [...pages.keys()].map((id) => ({ targetId: `tab-${id}`, type: 'tab', url })) };
        }
        return { targetInfos: [...pages.keys()].map((targetId) => ({ targetId, type: 'page', url })) };
      }
      if (method === 'Target.activateTarget') {
        selected.set(pages.get(params.targetId).window, params.targetId);
        activations.push(params.targetId);
        return {};
      }
      if (method === 'Target.attachToTarget') {
        const sessionId = `session-${++serial}`;
        sessions.set(sessionId, params.targetId);
        if (params.targetId.startsWith('tab-')) {
          // Chromium loads a deferred WebContents when its tab target is
          // attached, without selecting it or reloading a live renderer.
          const page = pages.get(params.targetId.slice(4));
          if (!page.loaded) { page.loaded = true; loads.push(params.targetId); }
        }
        return { sessionId };
      }
      if (method === 'Target.detachFromTarget') { sessions.delete(params.sessionId); return {}; }
      if (method === 'Target.closeTarget') { closed.push(params.targetId); pages.delete(params.targetId); return { success: true }; }
      assert.equal(method, 'Runtime.evaluate');
      const page = pages.get(sessions.get(options.sessionId));
      if (!page.loaded || now < readyAt) throw new Error('Cannot find context with specified id');
      const value = runInNewContext(params.expression, { sessionStorage: {
        getItem: (name) => page.storage.get(name) ?? null,
        removeItem: (name) => page.storage.delete(name),
      } });
      return { result: { value } };
    },
  };
  return { context: { pipe, snapshot: { key, tabs } }, pages, selected, activations, sessions, closed, loads, time: () => now };
}

test('native restore preserves each window selection while matching duplicate URLs by identity', async (t) => {
  const browser = restoredBrowser(t);
  const selected = new Map(browser.selected);
  const pages = await restoreTabs(browser.context, true);
  assert.deepEqual(pages.map((p) => [p.id, p.physical, p.navigate]), [
    ['first', 'physical-first', false], ['second', 'physical-second', false],
    ['third', 'physical-third', false], ['fourth', 'physical-fourth', false],
  ]);
  assert.deepEqual(browser.selected, selected, 'the other window must retain its selected tab');
  assert.deepEqual(browser.activations, [], 'identity probes must not generate focus/visibility transitions');
  assert.equal(browser.loads.length, 4, 'deferred documents must be loaded in the background');
  assert.deepEqual(browser.closed, [], 'native restoration must not close any page');
  assert.equal(browser.sessions.size, 0);
  for (const [id, page] of browser.pages) {
    assert.deepEqual([...page.storage], [['business', id.slice('physical-'.length)]]);
  }
});

test('native restore waits for documents that become readable after five seconds', async (t) => {
  const browser = restoredBrowser(t, { readyAt: 7000 });
  const pages = await restoreTabs(browser.context, true);
  assert.equal(pages.length, 4);
  assert.ok(pages.every((p) => !p.navigate));
  assert.deepEqual(browser.activations, [], 'slow loading must not cause tab switching');
  assert.equal(browser.loads.length, 4, 'retrying identity must not load a document twice');
  assert.equal(browser.sessions.size, 0, 'failed probes detach their sessions too');
});

test('native restore does not reload documents that are already loaded', async (t) => {
  const browser = restoredBrowser(t, { loaded: true });
  await restoreTabs(browser.context, true);
  assert.deepEqual(browser.loads, []);
  assert.deepEqual(browser.activations, []);
  assert.equal(browser.sessions.size, 0);
});

test('native restore still rejects missing identity on an identical URL within a bounded wait', async (t) => {
  const browser = restoredBrowser(t, { missing: true });
  await assert.rejects(restoreTabs(browser.context, true), /native tab identity could not be verified \(3\/4 tabs/);
  assert.ok(browser.time() <= 20_000, 'a missing marker must not wait forever');
  assert.deepEqual(browser.closed, []);
  assert.equal(browser.sessions.size, 0);
});
