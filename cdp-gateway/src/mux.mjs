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
// The context chromium's window ids (Browser.getWindowForTarget) are
// rewritten to ids no main window can have (contextWindowId), so a
// Browser.getWindowBounds / setWindowBounds that names only the window finds
// its way back there instead of reaching a main chromium window of the same
// number.
// Target.disposeBrowserContext(alias) or the client
// disconnecting destroys the context.
//
// The isolated context does not hang off the main browser: when the main
// browser exits (its window closed, Stop, idle, a crash) a connection that
// holds one goes on — the client is told its main pages are gone, the way
// chromium tells a target's end, and its context keeps running. Without a
// context the connection ends with the main browser, as it would with
// chromium's own. A connection to a stopped main browser starts without it
// (upgrade.mjs). Either way the main browser is started (and
// the client's target setup replayed there) only when the client uses it:
// what a client asks the browser itself while it is down (Browser.getVersion,
// Target.setAutoAttach, ...) the gateway answers (answerWithoutMain).
//
// Its upstreams are connections on the browsers' DevTools pipes (pipe.mjs):
// a browser-target session each, which behaves like a WebSocket of its own.
// Every client command is checked (client-frame.mjs) and goes upstream as
// the command the check read; an upstream message the gateway has no
// business with goes to the client as it came, unparsed (needsParse).

import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { guardFrame } from './client-frame.mjs';
import { INTERNAL_ID_BASE } from './config.mjs';
import { contexts } from './contexts.mjs';
import { forward } from './flow.mjs';
import { mainBrowser } from './main-browser.mjs';
import { log } from './util.mjs';
import { knownVersion } from './version.mjs';

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

// Main chromium replies the gateway reads (needsParse), kept in pending until
// they come: a disposal it may answer itself, and the session id of a
// client's browser-target session (clientBrowserSessions).
const READ_MAIN_REPLIES = new Set(['Target.disposeBrowserContext', 'Target.attachToBrowserTarget']);

// The main chromium's events the gateway keeps track of (trackMainMessage):
// the client's main targets and sessions, whose end it tells the client when
// the main browser exits under a connection that goes on (mainGone).
const MAIN_TRACKED = /^\{"method":"Target\.(attachedToTarget|detachedFromTarget|targetCreated|targetDestroyed)"/;

// Context chromium replies the gateway reads: the window id it rewrites.
const READ_CONTEXT_REPLIES = new Set(['Browser.getWindowForTarget']);

// The window id a client gets for a context chromium window, and back: the
// negated id. Each chromium numbers its windows on its own (SessionID), and
// the context chromium's profile is a clone of the main's, so it carries on
// from the same counter — a context window id as it came can name a main
// window too. Chromium's ids are always positive, so the negated ones never
// do, and they still fit CDP's 32-bit integer.
export function contextWindowId(windowId) {
  return -windowId;
}

const realWindowId = contextWindowId;

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

// open client connections
export function openMuxes() {
  return muxes.size;
}

// For idle.mjs: the connections that keep the main browser in use — those
// on it without an isolated context (the main browser is all they have) —,
// and when a client last sent it a command (one with an isolated context
// keeps it in use only that way).
export function mainClients() {
  let n = 0;
  for (const mux of muxes) if (mux.main && !mux.context && !mux.attaching) n++;
  return n;
}

export function lastMainUse() {
  let last = 0;
  for (const mux of muxes) last = Math.max(last, mux.mainUsedAt);
  return last;
}

// The main browser's connection for a client: started if it is not running.
async function connectMain() {
  await mainBrowser.ensure();
  return mainBrowser.pipe.connect();
}

export class Mux {
  // main: an open connection on the main browser's pipe (pipe.connect()),
  // or null to start without one; openMain: how to get one when the client
  // needs the main browser (tests stand in for it)
  constructor(client, clientAddr, main, { openMain = connectMain } = {}) {
    this.client = client;
    this.clientAddr = clientAddr;
    this.context = null;
    this.contextWs = null;
    this.alias = '';
    this.attaching = null; // the context startup in progress (attachContext)
    this.innerContexts = new Set(); // real extra contexts created inside the context's chromium
    // In-flight client commands the gateway may have to answer itself, kept
    // until their reply: anything sent to the context chromium (which can
    // die before answering) and the main chromium commands of READ_MAIN_REPLIES.
    this.pending = new Map(); // upstream command id -> { origin, msg: the client's command }
    this.sessionTarget = new Map(); // context chromium's sessionId -> targetId (any other session is main's)
    this.sessionParent = new Map(); // context sessionId -> the client session it was attached on
    this.contextTargets = new Set();
    // the window ids handed out for the context chromium's windows (contextWindowId)
    this.contextWindows = new Set();
    // A client's browser-target session (Target.attachToBrowserTarget, e.g.
    // Playwright's newCDPSession) lives on the main chromium; whatever it
    // addresses in the context chromium goes through a browser-target session
    // the gateway opens there instead.
    this.browserSessions = new Map(); // client sessionId -> { id: context browser sessionId ('' while opening), waiting: [msg] }
    this.browserSessionOf = new Map(); // context browser sessionId -> client sessionId
    // the client's browser-target sessions on the main chromium, which get the
    // merged lists (mergedTargets) like the root connection does
    this.clientBrowserSessions = new Set();
    this.autoAttach = null; // last Target.setAutoAttach params from the client
    this.discover = null; // last Target.setDiscoverTargets params
    this.downloadBehavior = null; // last Browser.setDownloadBehavior for the main default context
    this.nextInternalId = INTERNAL_ID_BASE;
    this.internal = new Map();
    this.closed = false;
    // The main browser's side: its connection (null while there is none),
    // the startup a command waits for (startMain), the commands waiting, the
    // client's commands in flight there (answered when it exits), and what
    // the client has of it (trackMainMessage).
    this.main = null;
    this.openMain = openMain;
    this.mainOpening = null;
    this.mainQueue = [];
    this.mainInFlight = new Map(); // client command id -> the command
    this.mainSessions = new Map(); // main sessionId -> { targetId, parent: the session it was attached on }
    this.mainTargets = new Set();
    this.mainUsedAt = 0; // last client command sent there (lastMainUse)
    this.closingBrowser = false; // the client closed the browser (CDP_ALLOW_BROWSER_CLOSE)
    // the browser target's id while there is no main browser to ask
    this.browserTargetId = randomBytes(16).toString('hex').toUpperCase();
    muxes.add(this);

    if (main) this.adoptMain(main);

    client.on('message', (data) => this.fromClient(data));
    client.on('close', () => this.close('client disconnected'));
    client.on('error', (err) => log(`mux ${clientAddr}: client error: ${err.message}`));
  }

  // --- sending ---------------------------------------------------------------
  // Commands go upstream as objects (the pipe serializes them), frames to
  // the client as text (a Buffer would go as binary), flow-controlled
  // against the other side (flow.mjs).
  sendMain(msg) {
    if (this.main?.readyState === WebSocket.OPEN) forward(this.main, msg, {}, [this.client]);
  }

  // A client command for the main chromium; without one, answered here or
  // held until it is up (startMain).
  toMain(msg) {
    if (!this.main) {
      if (!this.answerWithoutMain(msg)) {
        this.mainQueue.push(msg);
        this.startMain();
      }
      return;
    }
    this.mainUsedAt = Date.now();
    if (msg.id !== undefined) {
      this.mainInFlight.set(msg.id, msg);
      if (READ_MAIN_REPLIES.has(msg.method)) this.pending.set(msg.id, { origin: 'main', msg });
    }
    this.sendMain(msg);
  }

  sendContext(msg) {
    if (this.contextWs?.readyState === WebSocket.OPEN) forward(this.contextWs, msg, {}, [this.client]);
  }

  // A client command for the context chromium. Without one nothing would
  // ever answer it, so the gateway does (answerAs: the client's original
  // command when msg was rewritten for the upstream).
  toContext(msg, answerAs = msg) {
    if (!this.context) {
      this.answerGone(answerAs);
      return;
    }
    // a window id the gateway handed out goes back as the context chromium's own
    const params = paramsOf(msg);
    if (this.contextWindows.has(params.windowId)) {
      msg = { ...msg, params: { ...params, windowId: realWindowId(params.windowId) } };
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
  answerGone(msg, message = 'isolated CDP context is gone') {
    if (msg.id === undefined) return;
    if (msg.method === 'Target.disposeBrowserContext') this.reply(msg, {});
    else this.replyError(msg, message);
  }

  toClient(data) {
    if (this.client.readyState !== WebSocket.OPEN) return;
    const sources = [];
    if (this.main) sources.push(this.main);
    if (this.contextWs) sources.push(this.contextWs);
    forward(this.client, data, { binary: false }, sources);
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
    if (method === 'Target.detachFromTarget') {
      this.clientBrowserSessions.delete(params.sessionId);
      if (this.browserSessions.has(params.sessionId)) this.retireBrowserSession(params.sessionId);
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
          this.toMain(msg);
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
      case 'Browser.setDownloadBehavior':
        // the main default context's, replayed on a main browser started later
        if (params.browserContextId === undefined) this.downloadBehavior = params;
        break;
      case 'Browser.close':
        // only here when CDP_ALLOW_BROWSER_CLOSE lets it through: the client
        // means the browser to go, and its connection with it (mainGone)
        this.closingBrowser = true;
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
    this.toMain(msg);
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
    else if (this.context && msg.id !== undefined && MERGED.has(msg.method) && this.clientBrowserSessions.has(sessionId)) {
      // the lists a browser-target session asks for are the browser's: both
      // chromiums', as on the root connection
      this.mergedTargets(msg, params);
    } else if (this.sessionTarget.has(sessionId)) {
      this.toContext(params.browserContextId === this.alias ? strippedAlias(msg) : msg);
    } else if (!this.main) {
      // a main chromium session, gone with it (answerWithoutMain)
      this.toMain(msg);
    } else if (this.context && params.browserContextId === this.alias) {
      this.viaContextBrowserSession(msg, true);
    } else if (this.routesContext(params)) this.viaContextBrowserSession(msg);
    else this.toMain(msg);
  }

  // Browser-level params naming a target or session of the context chromium.
  addressesContext(params) {
    return Boolean(this.context) && (this.contextTargets.has(params.targetId)
      || this.sessionTarget.has(params.sessionId));
  }

  // Browser-level params addressed to the context chromium any way a client
  // can: the alias (its default context), one of the contexts created inside
  // it (innerContexts), a target or session of it, or one of its windows
  // (Browser.getWindowBounds / setWindowBounds name nothing else).
  routesContext(params) {
    return Boolean(this.context) && (params.browserContextId === this.alias
      || this.innerContexts.has(params.browserContextId) || this.addressesContext(params)
      || this.contextWindows.has(params.windowId));
  }

  // Target.getTargets / Target.getBrowserContexts on a connection with an
  // isolated context: neither chromium knows the other's, so the gateway
  // asks both and answers with the union — the context's targetInfos
  // rewritten to the alias, its contexts as the alias plus the inner ones.
  // (getBrowserContexts needs no trip to the context: what to append is
  // known here.) The main chromium's part of the answer goes out unchanged,
  // like every other main reply.
  async mergedTargets(msg, params) {
    // without a main browser its part is empty: nothing starts it for a list
    const mainPart = msg.method === 'Target.getTargets' ? { targetInfos: [] } : { browserContextIds: [] };
    const asks = [this.main ? this.internalSend('main', msg.method, params) : Promise.resolve(mainPart)];
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
      const ws = await context.pipe.connect();
      if (this.closed || context.destroyed) {
        // the client left (or the chromium died) while the connection opened:
        // nothing else would ever destroy the context
        ws.close();
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
      if (pending.msg.method === 'Target.attachToBrowserTarget' && typeof msg.result?.sessionId === 'string') {
        this.clientBrowserSessions.add(msg.result.sessionId);
      }
      if (origin === 'context' && pending.msg.method === 'Browser.getWindowForTarget'
        && Number.isInteger(msg.result?.windowId) && msg.result.windowId > 0) {
        msg.result.windowId = contextWindowId(msg.result.windowId);
        this.contextWindows.add(msg.result.windowId);
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
    } else {
      this.trackMainMessage(msg);
    }
    this.sendClient(msg);
  }

  trackMainMessage(msg) {
    const p = msg.params;
    switch (msg.method) {
      case 'Target.attachedToTarget':
        this.mainSessions.set(p.sessionId, { targetId: p.targetInfo?.targetId, parent: msg.sessionId });
        break;
      case 'Target.detachedFromTarget':
        this.mainSessions.delete(p.sessionId);
        // and the sessions attached on it (an iframe's, a worker's)
        for (const [sessionId, s] of this.mainSessions) if (s.parent === p.sessionId) this.mainSessions.delete(sessionId);
        break;
      case 'Target.targetCreated':
        this.mainTargets.add(p.targetInfo?.targetId);
        break;
      case 'Target.targetDestroyed':
        this.mainTargets.delete(p.targetId);
        break;
      default:
        break;
    }
  }

  // --- the main browser, when it is not there ---------------------------------
  adoptMain(main) {
    this.main = main;
    main.on('message', (data) => { if (this.main === main) this.fromUpstream('main', data); });
    main.on('close', () => { if (this.main === main) this.mainGone(); });
  }

  // A client command while there is no main browser that the gateway answers
  // itself, so that it does not start one; false for anything that needs it.
  // A session or target of the main chromium is gone with it (a new one has
  // others); what a client asks the browser on connecting is answered as an
  // idle browser would, and its setup is replayed once one starts.
  answerWithoutMain(msg) {
    if (msg.id === undefined) return true; // no command without an id
    const params = paramsOf(msg);
    if (msg.sessionId) {
      this.replyError(msg, 'Session with given id not found.');
      return true;
    }
    if (params.targetId !== undefined || params.sessionId !== undefined) {
      this.replyError(msg, 'No target with given id found');
      return true;
    }
    switch (msg.method) {
      case 'Browser.getVersion': {
        const version = knownVersion();
        if (!version) return false;
        this.reply(msg, version);
        return true;
      }
      case 'Target.setAutoAttach':
      case 'Target.setDiscoverTargets':
        // remembered by fromClient, replayed on a main browser started later
        this.reply(msg, {});
        return true;
      case 'Browser.setDownloadBehavior':
        if (params.browserContextId !== undefined) return false;
        this.reply(msg, {});
        return true;
      case 'Target.getTargetInfo':
        this.reply(msg, { targetInfo: { targetId: this.browserTargetId, type: 'browser', title: '', url: '', attached: true, canAccessOpener: false } });
        return true;
      case 'Target.getTargets':
        this.reply(msg, { targetInfos: [] });
        return true;
      case 'Target.getBrowserContexts':
        this.reply(msg, { browserContextIds: [] });
        return true;
      case 'Target.disposeBrowserContext':
        this.answerGone(msg);
        return true;
      case 'Browser.close':
        // (CDP_ALLOW_BROWSER_CLOSE) no browser to close: the connection goes
        this.reply(msg, {});
        this.close('client sent Browser.close');
        return true;
      default:
        return false;
    }
  }

  // Starts the main browser (if it is not running) and connects to it, for
  // the commands waiting in mainQueue; the client's target setup goes first,
  // so it finds the main browser's pages the way it would have on connecting.
  startMain() {
    if (this.mainOpening || this.closed) return;
    this.mainOpening = (async () => {
      const main = await this.openMain();
      if (this.closed) {
        main.close();
        return;
      }
      log(`mux ${this.clientAddr}: connected to the main browser for the client's command`);
      this.adoptMain(main);
      const setup = [
        ['Target.setDiscoverTargets', this.discover],
        ['Target.setAutoAttach', this.autoAttach],
        ['Browser.setDownloadBehavior', this.downloadBehavior],
      ];
      for (const [method, params] of setup) {
        if (params) this.internalSend('main', method, params).catch((err) => log(`mux ${this.clientAddr}: ${err.message}`));
      }
    })().then(() => this.flushMain(), (err) => {
      log(`mux ${this.clientAddr}: main browser: ${err.message}`);
      this.flushMain(err);
    }).finally(() => { this.mainOpening = null; });
  }

  flushMain(err) {
    const queued = this.mainQueue;
    this.mainQueue = [];
    for (const msg of queued) {
      if (err || !this.main) this.answerGone(msg, `the main browser could not be started${err ? `: ${err.message}` : ''}`);
      else this.toMain(msg);
    }
  }

  // The main browser exited. A connection without an isolated context ends
  // with it, as on chromium's own; one with a context goes on: the client's
  // main pages are gone (told the way chromium tells it), its commands in
  // flight there answered, and a later command for the main browser starts
  // it again (toMain).
  mainGone() {
    if (this.closed) return;
    if (this.closingBrowser || (!this.context && !this.attaching)) {
      this.close('main browser connection closed');
      return;
    }
    this.main = null;
    log(`mux ${this.clientAddr}: the main browser is gone; the client keeps its isolated context`);
    for (const [sessionId, { targetId, parent }] of this.mainSessions) {
      this.sendClient({ method: 'Target.detachedFromTarget', sessionId: parent, params: { sessionId, targetId } });
    }
    for (const targetId of this.mainTargets) {
      this.sendClient({ method: 'Target.targetDestroyed', params: { targetId } });
    }
    this.mainSessions.clear();
    this.mainTargets.clear();
    for (const msg of this.mainInFlight.values()) this.answerGone(msg, 'the main browser is gone');
    this.mainInFlight.clear();
    for (const [id, p] of this.pending) if (p.origin === 'main') this.pending.delete(id);
    for (const [id, p] of this.internal) {
      if (p.target !== 'main') continue;
      this.internal.delete(id);
      p.reject(new Error(`${p.method}: the main browser is gone`));
    }
    // the client's browser-target sessions were the main chromium's: their
    // stand-ins in the context chromium go with them
    for (const clientSession of [...this.browserSessions.keys()]) this.retireBrowserSession(clientSession);
    this.clientBrowserSessions.clear();
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
      if (origin === 'main') this.mainInFlight.delete(id);
      const pending = this.pending.get(id);
      if (pending?.origin === origin) {
        if (pending.msg.id !== id || READ_MAIN_REPLIES.has(pending.msg.method)) return true;
        if (origin === 'context' && READ_CONTEXT_REPLIES.has(pending.msg.method)) return true;
        this.pending.delete(id);
      }
    }
    if (origin === 'main') return MAIN_TRACKED.test(head);
    return this.browserSessionOf.size > 0 || CONTEXT_MARKERS.some((marker) => data.includes(marker));
  }

  trackContextMessage(msg) {
    const p = msg.params;
    if (msg.result?.browserContextId) this.innerContexts.add(msg.result.browserContextId);
    if (msg.result?.targetId) this.contextTargets.add(msg.result.targetId);
    switch (msg.method) {
      case 'Target.attachedToTarget':
        this.sessionTarget.set(p.sessionId, p.targetInfo.targetId);
        if (msg.sessionId) this.sessionParent.set(p.sessionId, msg.sessionId);
        break;
      case 'Target.detachedFromTarget':
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
    this.contextWindows.clear();
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
    this.main?.close();
    if (this.client.readyState === WebSocket.OPEN) this.client.close();
  }
}
