import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { subscribe } from '../src/console-live.mjs';
import { contexts } from '../src/contexts.mjs';
import { mainBrowser } from '../src/main-browser.mjs';
import { Mux } from '../src/mux.mjs';
import { relay } from '../src/relay.mjs';

const tab = (id) => ({ id, title: id, url: `http://fixture.test/${id}` });

function browser(name, ids) {
  const context = { name, state: 'running', snapshot: null, logicalTarget: (id) => id, physicalTarget: (id) => id };
  context.active = ids[0];
  context.pipe = Object.assign(new EventEmitter(), {
    async call(method) {
      assert.equal(method, 'Target.getTargets');
      return { targetInfos: ids.flatMap((id) => [
        { ...tab(id), type: 'page', targetId: id },
        { type: 'tab', targetId: 'tab-' + id, embedderData: { tabActive: context.active === id } },
      ]) };
    },
    async connect({ targetId }) {
      if (!targetId.startsWith('tab-')) throw new Error('no thumbnails in this fixture');
      return Object.assign(new EventEmitter(), {
        readyState: 1, targets: new Map(),
        send({ id, method }) {
          assert.equal(method, 'Target.setAutoAttach');
          this.targets.set('child', targetId.slice(4));
          this.emit('message', JSON.stringify({ id, result: {} }));
        },
        close() { this.emit('close'); },
      });
    },
  });
  return context;
}

function socket() {
  return Object.assign(new EventEmitter(), {
    readyState: 1, bufferedAmount: 0, messages: [],
    send(data) { this.messages.push(...JSON.parse(data).ops); },
    close() { this.readyState = 3; this.emit('close'); },
  });
}

async function snapshot() {
  const ws = socket();
  try {
    await subscribe(ws);
    return ws.messages.findLast((op) => op.t === 'snapshot').browsers;
  } finally { ws.close(); }
}

function registry(t, browsers) {
  t.mock.method(contexts, 'names', () => browsers.map((c) => c.name));
  t.mock.method(contexts, 'get', (name) => browsers.find((c) => c.name === name));
}

function connection(pipe) {
  return Object.assign(new EventEmitter(), {
    pipe, readyState: 1, bufferedAmount: 0,
    send() {},
    close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); },
    terminate() { this.close(); },
  });
}

function mainFixture(t) {
  const { state, pipe } = mainBrowser;
  t.after(() => Object.assign(mainBrowser, { state, pipe }));
  mainBrowser.state = 'running';
  mainBrowser.pipe = browser('main', []).pipe;
}

test('console reports idle CDP owners per browser, even while their context is asleep or stopped', async (t) => {
  const context = browser('context-clients', []);
  const unowned = browser('context-console', []);
  registry(t, [context, unowned]);
  mainFixture(t);
  const states = async () => Object.fromEntries((await snapshot()).map((b) => [b.name, b.hasClients]));
  const empty = { main: false, [context.name]: false, [unowned.name]: false };
  assert.deepEqual(await states(), empty, 'console subscriptions and internal probes are not clients');

  const client = connection();
  const mux = new Mux(client, 'test', null);
  const other = connection();
  const otherMux = new Mux(other, 'test', null);
  t.after(() => { client.close(); other.close(); });
  context.connect = async () => connection(context.pipe);
  context.destroy = () => {};
  t.mock.method(contexts, 'create', async () => context);
  await mux.attachContext({ id: 1, params: {} });
  assert.deepEqual(await states(), { ...empty, [context.name]: true }, 'an idle context owner need not use main');

  for (const state of ['hibernated', 'stopped']) {
    context.state = state;
    context.pipe = null;
    assert.deepEqual(await states(), { ...empty, [context.name]: true }, `${state} keeps its owner connected`);
  }
  mux.adoptMain(connection(mainBrowser.pipe));
  otherMux.adoptMain(connection(mainBrowser.pipe));
  assert.deepEqual(await states(), { ...empty, main: true, [context.name]: true });
  mux.main.close();
  assert.deepEqual(await states(), { ...empty, main: true, [context.name]: true }, 'another main client remains');
  other.close();
  assert.deepEqual(await states(), { ...empty, [context.name]: true }, 'main disconnection leaves the context owner');
  client.close();
  assert.deepEqual(await states(), empty, 'a closed client no longer prompts');
});

test('console counts direct page clients only on their browser and removes disconnected ones', async (t) => {
  const context = browser('context-page-client', []);
  registry(t, [context]);
  mainFixture(t);
  const states = async () => Object.fromEntries((await snapshot()).map((b) => [b.name, b.hasClients]));
  const client = connection();
  const upstream = connection(context.pipe);
  const mainClient = connection();
  t.after(() => { client.close(); mainClient.close(); });
  relay(client, upstream);
  assert.deepEqual(await states(), { main: false, [context.name]: true });
  relay(mainClient, connection(mainBrowser.pipe));
  assert.deepEqual(await states(), { main: true, [context.name]: true });
  upstream.close();
  assert.equal(client.readyState, 3);
  assert.deepEqual(await states(), { main: true, [context.name]: false });
  // A stale upstream must not make a replacement browser look connected.
  mainBrowser.pipe = browser('main-restarted', []).pipe;
  assert.deepEqual(await states(), { main: false, [context.name]: false });
  mainClient.close();
  assert.deepEqual(await states(), { main: false, [context.name]: false });
});

test('console keeps tab rows, order and current selection throughout capture and wake', async (t) => {
  const context = browser('context-live', ['third', 'second', 'first']);
  registry(t, [context]);
  const ws = socket();
  await subscribe(ws);
  try {
    const before = ws.messages.find((op) => op.t === 'snapshot').browsers.find((b) => b.name === context.name);
    const ids = before.tabs.map((tab) => tab.id);
    assert.deepEqual(ids, ['first', 'second', 'third']);
    assert.equal(before.current, 'third');
    ws.messages = [];
    for (let round = 0; round < 2; round++) {
      // Round 1 has no snapshot yet; round 2 still has the previous one.
      // Neither is a replacement for the visible list during capture.
      context.state = 'hibernating';
      let card = (await snapshot()).find((b) => b.name === context.name);
      assert.equal(card.state, 'hibernating', 'status must update even when tab rows are held');
      assert.deepEqual(card.tabs.map((tab) => tab.id), ids);
      context.snapshot = { tabs: ids.map(tab), current: before.current };
      context.state = 'hibernated';
      card = (await snapshot()).find((b) => b.name === context.name);
      assert.deepEqual(card.tabs.map((tab) => tab.id), ids, 'snapshot order must not reorder existing rows');
      context.state = 'waking';
      card = (await snapshot()).find((b) => b.name === context.name);
      assert.deepEqual(card.tabs.map((tab) => tab.id), ids);
      context.state = 'running';
      card = (await snapshot()).find((b) => b.name === context.name);
      assert.deepEqual(card.tabs.map((tab) => tab.id), ids);
      // Deliberately stale on the next capture; this must not remove rows.
      context.snapshot = { tabs: [tab('first')], current: 'first' };
    }
    assert.deepEqual(ws.messages.filter((op) => op.t === 'tabs' || op.t === 'current'), [],
      'hibernation must not delete/reinsert rows or clear the selection');
    // Genuine closure still clears rows promptly.
    context.state = 'closing';
    const closed = (await snapshot()).find((b) => b.name === context.name);
    assert.deepEqual(closed.tabs, []);
    assert.equal(closed.current, null);
  } finally { ws.close(); }
});

test('a running tab probe finishing during hibernation cannot publish shutdown targets', async (t) => {
  const context = browser('context-capture-race', ['saved']);
  registry(t, [context]);
  const ws = socket();
  await subscribe(ws);
  const entered = Promise.withResolvers();
  const query = Promise.withResolvers();
  const call = context.pipe.call.bind(context.pipe);
  t.mock.method(context.pipe, 'call', (method, ...args) => {
    if (method !== 'Target.getTargets') return call(method, ...args);
    entered.resolve();
    return query.promise;
  });
  try {
    const reading = snapshot();
    await entered.promise;
    context.state = 'hibernating';
    query.resolve({ targetInfos: [] });
    const card = (await reading).find((b) => b.name === context.name);
    assert.equal(card.state, 'hibernating');
    assert.deepEqual(card.tabs.map((tab) => tab.id), ['saved']);
  } finally { query.resolve({ targetInfos: [] }); ws.close(); }
});

test('another browser\'s slow probe cannot publish ids from a replaced process', async (t) => {
  const context = browser('context-process-race', ['saved']);
  const other = browser('context-slow', []);
  registry(t, [context, other]);
  const ws = socket();
  await subscribe(ws);
  const entered = Promise.withResolvers();
  const query = Promise.withResolvers();
  t.mock.method(other.pipe, 'call', () => { entered.resolve(); return query.promise; });
  try {
    const reading = snapshot();
    await entered.promise;
    // The first browser's query can already have finished before this wake.
    context.pipe = browser('new-process', ['replacement']).pipe;
    const translated = [];
    context.logicalTarget = (id) => { translated.push(id); return 'saved'; };
    query.resolve({ targetInfos: [] });
    const card = (await reading).find((b) => b.name === context.name);
    assert.deepEqual(card.tabs.map((tab) => tab.id), ['saved']);
    assert.ok(!translated.includes('saved'), 'old physical ids must not be translated after wake');
  } finally {
    context.state = 'hibernating';
    query.resolve({ targetInfos: [] }); ws.close();
  }
});
