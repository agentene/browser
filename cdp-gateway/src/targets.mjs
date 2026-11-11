// A browser's targets over its pipe (pipe.mjs): what chromium's DevTools
// HTTP endpoints (/json/*) answered — the browsers have none — and the tabs
// the console shows.

// How long a probe of a tab's visibility may take: a tab with a dialog open
// or paused in a debugger does not answer at all.
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

// The tab in front. Chromium's /json/list put the most recently activated
// tab first; Target.getTargets has no such order, so each tab says itself:
// 2 = visible and focused (the tab in front of the focused window), 1 =
// visible (in front of its window), 0 = hidden, null = no answer.
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

// The gateway's probe sessions, per pipe: targetId -> Promise of a sessionId.
const probes = new WeakMap();

function probeSessions(pipe) {
  let sessions = probes.get(pipe);
  if (!sessions) {
    probes.set(pipe, sessions = new Map());
    pipe.on('detached', (sessionId) => {
      for (const [targetId, session] of sessions) {
        session.then((s) => { if (s === sessionId) sessions.delete(targetId); }, () => {});
      }
    });
  }
  return sessions;
}

async function tabLevel(pipe, targetId) {
  const sessions = probeSessions(pipe);
  let session = sessions.get(targetId);
  if (!session) {
    session = pipe.call('Target.attachToTarget', { targetId, flatten: true }, { timeout: PROBE_TIMEOUT_MS })
      .then((r) => r.sessionId);
    sessions.set(targetId, session);
  }
  try {
    const sessionId = await session;
    const { result } = await pipe.call('Runtime.evaluate', {
      expression: "document.visibilityState === 'visible' ? (document.hasFocus() ? 2 : 1) : 0",
      returnByValue: true,
      silent: true,
    }, { sessionId, timeout: PROBE_TIMEOUT_MS });
    return typeof result?.value === 'number' ? result.value : null;
  } catch {
    sessions.delete(targetId); // attached anew next time
    return null;
  }
}

// A browser's tabs and the one in front (pickCurrent). Throws when the
// browser does not answer.
export async function browserTabs(pipe, memo) {
  const pages = await pageInfos(pipe);
  const levels = await Promise.all(pages.map(async (t) => [t.targetId, await tabLevel(pipe, t.targetId)]));
  return {
    tabs: pages.map((t) => ({ id: t.targetId, title: t.title, url: t.url })),
    current: pickCurrent(memo, levels),
  };
}

// Detaches the probe sessions of a pipe (no console is watching any more).
export function releaseProbes(pipe) {
  const sessions = probes.get(pipe);
  if (!sessions) return;
  for (const session of sessions.values()) {
    session.then((sessionId) => pipe.call('Target.detachFromTarget', { sessionId }), () => {}).catch(() => {});
  }
  sessions.clear();
}
