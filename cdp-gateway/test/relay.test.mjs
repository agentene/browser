// /devtools/page relay against a fake chromium page endpoint (node --test).

import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { openRelays, relay } from '../src/relay.mjs';

class FakeClient extends EventEmitter {
  readyState = WebSocket.OPEN;
  sent = [];

  send(data, opts) {
    this.sent.push([data.toString(), opts.binary]);
    this.emit('sent');
  }

  terminate() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
}

test('frames sent before the upstream is open keep their type, both ways', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const got = [];
  server.on('connection', (ws) => ws.on('message', (data, isBinary) => {
    got.push([data.toString(), isBinary]);
    ws.send(JSON.stringify({ id: JSON.parse(data).id, result: {} }));
  }));
  const client = new FakeClient();
  const before = openRelays();
  relay(client, `ws://127.0.0.1:${server.address().port}/devtools/page/X`);
  assert.equal(openRelays(), before + 1);
  // ws hands text frames over as Buffers: before the fix these went out binary
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
