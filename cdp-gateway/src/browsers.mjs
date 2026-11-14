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
  const context = contexts.get(name);
  return context?.state === 'running' ? context.pipe : null;
}

// A browser's process id, 0 when it has none (stopped, unknown).
export function browserPid(name) {
  return Number(name === 'main' ? mainBrowser.pid() : contexts.get(name)?.proc?.pid) || 0;
}

// The pipe of the browser that owns a target id, or null: any target type (a
// worker's or an iframe's /devtools/page/<id> too); all browsers are asked at
// once.
export async function targetOwner(targetId) {
  return (await targetAddress(targetId))?.pipe ?? null;
}

export async function targetAddress(targetId, wake = false) {
  for (const context of contexts.values()) {
    const known = context.session?.targets.has(targetId) || context.snapshot?.tabs.some((t) => t.id === targetId);
    if (known && wake) await context.wake();
    if (context.state !== 'running') continue;
    let id;
    try { id = context.physicalTarget(targetId); } catch { continue; }
    const pipe = context.pipe;
    if (await pipe?.call('Target.getTargetInfo', { targetId: id }).then(() => true, () => false)) {
      return { pipe, id, context };
    }
  }
  if (mainBrowser.running) {
    const pipe = mainBrowser.pipe;
    if (await pipe.call('Target.getTargetInfo', { targetId }).then(() => true, () => false)) return { pipe, id: targetId, context: null };
  }
  return null;
}
