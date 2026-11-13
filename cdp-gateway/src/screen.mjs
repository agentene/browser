// The desktop back to SCREEN_GEOMETRY before a context's window opens while
// nobody watches. Selkies' browser-driven resize leaves the display at the
// last viewer's canvas size, and labwc maximizes every window to it: after
// a narrow viewer a new context came up as a strip (100x60 -> 532x129 with
// chromium's minimum window size). The next viewer resizes the display to
// its canvas again, and every window follows.

import { SCREEN_SIZE, VIEWER_SOCKET, WAYLAND } from './config.mjs';
import { connectionsTo, log, output, run } from './util.mjs';

// The desktop's size now: { current: 'WxH' (undefined when unreadable),
// output: the Wayland output's name }.
export async function readScreen() {
  if (WAYLAND) {
    const text = await output('wlr-randr', []);
    return { current: /(\d+x\d+) px[^\n]*\(current\)/.exec(text)?.[1], output: text.split(' ')[0] };
  }
  return { current: /current (\d+) x (\d+)/.exec(await output('xrandr', ['--current']))?.slice(1).join('x') };
}

export async function restoreScreen() {
  if (!SCREEN_SIZE || !VIEWER_SOCKET || connectionsTo(VIEWER_SOCKET) > 0) return;
  const { current, output: name } = await readScreen();
  const resize = WAYLAND
    ? ['wlr-randr', ['--output', name, '--custom-mode', SCREEN_SIZE]]
    : ['selkies', ['resize', SCREEN_SIZE]];
  if (!current || current === SCREEN_SIZE) return;
  const code = await run(...resize);
  log(`no viewer: desktop ${current} -> ${SCREEN_SIZE}${code === 0 ? '' : ` failed (${code})`}`);
}
