// Password and API key hashing, session tokens, cookies: pure helpers.
//
//   password   scrypt$N$r$p$<salt b64url>$<hash b64url>  (slow on purpose)
//   API key    sha256$<hex>  (keys are long and random, or at least chosen
//              by the admin: a fast hash keeps every CDP request cheap)
//   session    <payload b64url>.<HMAC-SHA256 b64url>, payload {u, exp};
//              signed with the store's session secret, which is replaced
//              whenever the login changes, so every older session ends
//              with it.

import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEYLEN = 32;

const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest();

// Constant-time comparison of two strings of any length.
export function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, { ...SCRYPT, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every(Number.isInteger)) return false;
  const expected = Buffer.from(parts[5], 'base64url');
  if (expected.length !== KEYLEN) return false;
  const hash = await scrypt(String(password), Buffer.from(parts[4], 'base64url'), KEYLEN, {
    N, r, p, maxmem: 256 * 1024 * 1024,
  });
  return crypto.timingSafeEqual(hash, expected);
}

export function hashApiKey(key) {
  return `sha256$${sha256(key).toString('hex')}`;
}

export function verifyApiKey(given, stored) {
  if (typeof given !== 'string' || !given || typeof stored !== 'string') return false;
  return safeEqual(hashApiKey(given), stored);
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

export function signSession(secret, username, ttlMs, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ u: username, exp: now + ttlMs })).toString('base64url');
  return `${payload}.${hmac(secret, payload)}`;
}

// The session's user name, or null (malformed, forged, expired).
export function verifySession(secret, token, now = Date.now()) {
  if (!secret || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), hmac(secret, payload))) return null;
  try {
    const { u, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof u === 'string' && Number.isFinite(exp) && exp > now ? u : null;
  } catch {
    return null;
  }
}

// Cookie header -> Map(name -> value); the first occurrence of a name wins.
export function parseCookies(header) {
  const cookies = new Map();
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name && !cookies.has(name)) cookies.set(name, part.slice(eq + 1).trim());
  }
  return cookies;
}

// The API key a CDP client sent: Authorization: Bearer <key>, or X-API-Key.
export function apiKeyFrom(headers) {
  const auth = String(headers.authorization || '');
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  const key = headers['x-api-key'];
  return typeof key === 'string' ? key.trim() : '';
}
