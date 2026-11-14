// One client's logical connection to a context browser. Its pipe connection
// can be replaced without closing the client's Pages. Only top-level pages
// and browser sessions survive; document handles are generation-scoped.
import { EventEmitter } from 'node:events';
import { debuglog } from 'node:util';
import { ContextJournal } from './context-journal.mjs';
import { ProtocolIds } from './context-protocol.mjs';
import { MAX_BUFFERED, sleep } from './util.mjs';
const debug = debuglog('cdp-context');

export class ContextSession extends EventEmitter {
  readyState = 1;
  constructor(context, upstream, protocol) {
    super();
    this.context = context;
    this.ids = new ProtocolIds(protocol);
    this.sessions = new Map();
    this.root = this.entry('', '', 'browser', '');
    this.targets = new Map();
    this.windowTargets = new Map();
    this.pending = new Map();
    this.queue = [];
    this.queueBytes = 0;
    this.wireId = 0;
    this.mode = 'running';
    this.adopt(upstream);
  }

  entry(id, targetId, type, parent) {
    const s = { id, targetId, type, parent, journal: new ContextJournal(), worlds: new Map(), windows: new Set() };
    this.sessions.set(id, s);
    return s;
  }

  get bufferedAmount() { return this.queueBytes + (this.upstream?.bufferedAmount ?? 0); }
  pause() { this.upstream?.pause(); }
  resume() { this.upstream?.resume(); }

  get blockedReason() {
    if ([...this.pending.values()].some((p) => p.msg?.method === 'Target.createBrowserContext')) return 'an incognito context is being created';
    for (const s of this.sessions.values()) {
      const reason = s.journal.blockers.values().next().value;
      if (reason) return reason;
    }
    return '';
  }

  get controlledRestore() {
    return [...this.sessions.values()].some((s) => s.journal.controlled);
  }

  logicalTarget(id) { return this.ids.id('target', id, 'out'); }
  physicalTarget(id) { return this.ids.id('target', id, 'in'); }

  adopt(upstream) {
    this.upstream = upstream;
    upstream.on('message', (data) => { if (this.upstream === upstream) this.receive(JSON.parse(data)); });
    upstream.on('close', () => {
      if (this.upstream === upstream && this.mode === 'running') this.close();
    });
  }

  deliver(msg) { this.emit('message', Buffer.from(JSON.stringify(msg)), false); }
  error(msg, message) {
    if (msg.id !== undefined) this.deliver({ id: msg.id, sessionId: msg.sessionId, error: { code: -32000, message } });
  }

  send(data, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    const msg = typeof data === 'string' || Buffer.isBuffer(data) ? JSON.parse(data) : data;
    if (this.readyState !== 1) { cb?.(new Error('context connection closed')); return; }
    // Late interception replies belong to the old process and must never request a wake. Restoration still needs replies for its new requests; id translation rejects previous-generation requests.
    if (this.mode !== 'running' && /^Fetch\.(continueRequest|continueResponse|fulfillRequest|failRequest|continueWithAuth)$/.test(msg.method)) {
      if (this.mode === 'restoring') {
        try { this.forward(msg, cb); } catch (err) { this.error(msg, err.message); cb?.(); }
      } else {
        this.error(msg, 'intercepted request was interrupted by context hibernation');
        cb?.();
      }
      return;
    }
    if (this.mode !== 'running') {
      // Discovery is a view of logical targets, not an instruction to run
      // every sleeping browser. GC of an old handle must not wake it either.
      if (msg.method === 'Target.detachFromTarget') {
        const detached = new Set([msg.params?.sessionId]);
        for (const s of this.sessions.values()) if (detached.has(s.parent)) detached.add(s.id);
        for (const id of detached) {
          const s = this.sessions.get(id);
          if (!id || !s) continue;
          this.sessions.delete(id);
          this.deliver({ method: 'Target.detachedFromTarget', sessionId: s.parent || undefined,
            params: { sessionId: id, targetId: s.targetId } });
        }
        if (msg.id !== undefined) this.deliver({ id: msg.id, sessionId: msg.sessionId, result: {} });
      } else if (msg.method === 'Target.getTargets') {
        const filter = msg.params?.filter;
        const targetInfos = [...this.targets.values()].filter((t) => {
          if (!filter) return !['browser', 'tab'].includes(t.type);
          const rule = filter.find((f) => !f.type || f.type === t.type);
          return rule ? !rule.exclude : false;
        });
        this.deliver({ id: msg.id, sessionId: msg.sessionId, result: { targetInfos } });
      } else if (msg.method === 'Runtime.releaseObject') {
        this.sessions.get(msg.sessionId ?? '')?.journal.helpers.delete(msg.params?.objectId);
        this.deliver({ id: msg.id, sessionId: msg.sessionId, result: {} });
      } else {
        const bytes = Buffer.byteLength(JSON.stringify(msg));
        if (this.queueBytes + bytes > MAX_BUFFERED) this.error(msg, 'context wake queue is full');
        else {
          this.queue.push(msg);
          this.queueBytes += bytes;
          this.context.wake().catch((err) => this.flush(err));
        }
      }
      cb?.();
      return;
    }
    try { this.forward(msg, cb); } catch (err) { this.error(msg, err.message); cb?.(); }
  }

  forward(msg, cb) {
    debug('%s %s send %s %s %s', this.context.name, this.mode, msg.id, msg.method, msg.sessionId ?? 'root');
    const session = msg.sessionId ?? '';
    if (msg.method === 'Page.bringToFront') this.context.selected = this.sessions.get(session)?.targetId;
    if (msg.method === 'Target.activateTarget') this.context.selected = msg.params?.targetId;
    const out = {
      ...msg,
      params: this.ids.translate(msg.method, msg.params ?? {}, 'params', 'in', session),
      sessionId: session ? this.ids.id('session', session, 'in') : undefined,
    };
    out.id = ++this.wireId;
    this.pending.set(out.id, { msg, session });
    this.upstream.send(out, {}, cb);
  }

  // Private restoration commands address the physical connection directly.
  rpc(method, params = {}, sessionId) {
    if (this.readyState !== 1 || !this.upstream) return Promise.reject(new Error('context connection closed during restoration'));
    const id = ++this.wireId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: restoration timed out`));
      }, 15000);
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.upstream.send({ id, method, params, sessionId });
    });
  }

  receive(raw) {
    debug('%s %s receive %s %s %s', this.context.name, this.mode, raw.id ?? '', raw.method ?? (raw.error ? raw.error.message : 'reply'), raw.sessionId ?? 'root');
    if (raw.id !== undefined) {
      const p = this.pending.get(raw.id);
      if (!p) return;
      this.pending.delete(raw.id);
      if (p.resolve) {
        if (raw.error) p.reject(new Error(raw.error.message));
        else p.resolve(raw.result ?? {});
        return;
      }
      const { msg, session } = p;
      const result = raw.result && this.ids.translate(msg.method, raw.result, 'result', 'out', session);
      if (!raw.error) {
        const s = this.sessions.get(session);
        s?.journal.record(msg, result ?? {});
        if (msg.method === 'Runtime.releaseObject') this.ids.releaseObject(msg.params?.objectId, session);
        if (msg.method === 'Page.getFrameTree' && result?.frameTree) s.frameId = result.frameTree.frame.id;
        if (msg.method === 'Browser.getWindowForTarget' && result?.windowId) {
          s?.windows.add(result.windowId);
          const target = msg.params?.targetId ?? s?.targetId;
          if (target) this.windowTargets.set(result.windowId, target);
        }
        if (msg.method === 'Target.attachToBrowserTarget' && result?.sessionId && !this.sessions.has(result.sessionId)) {
          this.entry(result.sessionId, '', 'browser', session);
        }
        if (msg.method === 'Target.getTargets') {
          for (const info of result.targetInfos ?? []) this.targets.set(info.targetId, info);
        }
      }
      this.deliver({ id: msg.id, sessionId: msg.sessionId, ...(raw.error ? { error: raw.error } : { result }) });
      return;
    }
    if (this.mode === 'suspended') return;
    const parent = raw.sessionId ? this.ids.id('session', raw.sessionId, 'out') : '';
    const p = raw.params ?? {};
    if (raw.method === 'Target.attachedToTarget') {
      const target = this.logicalTarget(p.targetInfo.targetId);
      const existing = this.mode === 'restoring' && (this.attaching
        ?? [...this.sessions.values()].find((s) => s.id && s.targetId === target && s.parent === parent && !s.bound));
      const id = existing ? this.ids.bind('session', p.sessionId, existing.id) : this.ids.id('session', p.sessionId, 'out');
      const s = existing || this.entry(id, target, p.targetInfo.type, parent);
      if (existing?.type === 'browser' && existing.targetId) this.ids.bind('target', p.targetInfo.targetId, existing.targetId);
      s.bound = true;
      s.physical = p.sessionId;
    }
    if (raw.method === 'Runtime.executionContextCreated') {
      const c = p.context;
      const s = this.sessions.get(parent);
      const frame = c.auxData?.frameId ? this.logicalTarget(c.auxData.frameId) : '';
      const key = `${frame}:${c.name}:${Boolean(c.auxData?.isDefault)}`;
      const old = s?.worlds.get(key);
      if (this.mode === 'restoring' && old) {
        this.ids.bind('world', c.id, old.id, parent);
        if (c.uniqueId && old.uniqueId) this.ids.bind('uniqueWorld', c.uniqueId, old.uniqueId, parent);
      }
      const translated = this.ids.translate(raw.method, p, 'event', 'out', parent).context;
      s?.worlds.set(key, { ...translated, key });
    }
    const params = this.ids.translate(raw.method, p, 'event', 'out', parent);
    const s = this.sessions.get(parent);
    if (this.mode !== 'restoring' && raw.method === 'Runtime.executionContextsCleared') {
      s?.worlds.clear(); s?.journal.clearWorld();
      this.ids.dropTransient(parent);
    }
    if (this.mode !== 'restoring' && raw.method === 'Runtime.executionContextDestroyed') {
      for (const [key, c] of s?.worlds ?? []) if (c.id === params.executionContextId) s.worlds.delete(key);
      s?.journal.clearWorld(params.executionContextId);
    }
    if (params.targetInfo) this.targets.set(params.targetInfo.targetId, params.targetInfo);
    if (this.mode === 'restoring') {
      if (raw.method.startsWith('Fetch.') || (raw.method.startsWith('Network.')
        && s?.journal.states.get('Fetch.enable')?.method === 'Fetch.enable')) {
        this.deliver({ ...raw, sessionId: parent || undefined, params });
      }
      if ((raw.method === 'Page.frameAttached' && params.frameId !== s?.frameId)
        || (raw.method === 'Page.frameNavigated' && params.frame?.id !== s?.frameId)) {
        this.deliver({ ...raw, sessionId: parent || undefined, params });
      }
      if (raw.method === 'Target.attachedToTarget' && !['page', 'browser'].includes(params.targetInfo.type)) {
        this.deferredEvents.push({ ...raw, sessionId: parent || undefined, params });
      }
      return; // physical reattachment is not a new logical Page
    }
    if (raw.method === 'Target.detachedFromTarget') this.sessions.delete(params.sessionId);
    if (raw.method === 'Target.targetDestroyed') this.targets.delete(params.targetId);
    this.deliver({ ...raw, sessionId: parent || undefined, params });
  }

  suspend() {
    this.mode = 'suspended';
    for (const tab of this.context.snapshot?.tabs ?? []) {
      this.targets.set(tab.id, { ...this.targets.get(tab.id), targetId: tab.id, type: 'page', title: tab.title, url: tab.url,
        attached: [...this.sessions.values()].some((s) => s.targetId === tab.id) });
    }
    for (const [id, p] of this.pending) {
      if (p.reject) p.reject(new Error('context hibernated'));
      else this.error(p.msg, 'context hibernated while the command was in flight');
      this.pending.delete(id);
    }
    for (const [id, s] of this.sessions) {
      if (['page', 'browser'].includes(s.type)) {
        if (s.type === 'page') {
          for (const [key, world] of s.worlds) {
            if (world.auxData?.frameId === s.frameId) continue;
            s.journal.clearWorld(world.id);
            s.worlds.delete(key);
          }
          for (const [key, state] of s.journal.states) {
            if (state.method === 'Page.createIsolatedWorld' && state.params.frameId !== s.frameId) s.journal.states.delete(key);
          }
        }
        continue;
      }
      this.deliver({ method: 'Target.detachedFromTarget', sessionId: s.parent || undefined, params: { sessionId: id, targetId: s.targetId } });
      this.sessions.delete(id);
    }
    for (const [id, info] of this.targets) {
      if (['page', 'browser'].includes(info.type)) continue;
      this.deliver({ method: 'Target.targetDestroyed', params: { targetId: id } });
      this.targets.delete(id);
    }
    const old = this.upstream;
    this.upstream = null;
    old?.close();
  }

  async restore(pipe, pages) {
    this.mode = 'restoring';
    this.deferredEvents = [];
    this.ids.restart();
    for (const page of pages) this.ids.bind('target', page.physical, page.id);
    for (const s of this.sessions.values()) { s.bound = !s.id; s.physical = undefined; }
    this.adopt(await pipe.connect());
    const saved = [...this.sessions.values()];
    for (const [windowId, targetId] of this.windowTargets) {
      if (!pages.some((p) => p.id === targetId)) continue;
      const r = await this.rpc('Browser.getWindowForTarget', { targetId: this.physicalTarget(targetId) });
      this.ids.bind('window', r.windowId, windowId);
    }
    // Browser stand-ins first, then discovery / auto-attach. Auto-attached
    // pages are matched to their existing logical sessions in receive().
    for (const s of saved.filter((e) => e.id && e.type === 'browser')) {
      this.attaching = s;
      try {
        const r = await this.rpc('Target.attachToBrowserTarget', {}, s.parent ? this.ids.id('session', s.parent, 'in') : undefined);
        this.ids.bind('session', r.sessionId, s.id); s.physical = r.sessionId; s.bound = true;
      } finally { this.attaching = null; }
    }
    for (const s of saved.filter((e) => e.type === 'browser')) await this.replay(s);
    for (const s of saved.filter((e) => e.type === 'page')) {
      if (!s.bound) {
        this.attaching = s;
        try {
          const r = await this.rpc('Target.attachToTarget', { targetId: this.physicalTarget(s.targetId), flatten: true },
            s.parent ? this.ids.id('session', s.parent, 'in') : undefined);
          this.ids.bind('session', r.sessionId, s.id); s.physical = r.sessionId; s.bound = true;
        } finally { this.attaching = null; }
      }
      const tree = await this.rpc('Page.getFrameTree', {}, s.physical);
      if (s.frameId) this.ids.bind('target', tree.frameTree.frame.id, s.frameId);
      for (const w of s.windows) {
        const r = await this.rpc('Browser.getWindowForTarget', {}, s.physical);
        this.ids.bind('window', r.windowId, w);
      }
      await this.replay(s);
    }
    // Snapshot-created pages are blank until all their pre-navigation
    // settings and scripts have been reinstalled.
    for (const page of pages) {
      if (!page.navigate) continue;
      await pipe.call('Target.activateTarget', { targetId: page.physical });
      const primary = saved.find((s) => s.type === 'page' && s.targetId === page.id);
      const sessionId = primary?.physical ?? (await pipe.call('Target.attachToTarget', { targetId: page.physical, flatten: true })).sessionId;
      await pipe.call('Page.navigate', { url: page.url }, { sessionId });
      if (!primary) await pipe.call('Target.detachFromTarget', { sessionId });
    }
    for (const s of saved.filter((e) => e.type === 'page')) {
      await this.rpc('Runtime.runIfWaitingForDebugger', {}, s.physical);
      // Do not wait for networkidle: long polling is a normal web page.
      for (let i = 0; i < 150; i++) {
        const r = await this.rpc('Runtime.evaluate', { expression: '({state:document.readyState,url:location.href})', returnByValue: true }, s.physical);
        const expected = pages.find((p) => p.id === s.targetId);
        const v = r.result?.value;
        if (v && ['interactive', 'complete'].includes(v.state) && (v.url !== 'about:blank' || expected?.url === 'about:blank')) break;
        if (i === 149) throw new Error('restored page did not become ready');
        await sleep(100);
      }
      // Re-announce the actual worlds only inside the adapter. Client world
      // and helper identities survive this physical replacement.
      await this.rpc('Runtime.disable', {}, s.physical);
      await this.rpc('Runtime.enable', {}, s.physical);
      for (const state of s.journal.states.values()) {
        if (state.method === 'Page.createIsolatedWorld') await this.replayOne(s, state);
      }
      for (const [logical, helper] of s.journal.helpers) {
        const params = this.ids.translate('Runtime.evaluate', helper.msg.params, 'params', 'in', s.id);
        const r = await this.rpc('Runtime.evaluate', params, s.physical);
        if (!r.result?.objectId) throw new Error('could not rebuild Playwright helper');
        this.ids.bind('object', r.result.objectId, logical, s.id);
      }
      const { frameTree } = await this.rpc('Page.getFrameTree', {}, s.physical);
      const translated = this.ids.translate('Page.getFrameTree', { frameTree }, 'result', 'out', s.id);
      this.deliver({ method: 'Page.frameNavigated', sessionId: s.id, params: { frame: translated.frameTree.frame, type: 'Navigation' } });
      const children = (tree) => {
        for (const child of tree.childFrames ?? []) {
          this.deliver({ method: 'Page.frameAttached', sessionId: s.id, params: { frameId: child.frame.id, parentFrameId: tree.frame.id } });
          this.deliver({ method: 'Page.frameNavigated', sessionId: s.id, params: { frame: child.frame, type: 'Navigation' } });
          children(child);
        }
      };
      children(translated.frameTree);
      for (const { key: _, ...world } of s.worlds.values()) {
        if (world.auxData?.frameId !== translated.frameTree.frame.id) {
          this.deliver({ method: 'Runtime.executionContextCreated', sessionId: s.id, params: { context: world } });
        }
      }
      for (const name of ['DOMContentLoaded', 'load']) this.deliver({ method: 'Page.lifecycleEvent', sessionId: s.id,
        params: { frameId: translated.frameTree.frame.id, loaderId: translated.frameTree.frame.loaderId, name, timestamp: performance.now() / 1000 } });
    }
    this.mode = 'running';
    for (const event of this.deferredEvents) this.deliver(event);
    this.deferredEvents = [];
  }

  async replay(s) {
    for (const state of s.journal.states.values()) await this.replayOne(s, state);
  }

  async replayOne(s, state) {
    const params = this.ids.translate(state.method, state.params, 'params', 'in', s.id);
    const r = await this.rpc(state.method, params, s.physical);
    if (state.method === 'Page.addScriptToEvaluateOnNewDocument') this.ids.bind('initScript', r.identifier, state.result.identifier, s.id);
  }

  flush(err) {
    const queued = this.queue; this.queue = []; this.queueBytes = 0;
    for (const msg of queued) {
      if (err) this.error(msg, `context could not wake: ${err.message}`);
      else this.send(msg);
    }
  }

  close(silent = false) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.mode = 'suspended';
    if (silent) { this.queue = []; this.queueBytes = 0; }
    else this.flush(new Error('context is gone'));
    for (const p of this.pending.values()) p.reject?.(new Error('context connection closed'));
    this.pending.clear();
    this.upstream?.close();
    this.upstream = null;
    this.emit('close');
    this.sessions.clear();
    this.targets.clear();
    this.windowTargets.clear();
    this.ids.maps.clear();
  }

  terminate() { this.close(); }
}
