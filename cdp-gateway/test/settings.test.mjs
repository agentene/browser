// Unit tests for the console settings' schema handling (node --test).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePatch, resolve } from '../src/settings.mjs';

const schema = {
  desktop: {
    raiseNewWindows: { default: true, valid: (v) => typeof v === 'boolean', available: () => true },
    offHere: { default: 1, valid: Number.isInteger, available: () => false },
  },
};

test('resolve: saved values where valid, defaults otherwise', () => {
  assert.deepEqual(resolve(schema, {}), { desktop: { raiseNewWindows: true, offHere: 1 } });
  assert.deepEqual(resolve(schema, { desktop: { raiseNewWindows: false } }).desktop.raiseNewWindows, false);
  assert.equal(resolve(schema, { desktop: { raiseNewWindows: 'no' } }).desktop.raiseNewWindows, true);
  assert.equal(resolve(schema, { desktop: 'junk' }).desktop.raiseNewWindows, true);
  assert.equal(resolve(schema, { other: { x: 1 } }).other, undefined);
});

test('parsePatch: valid changes, HTTP errors for the rest', () => {
  assert.deepEqual(parsePatch(schema, { desktop: { raiseNewWindows: false } }), [['desktop', 'raiseNewWindows', false]]);
  assert.deepEqual(parsePatch(schema, {}), []);
  const status = (patch) => {
    try {
      parsePatch(schema, patch);
    } catch (err) {
      return err.status;
    }
    return 200;
  };
  assert.equal(status(null), 400);
  assert.equal(status([]), 400);
  assert.equal(status({ nope: {} }), 400);
  assert.equal(status({ desktop: true }), 400);
  assert.equal(status({ desktop: { nope: 1 } }), 400);
  assert.equal(status({ desktop: { raiseNewWindows: 'false' } }), 400);
  assert.equal(status({ desktop: { offHere: 2 } }), 409);
  assert.equal(status(JSON.parse('{"__proto__": {"raiseNewWindows": false}}')), 400); // own key, unknown section
});

// Exercise actual persistence and application in an isolated gateway process.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function settingsProcess(code, initial = {}, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-settings-'));
  const file = path.join(dir, 'settings.json');
  const helper = path.join(dir, 'desktop.sh');
  fs.writeFileSync(file, JSON.stringify(initial));
  fs.writeFileSync(helper, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  try {
    return execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { settingsView, updateSettings, closeSettings } from ${JSON.stringify(new URL('../src/settings.mjs', import.meta.url).href)};
      import { contexts } from ${JSON.stringify(new URL('../src/contexts.mjs', import.meta.url).href)};
      import * as config from ${JSON.stringify(new URL('../src/config.mjs', import.meta.url).href)};
      const file = process.env.CDP_GATEWAY_SETTINGS_FILE;
      const helper = process.env.CDP_GATEWAY_RAISE_SWITCH;
      const patch = (value, extra = {}) => updateSettings({ revision: settingsView().revision, patch: value, ...extra });
      ${code}
    `], { env: { ...process.env, CDP_GATEWAY_SETTINGS_FILE: file, CDP_GATEWAY_RAISE_SWITCH: helper,
      CDP_GATEWAY_DESKTOP_ENABLED: 'true', CDP_GATEWAY_STREAM_ENABLED: 'true', CDP_GATEWAY_BROWSER_ENABLED: 'true', ...env }, encoding: 'utf8', timeout: 15000 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('saved preferences alone control startup, and all legacy environment values are ignored', () => {
  settingsProcess(`
    const s = settingsView();
    assert.equal(s.values.browser.language, 'zh-CN');
    assert.equal(s.values.browser.autostart, undefined);
    assert.equal(s.values.desktop.resolution, '1280x720');
    assert.equal(config.MAX_CONTEXTS, 3);
    assert.equal(config.INPUT_OVERLAY, 'keys');
    assert.equal(s.values.browser.idleTimeout, undefined);
    assert.equal(s.values.media, undefined);
    const { execFileSync } = await import('node:child_process');
    const output = execFileSync(process.execPath, [${JSON.stringify(new URL('../src/settings-startup.mjs', import.meta.url).pathname)}, file], { encoding: 'utf8' });
    const assignments = Object.fromEntries(output.split('\\0').filter(Boolean).map((s) => [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)]));
    for (const key of ['CHROMIUM_AUTOSTART', 'CHROMIUM_START_URL', 'CHROMIUM_GPU', 'CHROMIUM_HEADLESS', 'SELKIES_ENABLE_RESIZE']) assert.equal(assignments[key], undefined);
    assert.equal(assignments.SCREEN_GEOMETRY, '1280x720x24');
    assert.equal(assignments.SELKIES_AUDIO_ON_START, undefined);
    assert.equal(assignments.CHROMIUM_IDLE_TIMEOUT, undefined);
    assert.equal(assignments.SELKIES_RESIZE_LOCKED, undefined);
    const retired = { browser: { idleTimeout: 1, autostart: true, startUrl: 'about:blank', headless: true, gpu: 'off' }, desktop: { width: 1280, height: 720, resize: false, resizeLocked: true }, media: { audioOnStart: true, audioLocked: true } };
    for (const [section, fields] of Object.entries(retired)) for (const [key, value] of Object.entries(fields)) {
      assert.equal(s.values[section]?.[key], undefined);
      assert.equal(s.fields[section]?.[key], undefined);
      await assert.rejects(patch({ [section]: { [key]: value } }), { status: 400 });
    }
    await patch({ contexts: { maxRunning: 4 } });
    const stored = JSON.parse(fs.readFileSync(file));
    for (const [section, fields] of Object.entries(retired)) for (const key of Object.keys(fields)) assert.equal(stored[section]?.[key], undefined);
    assert.equal(stored.desktop.resolution, '1280x720');
  `, { browser: { language: 'zh-CN', autostart: true, startUrl: 'https://removed.example/', idleTimeout: 1, headless: true, gpu: 'off' }, contexts: { maxRunning: 3 }, overlay: { mode: 'keys' }, desktop: { width: 1280, height: 720, resize: false, resizeLocked: true }, media: { audioOnStart: true, audioLocked: true } }, Object.fromEntries([
    'CHROMIUM_AUTOSTART', 'CHROMIUM_IDLE_TIMEOUT', 'CHROMIUM_START_URL', 'CHROMIUM_LANG', 'CHROMIUM_HEADLESS', 'CHROMIUM_GPU',
    'CDP_CONTEXTS_MAX', 'CDP_CONTEXTS_OVERFLOW', 'CDP_CONTEXTS_HIBERNATED_MAX', 'CDP_INPUT_OVERLAY', 'SCREEN_GEOMETRY', 'SELKIES_ENABLE_RESIZE', 'SELKIES_AUDIO_ON_START',
  ].map((key) => [key, 'invalid-ignored-value'])));
});

test('atomic persistence, live application, restart state, conflicts and retry after an apply failure', () => {
  settingsProcess(`
    const original = settingsView();
    const invalid = { browser: { language: 'zh-CN' }, desktop: { resolution: '9000x1080' } };
    await assert.rejects(patch(invalid), { status: 400 });
    assert.equal(settingsView().revision, original.revision);
    const changed = await patch({ contexts: { maxRunning: 7, overflow: 'reject' }, browser: { language: 'zh-CN' }, desktop: { resolution: '2560x1440', raiseNewWindows: false } });
    assert.equal(config.MAX_CONTEXTS, 7);
    assert.equal(changed.effective.browser.language, 'zh-CN');
    assert.equal(config.BROWSER_LANGUAGE, 'zh-CN');
    assert.equal(changed.fields.browser.language.type, 'select');
    assert.equal(changed.fields.browser.language.apply, 'next-start');
    assert.equal(changed.fields.browser.language.optionLabels['zh-CN'][1], '中文 (简体)');
    assert.deepEqual(changed.pendingRestart, ['desktop.resolution']);
    assert.equal(JSON.parse(fs.readFileSync(file)).future.keep, true);
    assert.equal(JSON.parse(fs.readFileSync(file)).desktop.raiseNewWindows, false);
    await assert.rejects(updateSettings({ revision: original.revision, patch: { contexts: { maxRunning: 1 } } }), (e) => e.details.code === 'settings_conflict');
    const pending = await patch({ browser: { language: 'en-US' }, desktop: { resolution: '1920x1080' } });
    assert.deepEqual(pending.pendingRestart, []);
    fs.writeFileSync(helper, '#!/bin/sh\\nexit 1\\n');
    const failedApply = await patch({ desktop: { raiseNewWindows: true } });
    assert.equal(failedApply.values.desktop.raiseNewWindows, true);
    assert.equal(failedApply.effective.desktop.raiseNewWindows, false);
    assert.ok(failedApply.errors['desktop.raiseNewWindows']);
    fs.writeFileSync(helper, '#!/bin/sh\\nexit 0\\n');
    assert.deepEqual((await patch({ desktop: { raiseNewWindows: true } })).errors, {});
    const before = settingsView();
    fs.unlinkSync(file); fs.mkdirSync(file);
    await assert.rejects(patch({ contexts: { maxRunning: 2 } }), { status: 500 });
    assert.equal(settingsView().revision, before.revision);
    assert.equal(config.MAX_CONTEXTS, 7);
    await closeSettings();
    await assert.rejects(patch({ contexts: { maxRunning: 2 } }), { status: 503 });
  `, { future: { keep: true } });
});

test('lowering the sleeper cap confirms an exact list, and stale confirmation never deletes a new victim', () => {
  settingsProcess(`
    const deleted = [];
    const sleepers = ['a', 'b', 'c'].map((name, i) => ({ name, createdAt: String(i), hibernatedAt: String(i), state: 'hibernated', destroyed: false, snapshot: { tabs: [] },
      async destroy() { this.destroyed = true; deleted.push(name); }, mux: { close() {} } }));
    contexts.values = () => sleepers;
    let preview;
    try { await patch({ contexts: { maxHibernated: 1 }, browser: { language: 'zh-CN' } }); } catch (e) { preview = e.details; }
    assert.equal(preview.code, 'confirm_evictions');
    assert.deepEqual(preview.evictions.map((c) => c.name), ['a', 'b']);
    assert.equal(settingsView().values.browser.language, 'en-US');
    assert.deepEqual(deleted, []);
    sleepers[0].state = 'running';
    let updated;
    try { await patch({ contexts: { maxHibernated: 1 }, browser: { language: 'zh-CN' } }, { confirmation: preview.confirmation }); } catch (e) { updated = e.details; }
    assert.deepEqual(updated.evictions.map((c) => c.name), ['b']);
    assert.deepEqual(deleted, []);
    await patch({ contexts: { maxHibernated: 1 }, browser: { language: 'zh-CN' } }, { confirmation: updated.confirmation });
    assert.deepEqual(deleted, ['b']);
    assert.equal(config.HIBERNATED_MAX, 1);
    assert.equal(config.BROWSER_LANGUAGE, 'zh-CN');
  `);
});

test('desktop-only settings permit desktop edits and refuse browser changes', () => {
  settingsProcess(`
    assert.equal(settingsView().capabilities.browser, false);
    await assert.rejects(patch({ browser: { language: 'zh-CN' } }), { status: 409 });
    assert.deepEqual((await patch({ desktop: { resolution: '1280x720' } })).pendingRestart, ['desktop.resolution']);
  `, {}, { CDP_GATEWAY_BROWSER_ENABLED: 'false' });
});

test('resolution migration retains saved custom sizes and CDP-only desktops stay configurable', () => {
  settingsProcess(`
    const view = settingsView();
    assert.equal(view.values.desktop.resolution, '1600x900');
    assert.equal(view.fields.desktop.resolution.type, 'select');
    assert.equal(view.fields.desktop.resolution.available, true);
    assert.equal(view.fields.media, undefined);
    assert.equal(view.fields.overlay.mode.available, false);
    await assert.rejects(patch({ media: { audioOnStart: true } }), { status: 400 });
    await assert.rejects(patch({ desktop: { resolution: '1920x0' } }), { status: 400 });
    assert.deepEqual((await patch({ desktop: { resolution: '1920x1080' } })).pendingRestart, ['desktop.resolution']);
  `, { desktop: { width: 1600, height: 900 } }, { CDP_GATEWAY_STREAM_ENABLED: 'false' });
});
