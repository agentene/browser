// The browsers the gateway knows, by name: 'main' and the contexts'
// 'context-N' (the names the console and its API use).

import { contexts } from './contexts.mjs';
import { mainBrowser } from './main-browser.mjs';

export function browserNames() {
  return ['main', ...contexts.names()];
}

// A browser's DevTools pipe (pipe.mjs), null for one not running or unknown.
export function pipeOf(name) {
  if (name === 'main') return mainBrowser.running ? mainBrowser.pipe : null;
  return contexts.get(name)?.pipe ?? null;
}

// A browser's process id, 0 when it has none (stopped, unknown).
export function browserPid(name) {
  return Number(name === 'main' ? mainBrowser.pid() : contexts.get(name)?.proc?.pid) || 0;
}

// The pipe of the browser that owns a target id, or null: any target type (a
// worker's or an iframe's /devtools/page/<id> too); all browsers are asked at
// once.
export async function targetOwner(targetId) {
  const pipes = browserNames().map(pipeOf).filter(Boolean);
  const owners = await Promise.all(pipes.map((pipe) => pipe.call('Target.getTargetInfo', { targetId })
    .then(() => pipe, () => null)));
  return owners.find(Boolean) ?? null;
}
