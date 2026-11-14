// Shared by the console and the entrypoint's read-only startup adapter.
// Browser preferences are persisted settings, never environment defaults.
const bool = (value, scope, apply = 'restart') => ({ default: value, type: 'boolean', scope, apply, valid: (v) => typeof v === 'boolean' });
const number = (value, min, max, scope, apply = 'live') => ({ default: value, type: 'number', min, max, scope, apply, valid: (v) => Number.isSafeInteger(v) && v >= min && v <= max });
const choice = (value, options, scope, apply = 'live') => ({ default: value, type: 'select', options, scope, apply, valid: (v) => options.includes(v) });
export const SCHEMA = {
  browser: {
    autostart: bool(true, 'browser', 'next-start'),
    idleTimeout: number(0, 0, 525600, 'browser'),
    startUrl: { default: 'about:blank', type: 'url', scope: 'browser', apply: 'next-start', valid: (v) => {
      if (typeof v !== 'string' || v.length > 8192 || /[\x00-\x20\x7f]/.test(v)) return false;
      try { return !!new URL(v).protocol; } catch { return false; }
    } },
    language: { default: 'en-US', type: 'text', scope: 'browser', apply: 'restart', valid: (v) => {
      if (typeof v !== 'string' || !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(v)) return false;
      try { return Intl.getCanonicalLocales(v).length === 1; } catch { return false; }
    } },
    headless: bool(false, 'browser'),
    gpu: choice('auto', ['auto', 'off', 'strict'], 'browser', 'restart'),
  },
  contexts: {
    maxRunning: number(4, 1, 10000, 'browser'),
    overflow: choice('hibernate', ['hibernate', 'reject'], 'browser'),
    maxHibernated: number(16, 0, 10000, 'browser'),
  },
  desktop: {
    raiseNewWindows: bool(true, 'desktop', 'live'),
    width: number(1920, 1, 8192, 'desktop', 'restart'),
    height: number(1080, 1, 4096, 'desktop', 'restart'),
    resize: bool(true, 'desktop'),
    resizeLocked: bool(false, 'desktop'),
  },
  overlay: { mode: choice('text', ['off', 'keys', 'text'], 'overlay') },
  media: { audioOnStart: bool(false, 'desktop'), audioLocked: bool(false, 'desktop') },
};

export const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
export function resolve(schema, saved, warn = () => {}) {
  const result = {};
  for (const [section, fields] of Object.entries(schema)) {
    result[section] = {};
    for (const [key, field] of Object.entries(fields)) {
      const v = isObject(saved?.[section]) ? saved[section][key] : undefined;
      if (v !== undefined && !field.valid(v)) warn(`invalid ${section}.${key}; using the default`);
      result[section][key] = v !== undefined && field.valid(v) ? v : field.default;
    }
  }
  return result;
}
