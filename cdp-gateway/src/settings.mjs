// The console's server-side settings (its settings menu; the language is
// per viewer and stays in the browser). Saved as a JSON object by section in
// SETTINGS_FILE on the /browser mount, so they outlive the container:
//   { "desktop": { "raiseNewWindows": true } }
// No environment knobs: the console is their one place. The entrypoint
// applies the ones the desktop needs before the gateway runs
// (entrypoint/lib/settings.sh); here a change is applied first, then saved.
// A new setting is one SCHEMA entry, plus its row in the console pages.

import fs from 'node:fs';
import path from 'node:path';
import { notifyChange } from './changes.mjs';
import { RAISE_SWITCH, SETTINGS_FILE } from './config.mjs';
import { applyRaiseNewWindows } from './desktop.mjs';
import { HttpError } from './respond.mjs';
import { log } from './util.mjs';

// section -> key -> {
//   default    the value until one is saved
//   valid(v)   whether v is a value it takes
//   available  whether it is offered at all here (e.g. needs a desktop)
//   apply(v)   make it take effect (may throw: nothing is saved then)
// }
export const SCHEMA = {
  desktop: {
    raiseNewWindows: {
      default: true,
      valid: (v) => typeof v === 'boolean',
      available: () => !!RAISE_SWITCH,
      apply: applyRaiseNewWindows,
    },
  },
};

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

// Every setting's value: the saved one where it is valid, else its default.
export function resolve(schema, saved) {
  const values = {};
  for (const [section, keys] of Object.entries(schema)) {
    values[section] = {};
    for (const [key, s] of Object.entries(keys)) {
      const v = isObject(saved[section]) ? saved[section][key] : undefined;
      values[section][key] = v !== undefined && s.valid(v) ? v : s.default;
    }
  }
  return values;
}

// A PATCH body ({section: {key: value}}, any subset) as [section, key, value]
// changes; throws an HttpError for anything the schema does not take.
export function parsePatch(schema, patch) {
  if (!isObject(patch)) throw new HttpError(400, 'expected a JSON object of settings by section');
  const changes = [];
  for (const [section, keys] of Object.entries(patch)) {
    if (!Object.hasOwn(schema, section)) throw new HttpError(400, `unknown settings section "${section}"`);
    if (!isObject(keys)) throw new HttpError(400, `settings section "${section}" must be an object`);
    for (const [key, value] of Object.entries(keys)) {
      const s = Object.hasOwn(schema[section], key) ? schema[section][key] : null;
      if (!s) throw new HttpError(400, `unknown setting "${section}.${key}"`);
      if (!s.valid(value)) throw new HttpError(400, `invalid value for "${section}.${key}": ${JSON.stringify(value)}`);
      if (!s.available()) throw new HttpError(409, `"${section}.${key}" is not available here`);
      changes.push([section, key, value]);
    }
  }
  return changes;
}

// The file as read; entries this version does not know are kept on save.
let saved = readSaved();
const values = resolve(SCHEMA, saved);

function readSaved() {
  try {
    const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (isObject(data)) return data;
    log(`settings: ${SETTINGS_FILE} is not a JSON object; using the defaults`);
  } catch (err) {
    if (err.code !== 'ENOENT') log(`settings: ${SETTINGS_FILE}: ${err.message}; using the defaults`);
  }
  return {};
}

// Write a temp file and rename it over, so a crash never leaves half a file.
function save() {
  const tmp = path.join(path.dirname(SETTINGS_FILE), `.${path.basename(SETTINGS_FILE)}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(saved, null, 2)}\n`);
  fs.renameSync(tmp, SETTINGS_FILE);
}

// What the console shows: the values of the settings on offer here.
export function settingsView() {
  const view = {};
  for (const [section, keys] of Object.entries(SCHEMA)) {
    for (const [key, s] of Object.entries(keys)) {
      if (s.available()) (view[section] ??= {})[key] = values[section][key];
    }
  }
  return view;
}

// Apply and save a PATCH body; one at a time. Resolves with settingsView().
let queue = Promise.resolve();
export function updateSettings(patch) {
  const run = queue.then(() => update(patch));
  queue = run.catch(() => {});
  return run;
}

async function update(patch) {
  const changes = parsePatch(SCHEMA, patch).filter(([section, key, value]) => values[section][key] !== value);
  if (!changes.length) return settingsView();
  // the changes applied before one fails stay applied, so they are saved
  // (and shown) all the same; the failure is reported after that
  let applied = 0;
  let failure = null;
  for (const [section, key, value] of changes) {
    try {
      await SCHEMA[section][key].apply(value);
    } catch (err) {
      failure = err;
      break;
    }
    values[section][key] = value;
    saved = { ...saved, [section]: { ...(isObject(saved[section]) ? saved[section] : {}), [key]: value } };
    log(`settings: ${section}.${key} = ${JSON.stringify(value)}`);
    applied++;
  }
  if (applied) {
    notifyChange();
    try {
      save();
    } catch (err) {
      throw new HttpError(500, `applied, but not saved to ${SETTINGS_FILE}: ${err.message}`);
    }
  }
  if (failure) throw failure;
  return settingsView();
}
