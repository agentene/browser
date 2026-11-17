import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');

function page(base) {
  const scripts = [], requests = [], events = [];
  const sandbox = {
    URL, window: { addEventListener(name) { events.push(name); } },
    document: {
      currentScript: { src: `${base}client.js` },
      createElement() { return { remove() {} }; },
      head: { append(script) { scripts.push(script); } },
      addEventListener(name) { events.push(name); },
    },
    async fetch(url, options) {
      requests.push({ url, options });
      return { ok: true, status: 200, async json() { return { renewIn: 10000 }; } };
    },
    setTimeout() { return 1; }, clearTimeout() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { sandbox, scripts, requests, events, client: sandbox.window.AgenteneAuthClient };
}

test('both console views share one path-aware auth bootstrap and renewal loop', async () => {
  for (const base of ['https://example.test/admin/__auth/', 'https://example.test/tools/control/__auth/', 'https://example.test/__auth/']) {
    const { sandbox, scripts, requests, events, client } = page(base);
    const eventCount = events.length;
    vm.runInContext(source, sandbox); // repeated injection is harmless
    assert.equal(events.length, eventCount);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, `${base}api/renew`);
    assert.equal(requests[0].options.credentials, 'same-origin');

    const mounts = [], languages = [];
    const settings = { menu: {}, root: {}, onError: assert.fail };
    const pending = client.mount({ ...settings, language: 'en-US' });
    const repeated = client.mount({ ...settings, language: 'en-US' });
    assert.equal(scripts.length, 1);
    assert.equal(scripts[0].src, `${base}ui.js`);
    client.setLang('zh-CN'); // language changes before the controls finish loading
    sandbox.window.AgenteneAuth = { setLang(lang) { languages.push(lang); }, mount(options) { mounts.push(options); } };
    scripts[0].onload();
    await Promise.all([pending, repeated]);
    assert.ok(languages.every((lang) => lang === 'zh-CN'));
    assert.equal(mounts[0].menu, settings.menu);
    assert.equal(mounts[0].root, settings.root);
    client.setLang('en-US');
    assert.equal(languages.at(-1), 'en-US');
  }
});

test('failed account-control loads report an error and can be retried', async () => {
  const { sandbox, scripts, client } = page('https://example.test/admin/__auth/');
  const errors = [];
  const options = { menu: {}, root: {}, language: 'en-US', onError(error) { errors.push(error); } };
  const failed = client.mount(options);
  scripts[0].onerror();
  await failed;
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /account controls/);
  const retry = client.mount(options);
  assert.equal(scripts.length, 2);
  let mounted = false;
  sandbox.window.AgenteneAuth = { setLang() {}, mount() { mounted = true; } };
  scripts[1].onload();
  await retry;
  assert.equal(mounted, true);
});
