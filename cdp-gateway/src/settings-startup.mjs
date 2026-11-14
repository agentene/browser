// Prints only known, validated shell assignments, NUL separated; never eval'd.
import { SCHEMA, resolve } from './settings-schema.mjs';
import { readSettings } from './settings-file.mjs';
const warn = (message) => process.stderr.write(`settings: ${message}\n`);
const s = resolve(SCHEMA, readSettings(process.argv[2] || '/browser/settings/settings.json', warn), warn);
const assignments = {
  CHROMIUM_AUTOSTART: s.browser.autostart,
  CHROMIUM_IDLE_TIMEOUT: s.browser.idleTimeout,
  CHROMIUM_START_URL: s.browser.startUrl,
  CHROMIUM_LANG: s.browser.language,
  CHROMIUM_HEADLESS: Number(s.browser.headless),
  CHROMIUM_GPU: s.browser.gpu,
  CDP_CONTEXTS_MAX: s.contexts.maxRunning,
  CDP_CONTEXTS_OVERFLOW: s.contexts.overflow,
  CDP_CONTEXTS_HIBERNATED_MAX: s.contexts.maxHibernated,
  CDP_INPUT_OVERLAY: s.overlay.mode,
  SCREEN_GEOMETRY: `${s.desktop.width}x${s.desktop.height}x24`,
  SELKIES_ENABLE_RESIZE: s.desktop.resize,
  SELKIES_RESIZE_LOCKED: s.desktop.resizeLocked,
  SELKIES_AUDIO_ON_START: `${s.media.audioOnStart}${s.media.audioLocked ? '|locked' : ''}`,
  DESKTOP_RAISE_NEW_WINDOWS: s.desktop.raiseNewWindows,
};
for (const [key, value] of Object.entries(assignments)) process.stdout.write(`${key}=${value}\0`);
