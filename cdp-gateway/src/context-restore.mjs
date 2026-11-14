// Tab snapshots are independent of physical CDP target ids. A temporary
// sessionStorage marker distinguishes even otherwise identical tabs; only
// a verified match can inherit an existing logical Page.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { browserTabs, pageInfos } from './targets.mjs';
import { sleep } from './util.mjs';

async function evaluate(pipe, targetId, expression) {
  const { sessionId } = await pipe.call('Target.attachToTarget', { targetId, flatten: true });
  try {
    const r = await pipe.call('Runtime.evaluate', { expression, returnByValue: true }, { sessionId, timeout: 2000 });
    if (r.exceptionDetails) return null;
    return r.result?.value;
  } finally { await pipe.call('Target.detachFromTarget', { sessionId }).catch(() => {}); }
}

export async function captureTabs(context) {
  const { pipe, session } = context;
  const listing = await browserTabs(pipe, {});
  const key = `__agentene_restore_${randomUUID()}`;
  const tabs = [];
  for (const tab of listing.tabs) {
    const id = context.logicalTarget(tab.id);
    const window = await pipe.call('Browser.getWindowForTarget', { targetId: tab.id }).catch(() => null);
    const marked = await evaluate(pipe, tab.id, `(() => { try { sessionStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(id)}); return true; } catch { return false; } })()`).catch(() => false);
    tabs.push({ ...tab, id, window: window?.windowId ?? null, marked: marked === true });
  }
  const order = session ? [...session.targets.keys()] : [];
  tabs.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const selected = tabs.some((t) => t.id === context.selected) ? context.selected : null;
  return { key, tabs, current: selected ?? (listing.current && context.logicalTarget(listing.current)) };
}

export function nativeRestore(context) {
  return context.snapshot?.tabs.length > 0 && context.snapshot.tabs.every((t) => t.marked)
    && !context.session?.controlledRestore;
}

// --no-startup-window alone is insufficient: the first createTarget can
// trigger deferred session restore. Quarantine session files for the URL
// path, while leaving restore_on_startup=1 (which retains session cookies).
export async function parkSessionFiles(context) {
  const directory = path.join(context.profile, 'Default');
  const backup = path.join(context.dir, 'saved-session');
  await fs.rm(backup, { recursive: true, force: true });
  await fs.mkdir(backup, { recursive: true });
  for (const name of await fs.readdir(directory)) {
    if (!name.startsWith('Sessions') && !/^(Current|Last) (Session|Tabs)$/.test(name)) continue;
    await fs.rename(path.join(directory, name), path.join(backup, name));
  }
  context.sessionBackup = backup;
}

export async function finishSessionFiles(context, success) {
  if (!context.sessionBackup) return;
  const backup = context.sessionBackup;
  if (!success) {
    for (const name of await fs.readdir(backup)) {
      const dest = path.join(context.profile, 'Default', name);
      await fs.rm(dest, { recursive: true, force: true });
      await fs.rename(path.join(backup, name), dest);
    }
  }
  await fs.rm(backup, { recursive: true, force: true });
  context.sessionBackup = null;
}

export async function restoreTabs(context, native) {
  const { pipe, snapshot } = context;
  const found = new Map();
  if (native) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      for (const info of await pageInfos(pipe)) {
        if ([...found.values()].includes(info.targetId)) continue;
        const id = await evaluate(pipe, info.targetId, `(() => { try { return sessionStorage.getItem(${JSON.stringify(snapshot.key)}); } catch { return null; } })()`).catch(() => null);
        if (snapshot.tabs.some((t) => t.id === id) && !found.has(id)) found.set(id, info.targetId);
      }
      if (found.size === snapshot.tabs.length) break;
      await sleep(100);
    }
  }
  if (native && found.size !== snapshot.tabs.length) throw new Error('native tab identity could not be verified');
  let pages;
  if (native && found.size === snapshot.tabs.length) {
    pages = snapshot.tabs.map((t) => ({ ...t, physical: found.get(t.id), navigate: false }));
  } else {
    // Keep existing windows until replacement targets exist: closing the
    // last window can exit headed chromium. No replacement goes to a client
    // before its logical slot has been assigned.
    const old = await pageInfos(pipe);
    pages = [];
    const groups = Map.groupBy(snapshot.tabs, (t) => t.window);
    for (const tabs of groups.values()) {
      for (const [index, tab] of tabs.entries()) {
        const { targetId } = await pipe.call('Target.createTarget', { url: 'about:blank', newWindow: index === 0 });
        await pipe.call('Target.activateTarget', { targetId });
        pages.push({ ...tab, physical: targetId, navigate: true });
      }
    }
    for (const t of old) await pipe.call('Target.closeTarget', { targetId: t.targetId });
    if (native) context.restoreWarning = 'native tab identity could not be verified; restored URLs instead';
  }
  // Remove only our marker, never clear the application's sessionStorage.
  for (const p of pages.filter((p) => !p.navigate)) {
    await evaluate(pipe, p.physical, `sessionStorage.removeItem(${JSON.stringify(snapshot.key)})`);
  }
  return pages;
}
