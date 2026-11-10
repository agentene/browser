// The per-connection multiplexer behind every browser-level DevTools
// WebSocket (/devtools/browser/...).
//
// It speaks to the main chromium and forwards everything verbatim, so
// default-context clients behave exactly as without the gateway. The FIRST
// Target.createBrowserContext on a connection (what an isolated Playwright /
// playwright-cli session sends) is answered by the gateway: it starts a
// context (contexts.mjs) and hands the client an alias browserContextId that
// stands for that chromium's default (persistent, cloned) context. From then
// on commands are routed per sessionId / targetId / browserContextId to the
// main or the context's chromium, and its events get their browserContextId
// rewritten to the alias. Target.disposeBrowserContext(alias) or the client
// disconnecting destroys the context.
//
// Default-context traffic is not even parsed: a client message that names no
// Target.* method goes to the main chromium as it came, and so does a main
// chromium message while the gateway awaits no reply there itself.

import WebSocket from 'ws';
import { INTERNAL_ID_BASE, WS_OPTIONS } from './config.mjs';
import { contexts } from './contexts.mjs';
import { forward } from './flow.mjs';
import { log } from './util.mjs';

const muxes = new Set();

// open client connections, for idle.mjs
export function openMuxes() {
  return muxes.size;
}

export class Mux {
  constructor(client, clientAddr, mainUrl) {
    this.client = client;
    this.clientAddr = clientAddr;
    this.context = null;
    this.contextWs = null;
    this.alias = '';
    this.attaching = null; // the context startup in progress (attachContext)
    this.innerContexts = new Set(); // real extra contexts created inside the context's chromium
    // In-flight client commands the gateway may have to answer itself, kept
    // until their reply: anything sent to the context chromium (which can
    // die before answering) and context disposals sent to the main chromium.
    this.pending = new Map(); // client command id -> { origin, msg }
    this.sessionOwner = new Map(); // context sessionId -> 'context' (any other session is main's)
    this.sessionTarget = new Map(); // context sessionId -> targetId
    this.sessionParent = new Map(); // context sessionId -> the client session it was attached on
    this.contextTargets = new Set();
    // A client's browser-target session (Target.attachToBrowserTarget, e.g.
    // Playwright's newCDPSession) lives on the main chromium; whatever it
    // addresses in the context chromium goes through a browser-target session
    // the gateway opens there instead.
    this.browserSessions = new Map(); // client sessionId -> Promise<context browser sessionId>
    this.browserSessionOf = new Map(); // context browser sessionId -> client sessionId
    this.autoAttach = null; // last Target.setAutoAttach params from the client
    this.discover = null; // last Target.setDiscoverTargets params
    this.nextInternalId = INTERNAL_ID_BASE;
    this.internal = new Map();
    this.queue = [];
    this.closed = false;
    muxes.add(this);

    this.main = new WebSocket(mainUrl, WS_OPTIONS);
    this.main.on('open', () => {
      const queued = this.queue;
      this.queue = null; // before sending: toMain queues while it is set
      for (const m of queued) this.toMain(m);
    });
    this.main.on('message', (data) => this.fromUpstream('main', data));
    this.main.on('close', () => this.close('main browser connection closed'));
    this.main.on('error', (err) => log(`mux ${clientAddr}: main upstream error: ${err.message}`));

    client.on('message', (data) => this.fromClient(data));
    client.on('close', () => this.close('client disconnected'));
    client.on('error', (err) => log(`mux ${clientAddr}: client error: ${err.message}`));
  }

  // --- sending ---------------------------------------------------------------
  // Every frame goes out as text (a Buffer would go as binary, which
  // chromium ignores), flow-controlled against the client (flow.mjs).
  toMain(data) {
    if (this.queue) this.queue.push(data);
    else if (this.main.readyState === WebSocket.OPEN) forward(this.main, data, { binary: false }, [this.client]);
  }

  sendMain(msg) {
    this.toMain(JSON.stringify(msg));
  }

  sendContext(msg) {
    if (this.contextWs?.readyState === WebSocket.OPEN) {
      forward(this.contextWs, JSON.stringify(msg), { binary: false }, [this.client]);
    }
  }

  // A client command for the context chromium. Without one nothing would
  // ever answer it, so the gateway does (answerAs: the client's original
  // command when msg was rewritten for the upstream).
  toContext(msg, answerAs = msg) {
    if (!this.context) {
      this.answerGone(answerAs);
      return;
    }
    if (msg.id !== undefined) this.pending.set(msg.id, { origin: 'context', msg: answerAs });
    this.sendContext(msg);
  }

  // Disposing a context that does not exist (any more) succeeds — it is gone
  // either way, and Playwright's context.close() must not fail on it;
  // anything else fails right away instead of hanging.
  answerGone(msg) {
    if (msg.id === undefined) return;
    if (msg.method === 'Target.disposeBrowserContext') this.reply(msg, {});
    else this.replyError(msg, 'isolated CDP context is gone');
  }

  toClient(data) {
    if (this.client.readyState !== WebSocket.OPEN) return;
    forward(this.client, data, { binary: false }, this.contextWs ? [this.main, this.contextWs] : [this.main]);
  }

  sendClient(msg) {
    this.toClient(JSON.stringify(msg));
  }

  reply(msg, result) {
    this.sendClient({ id: msg.id, sessionId: msg.sessionId, result });
  }

  replyError(msg, message) {
    this.sendClient({ id: msg.id, sessionId: msg.sessionId, error: { code: -32000, message } });
  }

  // A command of the gateway's own on an upstream; resolves with its result.
  internalSend(target, method, params) {
    const id = this.nextInternalId++;
    return new Promise((resolve, reject) => {
      this.internal.set(id, { resolve, reject, method, target });
      const msg = { id, method, params };
      if (target === 'context') this.sendContext(msg);
      else this.sendMain(msg);
    });
  }

  // --- client -> upstreams ---------------------------------------------------
  fromClient(data) {
    // nothing to route or rewrite without a context, unless it is one of the
    // Target.* commands the gateway handles (their method name is a JSON
    // string, so it always appears as "Target.)
    if (!this.context && !this.attaching && !data.includes('"Target.')) {
      this.toMain(data);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const { method, params = {}, sessionId } = msg;

    if (sessionId) {
      if (this.sessionOwner.get(sessionId) === 'context') this.toContext(msg);
      else if (this.addressesContext(params)) this.viaContextBrowserSession(msg);
      else this.sendMain(msg);
      return;
    }

    switch (method) {
      case 'Target.createBrowserContext':
        this.createContext(msg);
        return;
      case 'Target.disposeBrowserContext':
        if (this.alias && params.browserContextId === this.alias) {
          const context = this.context;
          this.reply(msg, {});
          context?.destroy('context disposed by client');
          return;
        }
        if (this.innerContexts.delete(params.browserContextId)) {
          this.toContext(msg);
        } else {
          // the main browser's, or one gone with its context chromium: an
          // unknown id is answered as disposed (see fromUpstream)
          if (msg.id !== undefined) this.pending.set(msg.id, { origin: 'main', msg });
          this.sendMain(msg);
        }
        return;
      case 'Target.setAutoAttach':
        this.autoAttach = params;
        if (this.context) this.internalSend('context', method, params).catch(() => {});
        break;
      case 'Target.setDiscoverTargets':
        this.discover = params;
        if (this.context) this.internalSend('context', method, params).catch(() => {});
        break;
      default:
        break;
    }

    if (this.alias && params.browserContextId === this.alias) {
      // the alias stands for the context chromium's default context, which CDP
      // addresses by leaving browserContextId out
      const { browserContextId: _, ...rest } = params;
      this.toContext({ ...msg, params: rest }, msg);
      return;
    }
    if (this.context && (this.innerContexts.has(params.browserContextId)
        || this.addressesContext(params))) {
      this.toContext(msg);
      return;
    }
    this.sendMain(msg);
  }

  // Browser-level params naming a target or session of the context chromium.
  addressesContext(params) {
    return Boolean(this.context) && (this.contextTargets.has(params.targetId)
      || this.sessionOwner.get(params.sessionId) === 'context');
  }

  async viaContextBrowserSession(msg) {
    const clientSession = msg.sessionId;
    let pending = this.browserSessions.get(clientSession);
    if (!pending) {
      pending = this.internalSend('context', 'Target.attachToBrowserTarget', {}).then(({ sessionId }) => {
        this.browserSessionOf.set(sessionId, clientSession);
        return sessionId;
      });
      this.browserSessions.set(clientSession, pending);
    }
    try {
      this.toContext({ ...msg, sessionId: await pending }, msg);
    } catch (err) {
      this.browserSessions.delete(clientSession);
      this.replyError(msg, err.message);
    }
  }

  // Target.createBrowserContext. One startup at a time: a client may create
  // contexts concurrently (Promise.all of newContext()), and the second must
  // see the first one's chromium — as the incognito context inside it —
  // instead of starting a chromium of its own that nothing would track.
  createContext(msg) {
    if (this.closed) return;
    if (this.attaching) {
      const retry = () => this.createContext(msg);
      this.attaching.then(retry, retry);
      return;
    }
    if (this.context) {
      // a second isolated context on the same connection: a plain
      // incognito context inside this context's chromium
      this.toContext(msg);
      return;
    }
    if (msg.params?.proxyServer) {
      log(`mux ${this.clientAddr}: context proxy ${msg.params.proxyServer} is not applied to contexts (they use the main browser's network settings)`);
    }
    this.attaching = this.attachContext(msg)
      .catch((err) => log(`mux ${this.clientAddr}: context attach: ${err.message}`))
      .finally(() => { this.attaching = null; });
  }

  async attachContext(msg) {
    let context;
    try {
      context = await contexts.create(this.clientAddr);
      if (this.closed) {
        await context.destroy('client went away during startup');
        return;
      }
      const ws = new WebSocket(context.browserWsUrl(), WS_OPTIONS);
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      if (this.closed || context.destroyed) {
        // the client left (or the chromium died) while the connection opened:
        // nothing else would ever destroy the context
        ws.terminate();
        if (!this.closed) throw new Error('isolated CDP context exited during startup');
        await context.destroy('client went away during startup');
        return;
      }
      this.context = context;
      this.contextWs = ws;
      context.mux = this;
      this.alias = `CONTEXT${context.name.replace(/\W/g, '').toUpperCase()}${Date.now().toString(16).toUpperCase()}`;
      ws.on('message', (data) => this.fromUpstream('context', data));
      ws.on('close', () => {
        if (this.context === context) context.destroy('context connection closed');
      });
      ws.on('error', (err) => log(`mux ${this.clientAddr}: ${context.name} upstream error: ${err.message}`));
      // mirror the client's target-tracking setup onto the new browser so
      // its pages reach the client the same way the main browser's do
      if (this.discover) await this.internalSend('context', 'Target.setDiscoverTargets', this.discover);
      if (this.autoAttach) await this.internalSend('context', 'Target.setAutoAttach', this.autoAttach);
      log(`${context.name}: attached to client ${this.clientAddr} as context ${this.alias}`);
      this.reply(msg, { browserContextId: this.alias });
    } catch (err) {
      log(`mux ${this.clientAddr}: context creation failed: ${err.message}`);
      if (context && !context.destroyed) await context.destroy('attach failed');
      this.replyError(msg, err.message);
    }
  }

  // --- upstreams -> client ---------------------------------------------------
  fromUpstream(origin, data) {
    // the main chromium's messages need no rewriting; only the replies the
    // gateway waits for itself are picked out
    if (origin === 'main' && this.pending.size === 0 && this.internal.size === 0) {
      this.toClient(data);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    // a reply to one of the gateway's own commands — only when it is one
    // (a client's command may use an id that large too) and from where it went
    const own = msg.id >= INTERNAL_ID_BASE && this.internal.get(msg.id);
    if (own && own.target === origin) {
      this.internal.delete(msg.id);
      if (msg.error) own.reject(new Error(`${own.method}: ${msg.error.message}`));
      else own.resolve(msg.result);
      return;
    }

    const pending = msg.id !== undefined && this.pending.get(msg.id);
    if (pending) {
      this.pending.delete(msg.id);
      if (msg.error && pending.msg.method === 'Target.disposeBrowserContext') {
        this.answerGone(pending.msg);
        return;
      }
    }
    if (origin === 'context') {
      // the gateway's own browser-target sessions stay invisible to the client
      if (msg.method === 'Target.attachedToTarget' && msg.params.targetInfo.type === 'browser') return;
      if (msg.method === 'Target.detachedFromTarget' && this.browserSessionOf.has(msg.params.sessionId)) return;
      if (this.browserSessionOf.has(msg.sessionId)) msg.sessionId = this.browserSessionOf.get(msg.sessionId);
      this.trackContextMessage(msg);
    }
    this.sendClient(msg);
  }

  trackContextMessage(msg) {
    const p = msg.params;
    if (msg.result?.browserContextId) this.innerContexts.add(msg.result.browserContextId);
    if (msg.result?.targetId) this.contextTargets.add(msg.result.targetId);
    switch (msg.method) {
      case 'Target.attachedToTarget':
        this.sessionOwner.set(p.sessionId, 'context');
        this.sessionTarget.set(p.sessionId, p.targetInfo.targetId);
        if (msg.sessionId) this.sessionParent.set(p.sessionId, msg.sessionId);
        break;
      case 'Target.detachedFromTarget':
        this.sessionOwner.delete(p.sessionId);
        this.sessionTarget.delete(p.sessionId);
        this.sessionParent.delete(p.sessionId);
        break;
      case 'Target.targetDestroyed':
        this.contextTargets.delete(p.targetId);
        break;
      default:
        break;
    }
    const info = p?.targetInfo;
    if (info) {
      this.contextTargets.add(info.targetId);
      // everything in the context chromium's default context belongs to the alias
      if (!this.innerContexts.has(info.browserContextId)) info.browserContextId = this.alias;
    }
  }

  // --- teardown --------------------------------------------------------------
  // The context is gone (disposed, crashed or deleted from the dashboard):
  // tell the client its pages are gone, the same way chromium would.
  contextGone(context) {
    if (this.context !== context) return;
    for (const [sessionId, targetId] of this.sessionTarget) {
      this.sendClient({ method: 'Target.detachedFromTarget', sessionId: this.sessionParent.get(sessionId), params: { sessionId, targetId } });
      this.sessionOwner.delete(sessionId);
    }
    for (const targetId of this.contextTargets) {
      this.sendClient({ method: 'Target.targetDestroyed', params: { targetId } });
    }
    // commands still in flight to the dead browser never get an answer
    for (const [id, p] of this.pending) {
      if (p.origin !== 'context') continue;
      this.pending.delete(id);
      this.answerGone(p.msg);
    }
    for (const [id, p] of this.internal) {
      if (p.target !== 'context') continue;
      this.internal.delete(id);
      p.reject(new Error(`${p.method}: isolated CDP context is gone`));
    }
    this.innerContexts.clear();
    this.sessionTarget.clear();
    this.sessionParent.clear();
    this.contextTargets.clear();
    this.browserSessions.clear();
    this.browserSessionOf.clear();
    this.contextWs?.close();
    this.contextWs = null;
    this.context = null;
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    muxes.delete(this);
    this.context?.destroy(reason);
    if (this.main.readyState === WebSocket.OPEN || this.main.readyState === WebSocket.CONNECTING) this.main.terminate();
    if (this.client.readyState === WebSocket.OPEN) this.client.close();
  }
}
