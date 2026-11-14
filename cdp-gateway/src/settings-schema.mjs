// Shared by the console and the entrypoint's read-only startup adapter.
// Browser preferences are persisted settings, never environment defaults.
const bool = (value, scope, apply = 'restart') => ({ default: value, type: 'boolean', scope, apply, valid: (v) => typeof v === 'boolean' });
const number = (value, min, max, scope, apply = 'live') => ({ default: value, type: 'number', min, max, scope, apply, valid: (v) => Number.isSafeInteger(v) && v >= min && v <= max });
const choice = (value, options, scope, apply = 'live') => ({ default: value, type: 'select', options, scope, apply, valid: (v) => options.includes(v) });
// Values stay BCP-47 tags; the console displays localized language names.
const languageLabels = {
  'en-US': ['English (United States)', '英语 (美国)'],
  'en-GB': ['English (United Kingdom)', '英语 (英国)'],
  'zh-CN': ['Chinese (Simplified)', '中文 (简体)'],
  'zh-TW': ['Chinese (Traditional)', '中文 (繁体)'],
  'ja-JP': ['Japanese', '日语'],
  'ko-KR': ['Korean', '韩语'],
  'fr-FR': ['French', '法语'],
  'de-DE': ['German', '德语'],
  'es-ES': ['Spanish (Spain)', '西班牙语 (西班牙)'],
  'es-419': ['Spanish (Latin America)', '西班牙语 (拉丁美洲)'],
  'pt-BR': ['Portuguese (Brazil)', '葡萄牙语 (巴西)'],
  'pt-PT': ['Portuguese (Portugal)', '葡萄牙语 (葡萄牙)'],
  'it-IT': ['Italian', '意大利语'],
  'ru-RU': ['Russian', '俄语'],
  'ar-SA': ['Arabic', '阿拉伯语'],
  'hi-IN': ['Hindi', '印地语'],
  'id-ID': ['Indonesian', '印度尼西亚语'],
  'th-TH': ['Thai', '泰语'],
  'vi-VN': ['Vietnamese', '越南语'],
  'tr-TR': ['Turkish', '土耳其语'],
  'nl-NL': ['Dutch', '荷兰语'],
  'pl-PL': ['Polish', '波兰语'],
};
export const SCHEMA = {
  browser: {
    language: { default: 'en-US', type: 'select', options: Object.keys(languageLabels), optionLabels: languageLabels,
      scope: 'browser', apply: 'next-start', valid: (v) => {
      // Preserve valid locales saved before the dropdown was introduced.
      if (typeof v !== 'string' || !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(v)) return false;
      try { return Intl.getCanonicalLocales(v).length === 1; } catch { return false; }
    } },
  },
  contexts: {
    maxRunning: number(4, 1, 10000, 'browser'),
    overflow: choice('hibernate', ['hibernate', 'reject'], 'browser'),
    maxHibernated: number(16, 0, 10000, 'browser'),
  },
  desktop: {
    raiseNewWindows: bool(true, 'desktop', 'live'),
    resolution: { ...choice('1920x1080', ['1280x720', '1920x1080', '2560x1440', '3840x2160'], 'desktop', 'restart'),
      // Keep valid custom sizes from older settings files as a saved choice.
      valid: (v) => typeof v === 'string' && /^[1-9]\d{0,3}x[1-9]\d{0,3}$/.test(v)
        && v.split('x').every((n, i) => Number(n) <= [8192, 4096][i]),
    },
  },
  overlay: { mode: choice('text', ['off', 'keys', 'text'], 'overlay') },
};

export const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

// One-way compatibility for persisted files, never an environment fallback.
// Removed preferences no longer affect startup and disappear on the next save.
export function migrateSettings(saved) {
  if (isObject(saved.desktop)) {
    const { width, height } = saved.desktop;
    const size = `${width}x${height}`;
    if (saved.desktop.resolution === undefined && Number.isInteger(width) && Number.isInteger(height)
        && SCHEMA.desktop.resolution.valid(size)) saved.desktop.resolution = size;
  }
  for (const [section, keys] of Object.entries({
    browser: ['autostart', 'startUrl', 'headless', 'gpu', 'idleTimeout'],
    desktop: ['width', 'height', 'resize', 'resizeLocked'],
    media: ['audioOnStart', 'audioLocked'],
  })) {
    if (isObject(saved[section])) {
      for (const key of keys) delete saved[section][key];
      if (!Object.keys(saved[section]).length) delete saved[section];
    }
  }
  return saved;
}
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
