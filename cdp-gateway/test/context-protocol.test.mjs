import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProtocolIds } from '../src/context-protocol.mjs';
import { ContextJournal, helperScript } from '../src/context-journal.mjs';
import { EventEmitter } from 'node:events';
import { ContextSession } from '../src/context-session.mjs';

const fetchReplies = ['continueRequest', 'continueResponse', 'fulfillRequest', 'failRequest', 'continueWithAuth'];
const schema = { domains: [
  { domain: 'Target', types: [{ id: 'TargetID', type: 'string' }, { id: 'SessionID', type: 'string' }] },
  { domain: 'Fetch', types: [{ id: 'RequestId', type: 'string' }],
    commands: fetchReplies.map((name) => ({ name, parameters: [{ name: 'requestId', $ref: 'RequestId' }] })),
    events: ['requestPaused', 'authRequired'].map((name) => ({ name, parameters: [{ name: 'requestId', $ref: 'RequestId' }] })) },
  { domain: 'Page', types: [{ id: 'FrameId', type: 'string' }] },
  { domain: 'Network', types: [{ id: 'RequestId', type: 'string' }, { id: 'LoaderId', type: 'string' }],
    events: [{ name: 'requestWillBeSent', parameters: [{ name: 'requestId', $ref: 'RequestId' }, { name: 'loaderId', $ref: 'LoaderId' }] }] },
  { domain: 'Runtime', types: [
    { id: 'ExecutionContextId', type: 'integer' }, { id: 'RemoteObjectId', type: 'string' },
    { id: 'RemoteObject', type: 'object', properties: [{ name: 'objectId', $ref: 'RemoteObjectId' }, { name: 'value', type: 'any' }] },
    { id: 'ExecutionContextDescription', type: 'object', properties: [{ name: 'id', $ref: 'ExecutionContextId' }, { name: 'uniqueId', type: 'string' }, { name: 'auxData', type: 'object' }] },
  ], commands: [
    { name: 'evaluate', parameters: [{ name: 'contextId', $ref: 'ExecutionContextId' }], returns: [{ name: 'result', $ref: 'RemoteObject' }] },
    { name: 'callFunctionOn', parameters: [{ name: 'objectId', $ref: 'RemoteObjectId' }, { name: 'arguments', type: 'array', items: { type: 'object', properties: [{ name: 'objectId', $ref: 'RemoteObjectId' }, { name: 'value', type: 'any' }] } }] },
  ], events: [{ name: 'executionContextCreated', parameters: [{ name: 'context', $ref: 'ExecutionContextDescription' }] }] },
] };

test('typed rewrites leave application objectId/sessionId/frameId properties untouched', () => {
  const ids = new ProtocolIds(schema);
  ids.restart();
  ids.bind('object', 'physical', 'logical', 'page');
  const payload = { objectId: 'logical', sessionId: 's', frameId: 'f' };
  const out = ids.translate('Runtime.callFunctionOn', { objectId: 'logical', arguments: [{ objectId: 'logical' }, { value: payload }] }, 'params', 'in', 'page');
  assert.equal(out.objectId, 'physical');
  assert.equal(out.arguments[0].objectId, 'physical');
  assert.deepEqual(out.arguments[1].value, payload);
  const result = ids.translate('Runtime.evaluate', { result: { objectId: 'physical', value: payload } }, 'result', 'out', 'page');
  assert.equal(result.result.objectId, 'logical');
  assert.deepEqual(result.result.value, payload);
});

test('new pages after a restart advertise the logical frame in Runtime auxData', () => {
  const ids = new ProtocolIds(schema);
  ids.restart();
  const frame = ids.id('target', 'physical-frame', 'out');
  const event = ids.translate('Runtime.executionContextCreated', { context: { id: 1, uniqueId: 'world', auxData: { frameId: 'physical-frame', isDefault: true } } }, 'event', 'out', 'page');
  assert.equal(event.context.auxData.frameId, frame);
  assert.equal(event.context.auxData.isDefault, true);
  assert.equal(ids.id('world', event.context.id, 'in', 'page'), 1);
});

test('document request and loader identity remains equal after translation', () => {
  const ids = new ProtocolIds(schema);
  ids.restart();
  const event = ids.translate('Network.requestWillBeSent', { requestId: 'document', loaderId: 'document' }, 'event', 'out', 'page');
  assert.equal(event.requestId, event.loaderId);
});

test('detaching a sleeping browser session retires its children without waking', () => {
  const upstream = new EventEmitter();
  upstream.close = () => upstream.emit('close');
  const context = { wake() { throw new Error('must not wake for detach'); } };
  const session = new ContextSession(context, upstream, schema);
  session.entry('browser-session', 'browser-target', 'browser', '');
  session.entry('page-session', 'page-target', 'page', 'browser-session');
  session.mode = 'suspended';
  const replies = [];
  session.on('message', (data) => replies.push(JSON.parse(data)));
  session.send({ id: 1, method: 'Target.detachFromTarget', params: { sessionId: 'browser-session' } });
  assert.equal(session.sessions.size, 1); // root only
  assert.deepEqual(replies.filter((m) => m.method).map((m) => m.params.sessionId), ['browser-session', 'page-session']);
  assert.deepEqual(replies.at(-1).result, {});
  session.close();
});

test('handles cannot cross sessions or survive restart unless explicitly rebuilt', () => {
  const ids = new ProtocolIds(schema);
  ids.bind('object', 'before', 'helper', 'a');
  ids.bind('object', 'old-node', 'element', 'a');
  ids.restart();
  ids.bind('object', 'after', 'helper', 'a');
  assert.equal(ids.id('object', 'helper', 'in', 'a'), 'after');
  assert.throws(() => ids.id('object', 'helper', 'in', 'b'), /unknown/);
  assert.throws(() => ids.id('object', 'element', 'in', 'a'), /stale/);
});

for (const mode of ['quiescing', 'suspended']) {
  test(`late interception replies cannot wake a ${mode} context`, () => {
    const upstream = new EventEmitter();
    upstream.close = () => upstream.emit('close');
    upstream.send = () => assert.fail('late replies must not reach the old browser');
    const session = new ContextSession({ wake: () => assert.fail('late replies must not wake a context') }, upstream, schema);
    session.entry('page-session', 'page-target', 'page', '');
    session.receive({ method: 'Fetch.requestPaused', sessionId: 'page-session', params: { requestId: 'paused-request' } });
    if (mode === 'suspended') session.suspend();
    else session.mode = mode;
    const replies = [];
    let callbacks = 0;
    session.on('message', (data) => replies.push(JSON.parse(data)));
    for (const [id, method] of fetchReplies.entries()) {
      session.send({ id, method: `Fetch.${method}`, sessionId: 'page-session', params: { requestId: 'paused-request' } }, () => callbacks++);
      assert.equal(replies.at(-1).id, id);
      assert.equal(replies.at(-1).sessionId, 'page-session');
      assert.match(replies.at(-1).error.message, /interrupted by context hibernation/);
    }
    assert.equal(callbacks, fetchReplies.length);
    assert.equal(session.queue.length, 0);
    assert.equal(session.queueBytes, 0);
    assert.equal(session.pending.size, 0);
    session.close();
  });
}

test('restoration accepts current interception replies and rejects old ones even when physical ids repeat', () => {
  const upstream = new EventEmitter();
  upstream.close = () => upstream.emit('close');
  const sent = [];
  upstream.send = (msg, options, cb) => { sent.push(msg); cb?.(); };
  const session = new ContextSession({ wake: () => assert.fail('interception replies must bypass the wake queue') }, upstream, schema);
  session.entry('page-session', 'page-target', 'page', '');
  session.receive({ method: 'Fetch.requestPaused', sessionId: 'page-session', params: { requestId: 'reused-request' } });
  session.suspend();
  session.mode = 'restoring';
  session.ids.restart();
  session.ids.bind('session', 'new-page-session', 'page-session');
  session.adopt(upstream);
  const messages = [];
  session.on('message', (data) => messages.push(JSON.parse(data)));
  for (const mode of ['restoring', 'running']) {
    session.mode = mode;
    for (const [id, method] of fetchReplies.entries()) {
      session.receive({ method: method === 'continueWithAuth' ? 'Fetch.authRequired' : 'Fetch.requestPaused', sessionId: 'new-page-session', params: { requestId: 'reused-request' } });
      const requestId = messages.at(-1).params.requestId;
      assert.notEqual(requestId, 'reused-request');
      const count = sent.length;
      session.send({ id, method: `Fetch.${method}`, sessionId: 'page-session', params: { requestId: 'reused-request' } });
      assert.match(messages.at(-1).error.message, /stale or unknown fetch id/);
      assert.equal(sent.length, count);
      session.send({ id, method: `Fetch.${method}`, sessionId: 'page-session', params: { requestId } });
      assert.equal(sent.length, count + 1);
      assert.equal(sent.at(-1).params.requestId, 'reused-request');
      assert.equal(sent.at(-1).sessionId, 'new-page-session');
      session.receive({ id: sent.at(-1).id, sessionId: 'new-page-session', result: {} });
      assert.deepEqual(messages.at(-1), { id, sessionId: 'page-session', result: {} });
    }
  }
  assert.equal(session.queue.length, 0);
  assert.equal(session.pending.size, 0);
  session.close();
});

test('journal replays setters and registrations, never business actions or arbitrary code', () => {
  const j = new ContextJournal();
  for (const method of ['Runtime.evaluate', 'Runtime.callFunctionOn', 'Input.dispatchMouseEvent', 'Page.navigate']) {
    j.record({ method, params: { expression: 'submitPayment()' } }, {});
  }
  assert.equal(j.states.size, 0);
  assert.equal(j.helpers.size, 0);
  j.record({ method: 'Network.setExtraHTTPHeaders', params: { headers: { first: '1' } } }, {});
  j.record({ method: 'Network.setExtraHTTPHeaders', params: { headers: { second: '2' } } }, {});
  assert.equal(j.states.size, 1);
  assert.deepEqual([...j.states.values()][0].params, { headers: { second: '2' } });
  j.record({ method: 'Page.addScriptToEvaluateOnNewDocument', params: { source: 'setup()' } }, { identifier: 'init' });
  j.record({ method: 'Page.removeScriptToEvaluateOnNewDocument', params: { identifier: 'init' } }, {});
  assert.ok(!j.states.has('script:init'));
  assert.equal(helperScript('return new UtilityScript(); submitPayment()', 'UtilityScript'), false);
  j.record({ method: 'Runtime.evaluate', params: { expression: 'return new UtilityScript(); submitPayment()' } }, { result: { objectId: 'x', className: 'UtilityScript' } });
  assert.equal(j.helpers.size, 0);
  assert.ok(j.blockers.has('helper'));
});
