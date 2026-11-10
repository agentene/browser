// Chromium's DevTools HTTP endpoints (/json/*) on its loopback port.

export async function fetchJson(port, pathname, method = 'GET') {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { method });
  if (!res.ok) throw new Error(`${method} ${pathname} on :${port} -> HTTP ${res.status}`);
  return res.json();
}

// Whether a DevTools endpoint answers on the port.
export function devtoolsUp(port) {
  return fetchJson(port, '/json/version').then(() => true, () => false);
}

// Swap the loopback host:port chromium embeds in its JSON for the public
// host:port the client dialed (nginx passes the original Host through).
export function rewriteHost(value, port, publicHost) {
  return JSON.parse(JSON.stringify(value).replaceAll(`127.0.0.1:${port}`, publicHost));
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
