// Who may use the console. Both checks return the [status, error] to answer
// with, or null. (Who may use the CDP API itself: cdp-origin.mjs.)

import crypto from 'node:crypto';
import { WEB_PASSWORD_SHA256 } from './config.mjs';

const sha256 = (text) => crypto.createHash('sha256').update(text).digest();

// The SHA-256 hex digest of a password, as the entrypoint hands it over
// (CDP_CONSOLE_WEB_PASSWORD_SHA256) — all the gateway compares against, so
// it is not given the password itself. (What keeps a CDP client from reading
// the environment of the container's processes through the browser is the
// file:// block, chromium.sh's CHROMIUM_ALLOW_FILE_URLS.)
export function passwordDigest(password) {
  return sha256(password).toString('hex');
}

// Console requests through the Selkies web port (the sidebar) are marked by
// nginx with X-CDP-Console-Via: web — the CDP listener strips that header.
// Those need Selkies' master password (the browser resends the Basic Auth of
// the Selkies page); a view-only password gets 401, without WWW-Authenticate
// so no login prompt pops up. Who may open the console at all is nginx's
// call (the built-in login's auth_request, ENABLE_AUTH), on either port.
//
// Every write (POST/PATCH/DELETE), on either port, needs the X-CDP-Console
// header: no cross-site form or image can send one, and a cross-site fetch
// that does needs a CORS preflight the gateway never grants.
export function consoleDenied(req, passwordSha256 = WEB_PASSWORD_SHA256) {
  if (req.headers['x-cdp-console-via'] === 'web' && passwordSha256) {
    const [scheme, encoded = ''] = (req.headers.authorization || '').split(' ');
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const given = sha256(decoded.slice(decoded.indexOf(':') + 1));
    const expected = Buffer.from(passwordSha256, 'hex');
    if (scheme !== 'Basic' || !decoded.includes(':') || expected.length !== given.length
        || !crypto.timingSafeEqual(given, expected)) {
      return [401, 'unauthorized'];
    }
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
