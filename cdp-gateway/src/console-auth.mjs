// Who may use the console. Both checks return the [status, error] to answer
// with, or null. (Who may use the CDP API itself: cdp-origin.mjs.)

import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { WEB_PASSWORD_HASH } from './config.mjs';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEYLEN = 32;

// A salted scrypt hash of a password, scrypt$N$r$p$<salt>$<hash> (base64url;
// the format of auth-server/src/secrets.mjs), as the entrypoint hands it over
// (CDP_CONSOLE_WEB_PASSWORD_HASH, made by entrypoint/helpers/password-hash.mjs)
// — all the gateway compares against, so it is never given the password
// itself, and a leaked environment does not give it away cheaply either.
// (What keeps a CDP client from reading the container's files through the
// browser: the file:// block, chromium.sh's CHROMIUM_ALLOW_FILE_URLS, and for
// the CDP commands that name files by path, file-access.mjs' CDP_FILE_DIRS.)
export async function hashPassword(password, salt = crypto.randomBytes(16)) {
  const hash = await scrypt(password, salt, KEYLEN, SCRYPT);
  const b64 = (buf) => buf.toString('base64url');
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, b64(salt), b64(hash)].join('$');
}

// Whether the password matches the hash; false for a malformed hash.
export async function verifyPassword(password, stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every(Number.isInteger)) return false;
  const expected = Buffer.from(parts[5], 'base64url');
  if (expected.length !== KEYLEN) return false;
  try {
    const hash = await scrypt(String(password), Buffer.from(parts[4], 'base64url'), KEYLEN, { N, r, p, maxmem: 256 * 1024 * 1024 });
    return crypto.timingSafeEqual(hash, expected);
  } catch {
    return false; // parameters scrypt refuses
  }
}

// The sidebar sends the same Authorization header with every request, and
// scrypt is slow on purpose: a few headers that passed are remembered (as
// SHA-256 digests, never as given).
const verified = new Map(); // stored hash -> Set of header digests
const VERIFIED_MAX = 16;

async function basicAuthOk(header, stored) {
  const [scheme, encoded = ''] = String(header || '').split(' ');
  if (scheme !== 'Basic') return false;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  if (!decoded.includes(':')) return false;
  const digest = crypto.createHash('sha256').update(header).digest('hex');
  let known = verified.get(stored);
  if (known?.has(digest)) return true;
  if (!(await verifyPassword(decoded.slice(decoded.indexOf(':') + 1), stored))) return false;
  if (!known) verified.set(stored, known = new Set());
  if (known.size >= VERIFIED_MAX) known.delete(known.values().next().value);
  known.add(digest);
  return true;
}

// Console requests through the Selkies web port (the sidebar) are marked by
// nginx with X-CDP-Console-Via: web — the CDP listener strips that header.
// Those need Selkies' master password (the browser resends the Basic Auth of
// the Selkies page; any user name); a view-only password gets 401, without
// WWW-Authenticate so no login prompt pops up. Who may open the console at
// all is nginx's call (the built-in login's auth_request, ENABLE_AUTH), on
// either port.
//
// Every write (POST/PATCH/DELETE), on either port, needs the X-CDP-Console
// header: no cross-site form or image can send one, and a cross-site fetch
// that does needs a CORS preflight the gateway never grants.
export async function consoleDenied(req, passwordHash = WEB_PASSWORD_HASH) {
  if (req.headers['x-cdp-console-via'] === 'web' && passwordHash
      && !(await basicAuthOk(req.headers.authorization, passwordHash))) {
    return [401, 'unauthorized'];
  }
  if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-cdp-console'] !== '1') {
    return [403, 'missing X-CDP-Console header'];
  }
  return null;
}

// WebSockets are not covered by CORS: any site the viewer has open could
// subscribe to the console (with the cached Basic Auth, on the web port) and
// read tab titles and thumbnails. Only pages served from the same host:port
// may; clients without an Origin header are no browser page.
export function consoleOriginDenied(req) {
  const origin = req.headers.origin;
  if (!origin) return null;
  try {
    if (new URL(origin).host === req.headers.host) return null;
  } catch { /* malformed: denied */ }
  return [403, 'cross-origin console connection'];
}
