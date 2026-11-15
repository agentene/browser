// Language belongs to each browser launch, including reused/cloned profiles.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { withRequestLanguage } from '../src/language.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-language-'));
process.env.CDP_GATEWAY_SETTINGS_FILE = path.join(dir, 'settings.json');
const { prepareBrowserLaunch } = await import('../src/launch.mjs');
const { applyRuntimeSettings, STARTUP_SETTINGS } = await import('../src/config.mjs');
const { SCHEMA, resolve } = await import('../src/settings-schema.mjs');
const setLanguage = (language) => {
  const settings = structuredClone(STARTUP_SETTINGS);
  settings.browser.language = language;
  applyRuntimeSettings(settings);
};
const prefsFile = (profile) => path.join(profile, 'Default', 'Preferences');
const readPrefs = (profile) => JSON.parse(fs.readFileSync(prefsFile(profile), 'utf8'));

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('Auto resolves independently for concurrent callers and explicit languages override their headers', async () => {
  setLanguage('auto');
  await Promise.all(['zh-CN', 'fr-FR'].map((language) => withRequestLanguage(`${language},en-US;q=0.9`, async () => {
    const profile = path.join(dir, `auto-${language}`);
    await new Promise((done) => setImmediate(done));
    const env = await prepareBrowserLaunch(profile);
    assert.equal(env.LANG, `${language.replace('-', '_')}.UTF-8`);
    assert.ok(readPrefs(profile).intl.accept_languages.startsWith(language));
  })));
  assert.equal((await prepareBrowserLaunch(path.join(dir, 'auto-no-header'))).LANG, 'en_US.UTF-8');
  setLanguage('ja-JP');
  await withRequestLanguage('zh-CN', async () => {
    assert.equal((await prepareBrowserLaunch(path.join(dir, 'explicit'))).LANG, 'ja_JP.UTF-8');
  });
});

test('new launches use the current language without rewriting another running profile or the gateway environment', async () => {
  const main = path.join(dir, 'main');
  const clone = path.join(dir, 'clone');
  const originalEnvironment = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL };
  const initial = { intl: { accept_languages: 'de-DE,de', selected_languages: 'de-DE,de', unrelated: true }, profile: { exit_type: 'Normal' }, session: { restore_on_startup: 1 } };
  fs.mkdirSync(path.dirname(prefsFile(main)), { recursive: true });
  fs.writeFileSync(prefsFile(main), JSON.stringify(initial));
  fs.writeFileSync(path.join(main, 'Default', 'Cookies'), 'unchanged-cookie-store');
  setLanguage('en-US');
  const mainEnv = await prepareBrowserLaunch(main);
  assert.equal(mainEnv.LANG, 'en_US.UTF-8');
  assert.equal(mainEnv.LC_ALL, 'en_US.UTF-8');
  assert.equal(readPrefs(main).intl.accept_languages, 'en-US,en');
  fs.cpSync(main, clone, { recursive: true });

  setLanguage('zh-CN');
  const cloneEnv = await prepareBrowserLaunch(clone);
  assert.equal(cloneEnv.LANG, 'zh_CN.UTF-8');
  assert.equal(cloneEnv.LC_ALL, 'zh_CN.UTF-8');
  assert.equal(readPrefs(clone).intl.accept_languages, 'zh-CN,zh');
  assert.equal(readPrefs(clone).intl.selected_languages, 'zh-CN,zh');
  assert.equal(readPrefs(main).intl.accept_languages, 'en-US,en');
  assert.equal(mainEnv.LANG, 'en_US.UTF-8', 'an already prepared process retains its language');

  // Waking a profile must refresh its locale too; session state is retained.
  setLanguage('ja-JP');
  assert.equal((await prepareBrowserLaunch(clone)).LANG, 'ja_JP.UTF-8');
  const resumed = readPrefs(clone);
  assert.equal(resumed.intl.accept_languages, 'ja-JP,ja');
  assert.equal(resumed.intl.unrelated, true);
  assert.deepEqual(resumed.profile, initial.profile);
  assert.deepEqual(resumed.session, initial.session);
  assert.equal(fs.readFileSync(path.join(clone, 'Default', 'Cookies'), 'utf8'), 'unchanged-cookie-store');
  assert.ok(!fs.readdirSync(path.dirname(prefsFile(clone))).some((name) => name.startsWith('.org.chromium.')));
  assert.deepEqual({ LANG: process.env.LANG, LC_ALL: process.env.LC_ALL }, originalEnvironment);
});

test('existing valid locales outside common choices survive, and failed preparation does not start a browser', async () => {
  assert.equal(SCHEMA.browser.language.type, 'select');
  assert.equal(SCHEMA.browser.language.apply, 'next-start');
  assert.equal(resolve(SCHEMA, { browser: { language: 'fr-CA' } }).browser.language, 'fr-CA');
  const profile = path.join(dir, 'legacy');
  setLanguage('fr-CA');
  assert.equal((await prepareBrowserLaunch(profile)).LANG, 'fr_CA.UTF-8');
  assert.equal(readPrefs(profile).intl.accept_languages, 'fr-CA,fr');
  setLanguage('fr');
  await prepareBrowserLaunch(profile);
  assert.equal(readPrefs(profile).intl.accept_languages, 'fr');
  fs.unlinkSync(prefsFile(profile));
  fs.mkdirSync(prefsFile(profile));
  await assert.rejects(prepareBrowserLaunch(profile), { code: 'EISDIR' });
});
