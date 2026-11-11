// HTTP response helpers.

import { PUBLIC_FALLBACK } from './config.mjs';

// The public host:port the client dialed (nginx passes the original Host through).
export function publicHost(req) {
  return req.headers.host || PUBLIC_FALLBACK;
}

// The path a request is routed by, or null for one that must be refused.
// nginx picks the location (and so the auth check) from its own reading of
// the raw request target and passes that target on unchanged; the WHATWG URL
// parser reads more into it — a backslash is a slash, tabs and newlines are
// dropped — so /console/..\json/version is /console/… to nginx (the console
// login) but /json/version here (the CDP API, which needs the API key). And
// a target that starts with // is a host to it: //console/json/version is
// /console/json/version to nginx (merge_slashes) but host "console", path
// /json/version here. Only targets both read alike get through:
// origin-form, not //, no backslash, no whitespace or control characters.
export function requestPath(req) {
  const target = req.url || '';
  if (!target.startsWith('/') || target.startsWith('//') || /[\\\x00-\x20\x7f]/.test(target)) return null;
  return new URL(target, 'http://gateway').pathname;
}

// A console request nginx forwarded from the web UI port (its cdp-console/
// location sets this header; the CDP listener strips it). Those may reach
// the console and nothing else: the CDP API is the CDP port's alone.
export function viaWeb(req) {
  return req.headers['x-cdp-console-via'] === 'web';
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
