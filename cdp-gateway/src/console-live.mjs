// Console live state (WebSocket /console/ws), the console pages' only source
// of state. A new subscriber gets a snapshot, then only what changed,
// batched per tick as {ops: [...]}:
//   {t:'snapshot', max, settings, browsers:[{name, ...fields, tabs, current, thumb}]}
//   {t:'settings', settings}               the server-side settings changed
//                                          (all of them, as settingsView())
//   {t:'browser', name, ...fields}         a new browser (all fields) or changed fields
//   {t:'gone', name}                       a context is gone
//   {t:'tabs', name, set:[tab], del:[id]}  new or changed tabs, closed tabs
//   {t:'current', name, id}                another tab is in front
//   {t:'thumb', name, id, jpeg}            a new thumbnail of the current tab (base64)
// Ticks list each browser's tabs over its pipe (targets.mjs), only while a
// console is connected, and never start a stopped main browser. Thumbnails
// come from a screencast of each browser's current tab (screencast.mjs).

import WebSocket from 'ws';
import { browserNames, pipeOf } from './browsers.mjs';
import { onChange } from './changes.mjs';
import { MAX_CONTEXTS } from './config.mjs';
import { contexts } from './contexts.mjs';
import { desktopWindows, unwatchFront, watchFront } from './desktop.mjs';
import { mainBrowser } from './main-browser.mjs';
import { Screencast } from './screencast.mjs';
import { settingsView } from './settings.mjs';
import { NO_TABS, browserTabs, releaseProbes } from './targets.mjs';
import { log } from './util.mjs';

const TICK_MS = 1000;
// At most one thumbnail per browser this often: the browser in front on
// the desktop (the one the Selkies stream shows) refreshes fast, the ones
// behind it slowly. With no desktop (or none in front) all refresh fast.
const THUMB_FRONT_MS = 2000;
const THUMB_BACK_MS = 20000;

const subscribers = new Set();
const views = new Map(); // name -> what subscribers were last told: { fields, tabs, current, thumb, cast }
const memos = new Map(); // name -> the current-tab memo of targets.mjs' pickCurrent
let tickTimer = null;
let anyFront = false;
let settingsSent = JSON.stringify(settingsView());
let tickRunning = Promise.resolve();
let tickQueued = null;

// A console that reads slower than the thumbnails come (a stalled tab, a bad
// link) would grow the gateway's send buffer without bound; skipping ops would
// leave it with a wrong picture, so it is dropped instead — the pages
// reconnect and start over from a snapshot.
export const MAX_BUFFERED = 8 * 1024 * 1024;

export function broadcast(ops, to = subscribers) {
  if (!ops.length) return;
  const msg = JSON.stringify({ ops });
  for (const ws of to) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (ws.bufferedAmount > MAX_BUFFERED) {
      log(`console subscriber too slow (${ws.bufferedAmount} bytes waiting): disconnected`);
      ws.terminate();
      continue;
    }
    ws.send(msg);
  }
}

// One tick at a time; calls while one runs share the next one.
function runTick() {
  tickQueued ??= tickRunning.then(() => {
    tickQueued = null;
    return tick();
  });
  tickRunning = tickQueued.catch((err) => log(`console tick: ${err.message}`));
  return tickRunning;
}

// Something changed: tell the consoles now instead of on the next tick.
function consolePoke() {
  if (subscribers.size) runTick();
}
onChange(consolePoke);

function browserFields(name, front) {
  if (name === 'main') return { main: true, state: mainBrowser.state, front };
  const s = contexts.get(name);
  return { color: s.color, client: s.client, createdAt: s.createdAt, pid: s.proc?.pid ?? null, front };
}

async function tick() {
  const ops = [];
  const settings = settingsView();
  if (JSON.stringify(settings) !== settingsSent) {
    settingsSent = JSON.stringify(settings);
    ops.push({ t: 'settings', settings });
  }
  const names = browserNames();
  const { front, titles } = await desktopWindows(names);
  anyFront = !!front;
  for (const [name, view] of views) {
    if (names.includes(name)) continue;
    stopCast(view);
    views.delete(name);
    ops.push({ t: 'gone', name });
  }
  for (const name of memos.keys()) if (!names.includes(name)) memos.delete(name);
  // all browsers at once: one slow to answer holds up the tick only as long
  // as the slowest (and at most a pipe call's timeout), not their sum
  const listings = await Promise.all(names.map((name) => {
    const pipe = pipeOf(name);
    if (!memos.has(name)) memos.set(name, {});
    if (name === 'main' && !mainBrowser.running) return NO_TABS;
    // null: starting up or shutting down — keep what the consoles have
    return pipe ? browserTabs(pipe, memos.get(name), titles.get(name)).catch(() => null) : null;
  }));
  for (const [i, name] of names.entries()) {
    const listing = listings[i];
    if (!listing) continue;
    if (name !== 'main' && !contexts.get(name)) continue; // destroyed meanwhile
    const pipe = pipeOf(name);
    let view = views.get(name);
    if (!view) views.set(name, view = { fields: {}, tabs: new Map(), current: null, thumb: null, cast: null });
    const changed = {};
    for (const [k, v] of Object.entries(browserFields(name, name === front))) {
      if (view.fields[k] !== v) changed[k] = v;
    }
    if (Object.keys(changed).length) {
      Object.assign(view.fields, changed);
      ops.push({ t: 'browser', name, ...changed });
    }
    // tabs keep the order they were first seen in (least recently active
    // first), so a console's list does not jump around on every tab switch
    const set = [];
    const seen = new Set();
    for (const tab of listing.tabs.toReversed()) {
      seen.add(tab.id);
      const old = view.tabs.get(tab.id);
      if (old && old.title === tab.title && old.url === tab.url) continue;
      view.tabs.set(tab.id, tab);
      set.push(tab);
    }
    const del = [...view.tabs.keys()].filter((id) => !seen.has(id));
    for (const id of del) view.tabs.delete(id);
    if (set.length || del.length) ops.push({ t: 'tabs', name, set, del });
    if (view.thumb && !view.tabs.has(view.thumb.id)) view.thumb = null; // no dead weight in snapshots
    if (listing.current !== view.current) {
      view.current = listing.current;
      ops.push({ t: 'current', name, id: view.current });
    }
    syncCast(name, view, pipe);
    view.cast?.reschedule(); // it may have come to the front, or gone behind
  }
  broadcast(ops);
}

function snapshot() {
  return {
    t: 'snapshot',
    max: MAX_CONTEXTS,
    settings: settingsView(),
    browsers: [...views].map(([name, v]) => ({
      name, ...v.fields, tabs: [...v.tabs.values()], current: v.current, thumb: v.thumb,
    })),
  };
}

// Screencast the browser's current tab while a console is connected.
function syncCast(name, view, pipe) {
  const want = subscribers.size && pipe ? view.current : null;
  if ((view.cast?.id ?? null) === want) return;
  stopCast(view);
  if (!want) return;
  const cast = new Screencast(pipe, want, {
    interval: () => (view.fields.front || !anyFront ? THUMB_FRONT_MS : THUMB_BACK_MS),
    onFrame: (jpeg) => {
      if (view.thumb?.id === want && view.thumb.jpeg === jpeg) return false;
      view.thumb = { id: want, jpeg };
      broadcast([{ t: 'thumb', name, id: want, jpeg }]);
      return true;
    },
    onEnd: () => {
      if (view.cast === cast) stopCast(view);
    },
  });
  view.cast = cast;
}

function stopCast(view) {
  view.cast?.close();
  view.cast = null;
}

export async function subscribe(ws) {
  ws.on('error', () => { /* close follows */ });
  ws.on('close', () => {
    subscribers.delete(ws);
    if (subscribers.size) return;
    clearInterval(tickTimer);
    tickTimer = null;
    unwatchFront();
    for (const view of views.values()) stopCast(view);
    // the current-tab probes' sessions too (targets.mjs) — once a tick
    // under way is done, or it would probe the tabs again after this
    tickRunning.then(() => {
      if (subscribers.size) return;
      for (const name of browserNames()) {
        const pipe = pipeOf(name);
        if (pipe) releaseProbes(pipe);
      }
    });
  });
  await runTick(); // views may be stale while nobody watched
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ ops: [snapshot()] }));
  subscribers.add(ws);
  if (!tickTimer) {
    watchFront();
    tickTimer = setInterval(runTick, TICK_MS);
    runTick(); // starts the screencasts
  }
}
