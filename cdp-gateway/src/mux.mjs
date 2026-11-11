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
// rewritten to the alias. Target.getTargets / Target.getBrowserContexts are
// answered from both chromiums, the context's ids rewritten to the alias.
// Target.disposeBrowserContext(alias) or the client
// disconnecting destroys the context.
//
// Default-context traffic is not even parsed: a client message that names no
// Target.* method (nor a command client-frame.mjs checks: Browser.close, local
// file paths) goes to the main chromium as it came, and so does an upstream
// message the gateway has no business with (needsParse). A parsed message
// goes upstream re-serialized (client-frame.mjs).

import WebSocket from 'ws';
import { openWs } from './cdp-client.mjs';
import { guardFrame, needsGuard } from './client-frame.mjs';
import { INTERNAL_ID_BASE, WS_OPTIONS } from './config.mjs';
import { contexts } from './contexts.mjs';
import { forward } from './flow.mjs';
import { log } from './util.mjs';

const muxes = new Set();

// How chromium starts a reply: {"id":<n>, — its id comes first.
const REPLY_HEAD = /^\{"id":(-?\d+)[,}]/;
// What a context chromium's message has to contain for the gateway to track
// or rewrite it (targets, contexts, sessions: trackContextMessage).
// '"targetInfos"' (a getTargets reply) has a marker of its own: an entry
// without a browserContextId would match none of the others.
const CONTEXT_MARKERS = ['"Target.', '"targetId"', '"browserContextId"', '"targetInfo"', '"targetInfos"'];

// The list commands the gateway answers from BOTH chromiums of the
// connection when a context is attached (mergedTargets): each chromium
// knows only its own targets and contexts.
const MERGED = new Set(['Target.getTargets', 'Target.getBrowserContexts']);

// A client command's params as an object: chromium refuses any other kind
// itself, but the gateway reads them first (and a null would throw).
function paramsOf(msg) {
  return msg.params !== null && typeof msg.params === 'object' ? msg.params : {};
}

// A command that names the alias, as it goes to the context chromium: the
// alias stands for its default context, which CDP addresses by leaving
// browserContextId out (on a root connection and through a stand-in session
// alike).
function strippedAlias(msg) {
  const { browserContextId: _, ...params } = paramsOf(msg);
  return { ...msg, params };
}

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
    this.pending = new Map(); // upstream command id -> { origin, msg: the client's command }
    this.sessionOwner = new Map(); // context sessionId -> 'context' (any other session is main's)
    this.sessionTarget = new Map(); // context sessionId -> targetId
    this.sessionParent = new Map(); // context sessionId -> the client session it was attached on
    this.contextTargets = new Set();
    // A client's browser-target session (Target.attachToBrowserTarget, e.g.
    // Playwright's newCDPSession) lives on the main chromium; whatever it
    // addresses in the context chromium goes through a browser-target session
    // the gateway opens there instead.
    this.browserSessions = new Map(); // client sessionId -> { id: context browser sessionId ('' while opening), waiting: [msg] }
    this.browserSessionOf = new Map(); // context browser sessionId -> client sessionId
    this.autoAttach = null; // last Target.setAutoAttach params from the client
    this.discover = null; // last Target.setDiscoverTargets params
    this.nextInternalId = INTERNAL_ID_BASE;
    this.internal = new Map();
    this.queue = [];
    this.closed = false;
    muxes.add(this);

    // nothing is read from the client until the upstream is open, so what
    // it sends meanwhile waits in the socket (TCP pushes back), not here
    client.pause?.();
    this.main = new WebSocket(mainUrl, WS_OPTIONS);
    this.main.on('open', () => {
      const queued = this.queue;
      this.queue = null; // before sending: toMain queues while it is set
      for (const m of queued) this.toMain(m);
      client.resume?.();
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
    if (msg.id !== undefined) {
      // the gateway's own commands there count up from INTERNAL_ID_BASE; a
      // client id that is one of those in flight goes up under a fresh id,
      // and its reply gets the client's back (fromUpstream)
      if (this.internal.has(msg.id)) msg = { ...msg, id: this.nextInternalId++ };
      this.pending.set(msg.id, { origin: 'context', msg: answerAs });
    }
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
    let id;
    do id = this.nextInternalId++; while (this.pending.has(id)); // not a client's id in flight
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
    // string, so it appears as "Target. — or escaped, browser-exit.mjs) or
    // one it checks (client-frame.mjs)
    if (!this.context && !this.attaching && !data.includes('"Target.') && !needsGuard(data)) {
      this.toMain(data);
      return;
    }
    const checked = guardFrame(data);
    if (checked.note) log(`mux ${this.clientAddr}: ${checked.note}`);
    if (checked.notes) for (const note of checked.notes) log(`mux ${this.clientAddr}: ${note}`);
    if (!checked.msg) {
      // not CDP, or a command the gateway answers itself (client-frame.mjs):
      // a refusal, or a client's Browser.close, which succeeds and ends this
      // client's connection — its isolated context with it —, as a closing
      // browser would; the shared browser stays up
      if (checked.answer) this.sendClient(checked.answer);
      if (checked.close) this.close('client sent Browser.close');
      return;
    }
    const { msg } = checked;
    const { method, sessionId } = msg;
    const params = paramsOf(msg);

    // The client detached one of its browser-target sessions: the stand-in
    // the gateway holds for it in the context chromium goes down too, right
    // now — the command itself still travels to the main chromium below,
    // which owns the session
    if (method === 'Target.detachFromTarget' && this.browserSessions.has(params.sessionId)) {
      this.retireBrowserSession(params.sessionId);
    }

    if (sessionId) {
      this.fromClientSession(msg);
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
      this.toContext(strippedAlias(msg), msg);
      return;
    }
    if (this.routesContext(params)) {
      this.toContext(msg);
      return;
    }
    if (this.context && msg.id !== undefined && MERGED.has(method)) {
      this.mergedTargets(msg, params);
      return;
    }
    this.sendMain(msg);
  }

  // A command on a session: the context chromium's, the main chromium's, or
  // a browser-target session on main that addresses the context chromium —
  // by the alias (its default context, addressed there by leaving the field
  // out, as on a root connection), an inner context, or a target of it.
  fromClientSession(msg) {
    const { sessionId } = msg;
    const params = paramsOf(msg);
    // while that session's stand-in in the context chromium is being opened,
    // everything on it waits, so its commands keep their order
    const browserSession = this.browserSessions.get(sessionId);
    if (browserSession && !browserSession.id) browserSession.waiting.push(msg);
    else if (this.sessionOwner.get(sessionId) === 'context') {
      this.toContext(params.browserContextId === this.alias ? strippedAlias(msg) : msg);
    } else if (this.context && params.browserContextId === this.alias) {
      this.viaContextBrowserSession(msg, true);
    } else if (this.routesContext(params)) this.viaContextBrowserSession(msg);
    else this.sendMain(msg);
  }

  // Browser-level params naming a target or session of the context chromium.
  addressesContext(params) {
    return Boolean(this.context) && (this.contextTargets.has(params.targetId)
      || this.sessionOwner.get(params.sessionId) === 'context');
  }

  // Browser-level params addressed to the context chromium any way a client
  // can: the alias (its default context), one of the contexts created inside
  // it (innerContexts), or a target or session of it.
  routesContext(params) {
    return Boolean(this.context) && (params.browserContextId === this.alias
      || this.innerContexts.has(params.browserContextId) || this.addressesContext(params));
  }

  // Target.getTargets / Target.getBrowserContexts on a connection with an
  // isolated context: neither chromium knows the other's, so the gateway
  // asks both and answers with the union — the context's targetInfos
  // rewritten to the alias, its contexts as the alias plus the inner ones.
  // (getBrowserContexts needs no trip to the context: what to append is
  // known here.) The main chromium's part of the answer goes out unchanged,
  // like every other main reply.
  async mergedTargets(msg, params) {
    const asks = [this.internalSend('main', msg.method, params)];
    if (msg.method === 'Target.getTargets') {
      asks.push(this.internalSend('context', msg.method, params));
    }
    const settled = await Promise.allSettled(asks);
    const [main, context] = settled;
    if (main.status === 'rejected') {
      this.replyError(msg, main.reason instanceof Error ? main.reason.message : `${msg.method} failed`);
      return;
    }
    const merged = { ...main.value };
    if (msg.method === 'Target.getBrowserContexts') {
      merged.browserContextIds = [...(merged.browserContextIds ?? []), this.alias, ...this.innerContexts];
    } else if (context.status === 'fulfilled') {
      const infos = (context.value.targetInfos ?? []).map((info) => ({ ...info }));
      for (const info of infos) {
        this.contextTargets.add(info.targetId);
        if (!this.innerContexts.has(info.browserContextId)) info.browserContextId = this.alias;
      }
      merged.targetInfos = [...(merged.targetInfos ?? []), ...infos];
    } else {
      log(`mux ${this.clientAddr}: merging ${msg.method}: ${context.reason instanceof Error ? context.reason.message : 'the context chromium did not answer'}`);
    }
    this.reply(msg, merged);
  }

  // A client browser-target session's command for the context chromium goes
  // through the stand-in session the gateway opens there (once per session).
  // withAlias: the command names the alias, which stands for the context
  // chromium's default context — stripped on the way there, as on a root
  // connection. The message is queued as it came, so a re-route on the flush
  // can tell where it belongs again.
  viaContextBrowserSession(msg, withAlias = false) {
    const clientSession = msg.sessionId;
    const known = this.browserSessions.get(clientSession);
    if (known) {
      const out = { ...msg, sessionId: known.id };
      this.toContext(withAlias ? strippedAlias(out) : out, msg);
      return;
    }
    const entry = { id: '', waiting: [msg] };
    this.browserSessions.set(clientSession, entry);
    const flush = (err) => {
      const { waiting } = entry;
      entry.waiting = [];
      for (const m of waiting) {
        // without a stand-in what needed one fails (no retry loop); the rest
        // takes its usual way
        if (err && this.routesContext(paramsOf(m))) this.replyError(m, err.message);
        else this.fromClientSession(m);
      }
    };
    this.internalSend('context', 'Target.attachToBrowserTarget', {}).then(({ sessionId }) => {
      entry.id = sessionId;
      this.browserSessionOf.set(sessionId, clientSession);
      flush();
      if (entry.retired) {
        // the client detached the session while this stand-in was opening:
        // the queued commands went through first, in the order the client
        // sent them (as they would have on the main chromium), and the
        // fresh stand-in follows the session down
        this.browserSessions.delete(clientSession);
        this.detachStandIn(entry);
      }
    }, (err) => {
      if (this.browserSessions.get(clientSession) === entry) this.browserSessions.delete(clientSession);
      flush(err);
    });
  }

  // A client browser-target session the client detached (the command is on
  // its way to the main chromium, which owns the session): the stand-in the
  // gateway opened for it in the context chromium goes down too, and both
  // maps forget the pair — without this, a long-lived connection that keeps
  // opening and closing browser sessions would pile them up for the context
  // chromium's lifetime.
  retireBrowserSession(clientSession) {
    const entry = this.browserSessions.get(clientSession);
    if (!entry) return;
    entry.retired = true;
    if (!entry.id) return; // still opening: retired once the stand-in is up
    this.browserSessions.delete(clientSession);
    this.detachStandIn(entry);
  }

  // Best effort: the context chromium (or the whole context) may be gone
  // already. The browserSessionOf entry outlives this: whatever is still in
  // flight on the stand-in keeps its rewrite, and the entry is dropped only
  // when the context chromium reports the stand-in detached (fromUpstream).
  detachStandIn(entry) {
    const standIn = entry.id;
    entry.id = '';
    this.sendContext({ method: 'Target.detachFromTarget', params: { sessionId: standIn } });
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
    this.attaching = this.attachContext(msg)
      .catch((err) => log(`mux ${this.clientAddr}: context attach: ${err.message}`))
      .finally(() => { this.attaching = null; });
  }

  async attachContext(msg) {
    let context;
    try {
      // its proxy becomes the context chromium's own (contexts.mjs)
      const { proxyServer, proxyBypassList } = paramsOf(msg);
      context = await contexts.create(this.clientAddr, { proxyServer, proxyBypassList });
      if (this.closed) {
        await context.destroy('client went away during startup');
        return;
      }
      const ws = await openWs(context.browserWsUrl());
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
      // the alias carries the context's number (context-7 -> CONTEXT7…);
      // the timestamp tells two aliases of one number apart across restarts
      this.alias = `CONTEXT${context.name.replace(/\D/g, '')}${Date.now().toString(16).toUpperCase()}`;
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
  // Most upstream traffic goes to the client as it came: parsing and
  // re-serializing every frame would cost the most on the largest ones
  // (screenshots, screencasts, traces).
  fromUpstream(origin, data) {
    if (!this.needsParse(origin, data)) {
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
    if (pending?.origin === origin) {
      this.pending.delete(msg.id);
      msg.id = pending.msg.id; // the client's own id (toContext may have sent another)
      if (msg.error && pending.msg.method === 'Target.disposeBrowserContext') {
        this.answerGone(pending.msg);
        return;
      }
    }
    if (origin === 'context') {
      // the gateway's own browser-target sessions stay invisible to the client
      if (msg.method === 'Target.attachedToTarget' && msg.params.targetInfo.type === 'browser') return;
      if (msg.method === 'Target.detachedFromTarget' && this.browserSessionOf.has(msg.params.sessionId)) {
        // a stand-in, gone by the gateway's own hand (retireBrowserSession):
        // the client never knew the id — and only now, with nothing in
        // flight on it any more, is the pair fully forgotten
        this.browserSessionOf.delete(msg.params.sessionId);
        return;
      }
      if (this.browserSessionOf.has(msg.sessionId)) msg.sessionId = this.browserSessionOf.get(msg.sessionId);
      this.trackContextMessage(msg);
    }
    this.sendClient(msg);
  }

  // Whether an upstream frame needs the gateway: a reply to its own command,
  // a reply it rewrites or answers itself, or a context chromium message
  // that names a target, a context or one of the gateway's stand-in sessions.
  // Chromium writes a reply's id first and an event's method first; a frame
  // laid out any other way is parsed. Bookkeeping for a plain reply (its
  // pending entry) is done right here.
  needsParse(origin, data) {
    const head = data.subarray(0, 40).toString('latin1');
    const reply = REPLY_HEAD.exec(head);
    if (!reply && !head.startsWith('{"method":"')) return true;
    if (reply) {
      const id = Number(reply[1]);
      if (this.internal.get(id)?.target === origin) return true;
      const pending = this.pending.get(id);
      if (pending?.origin === origin) {
        if (pending.msg.id !== id || pending.msg.method === 'Target.disposeBrowserContext') return true;
        this.pending.delete(id);
      }
    }
    return origin === 'context'
      && (this.browserSessionOf.size > 0 || CONTEXT_MARKERS.some((marker) => data.includes(marker)));
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
    // a targetInfo wherever the context chromium put it — an event's
    // params, or the result of Target.getTargetInfo / Target.getTargets:
    // the ids belong to the client's namespace, not chromium's
    const infos = [];
    if (p?.targetInfo) infos.push(p.targetInfo);
    if (msg.result?.targetInfo) infos.push(msg.result.targetInfo);
    if (Array.isArray(msg.result?.targetInfos)) infos.push(...msg.result.targetInfos);
    for (const info of infos) {
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
