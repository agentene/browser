import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-session-launch-'));
const executable = path.join(dir, 'chrome.mjs');
fs.writeFileSync(executable, `#!/usr/bin/env node
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const file = args.find(a => a.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
let child;
if (args.includes('--hang')) child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(file, JSON.stringify({ pid: process.pid, child: child?.pid, args }));
if (!child) process.exit(args.includes('--fail') ? 7 : 0);
`, { mode: 0o755 });
process.env.CHROME_BIN = executable;
const { openChromiumSession } = await import('../src/launch.mjs');
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const owner = () => Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
const flags = (file, ...extra) => [`--user-data-dir=${file}`, '--no-startup-window', '--restore-last-session', ...extra];
const gone = (pid) => {
  try { process.kill(pid, 0); return false; } catch { return true; }
};

test('native window command forwards the profile and restore switches without another CDP channel', async () => {
  const file = path.join(dir, 'forwarded');
  const browser = owner();
  await openChromiumSession(browser, flags(file, '--no-startup-window=true', 'http://startup.test/',
    '--remote-debugging-pipe', '--remote-debugging-port=1234'), 'ignore', process.env, 1000);
  const command = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(command.args, [`--user-data-dir=${file}`, '--restore-last-session']);
  assert.ok(gone(command.pid));
  assert.equal(browser.listenerCount('exit'), 0);
});

test('native window command fails on a rejected request or an already exited owner', async () => {
  const file = path.join(dir, 'failed');
  await assert.rejects(openChromiumSession(owner(), flags(file, '--fail'), 'ignore', process.env, 1000), /failed \(7\)/);
  const browser = owner();
  browser.exitCode = 0;
  const absent = path.join(dir, 'not-started');
  await assert.rejects(openChromiumSession(browser, flags(absent), 'ignore', process.env, 1000), /exited before/);
  assert.equal(fs.existsSync(absent), false);
});

for (const failure of ['timeout', 'owner exit']) {
  test(`native window command cleans up its process group after ${failure}`, async () => {
    const file = path.join(dir, failure);
    const browser = owner();
    const pending = assert.rejects(openChromiumSession(browser, flags(file, '--hang'), 'ignore', process.env,
      failure === 'timeout' ? 1000 : 5000), failure === 'timeout' ? /timed out/ : /exited while/);
    for (let i = 0; !fs.existsSync(file); i++) {
      assert.ok(i < 300, 'fixture did not start');
      await delay(10);
    }
    const command = JSON.parse(fs.readFileSync(file));
    if (failure === 'owner exit') browser.emit('exit', 0);
    await pending;
    assert.ok(gone(command.pid), 'wait for the forwarding process to exit before returning');
    // An orphaned child can briefly remain a zombie until init reaps it.
    const stat = `/proc/${command.child}/stat`;
    const childRunning = () => {
      try { return !/\) Z /.test(fs.readFileSync(stat, 'utf8')); }
      catch (err) { if (err.code === 'ENOENT') return false; throw err; }
    };
    for (let i = 0; childRunning(); i++) {
      assert.ok(i < 100, 'forwarding process left a live child behind');
      await delay(10);
    }
    assert.equal(browser.listenerCount('exit'), 0);
  });
}
