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
// The gateway always owns the main browser (main-browser.mjs);
// CHROMIUM_AUTOSTART=true starts it with the gateway, false on demand only.
export const MAIN_AUTOSTART = env.CHROMIUM_AUTOSTART !== 'false';
export const IDLE_TIMEOUT_MS = intEnv('CHROMIUM_IDLE_TIMEOUT', 0) * 60_000;
// Selkies' loopback port: an open connection there is someone watching
export const VIEWER_PORT = intEnv('CDP_GATEWAY_VIEWER_PORT', 0);
export const PUBLIC_FALLBACK = `127.0.0.1:${env.CDP_LISTEN_PORT || 9222}`;
export const WAYLAND = env.DISPLAY_BACKEND === 'wayland';
export const CONTEXTS_HEADLESS = env.CDP_CONTEXTS_HEADLESS === '1';
// desktop-raise-new-windows.sh, which hands the console's "new windows to
// the front" to the desktop; empty when the browsers have no desktop
export const RAISE_SWITCH = env.CDP_GATEWAY_RAISE_SWITCH || '';
// the console's persisted settings (settings.mjs)
export const SETTINGS_FILE = env.CDP_GATEWAY_SETTINGS_FILE || '/browser/settings/settings.json';
// A salted scrypt hash of Selkies' master password: console requests that
// came in through the web port (nginx marks them, see console-auth.mjs) must
// carry the password. Empty = no login.
export const WEB_PASSWORD_HASH = env.CDP_CONSOLE_WEB_PASSWORD_HASH || '';
// CDP_ALLOW_ORIGINS: the web page origins that may use the CDP API, like
// chromium's --remote-allow-origins (cdp-origin.mjs); parsed there.
export const ALLOW_ORIGINS_RAW = env.CDP_ALLOW_ORIGINS || '';
// CDP_ALLOW_BROWSER_CLOSE=true: a client's Browser.close / Browser.crash
// reaches the shared browser (browser-exit.mjs)
export const ALLOW_BROWSER_CLOSE = env.CDP_ALLOW_BROWSER_CLOSE === 'true';

// CDP_FILE_DIRS: the directories CDP clients may name local files in
// (file-access.mjs), colon-separated; * = any (null here).
export function parseFileDirs(raw) {
  const value = (raw ?? '').trim();
  if (value === '*') return null;
  const dirs = value.split(':').map((d) => d.trim()).filter(Boolean);
  if (!dirs.length) throw new Error('CDP_FILE_DIRS is empty (use * to allow any directory)');
  for (const d of dirs) {
    if (!path.isAbsolute(d)) throw new Error(`CDP_FILE_DIRS: ${d} is not an absolute path`);
  }
  return dirs.map((d) => path.resolve(d));
}
export const FILE_DIRS = parseFileDirs(env.CDP_FILE_DIRS ?? '/browser/downloads');

// The gateway's install dir: dashboard.html, panel.js and the Python helpers
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Ids the gateway uses for its own commands on a client's upstreams; client
// ids (small integers counted up by Playwright) never get there.
export const INTERNAL_ID_BASE = 1_000_000_000;
const MAX_PAYLOAD = 256 * 1024 * 1024; // screenshots and traces can be large
// options for every WebSocket the gateway opens or accepts
export const WS_OPTIONS = { perMessageDeflate: false, maxPayload: MAX_PAYLOAD };
// how long the gateway waits for a WebSocket of its own to open (cdp-client.mjs)
export const WS_OPEN_TIMEOUT_MS = 10_000;

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
