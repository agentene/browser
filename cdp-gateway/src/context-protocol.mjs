// Typed CDP id translation. In particular, Runtime.RemoteObject.value is
// arbitrary application data, NOT a tree of protocol ids to rewrite.
import { readFileSync } from 'node:fs';
import { PROTOCOL_FILE } from './config.mjs';

const KINDS = new Map(Object.entries({
  'Target.TargetID': 'target', 'Page.FrameId': 'target',
  'Target.SessionID': 'session', 'Runtime.ExecutionContextId': 'world',
  'Runtime.RemoteObjectId': 'object', 'Browser.WindowID': 'window',
  'Page.ScriptIdentifier': 'initScript', 'Runtime.ScriptId': 'script',
  'DOM.NodeId': 'node', 'DOM.BackendNodeId': 'backendNode',
  'Network.RequestId': 'request', 'Fetch.RequestId': 'fetch',
  // Chromium uses requestId === loaderId to identify document requests.
  'Network.LoaderId': 'request', 'Network.InterceptionId': 'interception',
  'IO.StreamHandle': 'stream', 'Debugger.BreakpointId': 'breakpoint',
}));
const GLOBAL = new Set(['target', 'session', 'window']);
let schema;

export class ProtocolIds {
  constructor(protocol) {
    schema ??= protocol ?? JSON.parse(readFileSync(PROTOCOL_FILE, 'utf8'));
    this.types = new Map();
    this.commands = new Map();
    this.events = new Map();
    for (const d of (protocol ?? schema).domains) {
      for (const t of d.types ?? []) this.types.set(`${d.domain}.${t.id}`, { ...t, domain: d.domain });
      for (const c of d.commands ?? []) this.commands.set(`${d.domain}.${c.name}`, { ...c, domain: d.domain });
      for (const e of d.events ?? []) this.events.set(`${d.domain}.${e.name}`, { ...e, domain: d.domain });
    }
    this.maps = new Map();
    this.serial = 1_000_000;
    this.generation = 0;
  }

  table(kind, session = '') {
    const key = `${GLOBAL.has(kind) ? '' : session}\0${kind}`;
    if (!this.maps.has(key)) this.maps.set(key, { to: new Map(), from: new Map(), used: new Set() });
    return this.maps.get(key);
  }

  bind(kind, physical, logical, session = '') {
    const t = this.table(kind, session);
    const previous = t.to.get(logical);
    if (previous !== undefined) t.from.delete(previous);
    t.to.set(logical, physical);
    t.from.set(physical, logical);
    t.used.add(logical);
    return logical;
  }

  id(kind, value, direction, session = '') {
    if (value === undefined || value === null || value === 0 || value === '') return value;
    const t = this.table(kind, session);
    if (direction === 'in') {
      if (t.to.has(value)) return t.to.get(value);
      if (!this.generation) return value; // ordinary chromium validates unknown ids
      throw new Error(`stale or unknown ${kind} id after context restoration`);
    }
    if (t.from.has(value)) return t.from.get(value);
    const logical = !this.generation && !t.used.has(value) ? value
      : typeof value === 'number' ? ++this.serial : `hibernate-${kind}-${++this.serial}`;
    return this.bind(kind, value, logical, session);
  }

  restart() {
    this.generation++;
    for (const t of this.maps.values()) { t.to.clear(); t.from.clear(); }
  }

  dropTransient(session) {
    for (const kind of ['object', 'node', 'backendNode', 'world', 'uniqueWorld', 'script']) {
      const t = this.table(kind, session);
      t.to.clear(); t.from.clear();
    }
  }

  releaseObject(id, session) {
    const t = this.table('object', session);
    const physical = t.to.get(id);
    if (physical !== undefined) t.from.delete(physical);
    t.to.delete(id);
    t.used.delete(id);
  }

  // params/result are traversed only according to the protocol schema.
  translate(method, value, part, direction, session = '') {
    const def = (part === 'event' ? this.events : this.commands).get(method);
    if (!def) return value;
    const out = this.object(value, part === 'result' ? def.returns : def.parameters, def.domain, direction, session);
    // These two execution-context identifiers are strings in CDP's schema.
    if (method === 'Runtime.executionContextCreated' && out?.context?.uniqueId) {
      out.context.uniqueId = this.id('uniqueWorld', out.context.uniqueId, direction, session);
    }
    // auxData is formally an untyped object, but Chromium's documented
    // execution-context extension carries the owning frame here. Leaving
    // its physical id would make Playwright ignore a new page's worlds.
    if (method === 'Runtime.executionContextCreated' && out?.context?.auxData?.frameId) {
      out.context.auxData = { ...out.context.auxData,
        frameId: this.id('target', out.context.auxData.frameId, direction, session) };
    }
    if (method === 'Runtime.executionContextDestroyed' && out?.executionContextUniqueId) {
      out.executionContextUniqueId = this.id('uniqueWorld', out.executionContextUniqueId, direction, session);
    }
    if (out?.uniqueContextId) out.uniqueContextId = this.id('uniqueWorld', out.uniqueContextId, direction, session);
    return out;
  }

  object(value, properties, domain, direction, session) {
    if (!value || typeof value !== 'object') return value;
    const out = { ...value };
    for (const p of properties ?? []) {
      if (Object.hasOwn(value, p.name)) out[p.name] = this.walk(value[p.name], p, domain, direction, session);
    }
    return out;
  }

  walk(value, def, domain, direction, session) {
    if (value === undefined || value === null) return value;
    if (def.$ref) {
      const ref = def.$ref.includes('.') ? def.$ref : `${domain}.${def.$ref}`;
      if (KINDS.has(ref)) return this.id(KINDS.get(ref), value, direction, session);
      const type = this.types.get(ref);
      return type ? this.walk(value, type, type.domain, direction, session) : value;
    }
    if (def.type === 'array' && Array.isArray(value)) return value.map((v) => this.walk(v, def.items, domain, direction, session));
    if (def.type === 'object') return this.object(value, def.properties, domain, direction, session);
    return value;
  }
}
