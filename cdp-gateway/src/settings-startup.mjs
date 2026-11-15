// Prints only known, validated shell assignments, NUL separated; never eval'd.
import { SCHEMA, resolve } from './settings-schema.mjs';
import { readSettings } from './settings-file.mjs';
import { resolveLanguage } from './language.mjs';
const warn = (message) => process.stderr.write(`settings: ${message}\n`);
const s = resolve(SCHEMA, readSettings(process.argv[2] || '/browser/settings/settings.json', warn), warn);
const assignments = {
  // Startup has no caller; the gateway resolves Auto again for each launch.
  CHROMIUM_LANG: resolveLanguage(s.browser.language),
  CDP_CONTEXTS_MAX: s.contexts.maxRunning,
  CDP_CONTEXTS_OVERFLOW: s.contexts.overflow,
  CDP_CONTEXTS_HIBERNATED_MAX: s.contexts.maxHibernated,
  CDP_INPUT_OVERLAY: s.overlay.mode,
  SCREEN_GEOMETRY: `${s.desktop.resolution}x24`,
  DESKTOP_RAISE_NEW_WINDOWS: s.desktop.raiseNewWindows,
};
for (const [key, value] of Object.entries(assignments)) process.stdout.write(`${key}=${value}\0`);
