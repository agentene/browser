// Unit tests for the gateway's side-effect-free pieces (node --test).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { browserExitAction, hasEscape, mayEndBrowser } from '../src/browser-exit.mjs';
import { appId, intEnv } from '../src/config.mjs';
import { broadcast, MAX_BUFFERED } from '../src/console-live.mjs';
import { listedAppIds } from '../src/desktop.mjs';
import { cdpOriginDenied, normalizeOrigin, parseAllowedOrigins } from '../src/cdp-origin.mjs';
import { consoleDenied, consoleOriginDenied, hashPassword, verifyPassword } from '../src/console-auth.mjs';
import { rewriteHost } from '../src/devtools-http.mjs';
import { requestPath, viaWeb } from '../src/respond.mjs';
import { connectionsTo } from '../src/idle.mjs';
import { adjustPrefs, cloned } from '../src/profile.mjs';
import { cookieKey, cookieParam, originTabs } from '../src/storage-sync.mjs';

test('intEnv: default, integer, rejects junk', () => {
  assert.equal(intEnv('X', 7, {}), 7);
  assert.equal(intEnv('X', 7, { X: '' }), 7);
  assert.equal(intEnv('X', 7, { X: '0' }), 0);
  assert.equal(intEnv('X', 7, { X: '42' }), 42);
  assert.throws(() => intEnv('X', 7, { X: '-1' }), /non-negative integer/);
  assert.throws(() => intEnv('X', 7, { X: '1.5' }), /non-negative integer/);
  assert.throws(() => intEnv('X', 7, { X: 'abc' }), /non-negative integer/);
});

test('appId matches the entrypoint convention', () => {
  assert.equal(appId('main'), 'cdp-main');
  assert.equal(appId('context-3'), 'cdp-context-3');
});

test('rewriteHost swaps the loopback host:port in the address fields only', () => {
  const v = {
    webSocketDebuggerUrl: 'ws://127.0.0.1:9221/devtools/browser/x',
    other: 'ws://127.0.0.1:9221/z',
  };
  assert.deepEqual(rewriteHost(v, 9221, 'example.com:9222'), {
    webSocketDebuggerUrl: 'ws://example.com:9222/devtools/browser/x',
    other: 'ws://127.0.0.1:9221/z',
  });
  const list = [{
    devtoolsFrontendUrl: '/devtools/inspector.html?ws=127.0.0.1:9221/devtools/page/y',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/z',
    title: 'http://127.0.0.1:9221/',
    url: 'http://127.0.0.1:9221/json',
  }];
  assert.deepEqual(rewriteHost(list, 9221, 'example.com:9222'), [{
    devtoolsFrontendUrl: '/devtools/inspector.html?ws=example.com:9222/devtools/page/y',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/z',
    title: 'http://127.0.0.1:9221/',
    url: 'http://127.0.0.1:9221/json',
  }]);
});

const basic = (user, pw) => `Basic ${Buffer.from(`${user}:${pw}`).toString('base64')}`;
const req = (headers, method = 'GET') => ({ method, headers });

const PW = await hashPassword('pw');

test('hashPassword / verifyPassword: salted scrypt, the auth service\'s format', async () => {
  assert.match(PW, /^scrypt\$16384\$8\$1\$[\w-]{22}\$[\w-]{43}$/);
  assert.notEqual(await hashPassword('pw'), PW, 'salted');
  assert.equal(await verifyPassword('pw', PW), true);
  assert.equal(await verifyPassword('wrong', PW), false);
  for (const junk of ['', 'zz', 'scrypt$1$2$3$x$y', '30c952fab122c3f9759f02a6d95c3758b246b4fee239957b2d4fee46e26170c4']) {
    assert.equal(await verifyPassword('pw', junk), false, junk);
  }
  // made by the entrypoint's helper
  const helper = path.resolve(import.meta.dirname, '../../entrypoint/helpers/password-hash.mjs');
  const made = execFileSync(process.execPath, [helper], { input: 'p:w $x' }).toString().trim();
  assert.equal(await verifyPassword('p:w $x', made), true);
});

test('consoleDenied: reads on the CDP port (no web marker) need nothing', async () => {
  assert.equal(await consoleDenied(req({}), PW), null);
  assert.equal(await consoleDenied(req({}, 'HEAD'), PW), null);
});

test('consoleDenied: the web port needs the master password', async () => {
  const via = { 'x-cdp-console-via': 'web' };
  assert.equal(await consoleDenied(req({ ...via, authorization: basic('ubuntu', 'pw') }), PW), null);
  assert.equal(await consoleDenied(req({ ...via, authorization: basic('ubuntu', 'pw') }), PW), null, 'remembered');
  assert.equal(await consoleDenied(req({ ...via, authorization: basic('anyone', 'pw') }), PW), null);
  assert.equal(await consoleDenied(req({ ...via, authorization: basic('ubuntu', 'p:w') }), await hashPassword('p:w')), null);
  assert.deepEqual(await consoleDenied(req({ ...via, authorization: basic('ubuntu', 'wrong') }), PW), [401, 'unauthorized']);
  assert.deepEqual(await consoleDenied(req(via), PW), [401, 'unauthorized']);
  assert.deepEqual(await consoleDenied(req({ ...via, authorization: 'Bearer pw' }), PW), [401, 'unauthorized']);
  const noColon = `Basic ${Buffer.from('pw').toString('base64')}`;
  assert.deepEqual(await consoleDenied(req({ ...via, authorization: noColon }), PW), [401, 'unauthorized']);
  // a malformed hash never matches
  assert.deepEqual(await consoleDenied(req({ ...via, authorization: basic('u', 'pw') }), 'zz'), [401, 'unauthorized']);
  // a header that passed for one hash does not pass for another
  assert.deepEqual(await consoleDenied(req({ ...via, authorization: basic('ubuntu', 'pw') }), await hashPassword('other')), [401, 'unauthorized']);
  // no password configured: no login
  assert.equal(await consoleDenied(req(via), ''), null);
});

test('consoleDenied: every write needs X-CDP-Console, on either port', async () => {
  const via = { 'x-cdp-console-via': 'web', authorization: basic('u', 'pw') };
  assert.deepEqual(await consoleDenied(req(via, 'POST'), PW), [403, 'missing X-CDP-Console header']);
  assert.equal(await consoleDenied(req({ ...via, 'x-cdp-console': '1' }, 'POST'), PW), null);
  assert.equal(await consoleDenied(req({ ...via, 'x-cdp-console': '1' }, 'DELETE'), PW), null);
  // the CDP port: no password, but the same CSRF guard (a cross-site form POST)
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    assert.deepEqual(await consoleDenied(req({}, method), PW), [403, 'missing X-CDP-Console header']);
    assert.equal(await consoleDenied(req({ 'x-cdp-console': '1' }, method), PW), null);
  }
});

test('requestPath: only targets nginx and the WHATWG parser read alike', () => {
  const at = (url) => requestPath({ url });
  assert.equal(at('/json/version'), '/json/version');
  assert.equal(at('/json/list?x=1'), '/json/list');
  assert.equal(at('/console/../json/version'), '/json/version'); // nginx resolves it alike
  assert.equal(at('/console/%2e%2e/json/version'), '/json/version'); // and this
  assert.equal(at('/x%5Cy'), '/x%5Cy'); // an escaped backslash stays one
  for (const url of ['/console/..\\json/version', '/console\\..\\devtools/browser/x', '/a\tb', '/a b', '/a\nb', '/a\x7f', 'http://x/json/version', '*', '']) {
    assert.equal(at(url), null, JSON.stringify(url));
  }
});

test('viaWeb: the marker nginx sets on the web port', () => {
  assert.equal(viaWeb(req({ 'x-cdp-console-via': 'web' })), true);
  assert.equal(viaWeb(req({})), false);
});

test('cdpOriginDenied: CDP clients and address-bar visits pass, web pages do not', () => {
  const none = parseAllowedOrigins('');
  // Playwright / Puppeteer / curl: no Origin, no Sec-Fetch-*
  assert.equal(cdpOriginDenied(req({ host: 'h:9222' }), none), null);
  // Node's own fetch / WebSocket (undici): Sec-Fetch-Mode only
  assert.equal(cdpOriginDenied(req({ 'sec-fetch-mode': 'cors' }), none), null);
  assert.equal(cdpOriginDenied(req({ 'sec-fetch-mode': 'websocket' }), none), null);
  // /json/version typed into a browser's address bar
  assert.equal(cdpOriginDenied(req({ 'sec-fetch-site': 'none' }), none), null);
  // a page's WebSocket or fetch (cross-site, same-site, or DNS-rebound same-origin)
  assert.equal(cdpOriginDenied(req({ origin: 'https://evil.example' }), none)[0], 403);
  assert.equal(cdpOriginDenied(req({ origin: 'http://h:9222', host: 'h:9222' }), none)[0], 403);
  assert.equal(cdpOriginDenied(req({ origin: 'null' }), none)[0], 403);
  // an <img> / link / form GET from another site carries no Origin
  assert.equal(cdpOriginDenied(req({ 'sec-fetch-site': 'cross-site' }), none)[0], 403);
  assert.equal(cdpOriginDenied(req({ 'sec-fetch-site': 'same-site' }), none)[0], 403);
});

test('cdpOriginDenied: CDP_ALLOW_ORIGINS lists origins, * allows any', () => {
  const allowed = parseAllowedOrigins(' http://tools.example:8000/ , devtools://devtools/ ');
  assert.deepEqual([...allowed], ['http://tools.example:8000', 'devtools://devtools']);
  assert.equal(cdpOriginDenied(req({ origin: 'http://tools.example:8000' }), allowed), null);
  assert.equal(cdpOriginDenied(req({ origin: 'HTTP://TOOLS.example:8000' }), allowed), null);
  assert.equal(cdpOriginDenied(req({ origin: 'devtools://devtools' }), allowed), null);
  assert.equal(cdpOriginDenied(req({ origin: 'http://tools.example:8001' }), allowed)[0], 403);
  assert.equal(cdpOriginDenied(req({ origin: 'https://tools.example:8000' }), allowed)[0], 403);
  assert.equal(parseAllowedOrigins('http://a, *'), '*');
  assert.equal(cdpOriginDenied(req({ origin: 'https://anything' }), '*'), null);
  assert.equal(normalizeOrigin('http://a.example:80'), 'http://a.example');
});

test('consoleOriginDenied: same host:port or no Origin only', () => {
  assert.equal(consoleOriginDenied(req({ host: 'h:8080' })), null);
  assert.equal(consoleOriginDenied(req({ host: 'h:8080', origin: 'http://h:8080' })), null);
  assert.equal(consoleOriginDenied(req({ host: 'h:8080', origin: 'https://h:8080' })), null);
  assert.deepEqual(consoleOriginDenied(req({ host: 'h:8080', origin: 'http://h:9222' })), [403, 'cross-origin console connection']);
  assert.deepEqual(consoleOriginDenied(req({ host: 'h:8080', origin: 'http://evil.example' })), [403, 'cross-origin console connection']);
  assert.deepEqual(consoleOriginDenied(req({ host: 'h:8080', origin: 'null' })), [403, 'cross-origin console connection']);
});

test('profile clone skips locks, caches and sessions', () => {
  for (const skipped of ['SingletonLock', 'SingletonSocket', 'DevToolsActivePort', 'Default/Cache',
    'Default/Code Cache', 'GrShaderCache', 'BrowserMetrics-spare.pma', 'Default/Sessions',
    'Default/Sessions_Encrypted', 'Default/Current Session', 'Default/Last Tabs', 'Crashpad']) {
    assert.equal(cloned(`/p/${skipped}`), false, skipped);
  }
  for (const kept of ['Default', 'Default/Cookies', 'Default/Local Storage', 'Default/IndexedDB',
    'Default/Preferences', 'Local State', 'Default/Service Worker']) {
    assert.equal(cloned(`/p/${kept}`), true, kept);
  }
});

test('adjustPrefs: clean exit, continue-where-left-off, frame color', () => {
  const prefs = adjustPrefs({
    profile: { exit_type: 'Crashed', exited_cleanly: false, name: 'keep' },
    session: { restore_on_startup: 5, startup_urls: ['x'] },
    browser: { theme: { other: 1 }, show_home_button: true },
  }, '#e53935');
  assert.deepEqual(prefs.profile, { exit_type: 'Normal', exited_cleanly: true, name: 'keep' });
  assert.deepEqual(prefs.session, { restore_on_startup: 1, startup_urls: ['x'] });
  assert.equal(prefs.browser.show_home_button, true);
  assert.equal(prefs.browser.theme.other, 1);
  assert.equal(prefs.browser.theme.user_color2, (0xffe53935 | 0));
  assert.ok(prefs.browser.theme.user_color2 < 0, 'a signed ARGB int');
  assert.equal(prefs.browser.theme.color_variant2, 3);
  assert.deepEqual(adjustPrefs({}, '#000000').session, { restore_on_startup: 1 });
});

test('cookieParam: session cookies lose expires, optional fields only when set', () => {
  const base = {
    name: 'n', value: 'v', domain: '.a.com', path: '/', secure: true, httpOnly: true,
    priority: 'Medium', sourceScheme: 'Secure', sourcePort: 443, size: 2,
  };
  const session = cookieParam({ ...base, session: true, expires: -1, sameSite: undefined });
  assert.equal('expires' in session, false);
  assert.equal('sameSite' in session, false);
  assert.equal('partitionKey' in session, false);
  assert.equal('size' in session, false);
  const persistent = cookieParam({ ...base, session: false, expires: 123, sameSite: 'Lax',
    partitionKey: { topLevelSite: 'https://a.com', hasCrossSiteAncestor: false } });
  assert.equal(persistent.expires, 123);
  assert.equal(persistent.sameSite, 'Lax');
  assert.deepEqual(persistent.partitionKey, { topLevelSite: 'https://a.com', hasCrossSiteAncestor: false });
});

test('cookieKey: name, domain, path and partition make a cookie', () => {
  const c = { name: 'n', domain: 'a', path: '/' };
  assert.equal(cookieKey(c), cookieKey({ ...c, value: 'other' }));
  assert.notEqual(cookieKey(c), cookieKey({ ...c, path: '/x' }));
  assert.notEqual(cookieKey(c), cookieKey({ ...c, partitionKey: { topLevelSite: 'https://b' } }));
});

test('connectionsTo counts established connections on the local port', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-gateway-test-'));
  const table = path.join(dir, 'tcp');
  // port 8082 = 0x1F92; state 01 = ESTABLISHED, 0A = LISTEN
  fs.writeFileSync(table, [
    '  sl  local_address rem_address   st tx_queue rx_queue',
    '   0: 0100007F:1F92 00000000:0000 0A 00000000:00000000',
    '   1: 0100007F:1F92 0100007F:D431 01 00000000:00000000',
    '   2: 0100007F:D431 0100007F:1F92 01 00000000:00000000',
    '   3: 0100007F:1F93 0100007F:D432 01 00000000:00000000',
  ].join('\n'));
  try {
    assert.equal(connectionsTo(8082, [table, path.join(dir, 'missing')]), 1);
    assert.equal(connectionsTo(8083, [table]), 1);
    assert.equal(connectionsTo(9999, [table]), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('browserExitAction / mayEndBrowser: Browser.close is answered, crashes refused, unless allowed', () => {
  assert.equal(browserExitAction('Browser.close', false), 'close');
  assert.equal(browserExitAction('Browser.crash', false), 'refuse');
  assert.equal(browserExitAction('Browser.crashGpuProcess', false), 'refuse');
  assert.equal(browserExitAction('Browser.getVersion', false), null);
  assert.equal(browserExitAction('Browser.close', true), null);
  assert.equal(mayEndBrowser(Buffer.from('{"id":1,"method":"Browser.close"}'), false), true);
  assert.equal(mayEndBrowser(Buffer.from('{"id":1,"method":"Page.navigate"}'), false), false);
  assert.equal(mayEndBrowser(Buffer.from('{"id":1,"method":"Browser.close"}'), true), false);
  // a JSON escape may hide the name (chromium decodes it): parsed to be sure
  assert.equal(mayEndBrowser(Buffer.from(String.raw`{"id":1,"method":"Browser.\u0063lose"}`), false), true);
  assert.equal(mayEndBrowser(Buffer.from(String.raw`{"id":1,"method":"\u0042rowser.crash"}`), false), true);
  assert.equal(hasEscape(Buffer.from('{"id":1,"method":"Page.navigate"}')), false);
});

test('originTabs: one tab per http(s) origin', () => {
  assert.deepEqual(originTabs([
    { id: 'A', url: 'https://a.example/x' },
    { id: 'B', url: 'https://a.example/y' },
    { id: 'C', url: 'http://b.example:8080/' },
    { id: 'D', url: 'about:blank' },
    { id: 'E', url: 'chrome://newtab/' },
    { id: 'F', url: 'not a url' },
  ]), [['https://a.example', 'A'], ['http://b.example:8080', 'C']]);
});

test('listedAppIds: app_ids of wlrctl toplevel list', () => {
  assert.deepEqual(listedAppIds('cdp-context-1: ctx - Google Chrome for Testing\ncdp-main: a: b\n'),
    new Set(['cdp-context-1', 'cdp-main']));
  assert.deepEqual(listedAppIds(''), new Set());
});

test('broadcast: a console that does not keep up is dropped, not buffered for', () => {
  const ws = (bufferedAmount) => ({
    readyState: 1, bufferedAmount, sent: [], terminated: false,
    send(m) { this.sent.push(m); },
    terminate() { this.terminated = true; },
  });
  const fast = ws(0);
  const slow = ws(MAX_BUFFERED + 1);
  broadcast([{ t: 'gone', name: 'context-1' }], [fast, slow]);
  assert.deepEqual(fast.sent, ['{"ops":[{"t":"gone","name":"context-1"}]}']);
  assert.deepEqual(slow.sent, []);
  assert.equal(slow.terminated, true);
});
