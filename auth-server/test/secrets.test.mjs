// Unit tests for the hashing, session and header helpers (node --test).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  apiKeyFrom, hashApiKey, hashPassword, parseCookies, safeEqual, signSession, verifyApiKey, verifyPassword,
  readSession, verifySession,
} from '../src/secrets.mjs';

test('passwords: scrypt, salted, verified', async () => {
  const a = await hashPassword('correct horse');
  const b = await hashPassword('correct horse');
  assert.match(a, /^scrypt\$16384\$8\$1\$/);
  assert.notEqual(a, b); // salted
  assert.equal(await verifyPassword('correct horse', a), true);
  assert.equal(await verifyPassword('correct hors', a), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
  assert.equal(await verifyPassword('x', undefined), false);
});

test('API keys: hashed, compared in full', () => {
  const stored = hashApiKey('k3y-0123456789');
  assert.match(stored, /^sha256\$[0-9a-f]{64}$/);
  assert.equal(verifyApiKey('k3y-0123456789', stored), true);
  assert.equal(verifyApiKey('k3y-012345678', stored), false);
  assert.equal(verifyApiKey('', stored), false);
  assert.equal(verifyApiKey(undefined, stored), false);
});

test('sessions: signed, bound to the secret, expire', () => {
  const now = 1_000_000;
  const token = signSession('s1', 'admin', 1000, now);
  assert.equal(verifySession('s1', token, now + 999), 'admin');
  assert.deepEqual(readSession('s1', token, now), { u: 'admin', exp: now + 1000 });
  assert.equal(readSession('s1', token, now + 1000), null);
  assert.equal(verifySession('s1', token, now + 1000), null); // expired
  assert.equal(verifySession('s2', token, now), null); // other secret
  const [payload, mac] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ u: 'root', exp: now + 1e9 })).toString('base64url');
  assert.equal(verifySession('s1', `${forged}.${mac}`, now), null);
  assert.equal(verifySession('s1', `${payload}.`, now), null);
  assert.equal(verifySession('s1', 'nonsense', now), null);
  assert.equal(verifySession('', token, now), null);
});

test('cookies and API key headers', () => {
  const c = parseCookies('a=1; agentene_session_x=tok.en; a=2; junk; =x');
  assert.equal(c.get('a'), '1');
  assert.equal(c.get('agentene_session_x'), 'tok.en');
  assert.equal(c.size, 2);
  assert.equal(parseCookies(undefined).size, 0);
  assert.equal(apiKeyFrom({ authorization: 'Bearer abc' }), 'abc');
  assert.equal(apiKeyFrom({ authorization: 'bearer  abc ' }), 'abc');
  assert.equal(apiKeyFrom({ 'x-api-key': 'xyz' }), 'xyz');
  assert.equal(apiKeyFrom({ authorization: 'Basic dTpw' }), '');
  assert.equal(apiKeyFrom({}), '');
  assert.equal(safeEqual('a', 'a'), true);
  assert.equal(safeEqual('a', 'ab'), false);
});
