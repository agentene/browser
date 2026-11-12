// cdp-gateway/gateway.mjs — CDP gateway that backs every isolated browser
// context with its own Chromium process running on a clone of the main
// browser profile, so every isolated client inherits the main browser's
// logins (cookies, localStorage, IndexedDB, service workers, ...) while
// staying isolated from the main browser and from each other.
//
// Started by docker-entrypoint.sh whenever the CDP endpoint is on; nginx
// proxies the whole public CDP port here (to its unix socket). The browsers
// have no DevTools port at all: the gateway, their parent, speaks CDP with
// each over its DevTools pipe (pipe.mjs), so nothing — not even a page in
// the browser, which could open a loopback port's origin — gets past it.
//
// How it works (clients need no changes — see README "CDP gateway"):
//   * every browser-level DevTools WebSocket gets a Mux that speaks to the
//     main chromium on a connection of its pipe of its own and forwards
//     everything as it came, so default-context clients behave exactly as
//     on chromium's own DevTools port;
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
// The gateway also owns the main browser: started with the gateway
// (CHROMIUM_AUTOSTART=true) or only by the first CDP client or the console's
// "Start" (false), and it may exit (window closed, "Stop", a crash) without
// taking the container down — the next client starts it again.
// CHROMIUM_IDLE_TIMEOUT closes it after that many idle minutes.
//
// Also serves /json/* (made from CDP, with URLs on the public host:port the
// client dialed) and a small dashboard under /console/: its state (a
// snapshot, then changes) comes only over the /console/ws WebSocket, its
// actions are POST/DELETE /console/api/<name>… and PATCH /console/api/settings; plus the sidebar script
// nginx injects into the Selkies page (panel.js; nginx proxies /cdp-console/
// on the web port to /console/ here).
//
// The modules, in src/:
//   server.mjs          startup, the HTTP server (unix socket), shutdown
//   http.mjs            HTTP dispatch -> routes-json.mjs (/json/*),
//                       routes-console.mjs (/console/*), respond.mjs
//   upgrade.mjs         WebSocket dispatch -> mux.mjs, relay.mjs, console-live.mjs
//   cdp-origin.mjs      who may use the CDP API from a web page (CDP_ALLOW_ORIGINS)
//   mux.mjs             per-connection CDP multiplexer (main <-> context routing)
//   relay.mjs           /devtools/page/<id> pass-through
//   pipe.mjs            a browser's DevTools pipe, and the client connections on it
//   launch.mjs          starting a chromium on its pipe
//   client-frame.mjs    what is checked in a client's command (parse, guard, re-serialize)
//   browser-exit.mjs    a client's Browser.close spares the shared browser (CDP_ALLOW_BROWSER_CLOSE)
//   file-access.mjs     local files a client names stay in CDP_FILE_DIRS
//   flow.mjs            backpressure between the WebSockets mux/relay join
//   contexts.mjs        isolated contexts: a chromium each, and their registry
//   profile.mjs         profile cloning and the clone's Preferences
//   storage-sync.mjs    live cookies + localStorage from main into a context
//   main-browser.mjs    the main browser (at start, or on demand)
//   idle.mjs            CHROMIUM_IDLE_TIMEOUT
//   browsers.mjs        main + contexts by name (pipe, pid, target owner)
//   screen.mjs          the desktop back to SCREEN_GEOMETRY before a context window opens unwatched
//   desktop.mjs         the browser windows (the one in front, their titles), bringing one to the front
//   settings.mjs        the console's persisted settings (/browser/settings)
//   console-live.mjs    the console's live state over /console/ws
//   screencast.mjs      console thumbnails
//   console-auth.mjs    who may use the console
//   changes.mjs         change notifications for the console
//   cdp-client.mjs      minimal CDP client for the gateway's own commands
//   targets.mjs         a browser's targets: /json/* entries, the console's tabs
//   config.mjs          environment and constants
//   util.mjs            log and small helpers

import { startGateway } from './src/server.mjs';

await startGateway();
