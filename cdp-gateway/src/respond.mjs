// HTTP response helpers.

import { PUBLIC_FALLBACK } from './config.mjs';

// The public host:port the client dialed (nginx passes the original Host through).
export function publicHost(req) {
  return req.headers.host || PUBLIC_FALLBACK;
}

export function send(res, status, body, type = 'application/json; charset=UTF-8') {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(payload);
}
