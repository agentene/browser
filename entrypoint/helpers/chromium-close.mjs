// chromium-close.mjs <devtools-port> <timeout-ms> — close the browser on the
// loopback DevTools port the orderly way and wait until it has exited.
//
// Browser.close is the exit closing the last window takes: chromium commits
// cookies and the session to the profile first. A SIGTERM also exits 0 but
// drops what is still in memory (a cookie set a second before `docker stop`
// was gone after the restart), so the supervisor runs this before it signals
// the services (supervisor_cleanup), whoever started the browser — the
// entrypoint or, with CHROMIUM_AUTOSTART=false, the CDP gateway.
//
// Exit status: 0 = closed (or nothing listening), 1 = still running at the
// deadline or no orderly close possible; the caller's signals take over.
import { readFileSync } from 'node:fs';

const [port, timeoutArg = '6000'] = process.argv.slice(2);
const deadline = Date.now() + Number(timeoutArg);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let version;
try {
  version = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })).json();
} catch {
  process.exit(0); // no browser running
}

const ws = new WebSocket(version.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 0;
const send = (method) => new Promise((resolve, reject) => {
  pending.set(++nextId, { resolve, reject });
  ws.send(JSON.stringify({ id: nextId, method }));
});
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) p.reject(new Error(msg.error.message));
  else p.resolve(msg.result);
};
await Promise.race([new Promise((resolve) => { ws.onopen = resolve; }), sleep(2000)]);
if (ws.readyState !== WebSocket.OPEN) process.exit(1);

// the browser process's pid (same pid namespace), to wait for its exit
let pid;
try {
  pid = (await send('SystemInfo.getProcessInfo')).processInfo.find((p) => p.type === 'browser')?.id;
} catch { /* waited for by the DevTools port below instead */ }

// gone = no such process, or a zombie its parent has not reaped yet
function exited(id) {
  try {
    return readFileSync(`/proc/${id}/stat`, 'utf8').replace(/^.*\) /s, '')[0] === 'Z';
  } catch {
    return true;
  }
}

send('Browser.close').catch(() => { /* the connection dies with the browser */ });
while (Date.now() < deadline) {
  await sleep(100);
  const gone = pid
    ? exited(pid)
    : await fetch(`http://127.0.0.1:${port}/json/version`).then(() => false, () => true);
  if (gone) process.exit(0);
}
process.exit(1);
