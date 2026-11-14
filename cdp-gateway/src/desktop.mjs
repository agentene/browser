// The browsers' windows on the desktop (what the Selkies stream shows): which
// one is in front and what their titles say, and bringing one to the front.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { browserPid, pipeOf } from './browsers.mjs';
import { notifyChange } from './changes.mjs';
import { CONTEXTS_HEADLESS, RAISE_SWITCH, ROOT, WAYLAND, appId } from './config.mjs';
import { mainBrowser } from './main-browser.mjs';
import { contexts } from './contexts.mjs';
import { pageInfos } from './targets.mjs';
import { output, run, sleep } from './util.mjs';

// Hand desktop.raiseNewWindows (settings.mjs) to the desktop: whether a
// window that opens comes to the front or stays behind the one in front.
// labwc / the X11 screen follower apply it as each window opens; Show
// (focus below) raises either way.
export async function applyRaiseNewWindows(on) {
  if (await run(RAISE_SWITCH, [String(on)]) !== 0) throw new Error(`${path.basename(RAISE_SWITCH)} ${on} failed`);
}

// The windows in `wlrctl toplevel list` output ("<app_id>: <title>" lines),
// as [app_id, title] pairs.
export function listedToplevels(text) {
  return text.split('\n').filter((line) => line.includes(':')).map((line) => {
    const colon = line.indexOf(':');
    return [line.slice(0, colon), line.slice(colon + 1).replace(/^ /, '')];
  });
}

// The browsers' windows on the desktop: front, the browser whose window is
// in front (or null), and titles, each browser's window titles, the one in
// front first. Chromium titles a window after the tab in front of it — the
// one tab state no CDP client can blur (targets.mjs). Wayland: what labwc
// lists (two wlrctl calls: every window, the focused one). X11: what
// front-window.py reports whenever it changes, top to bottom (while
// watchFront runs).
let x11Windows = []; // [pid, title], topmost first
let frontWatch = null;

export async function desktopWindows(names) {
  const titles = new Map();
  const add = (name, title) => {
    const list = titles.get(name) ?? [];
    if (!list.includes(title)) titles.set(name, [...list, title]);
  };
  if (!WAYLAND) {
    const byPid = (pid) => names.find((name) => browserPid(name) === pid);
    for (const [pid, title] of x11Windows) {
      const name = byPid(pid);
      if (name) add(name, title);
    }
    return { front: x11Windows.length ? byPid(x11Windows[0][0]) ?? null : null, titles };
  }
  const shown = names.filter((name) => (name === 'main' ? mainBrowser.running : !CONTEXTS_HEADLESS));
  if (!shown.length) return { front: null, titles };
  const [focused, all] = (await Promise.all([
    output('wlrctl', ['toplevel', 'list', 'state:focused']),
    output('wlrctl', ['toplevel', 'list']),
  ])).map(listedToplevels);
  const byAppId = (id) => shown.find((name) => appId(name) === id);
  for (const [id, title] of [...focused, ...all]) {
    const name = byAppId(id);
    if (name) add(name, title);
  }
  return { front: focused.map(([id]) => byAppId(id)).find(Boolean) ?? null, titles };
}

// X11: front-window.py runs while anyone needs the window in front — the
// console (console-live.mjs) and the input overlay (input-overlay.mjs) each
// watch and unwatch once.
let frontUsers = 0;

export function watchFront() {
  frontUsers++;
  if (WAYLAND || frontWatch) return;
  const child = spawn('python3', [path.join(ROOT, 'front-window.py')], { stdio: ['pipe', 'pipe', 'ignore'] });
  frontWatch = child;
  let buffered = '';
  child.stdout.on('data', (chunk) => {
    const lines = (buffered + chunk).split('\n');
    buffered = lines.pop();
    if (!lines.length) return;
    try {
      x11Windows = JSON.parse(lines.at(-1));
    } catch {
      return;
    }
    notifyChange();
  });
  child.stdin.on('error', () => { /* exited */ });
  child.on('error', () => { /* no python3: no front marker */ });
  child.on('exit', () => {
    // no X display (headless desktop) ends it right away: no front marker
    if (frontWatch === child) frontWatch = null;
    x11Windows = [];
  });
}

export function unwatchFront() {
  if (frontUsers > 0) frontUsers--;
  if (frontUsers) return;
  frontWatch?.stdin.end();
  frontWatch = null;
  x11Windows = [];
}

// Bring a context's (or the main browser's) window to the front of the desktop
// so it shows up in the Selkies stream, with the tab targetId in front if
// one is given (else the tab in front stays). A browser whose tabs were all
// closed (it keeps running without a window) gets a blank tab to show.
// Resolves false when there is nothing to focus: no such browser or tab.
export async function focus(name, targetId) {
  const pipe = pipeOf(name);
  if (!pipe) return false;
  const context = contexts.get(name);
  let id = targetId && (context?.physicalTarget(targetId) ?? targetId);
  if (context && targetId) context.selected = targetId;
  const opened = !id && !(await pageInfos(pipe)).length;
  if (opened) ({ targetId: id } = await pipe.call('Target.createTarget', { url: 'about:blank' }));
  if (id) {
    try {
      await pipe.call('Target.activateTarget', { targetId: id });
    } catch {
      return false; // no such tab (any more)
    }
  }
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
