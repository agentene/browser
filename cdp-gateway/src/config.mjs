// Settings: the environment entrypoint/lib/cdp-gateway.sh starts the gateway
// with, and the gateway's own constants. Read once, at import time.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;

export function intEnv(name, fallback, source = env) {
  const raw = source[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name}=${raw} is not a non-negative integer`);
  return n;
}

export const LISTEN_PORT = intEnv('CDP_GATEWAY_INTERNAL_PORT', 9220);
export const MAIN_PORT = intEnv('CDP_INTERNAL_PORT', 9221);
export const MAX_CONTEXTS = intEnv('CDP_CONTEXTS_MAX', 4);
export const CONTEXTS_DIR = env.CDP_CONTEXTS_DIR || '/browser/contexts';
export const MAIN_PROFILE = env.CHROMIUM_USER_DATA_DIR || '/browser/user-data';
export const CHROME_BIN = env.CHROME_BIN;
export const FLAGS_FILE = env.CDP_GATEWAY_FLAGS_FILE || '/tmp/cdp-gateway-chromium-flags';
export const MAIN_FLAGS_FILE = env.CDP_GATEWAY_MAIN_FLAGS_FILE || '/tmp/cdp-gateway-main-flags';
export const MAIN_LOG = '/tmp/chromium.log';
// CHROMIUM_AUTOSTART=false: the gateway owns the main browser (main-browser.mjs)
export const MAIN_ON_DEMAND = env.CHROMIUM_AUTOSTART === 'false';
// the entrypoint-supervised main browser's pid (CHROMIUM_AUTOSTART=true)
export const MAIN_SUPERVISED_PID = env.CDP_MAIN_CHROMIUM_PID;
export const IDLE_TIMEOUT_MS = intEnv('CHROMIUM_IDLE_TIMEOUT', 0) * 60_000;
// Selkies' loopback port: an open connection there is someone watching
export const VIEWER_PORT = intEnv('CDP_GATEWAY_VIEWER_PORT', 0);
export const PUBLIC_FALLBACK = `127.0.0.1:${env.CDP_LISTEN_PORT || 9222}`;
export const WAYLAND = env.DISPLAY_BACKEND === 'wayland';
export const CONTEXTS_HEADLESS = env.CDP_CONTEXTS_HEADLESS === '1';
// desktop-raise-new-windows.sh, which applies DESKTOP_RAISE_NEW_WINDOWS on
// the desktop (the console's switch) and keeps it in RAISE_SETTING; empty
// when the browsers have no desktop
export const RAISE_SWITCH = env.CDP_GATEWAY_RAISE_SWITCH || '';
export const RAISE_SETTING = '/tmp/desktop-raise-new-windows';
// Selkies' master password: console requests that came in through the web
// port (nginx marks them, see console-auth.mjs) must carry it. Empty = no login.
export const WEB_PASSWORD = env.CDP_CONSOLE_WEB_PASSWORD || '';

// The gateway's install dir: dashboard.html, panel.js and the Python helpers
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Ids the gateway uses for its own commands on a client's upstreams; client
// ids (small integers counted up by Playwright) never get there.
export const INTERNAL_ID_BASE = 1_000_000_000;
const MAX_PAYLOAD = 256 * 1024 * 1024; // screenshots and traces can be large
// options for every WebSocket the gateway opens or accepts
export const WS_OPTIONS = { perMessageDeflate: false, maxPayload: MAX_PAYLOAD };

// Browser frame color per context (cycled), so a context window on the desktop
// is recognizable and matches its dashboard card. No window manager draws
// title bars on the Xvfb display, so chromium's own frame is the only place
// a marker shows.
export const CONTEXT_COLORS = ['#e53935', '#43a047', '#fb8c00', '#8e24aa', '#00897b', '#d81b60', '#3949ab', '#6d4c41'];

// The Wayland app_id of the main browser (set by the entrypoint) or a context.
export function appId(name) {
  return `cdp-${name}`;
}

export function readFlags(file = FLAGS_FILE) {
  // NUL-separated, written by the entrypoint from the same flag assembly as
  // the main chromium (GPU policy, locale features, CHROMIUM_EXTRA_ARGS, ...)
  return readFileSync(file, 'utf8').split('\0').filter(Boolean);
}
