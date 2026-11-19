// HTTP response helpers.

import { PUBLIC_FALLBACK } from './config.mjs';

// The public host:port the client dialed (nginx passes the original Host through).
export function publicHost(req) {
  return req.headers.host || PUBLIC_FALLBACK;
}

// The path a request is routed by, or null for one that must be refused.
// nginx routes the raw request target; the WHATWG URL parser reads more
// into it: a backslash is a slash, tabs and newlines are dropped, and a
// leading // introduces a host. Only targets both read alike get through:
// origin-form, not //, no backslash, no whitespace or control characters.
export function requestPath(req) {
  const target = req.url || '';
  if (!target.startsWith('/') || target.startsWith('//') || /[\\\x00-\x20\x7f]/.test(target)) return null;
  return new URL(target, 'http://gateway').pathname;
}

// An error a route answers with its own status instead of 500.
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// A JSON request body, at most `limit` bytes.
export async function readJson(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'request body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'request body is not JSON');
  }
}

export function send(res, status, body, type = 'application/json; charset=UTF-8') {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(payload);
}
