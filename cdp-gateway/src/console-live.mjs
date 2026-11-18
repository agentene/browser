// Console live state (WebSocket /console/ws), the console pages' only source
// of live state. A new subscriber gets a snapshot, then only what changed,
// batched per tick as {ops: [...]}:
//   {t:'snapshot', max, settings, browsers:[{name, ...fields, tabs, current, thumb}], ai}
//   {t:'settings', settings}               the server-side settings changed
//                                          (all of them, as settingsView())
//   {t:'browser', name, ...fields}         a new browser (all fields) or changed fields
//   {t:'gone', name}                       a context is gone
//   {t:'tabs', name, set:[tab], del:[id]}  new or changed tabs, closed tabs
//   {t:'current', name, id}                another tab is in front
//   {t:'thumb', name, id, jpeg}            a new thumbnail of the current tab (base64)
//   {t:'ai', ai:[{c, name, id}]}           the tabs the CDP clients work in now
//                                          (input-overlay.mjs' workingTabs: c numbers
//                                          the client as the overlay does; empty
//                                          with CDP_INPUT_OVERLAY=off)
// Ticks list each browser's tabs over its pipe (targets.mjs), only while a
// console is connected, and never start a stopped main browser. Thumbnails
// come from a screencast of each browser's current tab (screencast.mjs).

import WebSocket from 'ws';
import { browserNames, pipeOf } from './browsers.mjs';
import { onChange } from './changes.mjs';
import { DESKTOP_ENABLED, MAX_CONTEXTS, HIBERNATED_MAX, CONTEXTS_OVERFLOW } from './config.mjs';
import { contexts } from './contexts.mjs';
import { frontBrowser, unwatchFront, watchFront } from './desktop.mjs';
import { unwatchInput, watchInput, workingTabs } from './input-overlay.mjs';
import { mainBrowser } from './main-browser.mjs';
import { hasBrowserClients } from './mux.mjs';
import { hasPageClients } from './relay.mjs';
import { Screencast } from './screencast.mjs';
import { settingsView } from './settings.mjs';
import { NO_TABS, TabListing } from './targets.mjs';
import { MAX_BUFFERED, log } from './util.mjs';

const TICK_MS = 1000;
// At most one thumbnail per browser this often: the browser in front on
// the desktop (the one the Selkies stream shows) refreshes fast, the ones
// behind it slowly. With no desktop (or none in front) all refresh fast.
const THUMB_FRONT_MS = 2000;
const THUMB_BACK_MS = 20000;

const subscribers = new Set();
const views = new Map(); // name -> what subscribers were last told: { fields, tabs, current, thumb, cast }
const tabListings = new Map(); // physical browser pipe -> its live TabListing
let tickTimer = null;
let anyFront = false;
let settingsSent = JSON.stringify(settingsView());
let aiSent = '[]';
let tickRunning = Promise.resolve();
let tickQueued = null;

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
  // Input activity expires and internal probes also use CDP. Only real
  // client connections determine whether Stop/Delete needs confirmation.
  const pipe = name === 'main' ? mainBrowser.pipe : contexts.get(name)?.pipe;
  const hasClients = hasBrowserClients(name, pipe) || hasPageClients(pipe);
  if (name === 'main') return { main: true, state: mainBrowser.state, front, hasClients };
  const s = contexts.get(name);
  return { color: s.color, client: s.client, createdAt: s.createdAt, pid: s.proc?.pid ?? null, front, hasClients,
    state: s.state, occupied: s.slot, hibernatedAt: s.hibernatedAt, lastError: s.lastError, restoreWarning: s.restoreWarning, blockedReason: s.blockedReason };
}

// A transition is not an empty browser. During capture, the previous sleep's
// snapshot can still be present; keep the published rows until the new one is
// complete. Restoration exposes only saved logical targets, never partial
// physical targets from a process that is still starting.
function savedListing(context) {
  if (['hibernated', 'waking'].includes(context?.state)) return context.snapshot;
  if (['closing', 'stopped'].includes(context?.state)) return NO_TABS;
  return null;
}

async function tick() {
  const ops = [];
  const settings = settingsView();
  if (JSON.stringify(settings) !== settingsSent) {
    settingsSent = JSON.stringify(settings);
    ops.push({ t: 'settings', settings });
  }
  const ai = workingTabs().map((tab) => ({ ...tab, id: contexts.get(tab.name)?.logicalTarget(tab.id) ?? tab.id }));
  if (JSON.stringify(ai) !== aiSent) {
    aiSent = JSON.stringify(ai);
    ops.push({ t: 'ai', ai });
  }
  const names = browserNames();
  const front = await frontBrowser(names);
  anyFront = !!front;
  for (const [name, view] of views) {
    if (names.includes(name)) continue;
    stopCast(view);
    views.delete(name);
    ops.push({ t: 'gone', name });
  }
  // all browsers at once: one slow to answer holds up the tick only as long
  // as the slowest (and at most a pipe call's timeout), not their sum
  const pipes = names.map(pipeOf);
  closeTabListingsExcept(new Set(pipes));
  const listings = await Promise.all(names.map(async (name, index) => {
    const pipe = pipes[index];
    const context = contexts.get(name);
    if (pipe && !tabListings.has(pipe)) tabListings.set(pipe, new TabListing(pipe));
    const listing = pipe ? await tabListings.get(pipe).read().catch(() => null) : null;
    return { pipe, context, listing };
  }));
  for (const [i, name] of names.entries()) {
    const context = contexts.get(name);
    if (name !== 'main' && !context) continue; // destroyed meanwhile
    const pipe = pipeOf(name);
    const observed = listings[i];
    // Even another browser's slow probe can span an entire stop/restart.
    // Check the lifecycle and pipe again before translating physical ids.
    let listing = !pipe ? (name === 'main' ? NO_TABS : savedListing(context))
      : pipe === observed.pipe && context === observed.context ? observed.listing : null;
    if (pipe && listing && context) listing = {
      tabs: listing.tabs.map((t) => ({ ...t, id: context.logicalTarget(t.id) })),
      current: listing.current && context.logicalTarget(listing.current),
    };
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
    if (listing) {
      // Keep the first-seen order across switches, hibernation and wake.
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
    hibernatedMax: HIBERNATED_MAX,
    overflow: CONTEXTS_OVERFLOW,
    settings: settingsView(),
    browsers: [...views].map(([name, v]) => ({
      name, ...v.fields, tabs: [...v.tabs.values()], current: v.current, thumb: v.thumb,
    })),
    ai: JSON.parse(aiSent),
  };
}

// Screencast the browser's current tab while a console is connected.
function syncCast(name, view, pipe) {
  const want = subscribers.size && pipe ? view.current : null;
  if ((view.cast?.logicalId ?? null) === want) return;
  stopCast(view);
  if (!want) return;
  const cast = new Screencast(pipe, contexts.get(name)?.physicalTarget(want) ?? want, {
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
  cast.logicalId = want;
}

function stopCast(view) {
  view.cast?.close();
  view.cast = null;
}

function closeTabListingsExcept(keep) {
  for (const [pipe, listing] of tabListings) {
    if (keep?.has(pipe)) continue;
    listing.close();
    tabListings.delete(pipe);
  }
}

export async function subscribe(ws) {
  ws.on('error', () => { /* close follows */ });
  ws.on('close', () => {
    subscribers.delete(ws);
    if (subscribers.size) return;
    if (tickTimer) unwatchInput(); // watched since the first subscriber came in
    clearInterval(tickTimer);
    tickTimer = null;
    if (DESKTOP_ENABLED) unwatchFront();
    for (const view of views.values()) stopCast(view);
    tickRunning.then(() => {
      if (!subscribers.size) closeTabListingsExcept();
    });
  });
  await runTick(); // views may be stale while nobody watched
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ ops: [snapshot()] }));
  subscribers.add(ws);
  if (!tickTimer) {
    if (DESKTOP_ENABLED) watchFront();
    watchInput();
    tickTimer = setInterval(runTick, TICK_MS);
    runTick(); // starts the screencasts
  }
}
