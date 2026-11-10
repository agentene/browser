// Chromium's DevTools HTTP endpoints (/json/*) on its loopback port.

// How long the gateway waits for one of them. Chromium answers in
// milliseconds; one that does not (a hung browser process) must not hold up
// a client's request, an upgrade or a console tick for fetch's default of
// minutes.
export const DEVTOOLS_TIMEOUT_MS = 5000;

// A request to a chromium's DevTools HTTP endpoint, with that timeout.
export function devtoolsFetch(port, pathname, method = 'GET') {
  return fetch(`http://127.0.0.1:${port}${pathname}`, { method, signal: AbortSignal.timeout(DEVTOOLS_TIMEOUT_MS) });
}

export async function fetchJson(port, pathname, method = 'GET') {
  const res = await devtoolsFetch(port, pathname, method);
  if (!res.ok) throw new Error(`${method} ${pathname} on :${port} -> HTTP ${res.status}`);
  return res.json();
}

// Whether a DevTools endpoint answers on the port.
export function devtoolsUp(port) {
  return fetchJson(port, '/json/version').then(() => true, () => false);
}

// The fields of chromium's /json/* answers that carry its own loopback
// host:port (page titles and URLs are left alone, even when they mention it).
const ADDRESS_FIELDS = ['webSocketDebuggerUrl', 'devtoolsFrontendUrl', 'devtoolsFrontendUrlCompat'];

// Swap the loopback host:port chromium embeds in its JSON for the public
// host:port the client dialed (nginx passes the original Host through): an
// object (/json/version, /json/new) or a list of them (/json/list).
export function rewriteHost(value, port, publicHost) {
  if (Array.isArray(value)) return value.map((item) => rewriteHost(item, port, publicHost));
  if (typeof value !== 'object' || value === null) return value;
  const out = { ...value };
  for (const field of ADDRESS_FIELDS) {
    if (typeof out[field] === 'string') out[field] = out[field].replaceAll(`127.0.0.1:${port}`, publicHost);
  }
  return out;
}

// Every target chromium lists (pages, iframes, workers, ...); [] when it
// does not answer.
export async function allTargets(port) {
  try {
    return await fetchJson(port, '/json/list');
  } catch {
    return [];
  }
}

export async function pageTargets(port) {
  return (await allTargets(port)).filter((t) => t.type === 'page');
}

export const NO_TABS = { tabs: [], current: null };

// A browser's tabs and the one in front of its window: chromium lists
// targets most recently activated first (switching tabs and /json/activate
// both count), so that is the first page. Throws when chromium does not answer.
export async function browserTabs(port) {
  const pages = (await fetchJson(port, '/json/list')).filter((t) => t.type === 'page');
  return { tabs: pages.map((t) => ({ id: t.id, title: t.title, url: t.url })), current: pages[0]?.id ?? null };
}
