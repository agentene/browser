// Declarative state only. Never replay a click, navigation, fetch, or an
// arbitrary evaluation. Helper hashes are from the unmodified Playwright
// packages shipped with @playwright/cli 0.1.23 and 0.1.24.
import { createHash } from 'node:crypto';

const UTILITY = new Set(['89b21e9280b568c5a0dedba3aded1e3e367074977033ed743c0589e0d5abdf51']);
const INJECTED = new Set([
  'd02b377d9d848076f6eb6fd8bcc70bced62dffdfd35ee0144ababe6cdde39f76',
  '22a022c769a072860a4e63d9affaa86b3f6e42074f8d753df8859ebcbbd24c64',
]);
const hash = (s) => createHash('sha256').update(s).digest('hex');

export function helperScript(expression, className) {
  if (typeof expression !== 'string') return false;
  if (className === 'UtilityScript') return UTILITY.has(hash(expression));
  if (className !== 'InjectedScript') return false;
  const re = /(return new \(module\.exports\.InjectedScript\(\)\)\(globalThis, )(\{[^\n]*\})(\);)/;
  const match = expression.match(re);
  if (!match) return false;
  try {
    const options = JSON.parse(match[2]);
    if (!Array.isArray(options.customEngines) || options.customEngines.length) return false;
    return INJECTED.has(hash(expression.replace(re, '$1CONFIG$3')));
  } catch { return false; }
}

const DOMAINS = new Set(['Page', 'Runtime', 'Log', 'Network', 'DOM', 'Security', 'Performance', 'Inspector']);
const SETTERS = new Set([
  'Target.setAutoAttach', 'Target.setDiscoverTargets', 'Page.setLifecycleEventsEnabled',
  'Page.setBypassCSP', 'Page.setInterceptFileChooserDialog', 'Page.setFontFamilies', 'Page.setFontSizes',
  'Network.setCacheDisabled', 'Network.setBypassServiceWorker', 'Network.setExtraHTTPHeaders',
  'Network.setUserAgentOverride', 'Network.emulateNetworkConditions',
  'Network.emulateNetworkConditionsByRule', 'Network.overrideNetworkState',
  'Security.setIgnoreCertificateErrors', 'Browser.setDownloadBehavior', 'Browser.setWindowBounds',
  'Emulation.setDeviceMetricsOverride', 'Emulation.clearDeviceMetricsOverride',
  'Emulation.setFocusEmulationEnabled', 'Emulation.setTouchEmulationEnabled',
  'Emulation.setScriptExecutionDisabled', 'Emulation.setEmulatedMedia',
  'Emulation.setUserAgentOverride', 'Emulation.setLocaleOverride', 'Emulation.setTimezoneOverride',
  'Emulation.setGeolocationOverride', 'Emulation.clearGeolocationOverride',
  'Emulation.setDefaultBackgroundColorOverride', 'Emulation.setEmulatedVisionDeficiency',
  'Emulation.setHardwareConcurrencyOverride', 'Emulation.setFontFamilies', 'Emulation.setFontSizes',
  'Emulation.setEmulatedOSTextScale', 'Emulation.setAutoDarkModeOverride',
  'Emulation.setAutomationOverride', 'Emulation.setScrollbarsHidden',
  'Fetch.enable', 'Fetch.disable',
]);

export class ContextJournal {
  constructor() {
    this.states = new Map();
    this.helpers = new Map();
    this.blockers = new Map();
  }

  record(msg, result) {
    const { method, params: p = {} } = msg;
    let key;
    const [domain, action] = method.split('.');
    if (DOMAINS.has(domain) && ['enable', 'disable'].includes(action)) key = `${domain}.enabled`;
    else if (SETTERS.has(method)) key = method.replace('.clear', '.set').replace('Fetch.disable', 'Fetch.enable');
    else if (method === 'Page.createIsolatedWorld') key = `world:${p.frameId}:${p.worldName}`;
    else if (method === 'Page.addScriptToEvaluateOnNewDocument') key = `script:${result.identifier}`;
    else if (method === 'Page.removeScriptToEvaluateOnNewDocument') this.states.delete(`script:${p.identifier}`);
    else if (method === 'Runtime.addBinding') key = `binding:${p.name}:${p.executionContextName ?? ''}`;
    else if (method === 'Runtime.removeBinding') {
      for (const k of this.states.keys()) if (k.startsWith(`binding:${p.name}:`)) this.states.delete(k);
    } else if (method === 'Browser.resetPermissions') {
      for (const k of this.states.keys()) if (k.startsWith('permission:')) this.states.delete(k);
    } else if (method === 'Browser.grantPermissions' || method === 'Browser.setPermission') {
      key = `permission:${method}:${p.origin ?? ''}:${JSON.stringify(p.permission ?? '')}`;
    } else if (method === 'Runtime.evaluate' && result.result?.objectId
      && ['UtilityScript', 'InjectedScript'].includes(result.result.className)) {
      if (helperScript(p.expression, result.result.className)) {
        this.helpers.set(result.result.objectId, { msg, contextId: p.contextId });
      } else this.blockers.set('helper', 'unrecognized Playwright helper; update gateway compatibility before hibernating');
    } else if (method === 'Runtime.releaseObject') this.helpers.delete(p.objectId);
    // These are ongoing sessions, not declarative configuration to replay.
    if (/^(Tracing\.start|Profiler\.start|Debugger\.enable|Page\.startScreencast|Target\.sendMessageToTarget)/.test(method)) {
      this.blockers.set(domain, `${domain} session cannot be hibernated`);
    }
    if (/^(Tracing\.end|Profiler\.(stop|disable)|Debugger\.disable|Page\.stopScreencast)$/.test(method)) this.blockers.delete(domain);
    if ((method === 'Target.attachToTarget' || (method === 'Target.setAutoAttach' && p.autoAttach)) && p.flatten !== true) {
      this.blockers.set('legacy', 'non-flat CDP sessions cannot be hibernated');
    }
    if (method === 'Browser.setWindowBounds') key += `:${p.windowId}`;
    // Future protocol setters must not silently disappear on restart.
    // These explicit exceptions mutate document/storage data, not session
    // configuration; repeating them would repeat a user action.
    const transient = new Set(['Network.setCookies', 'Network.deleteCookies', 'Network.clearBrowserCookies',
      'Network.clearBrowserCache', 'Page.setDocumentContent', 'Page.addCompilationCache']);
    if (!key && /^(Browser|Page|Runtime|Network|Emulation|Security|Fetch)$/.test(domain)
      && /^(set|clear|add|remove)/.test(action) && !transient.has(method)
      && !['Page.removeScriptToEvaluateOnNewDocument', 'Runtime.removeBinding', 'Browser.resetPermissions'].includes(method)) {
      this.blockers.set(method, `${method} state cannot be replayed`);
    }
    if (key) { this.states.delete(key); this.states.set(key, { method, params: structuredClone(p), result }); }
    if ((key || method === 'Runtime.evaluate') && this.bytes > 8 * 1024 * 1024) this.blockers.set('size', 'context replay state exceeds 8 MiB');
  }

  get bytes() {
    return JSON.stringify([...this.states]).length + JSON.stringify([...this.helpers]).length;
  }

  get controlled() {
    return [...this.states.values()].some(({ method, params }) =>
      (method === 'Page.addScriptToEvaluateOnNewDocument' && params.source)
      || ['Fetch.enable', 'Network.setExtraHTTPHeaders', 'Network.setUserAgentOverride', 'Emulation.setUserAgentOverride'].includes(method));
  }

  clearWorld(id) {
    for (const [objectId, h] of this.helpers) if (id === undefined || h.contextId === id) this.helpers.delete(objectId);
  }
}
