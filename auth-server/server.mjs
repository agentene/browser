// auth-server/server.mjs — the built-in login of the web UI and the CDP
// console, and the CDP endpoint's API key (ENABLE_AUTH=true, started by
// entrypoint/lib/auth.sh on loopback, behind nginx).
//
// nginx asks it about every request (auth_request, entrypoint/lib/nginx.sh):
//   GET /check/web   the web UI and the console: 204 with a valid session
//                    (or with the login skipped), else 401 — nginx then
//                    serves /page in place: the setup or the login form.
//                    403 for a cookie-carrying cross-origin write or
//                    WebSocket (CSRF / cross-site WebSocket hijacking).
//   GET /check/cdp   the CDP API: 204 without an API key or with the right
//                    one (Authorization: Bearer <key> or X-API-Key), else 401
// and proxies its public paths (<web prefix>/__auth/ and /__auth/ on the
// CDP port) here, with that prefix stripped:
//   GET  /                the account page (login, API key, log out)
//   GET  /ui.js           settings rows + dialogs for the console pages
//   GET  /api/state       {setUp, login, authorized, username, apiKey, cdp}
//   POST /api/setup       {username, password} | {skip: true}   (first start)
//   POST /api/login       {username, password}
//   POST /api/logout
//   PUT  /api/credentials {currentPassword, username, password}; both empty
//                         = login off
//   PUT  /api/apikey      {apiKey}; empty = no API key
// The state lives in AUTH_FILE (store.mjs).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Limiter } from './src/limiter.mjs';
import { apiKeyFrom, parseCookies } from './src/secrets.mjs';
import { AuthStore, InputError, SESSION_TTL_MS } from './src/store.mjs';

const env = process.env;
const PORT = Number(env.AUTH_INTERNAL_PORT || 9219);
const FILE = env.AUTH_FILE || '/browser/settings/auth.json';
// whether this container has a CDP endpoint (the API key matters at all)
const CDP = env.ENABLE_CDP !== 'false';
const ROOT = path.dirname(fileURLToPath(import.meta.url));

const log = (msg) => console.log(`[auth] ${new Date().toISOString()} ${msg}`);
const store = new AuthStore(FILE, log);
const limiter = new Limiter();
const PAGE = fs.readFileSync(path.join(ROOT, 'page.html'), 'utf8');
const UI = fs.readFileSync(path.join(ROOT, 'ui.js'));

// --- request helpers -------------------------------------------------------------

function send(res, status, body, headers = {}) {
  const isText = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isText ? 'text/plain; charset=UTF-8' : 'application/json; charset=UTF-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body === undefined ? undefined : isText ? body : JSON.stringify(body));
}

const clientAddress = (req) => req.headers['x-real-ip'] || req.socket.remoteAddress || '?';
const isSecure = (req) => req.headers['x-forwarded-proto'] === 'https';

// A browser page of this host:port, or no browser at all (no Origin).
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function sessionCookie(req, token) {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${token ? SESSION_TTL_MS / 1000 : 0}`];
  if (isSecure(req)) attrs.push('Secure');
  return `${store.cookieName}=${token || ''}; ${attrs.join('; ')}`;
}

function authorized(req) {
  if (!store.setUp) return false;
  if (!store.loginOn) return true;
  return !!store.sessionUser(parseCookies(req.headers.cookie).get(store.cookieName));
}

async function readJson(req, limit = 16 * 1024) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new InputError('expected application/json', 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new InputError('request body too large', 413);
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new InputError('request body is not a JSON object');
  }
}

function state(req) {
  const ok = authorized(req);
  return {
    setUp: store.setUp,
    login: store.loginOn,
    authorized: ok,
    username: ok ? store.username : null,
    apiKey: ok ? store.apiKeySet : null,
    cdp: CDP,
    ...(store.broken ? { broken: store.broken } : {}),
  };
}

// A URL path nginx passed in a header, if it is a plain one.
function pathHeader(req, name, fallback) {
  const v = req.headers[name] || '';
  return /^\/[A-Za-z0-9._~/-]*$/.test(v) ? v : fallback;
}

// The page in a mode, with its API base (nginx: X-Auth-Base) and the page
// it links back to (X-Auth-Home: the web UI, or the console on the CDP port).
function page(req, res, mode, status) {
  const html = PAGE.replace('{{BASE}}', pathHeader(req, 'x-auth-base', '/__auth/'))
    .replace('{{HOME}}', pathHeader(req, 'x-auth-home', '/'))
    .replace('{{MODE}}', mode).replace('{{CDP}}', String(CDP));
  send(res, status, html, { 'Content-Type': 'text/html; charset=UTF-8' });
}

// Checks the current password for a change; throws when it is wrong.
async function requirePassword(req, password) {
  const address = clientAddress(req);
  const wait = limiter.blockedFor(address);
  if (wait) throw new InputError(`too many failed attempts, try again in ${Math.ceil(wait / 60)} min`, 429);
  if (!(await store.checkLogin(store.username, password))) {
    limiter.fail(address);
    throw new InputError('the current password is wrong', 403);
  }
  limiter.succeed(address);
}

// --- routes ----------------------------------------------------------------------

async function api(req, res, name) {
  if (name === 'state' && req.method === 'GET') return send(res, 200, state(req));
  if (!['POST', 'PUT'].includes(req.method)) return send(res, 405, { error: 'method not allowed' });
  if (!sameOrigin(req)) return send(res, 403, { error: 'cross-origin request' });
  const body = await readJson(req);

  if (name === 'setup' && req.method === 'POST') {
    await store.setup(body);
    const headers = store.loginOn ? { 'Set-Cookie': sessionCookie(req, store.newSession()) } : {};
    return send(res, 200, { ok: true }, headers);
  }
  if (name === 'login' && req.method === 'POST') {
    if (!store.loginOn) return send(res, 409, { error: 'the login is off' });
    const address = clientAddress(req);
    const wait = limiter.blockedFor(address);
    if (wait) return send(res, 429, { error: `too many failed attempts, try again in ${Math.ceil(wait / 60)} min` });
    if (!(await store.checkLogin(body.username, body.password))) {
      limiter.fail(address);
      log(`failed login for "${String(body.username).slice(0, 64)}" from ${address}`);
      return send(res, 401, { error: 'wrong user name or password' });
    }
    limiter.succeed(address);
    log(`"${store.username}" signed in from ${address}`);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, store.newSession()) });
  }
  if (name === 'logout' && req.method === 'POST') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '') });
  }

  if (!store.setUp) return send(res, 409, { error: store.broken || 'not set up yet' });
  if (!authorized(req)) return send(res, 401, { error: 'sign in first' });

  if (name === 'credentials' && req.method === 'PUT') {
    if (store.loginOn) await requirePassword(req, body.currentPassword);
    const { username = '', password = '' } = body;
    if (username === '' && password === '') {
      if (store.loginOn) store.disableLogin();
      return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '') });
    }
    await store.setLogin(username, password);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, store.newSession()) });
  }
  if (name === 'apikey' && req.method === 'PUT') {
    store.setApiKey(body.apiKey ?? '');
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: `no such API: ${name}` });
}

async function route(req, res) {
  store.refresh();
  const p = new URL(req.url, 'http://auth').pathname;

  if (p === '/check/web') {
    if (!authorized(req)) return send(res, 401);
    const method = req.headers['x-original-method'] || 'GET';
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method) || !!req.headers['x-original-upgrade'];
    if (unsafe && store.loginOn && !sameOrigin(req)) return send(res, 403);
    return send(res, 204);
  }
  if (p === '/check/cdp') return send(res, store.cdpAllowed(apiKeyFrom(req.headers)) ? 204 : 401);

  if (p === '/page') {
    // what nginx serves in place of a page the visitor may not see yet
    let mode = 'login';
    if (store.broken) mode = 'broken';
    else if (!store.setUp) mode = 'setup';
    else if (authorized(req)) mode = 'reload'; // signed in meanwhile
    return page(req, res, mode, 401);
  }
  if (p === '/' && req.method === 'GET') return page(req, res, 'account', 200);
  if (p === '/ui.js' && req.method === 'GET') {
    return send(res, 200, UI, { 'Content-Type': 'text/javascript; charset=UTF-8', 'Cache-Control': 'no-cache' });
  }
  const m = p.match(/^\/api\/([a-z]+)$/);
  if (m) return api(req, res, m[1]);
  return send(res, 404, { error: `not found: ${p}` });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    if (!(err instanceof InputError)) log(`${req.method} ${req.url}: ${err.stack || err.message}`);
    if (!res.headersSent) send(res, err.status ?? 500, { error: err.message });
  });
});
server.listen(PORT, '127.0.0.1', () => {
  let what = 'not set up yet: the web pages show the setup form';
  if (store.broken) what = `LOCKED: ${store.broken}`;
  else if (store.loginOn) what = `login on (user "${store.username}")`;
  else if (store.setUp) what = 'login skipped: the web UI is open';
  log(`listening on 127.0.0.1:${PORT}; ${FILE}: ${what}; CDP API key ${store.apiKeySet ? 'set' : 'not set (CDP open)'}`);
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
