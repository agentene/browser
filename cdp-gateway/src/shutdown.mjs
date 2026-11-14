// One orderly shutdown shared by signals and the console's restart action.
// Exiting this supervised service makes PID 1 exit; Docker's restart policy
// then starts the whole container, including the desktop and nginx.
import { log } from './util.mjs';

export function createShutdown({ server, sockets, contexts, mainBrowser, exit = (code) => process.exit(code) }) {
  let pending;
  return (reason) => {
    pending ??= (async () => {
      contexts.close();
      const stopping = contexts.values().map((context) => context.destroy('gateway shutdown'));
      stopping.push(mainBrowser.close());
      log(`${reason}: closing the gateway and ${contexts.size} context(s)`);
      server.close();
      // server.close() alone leaves upgraded WebSockets alive. End them so
      // existing clients cannot start work while the browsers are closing.
      for (const socket of sockets) socket.destroy();
      const results = await Promise.allSettled(stopping);
      for (const result of results) {
        if (result.status === 'rejected') log(`shutdown: ${result.reason?.message || result.reason}`);
      }
      exit(results.some((result) => result.status === 'rejected') ? 1 : 0);
    })();
    return pending;
  };
}
