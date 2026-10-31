// Cloning the main browser's profile for a context's chromium.

import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CONTEXTS_DIR, MAIN_PROFILE } from './config.mjs';

// Profile entries not worth cloning: per-run lock/port files, caches (pure
// performance state, rebuilt on demand) and the main browser's open tabs —
// Sessions/ and Sessions_Encrypted/ (chromium 15x), or the older
// Current/Last Session|Tabs files. Clones start with "continue where you
// left off" (see adjustPrefs), so any session left in would reopen the
// main browser's tabs inside the context — asynchronously, so depending on
// timing Playwright files them under the main browser's context (it only
// registers a new context after its setup round-trips) and no tab list
// shows them.
const SKIP_NAMES = new Set([
  'DevToolsActivePort', 'Cache', 'Code Cache', 'GPUCache', 'GrShaderCache',
  'ShaderCache', 'GraphiteDawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'Crashpad', 'component_crx_cache', 'extensions_crx_cache',
  'Current Session', 'Current Tabs', 'Last Session', 'Last Tabs',
]);
const SKIP_PREFIXES = ['Singleton', 'BrowserMetrics', 'Sessions'];

// Whether a profile entry (file or directory) goes into the clone.
export function cloned(source) {
  const base = path.basename(source);
  if (SKIP_NAMES.has(base)) return false;
  return !SKIP_PREFIXES.some((p) => base.startsWith(p));
}

export async function cloneProfile(src, dst) {
  // COPYFILE_FICLONE = reflink (copy-on-write) where the filesystem supports
  // it, a plain copy otherwise
  await fs.cp(src, dst, { recursive: true, mode: fsConstants.COPYFILE_FICLONE, filter: cloned });
}

// Whether cloneProfile gets reflinks: FICLONE needs source and destination
// on one mount of a reflink-capable filesystem (XFS, btrfs), which is what
// the /browser mount (profile + CONTEXTS_DIR side by side) is for. Probed
// once on the seeded Preferences file, for the log only.
export async function probeReflink() {
  const probe = path.join(CONTEXTS_DIR, '.reflink-probe');
  try {
    await fs.copyFile(path.join(MAIN_PROFILE, 'Default', 'Preferences'), probe,
      fsConstants.COPYFILE_FICLONE_FORCE);
    return 'reflink (copy-on-write)';
  } catch (err) {
    return `full copy (no reflink: ${err.code || err.message}; needs ${CONTEXTS_DIR} and ${MAIN_PROFILE} on one XFS/btrfs mount)`;
  } finally {
    await fs.rm(probe, { force: true });
  }
}

// Adjust the clone's Preferences: the main browser is running, so they say
// it did not exit cleanly (a clone would greet the user with a "restore
// pages?" bubble), and the context gets its frame color (the theme's
// user_color2 as a signed ARGB int; the older user_color key is ignored).
// A clean exit plus any startup setting but "continue where you left off"
// makes chromium drop the session cookies (no expiry — most logins, e.g.
// taobao's cookie2/unb) while loading the cookie store, overlay included; so
// startup is switched to 1. The clone has no Sessions dir, so there are no
// tabs to restore.
export function adjustPrefs(prefs, color) {
  prefs.profile = { ...prefs.profile, exit_type: 'Normal', exited_cleanly: true };
  prefs.session = { ...prefs.session, restore_on_startup: 1 };
  const browser = prefs.browser || {};
  browser.theme = { ...browser.theme, user_color2: (0xff000000 | parseInt(color.slice(1), 16)) | 0, color_variant2: 3 };
  prefs.browser = browser;
  return prefs;
}

export async function preparePrefs(profile, color) {
  const prefsPath = path.join(profile, 'Default', 'Preferences');
  let prefs = {};
  try {
    prefs = JSON.parse(await fs.readFile(prefsPath, 'utf8'));
  } catch { /* fresh profile without Preferences */ }
  await fs.mkdir(path.dirname(prefsPath), { recursive: true });
  await fs.writeFile(prefsPath, JSON.stringify(adjustPrefs(prefs, color)));
}
