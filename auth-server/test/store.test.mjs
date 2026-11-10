// Unit tests for the persisted store and the login limiter (node --test).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Limiter } from '../src/limiter.mjs';
import {
  AuthStore, SESSION_RENEW_AFTER_MS, SESSION_TTL_MS, apiKeyProblem, passwordProblem, usernameProblem,
} from '../src/store.mjs';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'auth-')), 'settings', 'auth.json');
const error = async (fn) => {
  try {
    await fn();
  } catch (err) {
    return err.status;
  }
  return 0;
};

test('validation', () => {
  assert.equal(usernameProblem('admin'), '');
  assert.notEqual(usernameProblem(''), '');
  assert.notEqual(usernameProblem('a b'), '');
  assert.notEqual(usernameProblem('a:b'), '');
  assert.notEqual(usernameProblem('x'.repeat(65)), '');
  assert.equal(passwordProblem('12345678'), '');
  assert.notEqual(passwordProblem('1234567'), '');
  assert.notEqual(passwordProblem(undefined), '');
  assert.equal(apiKeyProblem(''), '');
  assert.equal(apiKeyProblem('abcdefgh'), '');
  assert.notEqual(apiKeyProblem('short'), '');
  assert.notEqual(apiKeyProblem('has space'), '');
  assert.notEqual(apiKeyProblem('ключключключ'), '');
});

test('setup with a login, sessions, password change, login off', async () => {
  const file = tmpFile();
  const store = new AuthStore(file);
  assert.equal(store.setUp, false);
  assert.equal(store.cdpAllowed(''), true); // no key before setup
  assert.equal(await error(() => store.setup({ username: 'admin', password: 'short' })), 400);
  await store.setup({ username: 'admin', password: 'password1' });
  assert.equal(store.loginOn, true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(await error(() => store.setup({ skip: true })), 409); // once only
  assert.equal(await store.checkLogin('admin', 'password1'), true);
  assert.equal(await store.checkLogin('admin', 'password2'), false);
  assert.equal(await store.checkLogin('root', 'password1'), false);
  const session = store.newSession();
  assert.equal(store.sessionUser(session), 'admin');
  assert.match(store.cookieName, /^agentene_session_[A-Za-z0-9]+$/);

  // renewal: a fresh token is due SESSION_RENEW_AFTER_MS after the issue
  const now = Date.now();
  const s = store.session(session, now);
  assert.equal(s.u, 'admin');
  assert.ok(Math.abs(s.exp - now - SESSION_TTL_MS) < 5000);
  assert.ok(Math.abs(AuthStore.renewIn(s, now) - SESSION_RENEW_AFTER_MS) < 5000);
  assert.ok(AuthStore.renewIn(s, now + SESSION_RENEW_AFTER_MS + 5000) <= 0);
  assert.equal(store.session(session, now + SESSION_TTL_MS + 5000), null); // expired unrenewed
  assert.equal(store.session('nonsense'), null);

  // a new login ends every session
  await store.setLogin('boss', 'password2');
  assert.equal(store.sessionUser(session), null);
  assert.equal(store.sessionUser(store.newSession()), 'boss');

  // persisted: a second store (the next container start) reads the same
  const again = new AuthStore(file);
  assert.equal(again.username, 'boss');
  assert.equal(await again.checkLogin('boss', 'password2'), true);

  store.disableLogin();
  assert.equal(store.setUp, true);
  assert.equal(store.loginOn, false);
  assert.equal(store.sessionUser(session), null);
});

test('setup skipped, API key set and removed', async () => {
  const file = tmpFile();
  const store = new AuthStore(file);
  await store.setup({ skip: true });
  assert.equal(store.setUp, true);
  assert.equal(store.loginOn, false);
  assert.equal(await error(() => store.setApiKey('short')), 400);
  store.setApiKey('the-api-key-1');
  assert.equal(store.apiKeySet, true);
  assert.equal(store.cdpAllowed(''), false);
  assert.equal(store.cdpAllowed('wrong-key-11'), false);
  assert.equal(store.cdpAllowed('the-api-key-1'), true);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /the-api-key-1/); // hashed
  assert.equal(new AuthStore(file).cdpAllowed('the-api-key-1'), true);
  store.setApiKey('');
  assert.equal(store.apiKeySet, false);
  assert.equal(store.cdpAllowed(''), true);
});

test('a deleted file resets, a broken one locks', async () => {
  const file = tmpFile();
  const store = new AuthStore(file);
  await store.setup({ username: 'admin', password: 'password1' });
  store.setApiKey('the-api-key-1');
  fs.rmSync(file);
  store.refresh(Date.now() + 5000);
  assert.equal(store.setUp, false);
  assert.equal(store.cdpAllowed(''), true);

  fs.writeFileSync(file, '{ not json');
  store.refresh(Date.now() + 10_000);
  assert.notEqual(store.broken, '');
  assert.equal(store.setUp, false);
  assert.equal(store.cdpAllowed('the-api-key-1'), false); // fail closed
  assert.equal(await error(() => store.setup({ skip: true })), 409);

  fs.writeFileSync(file, JSON.stringify({ web: { login: true } })); // no user name
  assert.notEqual(new AuthStore(file).broken, '');
});

test('limiter: blocks after too many failures, per address, for a window', () => {
  const limiter = new Limiter(3, 1000);
  for (let i = 0; i < 3; i++) limiter.fail('a', 0);
  assert.equal(limiter.blockedFor('a', 10), 1);
  assert.equal(limiter.blockedFor('b', 10), 0);
  assert.equal(limiter.blockedFor('a', 1000), 0); // window over
  limiter.fail('b', 0);
  limiter.succeed('b');
  assert.equal(limiter.failures.has('b'), false);
});
