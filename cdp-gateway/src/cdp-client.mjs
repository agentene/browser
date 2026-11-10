// A minimal CDP client for the gateway's own one-off commands.

import WebSocket from 'ws';
import { WS_OPTIONS } from './config.mjs';

export class CdpClient {
  static async connect(url) {
    const ws = new WebSocket(url, WS_OPTIONS);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return new CdpClient(ws);
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map(); // event method -> handler(params, sessionId)
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return; // not CDP: nothing to dispatch (and no throw in an event handler)
      }
      if (msg.method) {
        this.listeners.get(msg.method)?.(msg.params, msg.sessionId);
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
    });
    // an error is followed by 'close', which rejects what is pending; without
    // a listener it would be an uncaught exception
    ws.on('error', () => {});
    ws.on('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('CDP connection closed'));
      this.pending.clear();
    });
  }

  on(method, handler) {
    this.listeners.set(method, handler);
  }

  send(method, params = {}, { sessionId, timeout = 15000 } = {}) {
    const id = this.nextId++;
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`${method}: CDP connection closed`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: timed out after ${timeout}ms`));
      }, timeout);
      this.pending.set(id, {
        method,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  close() {
    this.ws.close();
  }
}
