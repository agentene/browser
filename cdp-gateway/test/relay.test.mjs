// /devtools/page relay against a fake chromium page endpoint (node --test),
// reached the way the relay reaches a browser's pipe (fake-upstream.mjs).

import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { openRelays, relay } from '../src/relay.mjs';
import { wsConnection } from './fake-upstream.mjs';

class FakeClient extends EventEmitter {
  readyState = WebSocket.OPEN;
  sent = [];

  send(data, opts) {
    this.sent.push([data.toString(), opts.binary]);
    this.emit('sent');
  }

  close() {
    this.terminate();
  }

  terminate() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
}

test('frames go both ways as text', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const got = [];
  server.on('connection', (ws) => ws.on('message', (data, isBinary) => {
    got.push([data.toString(), isBinary]);
    ws.send(JSON.stringify({ id: JSON.parse(data).id, result: {} }));
  }));
  const client = new FakeClient();
  const before = openRelays();
  relay(client, await wsConnection(`ws://127.0.0.1:${server.address().port}/devtools/page/X`));
  assert.equal(openRelays(), before + 1);
  client.emit('message', Buffer.from('{"id":1,"method":"Runtime.enable"}'), false);
  await once(client, 'sent');
  client.emit('message', Buffer.from('{"id":2,"method":"Runtime.evaluate"}'), false);
  await once(client, 'sent');
  assert.deepEqual(got, [['{"id":1,"method":"Runtime.enable"}', false], ['{"id":2,"method":"Runtime.evaluate"}', false]]);
  assert.deepEqual(client.sent, [['{"id":1,"result":{}}', false], ['{"id":2,"result":{}}', false]]);
  client.terminate();
  assert.equal(openRelays(), before);
  server.close();
});

test('a closing upstream (the page closed) closes the client', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  server.on('connection', (ws) => setImmediate(() => ws.close()));
  const client = new FakeClient();
  const before = openRelays();
  relay(client, await wsConnection(`ws://127.0.0.1:${server.address().port}/devtools/page/X`));
  await once(client, 'close');
  assert.equal(openRelays(), before);
  server.close();
});

test('Browser.close on a page WebSocket closes that connection only, never reaching chromium', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const got = [];
  server.on('connection', (ws) => ws.on('message', (data) => got.push(data.toString())));
  const client = new FakeClient();
  relay(client, await wsConnection(`ws://127.0.0.1:${server.address().port}/devtools/page/X`));
  client.emit('message', Buffer.from('{"id":1,"method":"Browser.crash"}'), false);
  assert.match(client.sent[0][0], /"error".*Browser\.crash refused/);
  client.emit('message', Buffer.from('{"id":2,"method":"Browser.close"}'), false);
  assert.deepEqual(client.sent[1], ['{"id":2,"result":{}}', false]);
  assert.equal(client.readyState, WebSocket.CLOSED);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(got, []);
  server.close();
});

// A relay on a fake page endpoint that records what reaches it.
async function fakePage() {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const got = [];
  server.on('connection', (ws) => ws.on('message', (data) => {
    got.push(data.toString());
    const { id } = JSON.parse(data);
    ws.send(JSON.stringify({ id, result: {} }));
  }));
  const client = new FakeClient();
  relay(client, await wsConnection(`ws://127.0.0.1:${server.address().port}/devtools/page/X`));
  const sendAndWait = async (frame) => {
    const n = client.sent.length;
    client.emit('message', Buffer.from(frame), false);
    while (client.sent.length === n) await once(client, 'sent');
    return JSON.parse(client.sent[n][0]);
  };
  return { server, got, client, sendAndWait };
}

test('a frame JSON.parse rejects is answered with a parse error, never forwarded', async () => {
  const { server, got, client, sendAndWait } = await fakePage();
  const reply = await sendAndWait('{"id":11,"method":"Browser.close","params":{"a":"\t"}}');
  assert.equal(reply.error.code, -32700);
  assert.equal(client.readyState, WebSocket.OPEN);
  assert.deepEqual(await sendAndWait('{"id":12,"method":"Runtime.enable"}'), { id: 12, result: {} });
  assert.deepEqual(got, ['{"id":12,"method":"Runtime.enable"}']);
  client.terminate();
  server.close();
});

test('file paths outside CDP_FILE_DIRS are refused on a page WebSocket; checked frames go re-serialized', async () => {
  const { server, got, client, sendAndWait } = await fakePage();
  const refused = await sendAndWait('{"id":1,"method":"DOM.setFileInputFiles","params":{"files":["/browser/settings/auth.json"],"nodeId":5}}');
  assert.match(refused.error.message, /outside CDP_FILE_DIRS/);
  const escaped = await sendAndWait('{"id":2,"method":"Input.\\u0064ispatchDragEvent","params":{"type":"drop","x":1,"y":1,"data":{"items":[],"files":["/etc/shadow"],"dragOperationsMask":1}}}');
  assert.match(escaped.error.message, /outside CDP_FILE_DIRS/);
  // a duplicate key is read as JSON.parse reads it (the last), and that is
  // what chromium gets
  await sendAndWait('{"id":3,"method":"DOM.setFileInputFiles","params":{"files":["/etc/passwd"],"files":["/browser/downloads/a.txt"],"nodeId":5}}');
  await sendAndWait('{"id":4,"method":"Page.setDownloadBehavior","params":{"behavior":"allow","downloadPath":"/browser/settings"}}');
  assert.deepEqual(got, [
    '{"id":3,"method":"DOM.setFileInputFiles","params":{"files":["/browser/downloads/a.txt"],"nodeId":5}}',
    '{"id":4,"method":"Page.setDownloadBehavior","params":{"behavior":"allow","downloadPath":"/browser/downloads"}}',
  ]);
  // everything else too goes as the command the check read
  await sendAndWait('{"id":5, "method":"Runtime.evaluate","params":{"expression":"1"}}');
  assert.equal(got[2], '{"id":5,"method":"Runtime.evaluate","params":{"expression":"1"}}');
  client.terminate();
  server.close();
});
