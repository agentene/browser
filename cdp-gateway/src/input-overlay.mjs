// The input overlay: what CDP clients make the pages see as user input
// (Input.* — the pointer moving, clicks, wheel, keys, text), drawn over the
// Selkies stream by overlay.js, which nginx injects into the Selkies page.
// CDP input never reaches the desktop — chromium hands it straight to the
// page — so without this a viewer sees a page react with nothing that
// pointed or typed (CDP_INPUT_OVERLAY, config.mjs).
//
// WebSocket /console/overlay (upgrade.mjs; the console's auth), server to
// page only: {t:'hello', v, mode} first, then batches {ops: [...]} of
//   {t:'screen', w, h}                       the desktop's size (DIP), when it changes
//   {t:'move'|'down'|'up', c, b, x, y, button?, n?, approx?}
//   {t:'wheel', c, b, x, y, dx, dy}
//   {t:'key', c, b, combo, away?}            'Ctrl+A', 'Enter', 'Shift+Tab', ...
//   {t:'text', c, b, s, away?}               text typed (mode text, not sensitive)
//   {t:'text', c, b, n, masked?, away?}      only how many characters (mode keys,
//                                            or a sensitive field: masked)
//   {t:'off', c, b, why, tab, host?}         c's pointer input lands where the
//                                            stream does not show it
//   away: why the stream does not show the page these keys go to (as 'off');
//   ops with away or why also name the tab: tab (its title, or its host
//   when it has none) and host when another tab of that browser has the
//   same title
//   {t:'bye', c}                             c's CDP connection closed
// c numbers the CDP connections (the lowest free one), b names the browser
// ('main', 'context-N'); x, y are desktop coordinates in DIP.
//
// The consoles (console-live.mjs) show the same numbers on the tabs the
// clients work in: while one is open (watchInput), workingTabs() lists
// each connection's last input target, for WORKING_MS after its input.
//
// Costs nothing while no overlay or console is open: the pipes only report input to a
// listener (pipe.mjs), attached while one is. Per target it then keeps a
// session of the gateway's own and asks it, at most once a second (and
// again before text once the focus may have moved), where the viewport sits
// on the desktop and whether the focused field is one whose text must not
// be shown.

import WebSocket from 'ws';
import { browserNames, pipeOf } from './browsers.mjs';
import { onChange } from './changes.mjs';
import { CONTEXTS_HEADLESS, INPUT_OVERLAY, WAYLAND } from './config.mjs';
import { desktopWindows, unwatchFront, watchFront } from './desktop.mjs';
import { readScreen } from './screen.mjs';
import { MAX_BUFFERED, log } from './util.mjs';

const BATCH_MS = 33; // ops go out at most ~30 times a second
const GEOMETRY_MS = 1000; // how long what a target said of itself holds
const FRONT_MS = 1000; // how long the window in front holds
const SCREEN_MS = 2000; // how long the desktop size read on X11 holds
const CALL_MS = 1000; // the gateway's window / layout questions
const TAB_CHARS = 40; // a tab title longer than this is cut
const WORKING_MS = 60000; // a console marks a client's tab this long after its last input
const FACTS_MS = 300; // the page's own answer (a dialog or a busy page may never give it)

// What the page says of itself, in one evaluation (silent, returning a
// plain object): its viewport in CSS pixels, whether it is the tab shown,
// and whether the focused element is one whose text must stay hidden — a
// password (or a field drawn masked), a one-time code or card field, or a
// frame, where the focused field cannot be seen from here.
const PAGE_FACTS = `(() => {
  let e = document.activeElement;
  while (e && e.shadowRoot && e.shadowRoot.activeElement) e = e.shadowRoot.activeElement;
  const tag = e ? e.tagName : '';
  const ac = String((e && e.getAttribute && e.getAttribute('autocomplete')) || '').toLowerCase();
  let masked = false;
  try { masked = !!e && e !== document.body && getComputedStyle(e).webkitTextSecurity !== 'none'; } catch (_) {}
  const sensitive = ['IFRAME', 'FRAME', 'OBJECT', 'EMBED'].includes(tag)
    || (tag === 'INPUT' && e.type === 'password') || masked
    || /password|one-time-code|cc-/.test(ac);
  return { w: innerWidth, h: innerHeight, vis: document.visibilityState, sensitive };
})()`;

const ALT = 1;
const CTRL = 2;
const META = 4;
const SHIFT = 8;
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Fn', 'Hyper', 'Super', 'OS']);
const KEY_NAMES = { ' ': 'Space', Escape: 'Esc', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' };
// keys after which the focus may sit elsewhere: the next text checks again
const FOCUS_KEYS = new Set(['Tab', 'Enter', 'Escape']);

// --- pure helpers (exported for the tests) ------------------------------------

// Text a key event types, or null: printable text without Ctrl/Alt/Meta.
export function keyText(params) {
  const mods = Number(params.modifiers) || 0;
  if (mods & (ALT | CTRL | META)) return null;
  const text = typeof params.text === 'string' && params.text ? params.text
    : (params.type === 'keyDown' && typeof params.key === 'string' && [...params.key].length === 1 ? params.key : '');
  // eslint-disable-next-line no-control-regex
  return text && !/[\x00-\x1f\x7f]/.test(text) ? text : null;
}

// The label of a key press that is no text: 'Ctrl+Shift+T', 'Enter', ... —
// or null for a lone modifier and for anything that is no key press.
export function keyCombo(params) {
  if (params.type !== 'keyDown' && params.type !== 'rawKeyDown') return null;
  const key = typeof params.key === 'string' && params.key ? params.key : (params.code || '');
  if (!key || MODIFIER_KEYS.has(key)) return null;
  const mods = Number(params.modifiers) || 0;
  const parts = [];
  if (mods & CTRL) parts.push('Ctrl');
  if (mods & ALT) parts.push('Alt');
  // Shift is part of the text it typed ('A'); it only shows with another
  // modifier or a key that types nothing (Shift+Tab)
  const printable = [...key].length === 1;
  if (mods & SHIFT && (!printable || mods & (ALT | CTRL | META))) parts.push('Shift');
  if (mods & META) parts.push('Meta');
  parts.push(KEY_NAMES[key] ?? (printable ? key.toUpperCase() : key));
  return parts.join('+');
}

// What one key event means: { text } typed, { combo } pressed, or null.
// rawKeyDown + char (the older pair) types on the char; keyDown carries
// its text itself; keyUp says nothing new.
export function keyAction(params) {
  if (params.type === 'char') {
    const text = keyText({ ...params, type: 'keyDown' });
    return text ? { text } : null;
  }
  if (params.type !== 'keyDown' && params.type !== 'rawKeyDown') return null;
  // a rawKeyDown of a key that types: its char follows and types it
  const text = keyText({ ...params, type: 'keyDown' });
  if (text !== null) return params.type === 'keyDown' ? { text } : null;
  const combo = keyCombo(params);
  return combo ? { combo, key: params.key } : null;
}

// Where the viewport's top left sits on the desktop and the CSS-to-DIP
// factor, from the window's bounds (DIP), the viewport's CSS size and the
// page zoom. The viewport fills the window's bottom left: the tab strip,
// toolbar and infobars sit above it, nothing to its left (a side panel
// takes its right). With a viewport emulated (Emulation.setDeviceMetricsOverride)
// the page is drawn from the top, below the chrome measured before (top,
// the browser's last known toolbar height).
export function viewportGeometry(bounds, inner, zoom = 1, { emulated = false, top } = {}) {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const x = bounds.left;
  const y = emulated && Number.isFinite(top) ? bounds.top + top : bounds.top + bounds.height - inner.h * z;
  return { x, y, zoom: z };
}

// A point in the viewport (CSS pixels) on the desktop (DIP, rounded).
export function toDesktop(geo, x, y) {
  return { x: Math.round(geo.x + (Number(x) || 0) * geo.zoom), y: Math.round(geo.y + (Number(y) || 0) * geo.zoom) };
}

// The pointer-like actions of one Input command: [{ kind, x, y, button?, n?, dx?, dy? }].
export function pointerActions(method, params) {
  switch (method) {
    case 'Input.dispatchMouseEvent':
    case 'Input.emulateTouchFromMouseEvent': {
      const button = method === 'Input.emulateTouchFromMouseEvent' ? 'touch' : (params.button || 'none');
      const at = { x: params.x, y: params.y };
      if (params.type === 'mouseMoved') return [{ kind: 'move', ...at }];
      if (params.type === 'mousePressed') return [{ kind: 'down', ...at, button, n: params.clickCount || 1 }];
      if (params.type === 'mouseReleased') return [{ kind: 'up', ...at, button, n: params.clickCount || 1 }];
      if (params.type === 'mouseWheel') return [{ kind: 'wheel', ...at, dx: Number(params.deltaX) || 0, dy: Number(params.deltaY) || 0 }];
      return [];
    }
    case 'Input.dispatchTouchEvent': {
      const p = Array.isArray(params.touchPoints) ? params.touchPoints[0] : null;
      if (!p) return [];
      const at = { x: p.x, y: p.y };
      if (params.type === 'touchStart') return [{ kind: 'down', ...at, button: 'touch', n: 1 }];
      if (params.type === 'touchMove') return [{ kind: 'move', ...at }];
      if (params.type === 'touchEnd') return [{ kind: 'up', ...at, button: 'touch', n: 1 }];
      return [];
    }
    case 'Input.synthesizeTapGesture': {
      const at = { x: params.x, y: params.y, button: 'touch', n: params.tapCount || 1 };
      return [{ kind: 'down', ...at }, { kind: 'up', ...at }];
    }
    case 'Input.dispatchDragEvent': {
      const at = { x: params.x, y: params.y };
      if (params.type === 'drop') return [{ kind: 'up', ...at, button: 'drag', n: 1 }];
      if (params.type === 'dragEnter' || params.type === 'dragOver') return [{ kind: 'move', ...at }];
      return [];
    }
    default:
      return [];
  }
}

// How a text op reads in a mode: the text, or only its length.
export function textOp(text, { mode, sensitive }) {
  if (mode === 'text' && !sensitive) return { s: text };
  const n = [...text].length;
  return sensitive ? { n, masked: true } : { n };
}

// Adds op to a batch: a move or wheel right after the same connection's
// last one replaces it / adds up, typed text right after the same
// connection's text joins it.
export function addOp(batch, op) {
  const last = batch.at(-1);
  if (last && last.t === op.t && last.c === op.c && last.b === op.b && last.away === op.away && last.tab === op.tab) {
    if (op.t === 'move' && last.approx === op.approx) {
      batch[batch.length - 1] = op;
      return;
    }
    if (op.t === 'wheel') {
      last.x = op.x;
      last.y = op.y;
      last.dx += op.dx;
      last.dy += op.dy;
      return;
    }
    if (op.t === 'text' && typeof last.s === 'string' && typeof op.s === 'string') {
      last.s += op.s;
      return;
    }
    if (op.t === 'text' && last.s === undefined && op.s === undefined && !!last.masked === !!op.masked) {
      last.n += op.n;
      return;
    }
  }
  batch.push(op);
}

// --- state ---------------------------------------------------------------------

const subscribers = new Set();
const watched = new Map(); // pipe -> { name, onInput, onDetached, onClose }
const targets = new Map(); // pipe -> Map(targetId -> Target)
const toolbars = new Map(); // pipe -> the chrome's height above the viewport, last measured (DIP)
const clients = new Map(); // PipeConnection -> { c, shown: null | true | where it was hidden }
const working = new Map(); // PipeConnection -> { c, name, id, at }: where its last input went
let consoles = 0; // the consoles watching (watchInput)
let batch = [];
let batchTimer = null;
let screen = null; // { w, h }
let screenAt = 0;
let front = { at: 0, name: null, known: false };

// One target's state: what it said of itself, its own work queue.
class Target {
  constructor(pipe, targetId) {
    this.pipe = pipe;
    this.targetId = targetId;
    this.session = null; // Promise of the gateway's own sessionId on it
    this.facts = null; // { at, geo, vis, sensitive, approx }
    this.asking = null; // the facts being fetched
    this.focusMoved = true; // the next text asks the page again first
    this.emulated = false;
    this.queue = [];
    this.draining = false;
  }
}

function targetOf(pipe, targetId) {
  let byId = targets.get(pipe);
  if (!byId) targets.set(pipe, (byId = new Map()));
  let t = byId.get(targetId);
  if (!t) byId.set(targetId, (t = new Target(pipe, targetId)));
  return t;
}

// The lowest number no open connection has.
function clientOf(conn) {
  let client = clients.get(conn);
  if (client) return client;
  const used = new Set([...clients.values()].map((x) => x.c));
  let c = 1;
  while (used.has(c)) c++;
  client = { c, shown: null };
  clients.set(conn, client);
  conn.once('close', () => {
    clients.delete(conn);
    working.delete(conn);
    if (subscribers.size) push({ t: 'bye', c });
  });
  return client;
}

// --- the pipes ------------------------------------------------------------------

function syncPipes() {
  const live = new Map();
  if (subscribers.size || consoles) {
    for (const name of browserNames()) {
      const pipe = pipeOf(name);
      if (pipe && !pipe.closed) live.set(pipe, name);
    }
  }
  for (const [pipe, w] of watched) {
    if (live.get(pipe) === w.name) continue;
    unwatchPipe(pipe);
  }
  for (const [pipe, name] of live) {
    if (!watched.has(pipe)) watchPipe(pipe, name);
  }
}

function watchPipe(pipe, name) {
  const w = {
    name,
    onInput: (event) => onInput(pipe, name, event),
    onDetached: (sessionId) => forgetSession(pipe, sessionId),
    onClose: () => unwatchPipe(pipe),
  };
  watched.set(pipe, w);
  pipe.on('input', w.onInput);
  pipe.on('detached', w.onDetached);
  pipe.once('close', w.onClose);
}

function unwatchPipe(pipe) {
  const w = watched.get(pipe);
  if (!w) return;
  watched.delete(pipe);
  pipe.off('input', w.onInput);
  pipe.off('detached', w.onDetached);
  pipe.off('close', w.onClose);
  for (const t of targets.get(pipe)?.values() ?? []) releaseTarget(t);
  targets.delete(pipe);
  toolbars.delete(pipe);
}

function releaseTarget(t) {
  t.queue.length = 0;
  t.session?.then((sessionId) => {
    if (!t.pipe.closed) t.pipe.call('Target.detachFromTarget', { sessionId }).catch(() => {});
  }, () => {});
}

// One of the gateway's sessions detached: its tab closed.
function forgetSession(pipe, sessionId) {
  const byId = targets.get(pipe);
  if (!byId) return;
  for (const [targetId, t] of byId) {
    t.session?.then((s) => { if (s === sessionId && byId.get(targetId) === t) byId.delete(targetId); }, () => {});
  }
}

// --- input ------------------------------------------------------------------------

function onInput(pipe, name, { conn, targetId, msg }) {
  if (!targetId) return; // not a page's session: chromium refuses input there
  const params = msg.params !== null && typeof msg.params === 'object' ? msg.params : {};
  const t = targetOf(pipe, targetId);
  if (msg.method === 'Emulation.setDeviceMetricsOverride') {
    t.emulated = true;
    t.facts = null;
    return;
  }
  if (msg.method === 'Emulation.clearDeviceMetricsOverride') {
    t.emulated = false;
    t.facts = null;
    return;
  }
  const items = [];
  if (msg.method === 'Input.dispatchKeyEvent') {
    const action = keyAction(params);
    if (action?.text) items.push({ kind: 'text', text: action.text });
    else if (action?.combo) items.push({ kind: 'key', combo: action.combo, moves: FOCUS_KEYS.has(action.key) });
  } else if (msg.method === 'Input.insertText') {
    if (typeof params.text === 'string' && params.text) items.push({ kind: 'text', text: params.text });
  } else {
    items.push(...pointerActions(msg.method, params));
  }
  if (!items.length) return;
  const { c } = clientOf(conn);
  working.set(conn, { c, name, id: targetId, at: Date.now() });
  if (!subscribers.size) return; // only a console watches
  for (const item of items) enqueue(t, { ...item, c, conn, name });
}

// A target's input is handled in order, one at a time (some of it waits for
// the page's answer); a move queued behind another of the same connection
// replaces it, typed text joins the text before it.
function enqueue(t, item) {
  const last = t.queue.at(-1);
  if (last && last.conn === item.conn && last.kind === item.kind && item.kind === 'move') {
    t.queue[t.queue.length - 1] = item;
  } else if (last && last.conn === item.conn && last.kind === 'text' && item.kind === 'text') {
    last.text += item.text;
  } else {
    t.queue.push(item);
  }
  if (!t.draining) drain(t);
}

async function drain(t) {
  t.draining = true;
  try {
    while (t.queue.length && subscribers.size) {
      const item = t.queue.shift();
      try {
        await handle(t, item);
      } catch (err) {
        log(`input overlay: ${err.message}`);
      }
    }
  } finally {
    t.draining = false;
  }
}

async function handle(t, item) {
  if (item.kind === 'down' || (item.kind === 'key' && item.moves)) t.focusMoved = true;
  if (item.kind === 'key' || item.kind === 'text') {
    // text asks afresh once the focus may have moved (a sensitive field)
    const facts = await factsOf(t, item.kind === 'text' && t.focusMoved);
    const away = await hiddenBecause(t, item.name, facts);
    let op;
    if (item.kind === 'key') op = { t: 'key', c: item.c, b: item.name, combo: item.combo };
    else {
      // the text in keys mode is a count whatever the field
      const sensitive = INPUT_OVERLAY === 'text' ? facts.sensitive : false;
      t.focusMoved = false;
      op = { t: 'text', c: item.c, b: item.name, ...textOp(item.text, { mode: INPUT_OVERLAY, sensitive }) };
    }
    if (away) Object.assign(op, { away }, await tabOf(t));
    push(op);
    return;
  }
  const facts = await factsOf(t, false);
  // pointer input: drawn only where the stream shows it
  const client = clients.get(item.conn);
  const why = await hiddenBecause(t, item.name, facts);
  if (why) {
    // once per place: again when it moves to another hidden tab
    const tab = await tabOf(t);
    const where = JSON.stringify([why, item.name, tab.tab, tab.host]);
    if (client && client.shown !== where) push({ t: 'off', c: item.c, b: item.name, why, ...tab });
    if (client) client.shown = where;
    return;
  }
  if (client) client.shown = true;
  if (!facts.geo) return;
  const at = toDesktop(facts.geo, item.x, item.y);
  const op = { t: item.kind, c: item.c, b: item.name, ...at };
  if (item.button !== undefined) op.button = item.button;
  if (item.n !== undefined) op.n = item.n;
  if (item.kind === 'wheel') {
    op.dx = item.dx;
    op.dy = item.dy;
  }
  if (facts.approx) op.approx = true;
  push(op);
}

// What tells a tab apart in the tab strip, from the browser's page targets:
// { tab } its title — its host when it has none (chromium then reports the
// URL as the title) — plus { host } when another tab has the same title.
export function tabLabel(targetId, infos) {
  const pages = (infos || []).filter((i) => i.type === 'page');
  const me = pages.find((i) => i.targetId === targetId);
  if (!me) return {};
  let host = '';
  try {
    host = new URL(me.url).host;
  } catch { /* no URL: nothing to add */ }
  const title = (me.title || '').trim();
  if (!title || me.url.includes(title)) return { tab: clip(host || me.url) };
  const twin = pages.some((i) => i !== me && (i.title || '').trim() === title);
  return twin && host ? { tab: clip(title), host } : { tab: clip(title) };
}
const clip = (s) => ([...s].length > TAB_CHARS ? `${[...s].slice(0, TAB_CHARS - 1).join('')}…` : s);

// The tab label of a target, asked at most once a second.
async function tabOf(t) {
  if (t.tab && Date.now() - t.tab.at < GEOMETRY_MS) return t.tab.label;
  t.tabAsking ??= t.pipe.call('Target.getTargets', {}, { timeout: CALL_MS })
    .then((r) => tabLabel(t.targetId, r.targetInfos), () => ({}))
    .finally(() => { t.tabAsking = null; });
  const label = await t.tabAsking;
  t.tab = { at: Date.now(), label };
  return label;
}

// Why the stream does not show this target's pointer input, or null.
async function hiddenBecause(t, name, facts) {
  if (name !== 'main' && CONTEXTS_HEADLESS) return 'headless';
  if (facts.vis && facts.vis !== 'visible') return 'background';
  const inFront = await frontName();
  if (inFront.known && inFront.name !== name) return 'behind';
  return null;
}

async function frontName() {
  if (Date.now() - front.at < FRONT_MS) return front;
  try {
    const { front: name } = await desktopWindows(browserNames());
    front = { at: Date.now(), name, known: name !== null };
  } catch {
    front = { at: Date.now(), name: null, known: false };
  }
  return front;
}

// What the target said of itself, fresh enough (fresh: asked again now).
// No answer counts as sensitive: text is never shown on a guess.
async function factsOf(t, fresh) {
  if (!fresh && t.facts && Date.now() - t.facts.at < GEOMETRY_MS) return t.facts;
  t.asking ??= ask(t).finally(() => { t.asking = null; });
  const got = await t.asking;
  t.facts = got;
  return got;
}

async function ask(t) {
  const { pipe, targetId } = t;
  t.session ??= pipe.call('Target.attachToTarget', { targetId, flatten: true }, { timeout: CALL_MS }).then((r) => r.sessionId);
  let sessionId;
  try {
    sessionId = await t.session;
  } catch {
    t.session = null;
    return { at: Date.now(), geo: null, vis: null, sensitive: true };
  }
  const [win, metrics, page] = await Promise.all([
    pipe.call('Browser.getWindowForTarget', { targetId }, { timeout: CALL_MS }).catch(() => null),
    pipe.call('Page.getLayoutMetrics', {}, { sessionId, timeout: CALL_MS }).catch(() => null),
    pipe.call('Runtime.evaluate', { expression: PAGE_FACTS, returnByValue: true, silent: true }, { sessionId, timeout: FACTS_MS })
      .then((r) => (r.result?.value && typeof r.result.value === 'object' ? r.result.value : null), () => null),
  ]);
  const facts = { at: Date.now(), geo: null, vis: page?.vis ?? null, sensitive: page ? !!page.sensitive : true };
  const bounds = win?.bounds;
  if (bounds && Number.isFinite(bounds.left) && Number.isFinite(bounds.height)) {
    const zoom = metrics?.cssVisualViewport?.zoom ?? 1;
    // the viewport's CSS size: the page's own word, else the layout metrics
    const inner = page && Number.isFinite(page.h) ? { w: page.w, h: page.h }
      : { w: metrics?.cssLayoutViewport?.clientWidth, h: metrics?.cssLayoutViewport?.clientHeight };
    if (Number.isFinite(inner.h)) {
      if (!t.emulated) toolbars.set(pipe, bounds.height - inner.h * zoom);
      facts.geo = viewportGeometry(bounds, inner, zoom, { emulated: t.emulated, top: toolbars.get(pipe) });
      facts.approx = t.emulated;
    }
    await noteScreen(bounds);
  }
  return facts;
}

// The desktop's size, for the pages to scale by: on Wayland every window
// is maximized, so a maximized window's bounds are the output's (in DIP, the
// unit of the coordinates); otherwise what xrandr / wlr-randr say.
async function noteScreen(bounds) {
  let next = null;
  if (WAYLAND && ['maximized', 'fullscreen'].includes(bounds.windowState)) {
    next = { w: bounds.left + bounds.width, h: bounds.top + bounds.height };
  } else if (Date.now() - screenAt >= SCREEN_MS || !screen) {
    screenAt = Date.now();
    const size = /^(\d+)x(\d+)$/.exec((await readScreen()).current ?? '');
    if (size) next = { w: Number(size[1]), h: Number(size[2]) };
  }
  if (next && (next.w !== screen?.w || next.h !== screen?.h)) {
    screen = next;
    push({ t: 'screen', ...screen });
  }
}

// --- the pages ------------------------------------------------------------------

function push(op) {
  if (!subscribers.size) return;
  addOp(batch, op);
  batchTimer ??= setTimeout(flush, BATCH_MS);
}

function flush() {
  batchTimer = null;
  const ops = batch;
  batch = [];
  if (!ops.length) return;
  const msg = JSON.stringify({ ops });
  for (const ws of subscribers) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (ws.bufferedAmount > MAX_BUFFERED) {
      log(`input overlay subscriber too slow (${ws.bufferedAmount} bytes waiting): disconnected`);
      ws.terminate();
      continue;
    }
    ws.send(msg);
  }
}

onChange(() => {
  if (subscribers.size || consoles) syncPipes();
});

// A console opened / closed (console-live.mjs): while any is open the
// pipes report input, for workingTabs().
export function watchInput() {
  if (INPUT_OVERLAY === 'off') return;
  if (consoles++ === 0) syncPipes();
}

export function unwatchInput() {
  if (INPUT_OVERLAY === 'off' || consoles === 0) return;
  if (--consoles) return;
  syncPipes();
  if (!subscribers.size) working.clear();
}

// The tabs the CDP clients work in: [{ c, name, id }] — each connection's
// last input target (name: its browser, id: its targetId), while that
// input is no older than WORKING_MS.
export function workingTabs(now = Date.now()) {
  const list = [];
  for (const w of working.values()) {
    if (now - w.at < WORKING_MS) list.push({ c: w.c, name: w.name, id: w.id });
  }
  return list.sort((a, b) => a.c - b.c);
}

export function subscribeOverlay(ws) {
  ws.on('error', () => { /* close follows */ });
  ws.on('close', () => {
    if (!subscribers.delete(ws) || subscribers.size) return;
    // the last overlay closed: the gateway's own sessions go, and nothing
    // listens to the pipes any more unless a console does
    for (const [pipe, byId] of targets) {
      for (const t of byId.values()) releaseTarget(t);
      targets.delete(pipe);
    }
    syncPipes();
    if (!consoles) working.clear();
    unwatchFront();
    clearTimeout(batchTimer);
    batchTimer = null;
    batch = [];
    front = { at: 0, name: null, known: false };
  });
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ t: 'hello', v: 1, mode: INPUT_OVERLAY }));
  if (screen) ws.send(JSON.stringify({ ops: [{ t: 'screen', ...screen }] }));
  subscribers.add(ws);
  if (subscribers.size === 1) {
    watchFront();
    syncPipes();
  }
}

// for the tests
export function overlayState() {
  return { subscribers: subscribers.size, watched: watched.size, clients: clients.size, consoles };
}
