// The browsers' windows on the desktop (what the Selkies stream shows): which
// one is in front, and bringing one to the front.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { browserPid, portOf } from './browsers.mjs';
import { notifyChange } from './changes.mjs';
import { CONTEXTS_HEADLESS, RAISE_SETTING, RAISE_SWITCH, ROOT, WAYLAND, appId } from './config.mjs';
import { fetchJson, pageTargets } from './devtools-http.mjs';
import { mainBrowser } from './main-browser.mjs';
import { log, run, sleep } from './util.mjs';

// Whether windows that open on the desktop come to the front, or stay behind
// the one in front (DESKTOP_RAISE_NEW_WINDOWS); null without a desktop.
// labwc / the X11 screen follower apply it as each window opens, the
// switch helper hands it to them. Show (focus below) raises either way.
let raiseNew = null;
if (RAISE_SWITCH) {
  try {
    raiseNew = readFileSync(RAISE_SETTING, 'utf8').trim() !== 'false';
  } catch {
    raiseNew = true; // what the desktop does without the setting
  }
}

export function raiseNewWindows() {
  return raiseNew;
}

export async function setRaiseNewWindows(on) {
  if (raiseNew === null) throw new Error('the browsers have no desktop');
  if (await run(RAISE_SWITCH, [String(on)]) !== 0) throw new Error(`${path.basename(RAISE_SWITCH)} ${on} failed`);
  if (raiseNew === on) return;
  raiseNew = on;
  log(on ? 'new windows come to the front of the desktop' : 'new windows open behind the one in front');
  notifyChange();
}

// The browser whose window is in front on the desktop, or null. Wayland: the
// one labwc has focused — one wlrctl call per browser until it matches. X11:
// the topmost browser window, which front-window.py reports whenever it
// changes (while watchFront runs).
let frontPid = 0;
let frontWatch = null;

export async function frontBrowser(names) {
  if (!WAYLAND) return names.find((name) => frontPid && browserPid(name) === frontPid) ?? null;
  for (const name of names) {
    if (name === 'main' ? !mainBrowser.running : CONTEXTS_HEADLESS) continue;
    if (await run('wlrctl', ['toplevel', 'find', `app_id:${appId(name)}`, 'state:focused']) === 0) return name;
  }
  return null;
}

export function watchFront() {
  if (WAYLAND || frontWatch) return;
  const child = spawn('python3', [path.join(ROOT, 'front-window.py')], { stdio: ['pipe', 'pipe', 'ignore'] });
  frontWatch = child;
  let buffered = '';
  child.stdout.on('data', (chunk) => {
    const lines = (buffered + chunk).split('\n');
    buffered = lines.pop();
    if (!lines.length) return;
    frontPid = Number(lines.at(-1));
    notifyChange();
  });
  child.stdin.on('error', () => { /* exited */ });
  child.on('error', () => { /* no python3: no front marker */ });
  child.on('exit', () => {
    // no X display (headless desktop) ends it right away: no front marker
    if (frontWatch === child) frontWatch = null;
    frontPid = 0;
  });
}

export function unwatchFront() {
  frontWatch?.stdin.end();
  frontWatch = null;
  frontPid = 0;
}

// Bring a context's (or the main browser's) window to the front of the desktop
// so it shows up in the Selkies stream. A browser whose tabs were all closed
// (it keeps running without a window) gets a blank tab to show.
export async function focus(name, targetId) {
  const port = portOf(name);
  if (!port) return false;
  let id = targetId || (await pageTargets(port))[0]?.id;
  const opened = !id;
  if (opened) id = (await fetchJson(port, '/json/new?about:blank', 'PUT')).id;
  await fetch(`http://127.0.0.1:${port}/json/activate/${id}`);
  if (name !== 'main' && CONTEXTS_HEADLESS) return true;
  // a freshly opened window may take a moment to map
  for (let tries = opened ? 20 : 1; tries > 0; tries--) {
    if (await raise(name) === 0) break;
    if (tries > 1) await sleep(100);
  }
  return true;
}

// Chromium's own activate does not restack its window: on X11 no window
// manager runs (raise-window.py restacks via the X server directly), and on
// Wayland labwc refuses activation requests that no user input led to, so
// wlrctl activates the window through labwc's foreign-toplevel protocol.
function raise(name) {
  if (WAYLAND) return run('wlrctl', ['toplevel', 'focus', `app_id:${appId(name)}`]);
  const pid = browserPid(name);
  return pid ? run('python3', [path.join(ROOT, 'raise-window.py'), String(pid)]) : 1;
}
