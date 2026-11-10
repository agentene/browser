// The browsers the gateway knows, by name: 'main' and the contexts'
// 'context-N' (the names the console and its API use).

import { MAIN_PORT } from './config.mjs';
import { contexts } from './contexts.mjs';
import { allTargets } from './devtools-http.mjs';
import { mainBrowser } from './main-browser.mjs';

export function browserNames() {
  return ['main', ...contexts.names()];
}

// A browser's DevTools port, 0 for an unknown one.
export function portOf(name) {
  if (name === 'main') return MAIN_PORT;
  return contexts.get(name)?.port ?? 0;
}

// A browser's process id, 0 when it has none (stopped, unknown).
export function browserPid(name) {
  return Number(name === 'main' ? mainBrowser.pid() : contexts.get(name)?.proc?.pid) || 0;
}

// Which chromium (port) owns a target id: the main browser or a context.
// Any target type (a worker's or an iframe's /devtools/page/<id> too); the
// contexts are asked in parallel.
export async function targetPort(targetId) {
  const owners = await Promise.all(contexts.values().map(async (context) => (
    (await allTargets(context.port)).some((t) => t.id === targetId) ? context.port : 0
  )));
  return owners.find(Boolean) || MAIN_PORT;
}
