// One chromium's DevTools pipe (--remote-debugging-pipe), and the
// connections the gateway multiplexes over it.
//
// The browsers listen on no DevTools port. A port is reachable from inside
// the browser itself: a page opened at its own origin
// (http://127.0.0.1:<port>/json/version) may open its WebSocket, and from
// there speaks CDP past every check the gateway makes. Over a pipe chromium
// speaks CDP on file descriptors 3 (commands in) and 4 (messages out),
// NUL-separated JSON, and only its parent — the gateway — holds them.
//
// A pipe is one root session. What used to be a WebSocket of its own is a
// PipeConnection on it, and behaves like that WebSocket (send, 'message',
// 'close', pause/resume, bufferedAmount, readyState):
//   * a browser-level client gets a browser-target session
//     (Target.attachToBrowserTarget), /devtools/page/<id> a page session
//     (Target.attachToTarget, flatten);
//   * that session is implied: the client's commands without a sessionId go
//     to it, and its messages arrive without one — as on a connection of
//     its own;
//   * sessions attached through it are its own too, and no client can
//     address another connection's session (or the gateway's);
//   * command ids are mapped onto one id space per pipe, and back;
//   * contexts its client created to be disposed with its connection
//     (Target.createBrowserContext's disposeOnDetach, on by default) are
//     disposed when it closes, as chromium does for a WebSocket — chromium
//     itself disposes them only with the pipe.
// Chromium writes a reply's id first and every sessionId last, so a frame is
// routed by its two ends and passes on unparsed (screenshots, traces), the
// id and the session spliced.

import { EventEmitter } from 'node:events';
import { log } from './util.mjs';

// WebSocket readyState values, so callers test both kinds alike
export const CONNECTING = 0;
export const OPEN = 1;
export const CLOSED = 3;

const REPLY_HEAD = /^\{"id":(-?\d+)/;
const EVENT_HEAD = /^\{"method":"([^"\\]+)"/;
// the top-level sessionId: the last member, the only top-level string a
// message can end with
const SESSION_TAIL = /,"sessionId":"([^"\\]+)"\}$/;
// the attach/detach events that change which connection owns a session
const SESSION_EVENTS = new Set(['Target.attachedToTarget', 'Target.detachedFromTarget']);

const CALL_TIMEOUT_MS = 15_000;
// A client that has read nothing for this long while its browser waited for
// it (the pipe is paused for it, so all of that browser's connections are)
// is disconnected: one stalled client must not hold up the others for good.
export const STALL_MS = 60_000;

function parse(buf) {
  try {
    return JSON.parse(buf.toString());
  } catch {
    return null;
  }
}

export class CdpPipe extends EventEmitter {
  #input;
  #output;
  #partial = []; // the chunks of a frame not complete yet
  #nextId = 1;
  #calls = new Map(); // pipe id -> the gateway's own command: { method, resolve, reject }
  #forwarded = new Map(); // pipe id -> a connection's command: { conn, id, method, dispose }
  #sessions = new Map(); // sessionId -> the PipeConnection that owns it
  #stalls = new Map(); // connection whose client cannot keep up -> its stall timer
  closed = false;
  version = null; // Browser.getVersion, once the browser answered (launch.mjs)

  // input: chromium's fd 3, output: its fd 4
  constructor(input, output, label) {
    super();
    this.label = label;
    this.#input = input;
    this.#output = output;
    input.on('error', () => { /* the browser is gone: 'close' below */ });
    output.on('error', () => { /* likewise */ });
    output.on('data', (chunk) => this.#read(chunk));
    output.on('close', () => this.close());
  }

  // What waits to be written to chromium (the connections' bufferedAmount).
  get bufferedAmount() {
    return this.#input.writableLength;
  }

  // A command of the gateway's own on the root session (or one of its own
  // sessions); resolves with its result.
  call(method, params = {}, { sessionId, timeout = CALL_TIMEOUT_MS } = {}) {
    if (this.closed) return Promise.reject(new Error(`${method}: the browser is gone`));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#calls.delete(id);
        reject(new Error(`${method}: timed out after ${timeout}ms`));
      }, timeout);
      this.#calls.set(id, {
        method,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.#write({ id, method, params, sessionId });
    });
  }

  // A connection of its own for a client: a browser-target session, or with
  // targetId a session of that target (what /devtools/page/<id> was).
  async connect({ targetId } = {}, timeout = CALL_TIMEOUT_MS) {
    const { sessionId } = targetId === undefined
      ? await this.call('Target.attachToBrowserTarget', {}, { timeout })
      : await this.call('Target.attachToTarget', { targetId, flatten: true }, { timeout });
    const conn = new PipeConnection(this, sessionId);
    if (this.closed) conn.gone();
    else this.#sessions.set(sessionId, conn);
    return conn;
  }

  // Ends the pipe's side of everything (chromium exited, or is being let go).
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const call of this.#calls.values()) call.reject(new Error(`${call.method}: the browser is gone`));
    this.#calls.clear();
    this.#forwarded.clear();
    for (const conn of new Set(this.#sessions.values())) conn.gone();
    this.#sessions.clear();
    for (const timer of this.#stalls.values()) clearTimeout(timer);
    this.#stalls.clear();
    this.#input.destroy();
    this.#output.destroy();
    this.emit('close');
  }

  // --- for PipeConnection -------------------------------------------------------

  // A client's command (a parsed object) on its connection.
  send(conn, msg, cb) {
    let sessionId = conn.session;
    if (msg.sessionId !== undefined) {
      if (this.#sessions.get(msg.sessionId) !== conn) {
        // chromium's own answer for a session that is not this connection's
        if (msg.id !== undefined) {
          conn.deliverObject({ id: msg.id, error: { code: -32001, message: 'Session with given id not found.' }, sessionId: msg.sessionId });
        }
        cb?.();
        return;
      }
      sessionId = msg.sessionId;
    }
    const params = msg.params !== null && typeof msg.params === 'object' ? msg.params : {};
    if (msg.method === 'Target.disposeBrowserContext') conn.contexts.delete(params.browserContextId);
    let id;
    if (msg.id !== undefined) {
      id = this.#nextId++;
      this.#forwarded.set(id, {
        conn,
        id: msg.id,
        method: msg.method,
        dispose: msg.method === 'Target.createBrowserContext' && params.disposeOnDetach !== false,
      });
    }
    this.#write({ ...msg, id, sessionId }, cb);
  }

  // The connection closed on its client's side: its session is detached
  // (its child sessions go with it) and its contexts disposed.
  release(conn) {
    this.unstall(conn);
    for (const session of conn.sessions) this.#sessions.delete(session);
    if (this.closed) return;
    this.#write({ id: this.#nextId++, method: 'Target.detachFromTarget', params: { sessionId: conn.session } });
    for (const browserContextId of conn.contexts) {
      this.#write({ id: this.#nextId++, method: 'Target.disposeBrowserContext', params: { browserContextId } });
    }
  }

  // Flow control (flow.mjs pauses a connection whose client is behind): the
  // pipe carries every connection of the browser, so it stops being read
  // while any of them waits — for STALL_MS at most.
  stall(conn) {
    if (this.#stalls.has(conn)) return;
    this.#stalls.set(conn, setTimeout(() => {
      log(`${this.label}: a client read nothing for ${STALL_MS / 1000}s while the browser waited for it: disconnected`);
      conn.close();
    }, STALL_MS));
    this.#output.pause();
  }

  unstall(conn) {
    const timer = this.#stalls.get(conn);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.#stalls.delete(conn);
    if (!this.#stalls.size) this.#output.resume();
  }

  // --- the wire -------------------------------------------------------------------

  #write(msg, cb) {
    if (this.closed) {
      cb?.(new Error('the browser is gone'));
      return;
    }
    this.#input.write(`${JSON.stringify(msg)}\0`, cb);
  }

  #read(chunk) {
    let start = 0;
    let end;
    while ((end = chunk.indexOf(0, start)) !== -1) {
      const piece = chunk.subarray(start, end);
      const frame = this.#partial.length ? Buffer.concat([...this.#partial, piece]) : piece;
      this.#partial = [];
      start = end + 1;
      if (frame.length) this.#frame(frame);
    }
    if (start < chunk.length) this.#partial.push(chunk.subarray(start));
  }

  #frame(buf) {
    const head = buf.toString('latin1', 0, Math.min(buf.length, 64));
    const session = SESSION_TAIL.exec(buf.toString('latin1', Math.max(0, buf.length - 128)))?.[1];
    const reply = REPLY_HEAD.exec(head);
    if (reply) {
      const id = Number(reply[1]);
      const own = this.#calls.get(id);
      if (own) {
        this.#calls.delete(id);
        const msg = parse(buf);
        if (msg?.error) own.reject(new Error(`${own.method}: ${msg.error.message}`));
        else own.resolve(msg?.result ?? {});
        return;
      }
      const sent = this.#forwarded.get(id);
      if (!sent) return; // the gateway's own fire-and-forget, or a connection gone since
      this.#forwarded.delete(id);
      if (sent.dispose) {
        const contextId = parse(buf)?.result?.browserContextId;
        if (typeof contextId === 'string') sent.conn.contexts.add(contextId);
      }
      sent.conn.deliver(buf, { headLength: reply[0].length, id: sent.id, session });
      return;
    }
    const method = EVENT_HEAD.exec(head)?.[1];
    if (session === undefined) {
      this.#rootEvent(method, buf);
      return;
    }
    const conn = this.#sessions.get(session);
    if (!conn) return; // one of the gateway's own sessions, or one gone since
    if (SESSION_EVENTS.has(method)) {
      const child = parse(buf)?.params?.sessionId;
      if (typeof child === 'string') {
        if (method === 'Target.attachedToTarget') {
          this.#sessions.set(child, conn);
          conn.sessions.add(child);
        } else {
          this.#sessions.delete(child);
          conn.sessions.delete(child);
        }
      }
    }
    conn.deliver(buf, { session });
  }

  // Root session events: a connection's own session detached (its target
  // closed — the WebSocket of a page closes then) and, for the gateway's own
  // sessions, 'detached'.
  #rootEvent(method, buf) {
    if (method !== 'Target.detachedFromTarget') return;
    const sessionId = parse(buf)?.params?.sessionId;
    const conn = this.#sessions.get(sessionId);
    if (conn?.session === sessionId) {
      for (const session of conn.sessions) this.#sessions.delete(session);
      conn.gone();
    }
    this.emit('detached', sessionId);
  }
}

// A client's connection on a pipe, in place of a WebSocket to chromium.
export class PipeConnection extends EventEmitter {
  readyState = OPEN;

  constructor(pipe, session) {
    super();
    this.pipe = pipe;
    this.session = session; // its own session: implied in both directions
    this.sessions = new Set([session]); // every session it owns
    this.contexts = new Set(); // contexts to dispose when it closes
  }

  get bufferedAmount() {
    return this.pipe.bufferedAmount;
  }

  // A client command: a parsed object (the gateway parses every client
  // frame), or its JSON text. ws's send signature: (data, options, cb).
  send(data, options, cb) {
    const done = typeof options === 'function' ? options : cb;
    if (this.readyState !== OPEN) {
      done?.(new Error('the connection is closed'));
      return;
    }
    const msg = typeof data === 'object' && !Buffer.isBuffer(data) ? data : parse(Buffer.from(data));
    if (msg === null || typeof msg !== 'object') {
      done?.(new Error('not a CDP message'));
      return;
    }
    this.pipe.send(this, msg, done);
  }

  // A frame for the client: the client's own id at its head, and its own
  // session's id gone from its tail.
  deliver(buf, { headLength = 0, id, session }) {
    if (this.readyState !== OPEN) return;
    const strip = session !== undefined && session === this.session;
    let out = buf;
    if (headLength || strip) {
      const end = strip ? buf.length - `,"sessionId":"${session}"}`.length : buf.length;
      const parts = [];
      if (headLength) parts.push(Buffer.from(`{"id":${JSON.stringify(id)}`));
      parts.push(buf.subarray(headLength, end));
      if (strip) parts.push(Buffer.from('}'));
      out = Buffer.concat(parts);
    }
    this.emit('message', out, false);
  }

  deliverObject(msg) {
    if (this.readyState !== OPEN) return;
    const { sessionId, ...rest } = msg;
    const out = sessionId === undefined || sessionId === this.session ? rest : msg;
    this.emit('message', Buffer.from(JSON.stringify(out)), false);
  }

  pause() {
    if (this.readyState === OPEN) this.pipe.stall(this);
  }

  resume() {
    this.pipe.unstall(this);
  }

  // Closed by the gateway (its client left).
  close() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.pipe.release(this);
    this.emit('close');
  }

  terminate() {
    this.close();
  }

  // Closed from the browser's side: its target closed, or the browser exited.
  gone() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.pipe.unstall(this);
    this.emit('close');
  }
}
