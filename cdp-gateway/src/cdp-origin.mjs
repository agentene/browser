// Who may use the CDP API (/json/*, /devtools/*) from inside a web page.
//
// Chromium refuses a DevTools WebSocket whose Origin header is not listed in
// --remote-allow-origins: without that, any page a user has open could drive
// a local browser (WebSockets are not covered by CORS). The gateway dials
// chromium itself, without an Origin, and rewrites the Host header to the
// loopback upstream — so chromium's own Origin and DNS-rebinding checks never
// see the client's request, and the gateway has to apply them here:
//   * a request with an Origin header is a web page's: refused unless that
//     origin is in CDP_ALLOW_ORIGINS ('*' = any), like --remote-allow-origins
//     (browsers send an Origin with every WebSocket handshake and every
//     cross-origin or non-GET fetch, so this also stops DNS rebinding — the
//     rebound page's WebSocket still carries its own origin);
//   * a cross-site request without one (an <img>, a link, a form GET) is
//     refused by its Sec-Fetch-Site header.
// CDP clients (Playwright, Puppeteer, chromedp, ...) send neither, and
// opening /json/* in a browser's address bar is Sec-Fetch-Site: none.

import { ALLOW_ORIGINS_RAW } from './config.mjs';

// One origin the way it is compared: scheme://host[:port] for http(s) and
// ws(s), the lower-cased string without a trailing slash otherwise (e.g.
// devtools://devtools, whose URL origin is opaque).
export function normalizeOrigin(origin) {
  try {
    const u = new URL(origin);
    if (u.origin !== 'null') return u.origin;
  } catch { /* not a URL: compared as written */ }
  return origin.trim().toLowerCase().replace(/\/+$/, '');
}

// CDP_ALLOW_ORIGINS: comma-separated origins, or '*' for any — '*' or a Set.
export function parseAllowedOrigins(raw = '') {
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (list.includes('*')) return '*';
  return new Set(list.map(normalizeOrigin));
}

const ALLOW_ORIGINS = parseAllowedOrigins(ALLOW_ORIGINS_RAW);

// [status, error] to refuse a CDP API request with, or null.
export function cdpOriginDenied(req, allowed = ALLOW_ORIGINS) {
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (allowed === '*' || allowed.has(normalizeOrigin(origin))) return null;
    return [403, `CDP request from origin ${origin} refused (list it in CDP_ALLOW_ORIGINS to allow it)`];
  }
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') return [403, 'cross-site CDP request refused'];
  return null;
}
