// HTTP response helpers.

import { PUBLIC_FALLBACK } from './config.mjs';

// The public host:port the client dialed (nginx passes the original Host through).
export function publicHost(req) {
  return req.headers.host || PUBLIC_FALLBACK;
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
