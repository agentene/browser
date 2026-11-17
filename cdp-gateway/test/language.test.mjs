import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { firstLanguage, requestLanguage } from '../src/language.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-language-'));
process.env.CDP_GATEWAY_SETTINGS_FILE = path.join(dir, 'settings.json');
const { handleCdpHttp, handleConsoleHttp } = await import('../src/http.mjs');
const { handleCdpUpgrade, handleConsoleUpgrade } = await import('../src/upgrade.mjs');
const { mainBrowser } = await import('../src/main-browser.mjs');
const { SCHEMA, resolve } = await import('../src/settings-schema.mjs');
const gateway = http.createServer(handleConsoleHttp);
gateway.on('upgrade', handleConsoleUpgrade);
const cdp = http.createServer(handleCdpHttp);
cdp.on('upgrade', handleCdpUpgrade);
let base, cdpBase;

before(async () => {
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  base = `http://127.0.0.1:${gateway.address().port}`;
  cdp.listen(0, '127.0.0.1');
  await once(cdp, 'listening');
  cdpBase = `ws://127.0.0.1:${cdp.address().port}`;
});
after(async () => {
  await Promise.all([gateway, cdp].map((server) => new Promise((done) => server.close(done))));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Auto uses only the first header entry and defaults safely', () => {
  assert.equal(firstLanguage(' zh-cn ;q=0.2, en-US;q=1'), 'zh-CN');
  assert.equal(firstLanguage('ja-JP,zh-CN;q=0.9'), 'ja-JP');
  assert.equal(firstLanguage('en-GB,en;q=0.9'), 'en-GB');
  for (const header of [undefined, '', '*', '*,zh-CN', 'invalid_tag,zh-CN', ';q=0.9,zh-CN']) {
    assert.equal(firstLanguage(header), 'en-US');
  }
  assert.equal(resolve(SCHEMA, {}).browser.language, 'auto');
  assert.equal(SCHEMA.browser.language.options[0], 'auto');
  assert.equal(resolve(SCHEMA, { browser: { language: 'fr-CA' } }).browser.language, 'fr-CA');
  assert.equal(resolve(SCHEMA, { browser: { language: '--lang=zh' } }).browser.language, 'auto');
});

test('shared translations use BCP-47 keys and English for unsupported interface languages', () => {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(new URL('../i18n.js', import.meta.url), 'utf8'), sandbox);
  const { locale, t } = sandbox.window.AgenteneI18n;
  assert.equal(locale('zh-cn'), 'zh-CN');
  assert.equal(t('zh-CN', 'auto'), '自动');
  assert.equal(t('en-US', 'auto'), 'Auto');
  assert.equal(t('zh-CN', 'tabs', 2), '2 个标签页');
  for (const language of ['fr-FR', 'ja-JP', 'zh-TW', 'en-GB', undefined]) {
    assert.equal(locale(language), 'en-US');
    assert.equal(t(language, 'settings'), 'Settings');
  }
});

test('HTTP language detection is per caller and console snapshots only broadcast the saved preference', async (t) => {
  const headers = ['zh-CN,en-US;q=0.9', 'ja-JP,zh-CN;q=0.9'];
  const views = await Promise.all(headers.map(async (header) => {
    const response = await fetch(`${base}/console/api/settings`, { headers: { 'Accept-Language': header } });
    assert.equal(response.status, 200);
    return response.json();
  }));
  assert.deepEqual(views.map((v) => v.autoLanguage), ['zh-CN', 'ja-JP']);
  assert.equal(views[0].revision, views[1].revision);
  assert.ok(views.every((v) => v.values.browser.language === 'auto'));
  const snapshots = await Promise.all(headers.map(async (header) => {
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}/console/ws`, { headers: { 'Accept-Language': header } });
    t.after(async () => { const closed = once(ws, 'close'); ws.close(); await closed; });
    const [message] = await once(ws, 'message');
    return JSON.parse(message).ops[0];
  }));
  assert.ok(snapshots.every((s) => s.autoLanguage === undefined));
  assert.ok(snapshots.every((s) => s.settings.values.browser.language === 'auto'));
  assert.equal(fs.existsSync(process.env.CDP_GATEWAY_SETTINGS_FILE), false, 'detecting a language does not persist a preference');
});

test('later CDP messages retain each handshake language when starting a browser', async (t) => {
  const ensure = mainBrowser.ensure;
  mainBrowser.ensure = async () => {
    await new Promise((done) => setImmediate(done));
    throw new Error(`language probe: ${requestLanguage()}`);
  };
  t.after(() => { mainBrowser.ensure = ensure; });
  await Promise.all(['zh-CN', 'fr-FR'].map(async (language) => {
    const ws = new WebSocket(`${cdpBase}/devtools/browser/test`, { headers: { 'Accept-Language': `${language},en-US;q=0.9` } });
    t.after(async () => { const closed = once(ws, 'close'); ws.close(); await closed; });
    await once(ws, 'open');
    const response = once(ws, 'message');
    ws.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'about:blank' } }));
    const [message] = await response;
    assert.ok(JSON.parse(message).error.message.endsWith(`language probe: ${language}`));
  }));
  assert.equal(requestLanguage(), 'en-US');
});
