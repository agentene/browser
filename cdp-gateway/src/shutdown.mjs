// One orderly shutdown shared by signals and the console's restart action.
// Exiting this supervised service makes PID 1 exit; Docker's restart policy
// then starts the whole container, including the desktop and nginx.
import { log } from './util.mjs';
import { closeServers } from './listeners.mjs';

export function createShutdown({ servers, sockets, contexts, mainBrowser, exit = (code) => process.exit(code) }) {
  let pending;
  return (reason) => {
    pending ??= (async () => {
      contexts.close();
      const stopping = contexts.values().map((context) => context.destroy('gateway shutdown'));
      stopping.push(mainBrowser.close());
      log(`${reason}: closing the gateway and ${contexts.size} context(s)`);
      stopping.push(closeServers(servers, sockets));
      const results = await Promise.allSettled(stopping);
      for (const result of results) {
        if (result.status === 'rejected') log(`shutdown: ${result.reason?.message || result.reason}`);
      }
      exit(results.some((result) => result.status === 'rejected') ? 1 : 0);
    })();
    return pending;
  };
}
