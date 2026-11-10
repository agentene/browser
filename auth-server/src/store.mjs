// The persisted login + API key: one JSON file on the /browser mount (mode
// 0600, written by this service only):
//
//   {
//     "version": 1,
//     "instance": "<hex>",          // the session cookie's name suffix
//     "session": "<secret>",        // signs the sessions; replaced on every
//                                   // login change (= everyone signed out)
//     "web": { "login": true, "username": "admin", "password": "scrypt$…" }
//          | { "login": false },    // "skip login": the web UI stays open
//     "cdp": { "apiKey": "sha256$…" }   // absent = no API key
//   }
//
// No "web" entry = not set up yet: every web page shows the setup form.
// Deleting the file resets everything (picked up within a second, no
// restart). A file that exists but cannot be read or parsed locks the web
// UI and the CDP endpoint (fail closed) until it is fixed or deleted.

import fs from 'node:fs';
import path from 'node:path';
import {
  hashApiKey, hashPassword, randomToken, signSession, verifyApiKey, verifyPassword, verifySession,
} from './secrets.mjs';

export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const RELOAD_EVERY_MS = 1000;

export class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// What a user name / password / API key may be; each returns the error
// message, or '' when the value is fine.
export function usernameProblem(v) {
  if (typeof v !== 'string' || !v) return 'the user name is empty';
  if (v.length > 64) return 'the user name is longer than 64 characters';
  if (/[\s:]/.test(v) || /[\u0000-\u001f\u007f]/.test(v)) return 'the user name may not contain spaces, colons or control characters';
  return '';
}

export function passwordProblem(v) {
  if (typeof v !== 'string' || v.length < 8) return 'the password needs at least 8 characters';
  if (v.length > 1024) return 'the password is longer than 1024 characters';
  return '';
}

export function apiKeyProblem(v) {
  if (typeof v !== 'string') return 'the API key must be a string';
  if (v === '') return '';
  if (v.length < 8) return 'the API key needs at least 8 characters';
  if (v.length > 512) return 'the API key is longer than 512 characters';
  if (!/^[\x21-\x7e]+$/.test(v)) return 'the API key may only contain visible ASCII characters (no spaces)';
  return '';
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

export class AuthStore {
  constructor(file, log = () => {}) {
    this.file = file;
    this.log = log;
    this.data = {};
    this.broken = ''; // why the file cannot be used ('' = fine)
    this.stamp = null;
    this.checked = 0;
    this.load();
  }

  // --- the file ----------------------------------------------------------------

  load() {
    let stat;
    try {
      stat = fs.statSync(this.file);
    } catch (err) {
      if (err.code !== 'ENOENT') return this.fail(`cannot stat ${this.file}: ${err.message}`);
      if (this.stamp !== 'missing' && this.stamp !== null) this.log(`${this.file} is gone: not set up any more`);
      this.stamp = 'missing';
      this.data = {};
      this.broken = '';
      return;
    }
    const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!isObject(data)) throw new Error('not a JSON object');
      if (data.web !== undefined && !this.validWeb(data.web)) throw new Error('"web" is not a valid login entry');
      this.data = data;
      this.broken = '';
    } catch (err) {
      this.fail(`${this.file}: ${err.message}`);
    }
  }

  fail(message) {
    if (this.broken !== message) this.log(`${message} -> web UI and CDP endpoint locked until it is fixed or deleted`);
    this.broken = message;
    this.data = {};
  }

  validWeb(web) {
    if (!isObject(web) || typeof web.login !== 'boolean') return false;
    return !web.login || (!usernameProblem(web.username) && typeof web.password === 'string');
  }

  // Picks up a file edited or deleted by hand, at most once a second.
  refresh(now = Date.now()) {
    if (now - this.checked < RELOAD_EVERY_MS) return;
    this.checked = now;
    this.load();
  }

  save(next) {
    const data = { version: 1, ...next };
    data.instance ??= randomToken(6).replace(/[^A-Za-z0-9]/g, 'x');
    data.session ??= randomToken();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = path.join(path.dirname(this.file), `.${path.basename(this.file)}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
    this.data = data;
    this.broken = '';
    const stat = fs.statSync(this.file);
    this.stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  }

  // --- what it says ------------------------------------------------------------

  get setUp() { return !this.broken && isObject(this.data.web); }
  get loginOn() { return this.setUp && this.data.web.login === true; }
  get username() { return this.loginOn ? this.data.web.username : null; }
  get apiKeySet() { return !this.broken && typeof this.data.cdp?.apiKey === 'string'; }
  // per container, so two containers on one host (cookies ignore the port)
  // keep their sessions apart
  get cookieName() { return `agentene_session_${this.data.instance || 'new'}`; }

  // The user a session token stands for, or null.
  sessionUser(token) {
    if (!this.loginOn) return null;
    const user = verifySession(this.data.session, token);
    return user === this.data.web.username ? user : null;
  }

  newSession() {
    return signSession(this.data.session, this.data.web.username, SESSION_TTL_MS);
  }

  async checkLogin(username, password) {
    if (!this.loginOn) return false;
    // always hash, so a wrong user name takes as long as a wrong password
    const ok = await verifyPassword(String(password ?? ''), this.data.web.password);
    return ok && username === this.data.web.username;
  }

  // Whether a CDP request may pass: no key set, or the right one.
  cdpAllowed(given) {
    if (this.broken) return false;
    if (!this.apiKeySet) return true;
    return verifyApiKey(given, this.data.cdp.apiKey);
  }

  // --- changes -----------------------------------------------------------------

  // First start: an admin login, or { skip: true } for none.
  async setup(body) {
    if (this.broken) throw new InputError(this.broken, 409);
    if (this.setUp) throw new InputError('already set up', 409);
    if (body?.skip === true) {
      this.save({ ...this.data, web: { login: false } });
      this.log('set up without a login (skipped)');
      return;
    }
    await this.setLogin(body?.username, body?.password);
  }

  // A new user name + password (also turns the login on), with a new session
  // secret: every other session ends.
  async setLogin(username, password) {
    const problem = usernameProblem(username) || passwordProblem(password);
    if (problem) throw new InputError(problem);
    this.save({ ...this.data, session: randomToken(), web: { login: true, username, password: await hashPassword(password) } });
    this.log(`login set for user "${username}"`);
  }

  disableLogin() {
    this.save({ ...this.data, session: randomToken(), web: { login: false } });
    this.log('login turned off: the web UI is open');
  }

  setApiKey(key) {
    const problem = apiKeyProblem(key);
    if (problem) throw new InputError(problem);
    const { cdp, ...rest } = this.data;
    this.save(key ? { ...rest, cdp: { apiKey: hashApiKey(key) } } : rest);
    this.log(key ? 'CDP API key set' : 'CDP API key removed: the CDP endpoint is open');
  }
}
