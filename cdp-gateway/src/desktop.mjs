// The browsers' windows on the desktop (what the Selkies stream shows): which
// one is in front and bringing a browser to the front.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { browserPid, pipeOf } from './browsers.mjs';
import { notifyChange } from './changes.mjs';
import { RAISE_SWITCH, ROOT, WAYLAND, appId } from './config.mjs';
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

// Only the browser in front matters to the desktop marker and input overlay.
// The selected tab comes directly from Chrome over its pipe.
let x11FrontPid = null;
let frontWatch = null;

export async function frontBrowser(names) {
  if (!WAYLAND) return names.find((name) => browserPid(name) === x11FrontPid) ?? null;
  const running = names.filter((name) => name !== 'main' || mainBrowser.running);
  if (!running.length) return null;
  const focused = await output('wlrctl', ['toplevel', 'list', 'state:focused']);
  for (const line of focused.split('\n')) {
    const name = running.find((candidate) => line.startsWith(`${appId(candidate)}:`));
    if (name) return name;
  }
  return null;
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
    if (frontWatch !== child) return;
    const lines = (buffered + chunk).split('\n');
    buffered = lines.pop();
    if (!lines.length) return;
    try {
      x11FrontPid = JSON.parse(lines.at(-1));
    } catch {
      return;
    }
    notifyChange();
  });
  child.stdin.on('error', () => { /* exited */ });
  child.on('error', () => { /* no python3: no front marker */ });
  child.on('exit', () => {
    // A lost X connection clears the front marker.
    if (frontWatch !== child) return;
    frontWatch = null;
    x11FrontPid = null;
  });
}

export function unwatchFront() {
  if (frontUsers > 0) frontUsers--;
  if (frontUsers) return;
  frontWatch?.stdin.end();
  frontWatch = null;
  x11FrontPid = null;
}

// Bring a context's (or the main browser's) window to the front of the desktop
// so it shows up in the Selkies stream, with the tab targetId in front if
// one is given (else the tab in front stays). A browser whose tabs were all
// closed gets a fresh process and a blank tab to show.
// Resolves false when there is nothing to focus: no such browser or tab.
export async function focus(name, targetId) {
  const context = contexts.get(name);
  if (!context) return focusWindow(name, targetId);
  // Coalesce repeated Show clicks, including the empty check + createTarget.
  if (!targetId && context.focusing) return context.focusing;
  const task = (async () => {
    await context.wake('console focus');
    context.holds++;
    try { return await focusWindow(name, targetId); }
    finally { context.holds--; }
  })();
  if (targetId) return task;
  context.focusing = task.finally(() => { context.focusing = null; });
  return context.focusing;
}

async function focusWindow(name, targetId) {
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
