// Small helpers without gateway state.

import { spawn } from 'node:child_process';

export function log(...args) {
  console.log(new Date().toISOString(), '[cdp-gateway]', ...args);
}

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
