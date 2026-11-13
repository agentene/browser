// Small helpers without gateway state.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

export function log(...args) {
  console.log(new Date().toISOString(), '[cdp-gateway]', ...args);
}

// A page that reads slower than the gateway sends (a stalled tab, a bad
// link) would grow the gateway's send buffer without bound; skipping ops would
// leave it with a wrong picture, so it is dropped instead — the console pages
// and the overlay reconnect and start over from a snapshot.
export const MAX_BUFFERED = 8 * 1024 * 1024;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Run a helper to completion; resolves with its exit code (an Error when it
// could not be started at all, so callers only test for 0).
export function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'ignore' });
    child.on('exit', resolve);
    child.on('error', resolve);
  });
}

// Run a helper to completion; resolves with its stdout ('' when it failed or
// could not be started).
export function output(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('close', (code) => resolve(code === 0 ? out : ''));
    child.on('error', () => resolve(''));
  });
}

// Signal a process group, ignoring one that is already gone.
export function killGroup(pid, signal) {
  try { process.kill(-pid, signal); } catch { /* already gone */ }
}

// Connected streams on a unix socket: the connections its server accepted
// are listed under its path too, in state 03 (connected); the listening
// socket itself is 01. nginx keeps no idle upstream connections, so outside
// a request only a viewer's stream WebSocket is open.
export function connectionsTo(socketPath, table = '/proc/net/unix') {
  let text = '';
  try {
    text = readFileSync(table, 'utf8');
  } catch {
    return 0;
  }
  let n = 0;
  for (const line of text.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields[5] === '03' && fields[7] === socketPath) n++;
  }
  return n;
}
