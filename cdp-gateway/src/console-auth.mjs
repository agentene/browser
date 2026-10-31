// Who may use the console. Both checks return the [status, error] to answer
// with, or null.

import crypto from 'node:crypto';
import { WEB_PASSWORD } from './config.mjs';

const sha256 = (text) => crypto.createHash('sha256').update(text).digest();

// Console requests through the Selkies web port (the sidebar) are marked by
// nginx with X-CDP-Console-Via: web — the CDP listener strips that header, so
// the CDP port keeps its unauthenticated console. Those need Selkies' master
// password (the browser resends the Basic Auth of the Selkies page); a
// view-only password gets 401, without WWW-Authenticate so no login prompt
// pops up. Writes also need the X-CDP-Console header, which no cross-site
// form or image can send.
export function consoleDenied(req, password = WEB_PASSWORD) {
  if (req.headers['x-cdp-console-via'] !== 'web') return null;
  if (password) {
    const [scheme, encoded = ''] = (req.headers.authorization || '').split(' ');
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const given = sha256(decoded.slice(decoded.indexOf(':') + 1));
    if (scheme !== 'Basic' || !decoded.includes(':') || !crypto.timingSafeEqual(given, sha256(password))) {
      return [401, 'unauthorized'];
    }
  }
  if (req.method !== 'GET' && req.headers['x-cdp-console'] !== '1') return [403, 'missing X-CDP-Console header'];
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
