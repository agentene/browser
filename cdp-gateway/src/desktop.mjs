// The browsers' windows on the desktop (what the Selkies stream shows): which
// one is in front, and bringing one to the front.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { browserPid, portOf } from './browsers.mjs';
import { notifyChange } from './changes.mjs';
import { CONTEXTS_HEADLESS, RAISE_SWITCH, ROOT, WAYLAND, appId } from './config.mjs';
import { devtoolsFetch, fetchJson, pageTargets } from './devtools-http.mjs';
import { mainBrowser } from './main-browser.mjs';
import { output, run, sleep } from './util.mjs';

// Hand desktop.raiseNewWindows (settings.mjs) to the desktop: whether a
// window that opens comes to the front or stays behind the one in front.
// labwc / the X11 screen follower apply it as each window opens; Show
// (focus below) raises either way.
export async function applyRaiseNewWindows(on) {
  if (await run(RAISE_SWITCH, [String(on)]) !== 0) throw new Error(`${path.basename(RAISE_SWITCH)} ${on} failed`);
}

// The app_ids in `wlrctl toplevel list` output ("<app_id>: <title>" lines).
export function listedAppIds(text) {
  return new Set(text.split('\n').filter((line) => line.includes(':')).map((line) => line.slice(0, line.indexOf(':'))));
}

// The browser whose window is in front on the desktop, or null. Wayland: the
// one labwc has focused (one wlrctl call lists it). X11: the topmost browser
// window, which front-window.py reports whenever it changes (while
// watchFront runs).
let frontPid = 0;
let frontWatch = null;

export async function frontBrowser(names) {
  if (!WAYLAND) return names.find((name) => frontPid && browserPid(name) === frontPid) ?? null;
  const shown = names.filter((name) => (name === 'main' ? mainBrowser.running : !CONTEXTS_HEADLESS));
  if (!shown.length) return null;
  const focused = listedAppIds(await output('wlrctl', ['toplevel', 'list', 'state:focused']));
  return shown.find((name) => focused.has(appId(name))) ?? null;
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
// Resolves false when there is nothing to focus: no such browser or tab.
export async function focus(name, targetId) {
  const port = portOf(name);
  if (!port) return false;
  let id = targetId || (await pageTargets(port))[0]?.id;
  const opened = !id;
  if (opened) id = (await fetchJson(port, '/json/new?about:blank', 'PUT')).id;
  if (!(await devtoolsFetch(port, `/json/activate/${encodeURIComponent(id)}`)).ok) return false;
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
