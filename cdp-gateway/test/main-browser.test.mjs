// The main browser's stop (node --test), on a stand-in process: a plain
// `sleep` without a DevTools pipe, so stop() falls back to SIGTERM.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';

const { mainBrowser } = await import('../src/main-browser.mjs');

test('concurrent stops share one shutdown: one SIGTERM, all resolve with the exit', async () => {
  const proc = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  await once(proc, 'spawn');
  mainBrowser.proc = proc;
  mainBrowser.state = 'running';
  const terms = [];
  const realKill = process.kill;
  process.kill = (pid, signal) => {
    if (signal === 'SIGTERM') terms.push(pid);
    return realKill.call(process, pid, signal);
  };
  try {
    // the console's Stop and the idle timer's tick, while Browser.close is underway
    const stops = [mainBrowser.stop(), mainBrowser.stop(), mainBrowser.stop()];
    assert.equal(stops[1], stops[0], 'the same shutdown');
    await Promise.all(stops);
    assert.notEqual(proc.exitCode ?? proc.signalCode, null, 'exited');
    assert.equal(terms.length, 1, `SIGTERMs sent: ${terms.length}`);
  } finally {
    process.kill = realKill;
    mainBrowser.proc = null;
    mainBrowser.state = 'stopped';
  }
  // a later stop is a stop of its own (here: nothing to stop)
  await mainBrowser.stop();
});
