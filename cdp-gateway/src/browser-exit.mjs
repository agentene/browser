// CDP commands that end the shared browser (CDP_ALLOW_BROWSER_CLOSE).
//
// The main browser is shared by every client, every isolated context hangs
// off it, and with CHROMIUM_AUTOSTART=true the container itself exits with
// it — so one client's Browser.close (Puppeteer's browser.close() sends it,
// on a browser or a page WebSocket alike) would take everyone down. Unless
// CDP_ALLOW_BROWSER_CLOSE=true, the gateway answers it instead: it succeeds
// and ends that client's own connection (and so its isolated context), which
// is all a client can tell of a closed browser. The crash commands are
// refused.

import { ALLOW_BROWSER_CLOSE } from './config.mjs';

const CRASH = new Set(['Browser.crash', 'Browser.crashGpuProcess']);

// Whether a raw frame has a JSON \u escape: a method name may hide behind
// one ("Browser.\u0063lose" is Browser.close to chromium's parser too), so
// such a frame cannot be judged by its bytes and has to be parsed.
export function hasEscape(data) {
  return data.includes('\\u');
}

// Cheap pre-check on a raw frame: whether it may name one of the commands
// (their method name is a JSON string, so it appears as "Browser.c — or
// escaped).
export function mayEndBrowser(data, allowed = ALLOW_BROWSER_CLOSE) {
  return !allowed && (data.includes('"Browser.c') || hasEscape(data));
}

// What the gateway does with a parsed client command: null = forward it,
// 'close' = answer {} and end the client's connection, 'refuse' = answer an
// error.
export function browserExitAction(method, allowed = ALLOW_BROWSER_CLOSE) {
  if (allowed) return null;
  if (method === 'Browser.close') return 'close';
  if (CRASH.has(method)) return 'refuse';
  return null;
}

export const REFUSED_MESSAGE = 'refused by the CDP gateway: the browser is shared (CDP_ALLOW_BROWSER_CLOSE)';
