// Authentication is enforced by nginx's auth_request on both public ports.
// Keep CSRF and WebSocket origin checks here as well.

// Every write (POST/PATCH/DELETE), on either port, needs the X-CDP-Console
// header: no cross-site form or image can send one, and a cross-site fetch
// that does needs a CORS preflight the gateway never grants.
export function consoleDenied(req) {
  if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-cdp-console'] !== '1') {
    return [403, 'missing X-CDP-Console header'];
  }
  return null;
}

// WebSockets are not covered by CORS: any site the viewer has open could
// subscribe to the console with the session cookie and
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
