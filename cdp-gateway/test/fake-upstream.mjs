// A stand-in for a connection on a browser's pipe (pipe.mjs's
// PipeConnection), over a WebSocket to a fake chromium: what the Mux and the
// page relay get as their upstream. Commands go out as JSON text, frames
// come in as they were sent.

import { EventEmitter, once } from 'node:events';
import WebSocket from 'ws';

export async function wsConnection(url) {
  const ws = new WebSocket(url);
  ws.on('error', () => { /* 'close' follows */ });
  await once(ws, 'open');
  const conn = new EventEmitter();
  Object.defineProperty(conn, 'readyState', { get: () => ws.readyState });
  Object.defineProperty(conn, 'bufferedAmount', { get: () => ws.bufferedAmount });
  conn.send = (msg, options, cb) => {
    const done = typeof options === 'function' ? options : cb;
    ws.send(typeof msg === 'object' && !Buffer.isBuffer(msg) ? JSON.stringify(msg) : msg, done);
  };
  conn.pause = () => ws.pause();
  conn.resume = () => ws.resume();
  conn.close = () => ws.close();
  conn.terminate = () => ws.terminate();
  ws.on('message', (data) => conn.emit('message', data, false));
  ws.on('close', () => conn.emit('close'));
  return conn;
}
