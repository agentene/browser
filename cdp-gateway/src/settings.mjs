// Persisted configuration, optimistic concurrency, and explicit apply results.
// Startup uses the same schema; no migrated preference reads an environment value.
import { randomUUID, createHash } from 'node:crypto';
import { notifyChange } from './changes.mjs';
import {
  BROWSER_ENABLED, DESKTOP_ENABLED, STREAM_ENABLED, OVERLAY_AVAILABLE,
  SETTINGS_FILE, STARTUP_SAVED, STARTUP_SETTINGS, applyRuntimeSettings,
} from './config.mjs';
import { applyRaiseNewWindows } from './desktop.mjs';
import { writeSettings } from './settings-file.mjs';
import { SCHEMA, isObject, resolve } from './settings-schema.mjs';
import { HttpError } from './respond.mjs';
import { log } from './util.mjs';
export { SCHEMA, resolve };

const capabilities = {
  browser: BROWSER_ENABLED, desktop: DESKTOP_ENABLED, stream: STREAM_ENABLED, overlay: OVERLAY_AVAILABLE,
  gpuDevice: process.env.CDP_GATEWAY_GPU_DEVICE || '',
};
const available = (field) => field.available ? field.available() : !!capabilities[field.scope];
export function parsePatch(schema, patch) {
  if (!isObject(patch)) throw new HttpError(400, 'expected a JSON object of settings by section');
  const changes = [];
  for (const [section, keys] of Object.entries(patch)) {
    if (!Object.hasOwn(schema, section)) throw new HttpError(400, `unknown settings section "${section}"`);
    if (!isObject(keys)) throw new HttpError(400, `settings section "${section}" must be an object`);
    for (const [key, value] of Object.entries(keys)) {
      const field = Object.hasOwn(schema[section], key) ? schema[section][key] : null;
      if (!field) throw new HttpError(400, `unknown setting "${section}.${key}"`);
      if (!field.valid(value)) throw new HttpError(400, `invalid value for "${section}.${key}"`);
      if (!available(field)) throw new HttpError(409, `"${section}.${key}" is not available here`);
      changes.push([section, key, value]);
    }
  }
  return changes;
}

let saved = STARTUP_SAVED;
let values = structuredClone(STARTUP_SETTINGS);
const effective = structuredClone(STARTUP_SETTINGS);
const errors = {};
const boot = randomUUID();
let generation = 0;
const revision = () => `${boot}:${generation}`;
let queue = Promise.resolve();
let closing = false;

export function settingsView() {
  const fields = {};
  const pendingRestart = [];
  for (const [section, keys] of Object.entries(SCHEMA)) {
    fields[section] = {};
    for (const [key, field] of Object.entries(keys)) {
      const { valid: _valid, ...metadata } = field;
      fields[section][key] = { ...metadata, available: available(field) };
      if (field.apply === 'restart' && values[section][key] !== effective[section][key] && available(field)) pendingRestart.push(`${section}.${key}`);
    }
  }
  return { values: structuredClone(values), effective: structuredClone(effective), revision: revision(), pendingRestart, errors: { ...errors }, capabilities, fields };
}

export function closeSettings() {
  closing = true;
  return queue;
}

export function updateSettings(body) {
  if (closing) return Promise.reject(new HttpError(503, 'container is restarting'));
  const run = queue.then(async () => {
    const { contexts } = await import('./contexts.mjs');
    // Share the capacity lock with create/hibernate/wake; confirmation cannot
    // silently start deleting a different set while another request runs.
    return contexts.serialize(() => update(body, contexts));
  });
  queue = run.catch(() => {});
  return run;
}

async function update(body, contexts) {
  if (!isObject(body) || body.revision !== revision()) {
    const err = new HttpError(409, 'settings changed; review the current values before saving');
    err.details = { code: 'settings_conflict', settings: settingsView() };
    throw err;
  }
  const changes = parsePatch(SCHEMA, body.patch).filter(([s, k, v]) => values[s][k] !== v || errors[`${s}.${k}`]);
  if (!changes.length) return settingsView();
  const next = structuredClone(values);
  const nextSaved = structuredClone(saved);
  for (const [s, k, v] of changes) {
    next[s][k] = v;
    if (!isObject(nextSaved[s])) nextSaved[s] = {};
    nextSaved[s][k] = v;
  }
  const lowering = next.contexts.maxHibernated < effective.contexts.maxHibernated || !!errors['contexts.maxHibernated'];
  const sleepers = contexts.values().filter((c) => c.state === 'hibernated' && !c.destroyed)
    .sort((a, b) => a.hibernatedAt.localeCompare(b.hibernatedAt));
  const victims = lowering ? sleepers.slice(0, Math.max(0, sleepers.length - next.contexts.maxHibernated)) : [];
  if (victims.length) {
    const confirmation = createHash('sha256').update(JSON.stringify([revision(), next, victims.map((c) => [c.name, c.createdAt])])).digest('hex');
    if (body.confirmation !== confirmation) {
      const err = new HttpError(409, 'confirm removal of the oldest hibernated browsers');
      err.details = { code: 'confirm_evictions', confirmation, evictions: victims.map((c) => ({ name: c.name, tabs: c.snapshot?.tabs?.length ?? 0 })) };
      throw err;
    }
  }
  // A failed write changes neither the policy nor the desktop, and evicts nothing.
  try { writeSettings(SETTINGS_FILE, nextSaved); }
  catch (err) { throw new HttpError(500, `settings were not saved: ${err.message}`); }
  saved = nextSaved;
  values = next;
  generation++;
  const overlayChanged = changes.some(([s]) => s === 'overlay');
  for (const [s, k, v] of changes) {
    const name = `${s}.${k}`;
    delete errors[name];
    if (SCHEMA[s][k].apply === 'restart') continue;
    try {
      if (name === 'desktop.raiseNewWindows') await applyRaiseNewWindows(v);
      effective[s][k] = v;
    } catch (err) { errors[name] = err.message; }
  }
  applyRuntimeSettings(effective);
  if (overlayChanged) {
    const { resetOverlayMode } = await import('./input-overlay.mjs');
    resetOverlayMode();
  }
  if (victims.length) {
    try { await contexts.trim(); }
    catch (err) { errors['contexts.maxHibernated'] = err.message; }
  }
  log(`settings saved: ${changes.map(([s, k]) => `${s}.${k}`).join(', ')}`);
  notifyChange();
  return settingsView();
}
