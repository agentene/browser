// cdp-gateway/gateway.mjs — CDP gateway that backs every isolated browser
// context with its own Chromium process running on a clone of the main
// browser profile, so every isolated client inherits the main browser's
// logins (cookies, localStorage, IndexedDB, service workers, ...) while
// staying isolated from the main browser and from each other.
//
// Started by docker-entrypoint.sh whenever the CDP endpoint is on; nginx
// proxies the whole public CDP port here, never to chromium directly.
//
// How it works (clients need no changes — see README "CDP gateway"):
//   * every browser-level DevTools WebSocket gets a Mux that speaks to the
//     main chromium and forwards everything verbatim, so default-context
//     clients behave exactly as without the gateway;
//   * the FIRST Target.createBrowserContext on a connection (what an isolated
//     Playwright / playwright-cli session sends) is answered by the gateway:
//     it clones the main profile, launches a chromium on it and hands
//     the client an alias browserContextId that stands for that chromium's
//     default (persistent, cloned) context;
//   * from then on commands are routed per sessionId / targetId /
//     browserContextId to the main or the context's chromium, and its events
//     get their browserContextId rewritten to the alias;
//   * Target.disposeBrowserContext(alias) or the client disconnecting
//     destroys the context: process killed, cloned profile deleted.
//
// With CHROMIUM_AUTOSTART=false the gateway also owns the main browser:
// nothing runs until the first CDP client or the console's "Start", and the
// browser may exit (window closed, "Stop") without taking the container
// down. CHROMIUM_IDLE_TIMEOUT closes it again after that many idle minutes.
//
// Also serves /json/* (with URLs rewritten to the public host:port the
// client dialed) and a small dashboard under /console/: its state (a
// snapshot, then changes) comes only over the /console/ws WebSocket, its
// actions are POST/DELETE /console/api/<name>…; plus the sidebar script
// nginx injects into the Selkies page (panel.js; nginx proxies /cdp-console/
// on the web port to /console/ here).
//
// The modules, in src/:
//   server.mjs          startup, the HTTP server, shutdown
//   http.mjs            HTTP dispatch -> routes-json.mjs (/json/*),
//                       routes-console.mjs (/console/*), respond.mjs
//   upgrade.mjs         WebSocket dispatch -> mux.mjs, relay.mjs, console-live.mjs
//   mux.mjs             per-connection CDP multiplexer (main <-> context routing)
//   relay.mjs           /devtools/page/<id> pass-through
//   contexts.mjs        isolated contexts: a chromium each, and their registry
//   profile.mjs         profile cloning and the clone's Preferences
//   storage-sync.mjs    live cookies + localStorage from main into a context
//   main-browser.mjs    the main browser (supervised, or on demand)
//   idle.mjs            CHROMIUM_IDLE_TIMEOUT
//   browsers.mjs        main + contexts by name (port, pid, target owner)
//   desktop.mjs         window in front, bringing a window to the front
//   console-live.mjs    the console's live state over /console/ws
//   screencast.mjs      console thumbnails
//   console-auth.mjs    who may use the console
//   changes.mjs         change notifications for the console
//   cdp-client.mjs      minimal CDP client for the gateway's own commands
//   devtools-http.mjs   chromium's /json/* endpoints on loopback
//   config.mjs          environment and constants
//   util.mjs            log and small helpers

import { startGateway } from './src/server.mjs';

await startGateway();
