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
    autostart: bool(true, 'browser', 'next-start'),
    idleTimeout: number(0, 0, 525600, 'browser'),
    startUrl: { default: 'about:blank', type: 'url', scope: 'browser', apply: 'next-start', valid: (v) => {
      if (typeof v !== 'string' || v.length > 8192 || /[\x00-\x20\x7f]/.test(v)) return false;
      try { return !!new URL(v).protocol; } catch { return false; }
    } },
    language: { default: 'en-US', type: 'select', options: Object.keys(languageLabels), optionLabels: languageLabels,
      scope: 'browser', apply: 'next-start', valid: (v) => {
      // Preserve valid locales saved before the dropdown was introduced.
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
