// A browser's targets over its pipe (pipe.mjs): what chromium's DevTools
// HTTP endpoints (/json/*) answered — the browsers have none — and the tabs
// the console shows.

import { CdpClient } from './cdp-client.mjs';
import { CLOSED } from './pipe.mjs';
import { sleep } from './util.mjs';

// Every target the way chromium's /json/list had it: pages, iframes,
// workers, browser UI — not the tab and browser targets (Target.getTargets'
// default filter).
export async function targetInfos(pipe) {
  return (await pipe.call('Target.getTargets')).targetInfos;
}

export async function pageInfos(pipe) {
  return (await targetInfos(pipe)).filter((t) => t.type === 'page');
}

// A /json/list entry, its URLs on the public host:port the client dialed;
// the frontend URL is chromium's own for a remote browser (its revision).
export function listEntry(info, host, revision) {
  const ws = `${host}/devtools/page/${info.targetId}`;
  const entry = {
    description: '',
    devtoolsFrontendUrl: `https://chrome-devtools-frontend.appspot.com/serve_rev/${revision}/inspector.html?ws=${ws}`,
    id: info.targetId,
  };
  if (info.parentFrameId) entry.parentId = info.parentFrameId;
  return Object.assign(entry, { title: info.title, type: info.type, url: info.url, webSocketDebuggerUrl: `ws://${ws}` });
}

// The /json/version answer from Browser.getVersion; browserId names the
// browser WebSocket (/devtools/browser/<id>), one per launch, as chromium's.
export function versionEntry(version, host, browserId) {
  return {
    Browser: version.product,
    'File-Path-Style': 'posix',
    'Protocol-Version': version.protocolVersion,
    'User-Agent': version.userAgent,
    'V8-Version': version.jsVersion,
    'WebKit-Version': `537.36 (${version.revision})`,
    webSocketDebuggerUrl: `ws://${host}/devtools/browser/${browserId}`,
  };
}

export const NO_TABS = { tabs: [], current: null };

// Chrome exposes the selected flag on tab targets. A tab owns a primary
// page and may own a prerender too. Auto-attachment reports the actual
// child IDs before its reply and follows replacements while the tab is open.
async function observeTab(pipe, tabId) {
  const cdp = await CdpClient.connect(pipe, { targetId: tabId });
  try {
    await cdp.send('Target.setAutoAttach', {
      autoAttach: true, flatten: true, waitForDebuggerOnStart: false, filter: [{ type: 'page' }],
    });
    return { tabId, cdp };
  } catch (err) {
    cdp.close();
    throw err;
  }
}

// Every window has a selected tab. Chrome's windows API gives us the ID
// of the last focused window even when automation emulates focus in every
// renderer. Its bookmark-manager WebUI exposes that API. The static strings
// resource is an inert document, so the manager's UI never runs. A dedicated
// CDP session owns the hidden target and disposes it on detach.
const WINDOW_READER_ORIGIN = 'chrome://bookmarks';

async function openWindowReader(pipe, browserContextId) {
  const owner = await CdpClient.connect(pipe);
  try {
    const { targetId } = await owner.send('Target.createTarget', {
      url: `${WINDOW_READER_ORIGIN}/strings.m.js`, browserContextId, hidden: true, background: true,
    });
    const { sessionId } = await owner.send('Target.attachToTarget', { targetId, flatten: true });
    const ready = Promise.withResolvers();
    let world;
    owner.on('Runtime.executionContextCreated', ({ context }, session) => {
      if (session !== sessionId || !context.auxData?.isDefault || context.origin !== WINDOW_READER_ORIGIN) return;
      world = context.uniqueId;
      ready.resolve();
    });
    await owner.send('Runtime.enable', {}, { sessionId });
    // Discovery can precede navigation commit. A busy browser can finish
    // later and supply its window on the next console tick.
    if (!world) await Promise.race([ready.promise, sleep(1000)]);
    return {
      async read() {
        if (!owner.ws.targets.has(sessionId)) throw new Error('window observer detached');
        if (!world) return null;
        const { result } = await owner.send('Runtime.evaluate', {
          uniqueContextId: world,
          expression: `(async () => {
            const { id, focused } = await chrome.windows.getLastFocused();
            if (focused) return { id, focused };
            const [tab] = await chrome.tabs.query({ windowId: id, active: true });
            return { id, focused, lastAccessed: tab?.lastAccessed };
          })()`,
          awaitPromise: true, returnByValue: true,
        }, { sessionId, timeout: 1000 });
        return Number.isInteger(result?.value?.id) ? result.value : null;
      },
      close: () => owner.close(),
    };
  } catch (err) {
    owner.close();
    throw err;
  }
}

// One reader per physical browser, used by serial console ticks or once at
// hibernation. Only the selected tab needs an attached session. Multiple
// windows also need a window lookup in each profile (including incognito).
export class TabListing {
  constructor(pipe) {
    this.pipe = pipe;
    this.tab = null;
    this.readers = new Map();
    this.lastWindow = null;
  }

  async read() {
    const { targetInfos } = await this.pipe.call('Target.getTargets', { filter: [{ type: 'tab' }, { type: 'page' }] });
    const pages = targetInfos.filter((t) => t.type === 'page' && !t.subtype);
    const tabs = pages.map((t) => ({ id: t.targetId, title: t.title, url: t.url }));
    const active = targetInfos.filter((t) => t.type === 'tab' && t.embedderData?.tabActive);
    const profiles = new Set(active.length > 1 ? active.map((t) => t.browserContextId) : []);
    this.closeReadersExcept(profiles);
    const selected = active.length > 1 ? await this.frontTab(active, profiles) : active[0];
    if (this.tab?.tabId !== selected?.targetId || this.tab?.cdp.ws.readyState === CLOSED) {
      this.tab?.cdp.close();
      this.tab = selected ? await observeTab(this.pipe, selected.targetId).catch(() => null) : null;
    }
    // PipeConnection tracks attachments and detachments on this session.
    const children = new Set(this.tab?.cdp.ws.targets.values());
    const primary = pages.filter((p) => children.has(p.targetId));
    const current = primary.length === 1 ? primary[0].targetId : null;
    return { tabs, current };
  }

  async frontTab(active, profiles) {
    const [windows, reports] = await Promise.all([
      Promise.all(active.map(async (tab) => {
        const window = await this.pipe.call('Browser.getWindowForTarget', { targetId: tab.targetId }).catch(() => null);
        return [window?.windowId, tab];
      })),
      Promise.all([...profiles].map((id) => this.readWindow(id))),
    ]);
    const tabsByWindow = new Map(windows);
    const known = reports.filter((w) => w && tabsByWindow.has(w.id));
    // With no focused window (e.g. a background browser), compare Chrome's
    // last activation times across regular and incognito profiles. A tie
    // keeps the previously observed window instead of using discovery order.
    const latest = Math.max(...known.map((w) => w.lastAccessed ?? 0));
    const recent = new Set(known.filter((w) => (w.lastAccessed ?? 0) === latest).map((w) => w.id));
    const [newest] = recent;
    const last = known.length === profiles.size && recent.size === 1 ? newest : this.lastWindow;
    const windowId = known.find((w) => w.focused)?.id ?? last;
    if (windowId == null || !tabsByWindow.has(windowId)) return null;
    this.lastWindow = windowId;
    return tabsByWindow.get(windowId);
  }

  async readWindow(contextId) {
    let reader = this.readers.get(contextId);
    try {
      if (!reader) {
        reader = await openWindowReader(this.pipe, contextId);
        this.readers.set(contextId, reader);
      }
      return await reader.read();
    } catch {
      reader?.close();
      this.readers.delete(contextId);
      return null;
    }
  }

  closeReadersExcept(keep) {
    for (const [contextId, reader] of this.readers) {
      if (keep?.has(contextId)) continue;
      reader.close();
      this.readers.delete(contextId);
    }
  }

  close() {
    this.tab?.cdp.close();
    this.tab = null;
    this.closeReadersExcept();
  }
}
