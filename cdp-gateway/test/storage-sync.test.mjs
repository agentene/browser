// restoreLocalStorage against a fake context chromium endpoint (node --test):
// the temporary tab closes on every way out (Q1), or it would surface as a
// page of the alias context.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { restoreLocalStorage } from '../src/storage-sync.mjs';
import { wsConnection } from './fake-upstream.mjs';

// A fake context chromium: what it answers, and what reached it.
async function fakeContext(answers = {}) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const got = [];
  server.on('connection', (ws) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      got.push(msg);
      const answer = answers[msg.method];
      if (answer?.error) {
        ws.send(JSON.stringify({ id: msg.id, sessionId: msg.sessionId, error: answer.error }));
        return;
      }
      const result = { ...answer };
      ws.send(JSON.stringify({ id: msg.id, sessionId: msg.sessionId, result }));
      // the load of the navigation just answered, as chromium reports it
      if (msg.method === 'Page.navigate' && result.loaderId) {
        ws.send(JSON.stringify({
          method: 'Page.lifecycleEvent', sessionId: msg.sessionId,
          params: { name: 'load', loaderId: result.loaderId },
        }));
      }
    });
  });
  return {
    got,
    // the context browser's pipe, as restoreLocalStorage connects to it
    pipe: { connect: () => wsConnection(`ws://127.0.0.1:${server.address().port}/devtools/browser/fake`) },
    close: () => server.close(),
  };
}

test('a mid-restore failure still closes the temporary tab', async () => {
  const context = await fakeContext({
    'Target.createTarget': { targetId: 'T1' },
    'Target.attachToTarget': { sessionId: 'S1' },
    'Page.enable': { error: { code: -32000, message: 'boom' } },
  });
  try {
    const snapshot = new Map([['https://a.example', [['k', 'v']]]]);
    await assert.rejects(restoreLocalStorage(context.pipe, snapshot), /Page.enable: boom/);
    const closed = context.got.filter((m) => m.method === 'Target.closeTarget');
    assert.equal(closed.length, 1, 'the tab is closed exactly once');
    assert.deepEqual(closed[0].params, { targetId: 'T1' });
  } finally {
    context.close();
  }
});

test('a successful restore closes the tab after the last origin', async () => {
  const context = await fakeContext({
    'Target.createTarget': { targetId: 'T1' },
    'Target.attachToTarget': { sessionId: 'S1' },
    'Page.navigate': { loaderId: 'L1' },
  });
  try {
    const snapshot = new Map([
      ['https://a.example', [['k', 'v']]],
      ['http://b.example:8080', []],
    ]);
    assert.equal(await restoreLocalStorage(context.pipe, snapshot), 2);
    const methods = context.got.map((m) => m.method);
    assert.equal(methods.lastIndexOf('Target.closeTarget'), methods.length - 1, 'closed after everything else');
    assert.equal(methods.filter((m) => m === 'DOMStorage.setDOMStorageItem').length, 1);
  } finally {
    context.close();
  }
});

test('an empty snapshot touches nothing', async () => {
  const context = await fakeContext();
  try {
    assert.equal(await restoreLocalStorage(context.pipe, new Map()), 0);
    assert.deepEqual(context.got, []);
  } finally {
    context.close();
  }
});
