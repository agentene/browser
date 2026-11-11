// A browser's targets over its pipe (pipe.mjs): what chromium's DevTools
// HTTP endpoints (/json/*) answered — the browsers have none — and the tabs
// the console shows.

// How long the console waits for a tab to say whether it is in front: a tab
// with a dialog open or paused in a debugger does not answer until it is
// back. Only the wait is cut short — the probe itself goes on (Probes).
const PROBE_TIMEOUT_MS = 1000;

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

// The tab in front by what the tabs say of themselves. Chromium's /json/list
// put the most recently activated tab first; Target.getTargets has no such
// order, so each tab says itself (Probes): 2 = visible and focused (the tab
// in front of the focused window), 1 = visible (in front of its window), 0 =
// hidden, null = no answer.
//   memo: what the last call saw, per browser ({ candidates, current }):
//         headless, every window's tab in front is "focused", so of several
//         the one that just became so is the current one.
export function pickCurrent(memo, levels) {
  const top = Math.max(0, ...levels.map(([, level]) => level ?? 0));
  const best = top ? levels.filter(([, level]) => level === top).map(([id]) => id) : [];
  const fresh = best.filter((id) => !memo.candidates?.has(id));
  memo.candidates = new Set(best);
  if (fresh.length) memo.current = fresh[0];
  else if (!best.includes(memo.current)) {
    const stillThere = levels.some(([id]) => id === memo.current);
    memo.current = best[0] ?? (stillThere ? memo.current : levels[0]?.[0] ?? null);
  }
  return memo.current ?? null;
}

// The gateway's probes of a pipe's tabs while a console watches: one
// session per tab, kept while the tab is there (a session given up on would
// stay attached, out of reach), and one query at a time however long the
// tab keeps quiet (asked again only once the query answered or its call
// timed out). Released as a whole when no console watches any more; a tick
// still under way then holds a released set, which attaches nothing new.
class Probes {
  #pipe;
  #byTarget = new Map(); // targetId -> { session: Promise of a sessionId, inflight: Promise of a level | null }
  #released = false;

  constructor(pipe) {
    this.#pipe = pipe;
    this.onDetached = (sessionId) => { // the tab closed
      for (const [targetId, probe] of this.#byTarget) {
        probe.session.then((s) => { if (s === sessionId) this.#drop(targetId, probe); }, () => {});
      }
    };
    pipe.on('detached', this.onDetached);
  }

  // 2 = visible and focused, 1 = visible, 0 = hidden, null = no answer in
  // time (PROBE_TIMEOUT_MS)
  level(targetId) {
    if (this.#released) return Promise.resolve(null);
    const probe = this.#probe(targetId);
    probe.inflight ??= probe.session
      .then((sessionId) => this.#pipe.call('Runtime.evaluate', {
        expression: "document.visibilityState === 'visible' ? (document.hasFocus() ? 2 : 1) : 0",
        returnByValue: true,
        silent: true,
      }, { sessionId }))
      .then(({ result }) => (typeof result?.value === 'number' ? result.value : null), () => null)
      .finally(() => { probe.inflight = null; });
    return within(probe.inflight, PROBE_TIMEOUT_MS, null);
  }

  // Detaches every probe session, those still being attached once they are.
  release() {
    this.#released = true;
    this.#pipe.off('detached', this.onDetached);
    for (const { session } of this.#byTarget.values()) {
      session.then((sessionId) => this.#pipe.call('Target.detachFromTarget', { sessionId })).catch(() => {});
    }
    this.#byTarget.clear();
  }

  #probe(targetId) {
    let probe = this.#byTarget.get(targetId);
    if (!probe) {
      const session = this.#pipe.call('Target.attachToTarget', { targetId, flatten: true }).then((r) => r.sessionId);
      probe = { session, inflight: null };
      this.#byTarget.set(targetId, probe);
      session.catch(() => this.#drop(targetId, probe)); // the tab is gone (or the browser)
    }
    return probe;
  }

  #drop(targetId, probe) {
    if (this.#byTarget.get(targetId) === probe) this.#byTarget.delete(targetId);
  }
}

const probes = new WeakMap(); // pipe -> its Probes while a console watches

function within(promise, ms, fallback) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(resolve, ms, fallback); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// Whether a window shows a tab: chromium titles a window
// "<title of its tab in front> - <product>".
function shows(windowTitle, tabTitle) {
  return windowTitle === tabTitle || windowTitle.startsWith(`${tabTitle} - `);
}

// The tabs the window titles show, the tab of the window in front ranking
// highest (a tab no window shows has no entry). Of the tabs one title fits,
// the longest title is the one ("A" and "A - B" both fit "A - B - Chrome").
//   windowTitles: the browser's window titles, the one in front first
//                 (desktop.mjs' desktopWindows)
export function titleRanks(pages, windowTitles) {
  const ranks = new Map();
  windowTitles.forEach((windowTitle, i) => {
    const fits = pages.filter((t) => t.title && shows(windowTitle, t.title));
    const longest = Math.max(0, ...fits.map((t) => t.title.length));
    for (const t of fits) {
      if (t.title.length === longest && !ranks.has(t.targetId)) ranks.set(t.targetId, windowTitles.length - i);
    }
  });
  return ranks;
}

// A browser's tabs and the one in front. The window titles say it first: a
// tab cannot blur them, while what it says of itself a CDP client can —
// Playwright's focus emulation leaves every tab it drives visible and
// focused. What the tabs say (pickCurrent) decides between tabs of one
// title, and alone when no title fits (a page still loading) or there are
// no windows (headless); it keeps its memo either way, so that a title
// fitting no tab for a moment does not move the current tab. Throws when
// the browser does not answer.
export async function browserTabs(pipe, memo, windowTitles = []) {
  let tabProbes = probes.get(pipe);
  if (!tabProbes) probes.set(pipe, tabProbes = new Probes(pipe));
  const pages = await pageInfos(pipe);
  const levels = await Promise.all(pages.map(async (t) => [t.targetId, await tabProbes.level(t.targetId)]));
  let current = pickCurrent(memo, levels);
  const ranks = titleRanks(pages, windowTitles);
  const top = Math.max(0, ...ranks.values());
  const shown = levels.filter(([id]) => ranks.get(id) === top);
  if (shown.length && !shown.some(([id]) => id === current)) {
    const best = Math.max(...shown.map(([, level]) => level ?? 0));
    current = memo.current = shown.find(([, level]) => (level ?? 0) === best)[0];
  }
  return { tabs: pages.map((t) => ({ id: t.targetId, title: t.title, url: t.url })), current };
}

// Detaches the probe sessions of a pipe (no console is watching any more).
export function releaseProbes(pipe) {
  probes.get(pipe)?.release();
  probes.delete(pipe);
}
