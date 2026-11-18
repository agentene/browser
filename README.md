# agentene-browser

**A single Docker container that bundles Chrome for Testing with a live-viewable remote desktop and a public CDP endpoint.**

[![ci](https://github.com/agentene/browser/actions/workflows/ci.yaml/badge.svg)](https://github.com/agentene/browser/actions/workflows/ci.yaml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![docker image size](https://img.shields.io/docker/image-size/agentene/browser)](https://hub.docker.com/r/agentene/browser)
[![docker pulls](https://img.shields.io/docker/pulls/agentene/browser)](https://hub.docker.com/r/agentene/browser)

[English](README.md) | [简体中文](README.zh-CN.md)

The container starts everything it needs in one place and supervises it as PID 1:

```
docker run ─┬─ labwc       virtual Wayland desktop (Xvfb with DISPLAY_BACKEND=x11)
            ├─ PulseAudio  virtual audio
            ├─ Selkies ─── selkies.sock ─────────┐
            ├─ gateway ─┬─ console.sock ─────────┤
            │           ├─ cdp-gateway.sock ─────┼─ nginx: HTTP / HTTPS / CDP
            │           └─ Chrome (CDP pipes)   │
            └─ auth ────── auth.sock ────────────┘
```

* **Chromium with a public CDP endpoint** — connect [Playwright](https://playwright.dev) / Puppeteer / Selenium from *outside* the container via `connectOverCDP("http://localhost:9222")`.
* **Live-viewable desktop** — the browser runs **headed** on a headless Wayland desktop ([labwc](https://labwc.github.io/)) by default (Xvfb/X11 with `DISPLAY_BACKEND=x11`), and [Selkies](https://github.com/selkies-project/selkies) 2.x streams it to any browser over WebSockets/WebCodecs (WebRTC opt-in, audio included). Watch and interact with your automation as it runs.
* **Persistent profile** — cookies, logins and extensions survive container recreation via a bind mount.
* **HTTPS support** — self-signed by default, or bring your own certificate; existing valid pairs are always reused.
* **Sane defaults** — UTC timezone, `en-US` browser locale; timezone is a deployment setting; browser language is managed in web Settings.

## Table of contents

- [What's inside](#whats-inside)
- [Quick start](#quick-start)
  - [Docker Compose](#docker-compose)
  - [Plain docker run](#plain-docker-run)
- [Ports](#ports)
- [Connecting Playwright over CDP](#connecting-playwright-over-cdp)
- [CDP gateway (isolated contexts with your logins)](#cdp-gateway-isolated-contexts-with-your-logins)
- [Watching the desktop](#watching-the-desktop)
- [Login and CDP API key](#login-and-cdp-api-key)
- [Configuration](#configuration)
  - [Build arguments](#build-arguments)
  - [Environment variables](#environment-variables)
  - [Privilege drop (`RUN_USER`)](#privilege-drop-run_user)
  - [Timezone and language](#timezone-and-language)
- [HTTPS](#https)
- [GPU passthrough (optional)](#gpu-passthrough-optional)
  - [Wayland desktop (`DISPLAY_BACKEND=wayland`)](#wayland-desktop-display_backendwayland)
- [Persistence](#persistence)
- [Service toggles, health and restarts](#service-toggles-health-and-restarts)
- [Building from source](#building-from-source)
- [Keeping versions in sync](#keeping-versions-in-sync)
- [CI/CD and published images](#cicd-and-published-images)
- [Security considerations](#security-considerations)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

## What's inside

| Component           | Version                      | Role                                                                    |
| ------------------- | ---------------------------- | ----------------------------------------------------------------------- |
| Ubuntu              | 26.04                        | base image                                                              |
| Node.js             | [pinned LTS](Dockerfile)     | runs the CDP gateway (newest LTS line)                                  |
| Chrome for Testing  | [pinned stable](Dockerfile)  | the automated browser, Google's official build of the Stable channel   |
| Selkies             | [pinned release](Dockerfile) | HTML5 remote desktop (web client, signaling, streaming)                 |
| nginx               | Ubuntu package               | front door: web UI (HTTP/HTTPS) + CDP endpoint, WebSocket-capable       |
| labwc               | Ubuntu package               | headless Wayland desktop, the default (`DISPLAY_BACKEND=wayland`)       |
| Xvfb / PulseAudio   | Ubuntu packages              | X11 display (`DISPLAY_BACKEND=x11`) + audio for the stream              |

nginx is the single public front door and every proxy speaks WebSocket (required by both CDP and Selkies signaling). Nothing behind it listens on a TCP port, not even on loopback: Selkies, the console, CDP and the auth service sit on unix sockets in `/tmp/agentene` (`selkies.sock`, `console.sock`, `cdp-gateway.sock`, `auth.sock`), and the browsers speak CDP with the gateway over a pipe (`--remote-debugging-pipe`) — they have no DevTools port at all. A loopback port would be reachable from inside the browser: a page opened at its address could talk to what listens there past nginx's login and the gateway's checks.

## Quick start

### Docker Compose

```bash
git clone https://github.com/agentene/browser.git
cd browser

cp .env.example .env        # optional — defaults work out of the box
docker compose up -d --build
```

Then:

* **Desktop stream**: <http://localhost:8080/browser/> — the Chromium window, live.
* **Console**: <http://localhost:8080/console/> — browser management and settings, available with desktop streaming disabled too.
* **CDP endpoint**: <http://localhost:9222/json/version> — for Playwright et al.

Useful commands:

```bash
docker compose logs -f            # follow logs
docker compose exec browser bash  # shell in the container
docker compose down               # stop and remove the container (and compose's network)
```

### Plain docker run

```bash
docker build -t agentene/browser .

docker run -d --name agentene-browser \
  --restart always \
  -e LISTEN_ADDR=0.0.0.0 \
  -p 127.0.0.1:8080:80 \
  -p 127.0.0.1:9222:9222 \
  -v "$PWD/browser:/browser" \
  agentene/browser
```

Any argument other than the implicit `start` is exec'd instead of the supervisor, e.g. `docker run -it agentene/browser bash` drops to a shell.

## Ports

With Compose, configure just three access ports in `.env`; the same settings work in bridge and host modes:

| Service | Variable | Default access port |
| --- | --- | --- |
| Web UI (HTTP) | `HTTP_PORT` | `8080` |
| Web UI (HTTPS, opt-in) | `HTTPS_PORT` | `8443` |
| Chromium CDP | `CDP_PORT` | `9222` |

* **Bridge (default):** Docker publishes these ports on the host's `LISTEN_ADDR` and maps them to the container's HTTP / HTTPS / CDP ports (`80` / `443` / `9222`). The container listens on `0.0.0.0` to receive forwarded traffic; peers on the same Docker network still use the container ports.
* **[Host network](#host-network-compose):** nginx listens on the chosen access ports directly on the host's `LISTEN_ADDR`; there is no port mapping. Switching modes keeps the access URLs the same.

`LISTEN_ADDR` defaults to `127.0.0.1`, including an explicitly empty value, so both modes are host-local by default. For access from other machines, explicitly set `LISTEN_ADDR=0.0.0.0` or the desired host address (use bare IPv6, e.g. `::1`). Existing deployments that relied on remote access by default must choose an address when upgrading.

For example, `HTTP_PORT=18080` makes the console available at `http://localhost:18080/console/` in either mode. HTTPS is off by default: use `compose.https.yaml` to enable and publish it in bridge mode, or `ENABLE_HTTPS=true` in host mode (see [HTTPS](#https)).

These three port variables are Compose settings. With plain `docker run` in bridge mode, use `-e LISTEN_ADDR=0.0.0.0` so the container accepts forwarded traffic, and choose the host address and port through `-p`, e.g. `-p 127.0.0.1:18080:80`. Existing listener overrides remain supported for advanced deployments; see [Environment variables](#environment-variables).

`PORT_FORWARDS` can add extra listeners that proxy to sibling containers — see [Docker network (compose)](#docker-network-compose).

## Connecting Playwright over CDP

The image exposes Chromium's DevTools protocol through nginx, so any CDP client on your host (or anywhere reachable) can drive the browser. You do **not** need Playwright browsers installed locally.

```bash
npm init -y && npm i playwright
node examples/connect-playwright.mjs https://example.com
```

<details>
<summary>examples/connect-playwright.mjs (essence)</summary>

```js
import { chromium } from "playwright";

const browser = await chromium.connectOverCDP("http://localhost:9222");
const context = browser.contexts()[0];            // reuse default context
const page = context.pages()[0] ?? await context.newPage();

await page.goto("https://example.com");
console.log(await page.title());
await browser.close();  // closes the CDP session, not the browser
```

</details>

Notes:

* The default context uses the **persisted profile**, so logins and cookies carry over between runs.
* `curl http://localhost:9222/json/version` is the quickest health check.
* Puppeteer works the same way: `puppeteer.connect({ browserURL: "http://localhost:9222" })`. Its `browser.close()` sends CDP `Browser.close`, which would close the browser every client shares (and, as the container supervises it, the container); the gateway answers it instead and closes only that client's connection, as `browser.disconnect()` would. `CDP_ALLOW_BROWSER_CLOSE=true` passes it through.
* Once a [CDP API key](#login-and-cdp-api-key) is set, pass it as a header: `chromium.connectOverCDP(url, { headers: { Authorization: "Bearer <key>" } })` (Puppeteer: `connect({ browserURL, headers })`; `examples/connect-playwright.mjs` reads `CDP_API_KEY`). Without one the endpoint stays open, as before.
* Web pages cannot use the CDP API: the gateway refuses (403) every CDP request that carries an `Origin` header — the WebSocket handshake or `fetch` of a page in some browser, checked like Chromium's `--remote-allow-origins` — and every request whose `Sec-Fetch-Site` is anything but `none`: a page's request is cross-site, same-site, or — after DNS rebinding, a site pointing its own name at the container — same-origin, and that last one carries no `Origin` at all. So no site that you (or the container's own browser) has open can take over the browser, with or without an API key. CDP clients such as Playwright and Puppeteer send neither an `Origin` nor `Sec-Fetch-*` headers and are unaffected, and so is opening `/json/version` in the address bar (`Sec-Fetch-Site: none`). To let a page in (e.g. a DevTools frontend: `devtools://devtools`), list its origin in `CDP_ALLOW_ORIGINS`. A few non-browser clients send an `Origin` anyway — Python's `websocket-client` does unless given `suppress_origin=True` — and get 403, just as from Chromium itself since version 111; the gateway log names the origin.
* `/json/new` takes `PUT` only, as in Chromium itself (`GET` gets 405), so a mere link or image cannot open tabs.
* **Local files stay in `CDP_FILE_DIRS`** (default `/browser/downloads`, `./browser/downloads` on the host). A CDP command that makes the browser read a file by its path (a file input's `DOM.setFileInputFiles`, a drop, a PWA launch, an unpacked extension) is refused unless the file lies inside one of them; uploads Playwright sends as buffers (`setInputFiles({ name, mimeType, buffer })`) are not affected, and neither are paths on the client's machine, which never existed in the container. A download directory a client names elsewhere (Playwright's `connectOverCDP` names a temp directory of the client machine) is redirected into the first of them, which is also where the browsers' own downloads go.
* **`Target.exposeDevToolsProtocol` is refused** (whatever `CDP_FILE_DIRS` / `CDP_ALLOW_BROWSER_CLOSE` say): it gives a page's script a CDP channel of its own to the browser, which none of the checks above would ever see. For the same reason the browsers have no DevTools port (a page opened at its address could use it) and the gateway drives them over a pipe; `/json/*` is made by the gateway from CDP (`/json/protocol` is captured from the browser binary at image build). A DevTools window opened in the browser has such a channel as well — `CHROMIUM_ALLOW_DEVTOOLS=false` blocks them.

## CDP gateway (isolated contexts with your logins)

An *isolated* CDP client — `browser.newContext()` in Playwright, or a [playwright-cli](https://github.com/microsoft/playwright-cli) session with `"isolated": true` — normally gets a blank in-memory context: none of the logins in the persisted profile. Here a gateway that always sits in front of the CDP port backs every such context with **its own browser** instead: a separate Chromium running on a clone of the main profile. Each isolated context starts out logged in wherever the main browser is, yet nothing it does reaches the main browser or any other isolated context.

Clients need **no changes**: they keep connecting to `http://localhost:9222`. For example, this playwright-cli config gives every `-s=<session>` its own logged-in isolated context:

```json
{ "browser": { "browserName": "chromium", "isolated": true, "cdpEndpoint": "http://localhost:9222" } }
```

> [!TIP]
> Playwright gives every new context a default 1280×720 viewport, and the page then reports a 1280×720 *screen* as well, unlike the main browser's real one. Sites with risk control (shopping, banking) may take that for a different device and flag the login. Add `"contextOptions": { "viewport": null }` to the `browser` block so an isolated context uses its real window size, as the default context does.

How it works:

* nginx forwards the CDP port to a small gateway (`/usr/local/lib/cdp-gateway/gateway.mjs`).
* Clients that use the default context (`browser.contexts()[0]`) pass straight through to the main browser, unchanged.
* When a client creates a new context, the gateway answers `Target.createBrowserContext` itself:
  * it copies the profile, minus caches and the open tabs — an isolated context starts with no pages, like any new context. The copy is a reflink (instant, copy-on-write) since the profile (`/browser/user-data`) and the clones (`/browser/contexts`) share the `/browser` mount, on an XFS or btrfs host; otherwise it is a full copy. The gateway log (`/tmp/cdp-gateway.log`) says which one at startup;
  * starts a Chromium on the copy;
  * copies the live cookies (HttpOnly and session cookies included) and the live localStorage of the origins open in the main browser on top, since Chromium writes both to disk only lazily;
  * routes that context's traffic to the new browser.
  * This takes about 0.2–0.3 s.
* The context's browser lives as long as the context. Closing the context or disconnecting the client (`playwright-cli -s=… close`) destroys it: the process is stopped and its clone deleted. The next session gets a fresh clone, so it always has the main browser's current logins.
* Every isolated context inherits everything in the profile (cookies, localStorage, IndexedDB, service workers, extensions…) at the moment it starts. Later changes in the main browser do not flow into a running isolated context, and changes in one never flow back.

The CDP console lives at **`http://localhost:8080/console/`**, on the web HTTP/HTTPS listeners and protected by the built-in login. The gateway serves it on `console.sock`, sharing browser state with its separate CDP listener. `CONSOLE_SUBPATH` controls its public prefix; console URLs in this guide use the default `/console`. It shows the main browser and every isolated context as a card: on the left a live thumbnail of the tab in front with its title on a banner across the bottom, on the right a scrollable list of all its open tabs with the one in front highlighted. Clicking a tab in the list (or the thumbnail) switches the browser to it and raises its window. The card of the browser whose window is in front on the desktop — what the Selkies stream shows — glows softly and has *Showing* in place of its *Show* button. The cards update live: the page holds a WebSocket (`/console/ws`) over which the gateway pushes only what changed — tabs opened, closed or renamed, another tab in front, a new thumbnail (only while a console is open; at most every 2 seconds for the browser in front on the desktop, every 20 seconds for the others). Each card also offers two actions:

* *Show* raises that browser window in the Selkies stream.
* *Delete* force-closes an isolated context and disconnects its client.

The header’s **+** icon button (*New browser*) opens an independent browser on a clone of the main profile, with a blank tab. It shares the **Maximum running isolated browsers** limit with CDP-created contexts and stays alive when the console disconnects; delete its card to stop it and remove its clone. Hovering or focusing a tab reveals its **×** button inside the right edge without changing the row width (always visible on touch devices); otherwise the title uses the full row width. The button closes only that tab (including tabs used by automation). Closing the last tab can close its browser. Both actions are available in the sidebar too; `CDP_CONSOLE_ACTIONS=false` hides them and disables their API routes.

Each isolated context gets its own browser frame color, matching its console card, so windows on the desktop are easy to tell apart. The console pages get their state only over the `/console/ws` WebSocket: a full snapshot on connect, then changes; their actions are plain HTTP calls under `/console/api/`, and every write (`POST`/`PATCH`/`DELETE`) needs an `X-CDP-Console: 1` header, which no cross-site form can send. The console (and the sidebar below) speaks English and Simplified Chinese: it follows the browser's language, and the settings page (the gear in its header) switches it (remembered per browser).

Click the header’s gear to replace the browser cards with a settings page, keeping the header in place. Its fields scroll above a fixed footer: **Restart** on the left, **Save and apply** and **Cancel** on the right. Language, *New windows to the front* and *AI input display* stay unchanged until **Save and apply**, which applies them without restarting. **Cancel**, the gear again, or Escape returns to the cards and discards those pending edits; closing the sidebar also discards them. The *Access* controls keep their own dialogs and save independently: cancelling the settings page does not undo an account or API key change already saved there.

**Restart** immediately restarts the entire container, without a confirmation dialog or saving pending edits. It disconnects CDP clients and removes isolated contexts; the main browser closes normally to flush its profile. The page waits for the gateway to return, then reloads. This uses Docker’s restart policy: Compose already sets `restart: always`; with `docker run`, set `--restart always` (without a restart policy the container stops and stays stopped). `CDP_CONSOLE_RESTART=false` hides the button and disables the restart API. `GET /console/api/restart` reports `{ "enabled": true|false }`; `POST` accepts a restart with HTTP 202 and `{ "ok": true }`, using the same web login and `X-CDP-Console: 1` header as other console writes.

A browser window that opens on the desktop — e.g. the window of a new isolated context — comes to the front by default, as window managers do. Turn off *New windows to the front* in the same settings page and new windows open behind the one in front instead, so an automation run does not take over the window you are watching; *Show* still brings any window forward. It applies to the windows opened from then on, and is saved on the server: the console's settings live in `/browser/settings/settings.json` (a JSON object by section, e.g. `{"desktop": {"raiseNewWindows": false}}`) on the `/browser` mount, so they survive container restarts and re-creation; they have no environment variables, and the console's `GET` / `PATCH /console/api/settings` read and change them. The language is per viewer and stays in the browser. The switch is available when the desktop service is enabled. On Wayland labwc lowers the new window as it maps, before its first frame; on X11 the screen follower stands in for the missing window manager (Chromium asks it to activate a window instead of raising its own), so nothing gets switched back after the fact.

The same console also sits **next to the live desktop**: move the pointer to the right edge of the Selkies page and click the handle that appears (on touch screens it always shows). Drag the sidebar's left edge to resize it, up to half the page or 1000px, whichever is less (remembered per browser); its cards follow the width, side by side once there is room. The sidebar has the cards and actions of `/console/`; *Show* raises the window right in the stream you are watching. nginx injects the sidebar script (`cdp-gateway/panel.js`) into the Selkies page and uses the same `/console/api/` and `/console/ws` endpoints as the standalone console, independently of `BROWSER_SUBPATH`. Both follow the built-in login; the WebSocket also only accepts pages of the same origin. The sidebar is available whenever Selkies is on; without CDP it offers settings only.

**Seeing what an AI agent does.** CDP input (`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Input.insertText`, …) goes straight into the page: the stream shows the page react — hover styles, clicks, typed text — but no pointer moves and no key shows, and native popups follow the desktop's own pointer (a tooltip opens where it rests, not where the agent points). So the Selkies page also draws the CDP clients' input over the stream (**AI input detail**, on by default): a colored pointer per CDP connection (`AI #1`, `AI #2`, …) where it points, a ring for each click (dashed for a right click, `×2` for a double click), an arrow for the wheel, and a line at the bottom left with the key combos it presses (`Ctrl+A`, `Enter`) and the text it types. The gateway sees every client command on its way to the browsers, so this needs no change to the clients or the pages — nothing is injected into them; it maps the viewport's CSS pixels onto the desktop from the window's bounds and the page zoom, and holds each mark back about the stream's latency so it moves with the picture.
* Text typed into a password, one-time-code or card field (or anywhere inside a frame, where the focused field cannot be told) shows as `••••` with a count. **AI input detail** = `keys` shows only a count for all text; `off` turns the overlay off (the script remains available for live re-enabling, but the gateway watches and sends no input).
* Pointer input the stream does not show — into a background tab, a window behind the one in front — draws no pointer; a badge says where the agent is working instead, and its keys and text name that tab on their card — its title, the browser (`main`, `context-1`, …) when that window is not the one in front, the site when two tabs share the title: `AI #2 (context-1 › Pull requests)`.
* The CDP console (the sidebar and `/console/`) marks the tabs the agents work in with the same numbered, colored `AI #2` tag — on the tab in its list and on the browser's card, where a click brings that tab up — for a minute after the agent's last input.
* It reaches the sidebar's users only (the built-in login; the overlay's WebSocket is `/console/overlay`, same origin), and **AI input display** controls it for all viewers. The old per-browser visibility preference is no longer used. With nobody watching it costs nothing; while someone does, the gateway asks each page it draws for at most once a second where it sits.
* Limits: a client that emulates a viewport (`Emulation.setDeviceMetricsOverride`, e.g. Playwright's `viewport` option on a page of its own) gets a dashed pointer, its position approximate; a click done by script (`element.click()` through `Runtime.evaluate`) is no input and shows nothing.

**The main browser belongs to the gateway.** The gateway — not the browser — is the long-running service the container supervises: it launches the main browser as its own child, so closing the browser (its window, **Stop** on its card, a client's `Browser.close` with `CDP_ALLOW_BROWSER_CLOSE=true`) or a browser crash leaves the container running; its CDP clients without an isolated context get disconnected. The container starts without a main browser, so an idle container runs no Chromium at all. A stopped main browser starts on demand:

* when a CDP client uses the default context (`/json/new`, `browser.contexts()[0].newPage()`, any command for the main browser's pages). Connecting alone does not start it: while it is stopped the gateway answers the client's handshake (`/json/version`, `Browser.getVersion`, `Target.setAutoAttach`, …) itself and replays that setup once the browser is up, so clients need no changes — the first command that needs it just waits the second or two it takes to start. A client that works in isolated contexts only (`browser.newContext()`, playwright-cli) never runs it. One thing to know: a client connecting while it is stopped sees no pages until it opens one (`(await browser.pages())[0]` is empty — use `pages()[0] ?? newPage()`);
* with **Start browser** on the main browser's card in `/console/` or the Selkies sidebar.

**Stop** closes it the way closing its window does, so cookies and the session are saved to the profile first. Listings (`/json/list`) and the console do not start it, so health checks leave a stopped browser stopped.

**Isolated contexts do not hang off the main browser.** Each is a browser process of its own, the gateway's child like the main one, so the main browser closing (its window, **Stop**, a crash) leaves them — and their clients' connections — running: such a client is told its main-browser pages are gone (`Target.detachedFromTarget` / `Target.targetDestroyed`, as when they close), its commands in flight there fail, and its isolated context goes on. If it uses the default context again later, the main browser is started again for it. A client without an isolated context is disconnected, as before.

The main browser stays running when idle. Use **Stop**, close its last window, or send a permitted CDP browser-close command to stop it. The desktop stack (Xvfb or labwc, PulseAudio, Selkies) keeps running; without a viewer it costs little. With no browser window open the stream shows the desktop background: the picture that ships with the image (`entrypoint/assets/desktop-background.png`), centered at its own size on a neutral gray — drawn by `swaybg` on Wayland and by a native Cairo/Xlib helper on X11; it is fixed, not a setting.

The background's pixel storage is bounded by the picture dimensions, including at 4K and fractional output scales. Wayland uses a single color pixel stretched over the output plus an image-sized subsurface; the pinned `swaybg` build applies [`patches/swaybg-center-surfaces.patch`](patches/swaybg-center-surfaces.patch) and retains the checked [`memfd` allocations](patches/swaybg-memfd.patch). X11 uses a tiled 1×1 root pixmap and an image-sized window that passes input through and stays below the browsers; its native helper needs no resident Python PNG decoder. Resizing repositions or crops the picture without allocating a full-screen background bitmap. Docker's default 64 MiB `/dev/shm` is sufficient for the background; the desktop, browser and encoder still need their own memory.

**Hibernation at capacity.** **Capacity overflow policy** = `hibernate` (default) allows more isolated browsers than **Maximum running isolated browsers** to exist. Before creating or waking another browser, the gateway first selects an eligible browser with no open tabs; if several are empty, it selects the least recently used one. If no eligible browser is empty, it selects the least recently used eligible browser regardless of tab count. It gracefully closes that browser, retaining its profile and saved tabs. Starting, waking and still-exiting browsers occupy a running slot; the main browser is excluded. Set **Capacity overflow policy** = `reject` to restore the previous capacity error.

* The console and sidebar show running and hibernated counts, saved tabs, **Hibernate** and **Wake**. Clicking a sleeping card or tab also wakes it. Console refreshes and thumbnails do not keep a browser active; LRU follows client CDP commands and explicit console actions.
* The CDP connection, context alias and top-level Playwright `Page` objects stay alive. A command that needs the browser wakes it; `context.pages()` is a local list and does not. With existing tabs, unmodified playwright-cli `tab-list` wakes without adding a blank tab, while `tab-new` (with or without a URL) creates exactly one additional tab. Closing the last tab with `tab-close` keeps the browser running with zero tabs, including immediately after waking; `tab-new` reuses that browser. No new `open` is needed. An originally empty context keeps the CLI's usual default-page behavior.
* The document reloads: JavaScript memory, old JSHandle/ElementHandle objects, child-frame and worker identities do not survive. Commands already in flight may fail; navigation-dependent reads may be interrupted by the reload. Late replies to intercepted requests return a protocol error without waking the browser; interception for new requests during restoration still works. The gateway rebuilds recognized Playwright helpers and declarative settings, never arbitrary business evaluations or input actions. Compatibility tests cover CLI 0.1.23 and 0.1.24; an unrecognized helper prevents hibernation until gateway compatibility is updated.
* Chrome's session restoration is preferred. A temporary, random sessionStorage key verifies tab identity (duplicate URLs remain distinct); the key is removed after native restoration. Deferred tabs load in the background for identity checks without being activated, preserving Chrome's selected tab in each window; slow startup gets a 15-second identity-check budget. This is a polling budget, not a limit on the entire wake operation. If identity cannot be verified, a tab cannot store the marker, or request interception / business init scripts / custom headers or user-agent must be installed before navigation, all tabs are restored from their URL snapshots instead. This fallback preserves the profile but does not promise tab history or sessionStorage. Failure is shown on the card, and a failed native restore is also logged in `/tmp/cdp-gateway.log`; a failed wake keeps the saved profile for retry.
* Browsers containing additional incognito contexts, direct page-WebSocket clients, non-flat CDP sessions, active debugging/recording, or unsupported helper state cannot hibernate. If no eligible browser remains, creation or wake returns a capacity error. Stop those sessions, close another browser, or increase the limit.
* **Maximum retained hibernated browsers** = `16` bounds the number of sleeping profiles, **not disk bytes**. Above it, the oldest sleeper is permanently deleted and its owning CDP connection disconnected; console-created browsers are included. `0` retains none. A client disconnect or `context.close()` still deletes its profile immediately. Console-created browsers otherwise live until deleted. All isolated profiles, including sleepers, are discarded on container restart.

Limits:

* Each running isolated browser typically uses a few hundred MB of RAM. Hibernation trades restart latency and page memory for fewer running processes.
* CDP carries no session names, so an isolated context is tied to one connection. Reopening a playwright-cli session with the same name gets a new one, not the old one.
* Only the *first* isolated context of a connection gets its own profile-cloned browser. Further `browser.newContext()` calls on the same connection — also ones made at the same time, e.g. in a `Promise.all` — create plain incognito contexts inside that browser, without the logins; open a new connection for another logged-in context.
* The profile is copied while the main browser runs. Cookies and the localStorage of open origins are re-synced live (see above), but other databases (IndexedDB, the history, …) are copied as they are on disk at that moment, so a write the main browser makes during the copy may be missing or, rarely, half there in the clone.
* A per-context `proxy` (`browser.newContext({ proxy })`, CDP's `proxyServer` / `proxyBypassList`) becomes the isolated context's own: its browser starts with `--proxy-server` / `--proxy-bypass-list` (after `CHROMIUM_EXTRA_ARGS`, so it wins over a proxy set there), and a proxy login works as usual. A malformed one fails the context. Other options of a fresh context do not apply: an isolated context runs with the main browser's settings.

## Watching the desktop

Open <http://localhost:8080/browser/>. Selkies streams the virtual display (with audio) straight into the browser tab — keyboard and mouse input go to the container. Chromium always runs with desktop windows, so automation can be watched in the stream. Click **Start browser** in the sidebar to begin manual browsing. Set **Browser language** in the web settings; manage startup pages in Chrome’s own **Settings → On startup**.

The first visit asks you to set up the administrator login (or to skip it) — see [Login and CDP API key](#login-and-cdp-api-key).

### Serving under a subpath

Set the desktop and console prefixes independently in `.env` or the shell. The image supplies defaults when they are unset; Compose passes through configured values, including empty ones. Leading and trailing slashes are optional, and nested paths are supported:

```bash
BROWSER_SUBPATH=/tools/browser
CONSOLE_SUBPATH=/tools/console
```

The desktop's page, assets, API and WebSockets live under `/tools/browser/`. The console and sidebar use `/tools/console/`, including `/tools/console/__auth/` for their shared login, account controls and session renewal. nginx redirects either slash-less entry URL to its directory form.

`CONSOLE_SUBPATH` defaults to `/console`; an explicitly empty value or `/` puts it at the site root. `BROWSER_SUBPATH` defaults to `/browser`; an explicitly empty value or `/` puts the desktop at the site root. With Selkies enabled, the two prefixes must differ. One may be nested inside the other, provided it does not shadow the containing application's API or resources. If one application is at the root, it supplies `/`; otherwise `/` opens the desktop when enabled, or the console when streaming is disabled.

An outer reverse proxy must forward both namespaces **unchanged**, including the console's `__auth/` routes, and preserve WebSocket headers. The example above can share one proxy location:

```nginx
location /tools/ {
    proxy_pass http://docker-host:8080;   # no URI part -> path kept as-is
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 86400s;
}
```

## Login and CDP API key

With `ENABLE_AUTH=true` (the default) a small built-in auth service sits behind nginx. The standalone console and desktop sidebar share its login page and `auth-server/client.js` for account controls, language updates and session renewal. Its public routes are `<console prefix>/__auth/`:

* **First start.** Until it is set up, the web UI and the CDP console (`/console/` on the web port) show a setup form instead: enter the **setup code**, then create the administrator user name + password (8+ characters), or choose **Continue without a login** — that choice is saved too, and the web UI stays open as before. The setup code is printed in the container log on every start (`docker compose logs browser | grep 'setup code'`; a new one each start), so reaching the page first is not enough to claim the browser — whoever sets it up has to be able to read the log too. For scripted setups set `AUTH_SETUP_CODE` and send it along: `POST <web origin>/console/__auth/api/setup` with `{"code": "…", "skip": true}` or `{"code": "…", "username": "…", "password": "…"}`.
* **Login.** With a login, every desktop and console request (pages, APIs, sidebar and WebSockets) on the web listeners needs a session: anything else gets the login form in place (HTTP 401). The session is an `HttpOnly`, `SameSite=Lax` cookie valid for 7 days and renewed automatically: every open web UI or console page — an idle background tab included — gets it a fresh cookie about once a day (a single timer, at most one tiny request per day), so it only expires 6–7 days after the last page was closed. Any number of browsers can be signed in at once; the desktop and console share the same web session. Cross-origin writes and WebSockets that carry it are refused (403). After 10 failed passwords from one address within 15 minutes that address gets 429 until the window ends.
* **CDP API key.** Optional. Once set, the CDP API (`/json/*`, `/devtools/*` on the CDP port) needs it in a header — `Authorization: Bearer <key>` or `X-API-Key: <key>` — and answers 401 without; empty = no key, the CDP endpoint is open (the default, so existing clients keep working). The session cookie does not open the CDP API. With the login skipped, the key is what shows that the browser is yours: changing or removing it, or setting up a login, then asks for the current key.
* **Changing them.** The console's settings page (the gear in `/console/` and in the sidebar on the Selkies page) has an *Access* group: **Login → Change…** (current password, new user name + password; leave the user name and both password fields empty to turn the login off — or set one up when it was skipped), **CDP API key → Change…** (current password, then type one or *Generate* a random one, *Copy*; empty removes it) and **Log out**. Changing the login signs every other session out. The controls remain available when CDP is disabled, and on the account page, `<web origin>/console/__auth/`.
* **Where it is kept.** `/browser/settings/auth.json` on the `/browser` mount (mode 0600): the password as a salted scrypt hash, the API key as a SHA-256 hash (it cannot be shown again — copy it when you set it), the session secret. It survives restarts and re-creation and has no environment variables. **Forgot the password?** Delete the file (`docker compose exec browser rm /browser/settings/auth.json`, or `./browser/settings/auth.json` on the host): the next visit shows the setup form again, no restart needed (it asks for the setup code of the container's last start, in its log). A file that exists but cannot be parsed locks the web UI and the CDP API until it is fixed or deleted.

`ENABLE_AUTH=false` turns all of it off: no setup form, no login, no API key — the web UI and the CDP endpoint are open as in earlier versions. `PORT_FORWARDS` listeners are not covered by the login.

The built-in login is the only gate: Selkies' own Basic Auth and master token stay disabled (since 0.1.7). `SELKIES_BASIC_AUTH_PASSWORD`, `SELKIES_ENABLE_BASIC_AUTH`, `SELKIES_MASTER_TOKEN` and `--enable-basic-auth` / `--master-token` in `SELKIES_EXTRA_ARGS` are ignored — a deployment that relied on the Selkies password now gets the setup form instead.

## Configuration

### Web settings and upgrade migration

Configure browser, capacity, desktop and AI input preferences in **Settings** in either the console or the sidebar. They persist on the mount at `/browser/settings/settings.json`. Editing controls changes a draft; **Save and apply** submits it, and **Cancel** discards it. Settings that require a restart are identified explicitly; use the existing **Restart container** button to apply them. Saving never automatically restarts the container.

| Removed environment variable | Web setting | Default | Application |
| --- | --- | --- | --- |
| `CHROMIUM_LANG` | Language (interface and browser) | Auto | Interface and new browser processes after saving; no container restart |
| `CDP_CONTEXTS_MAX` | Maximum running isolated browsers | `4` | Live; existing running browsers are not stopped on save |
| `CDP_CONTEXTS_OVERFLOW` | Capacity overflow policy | `hibernate` | Live; hibernate / reject |
| `CDP_CONTEXTS_HIBERNATED_MAX` | Maximum retained hibernated browsers | `16` | Live; confirm the removal list when lowering below current usage |
| `CDP_INPUT_OVERLAY` | AI input display (all viewers) | `text` | Live; off / keys / text |
| `SCREEN_GEOMETRY` | Initial resolution | `1920 × 1080` | Container restart; presets: 720p / 1080p / 1440p / 4K, depth fixed at 24 |

**Migrating existing environment settings:** the variables above no longer work in `.env`, Compose, or `docker run -e`. Startup logs identify them, but their old values are not imported; configure them in the web UI. Existing console settings and login state are retained; unset preferences use the defaults above. Deployment settings remain in the environment.

The autostart, startup-page, headless, rendering-policy, idle-close, audio-startup and resize controls have been removed from web settings too. Their old environment variables (`CHROMIUM_AUTOSTART`, `CHROMIUM_START_URL`, `CHROMIUM_HEADLESS`, `CHROMIUM_GPU`, `CHROMIUM_IDLE_TIMEOUT`, `SELKIES_AUDIO_ON_START`, `SELKIES_ENABLE_RESIZE`) are ignored. Main browsers start on demand, Chrome owns their startup pages, browsers always use the virtual desktop, and rendering automatically uses available hardware with software fallback. `--headless` in `CHROMIUM_EXTRA_ARGS` is rejected.

**Initial resolution** is a single dropdown used at container startup and before launching a browser with no viewers. While viewing, the shared desktop follows the viewing window; page layouts and screenshots can change with it. Automatic resizing is always enabled and locked, and manual-resolution overrides (including `SELKIES_MANUAL_*` and related extra arguments) no longer apply. Valid saved width/height pairs migrate to the new resolution setting; an existing custom size remains available as a saved choice. Removed settings are ignored and cleaned from the file on the next save.

With CDP disabled (`ENABLE_CDP=false`), the console and web sidebar offer language and desktop settings without starting Chromium or exposing CDP. With Selkies disabled, the HTTP/HTTPS console, login and virtual desktop remain available; `/` opens the configured console entry; AI input display is unavailable because there is no stream. Audio starts on by default; viewers can turn it off or on with the Selkies audio button.

**Language** is one shared dropdown for the console/sidebar interface and Chrome, with **Auto** first and selected when no language has been saved. Auto uses the first entry of the calling browser's `Accept-Language` header, without searching later entries for a supported translation or sorting by quality weights. The interface currently supports `en-US` and `zh-CN`; other languages use English text while Chrome still receives the chosen language. Each new or woken browser process resolves Auto from the request or CDP connection that starts it. Missing, wildcard or invalid first entries use `en-US`. Running browsers keep their language. Saving an explicit language synchronizes the open consoles; Auto lets each viewer follow their own header. Existing saved browser languages are retained; the former local interface-language preference is ignored. Shared interface translations live in [`cdp-gateway/i18n.js`](cdp-gateway/i18n.js).

The retained-sleeper cap is shown only when the overflow policy is **Hibernate eligible browsers**. Choosing **Reject new browsers** hides it and preserves its saved value. Lowering the cap first displays the browsers to delete; confirmation saves the change and removes them. A changed list requires confirmation again. Concurrent edits return a revision conflict and retain the draft for review. A persistence failure applies nothing; application failures identify saved and unapplied fields separately. Restarting removes all isolated browsers, including sleepers.

Settings API: `GET /console/api/settings` returns `values`, `effective`, `revision`, `pendingRestart`, `errors`, `capabilities`, `fields` and the request's detected `autoLanguage`. `PATCH` accepts `{ "revision": "<value from GET>", "patch": { "browser": { "language": "zh-CN" } } }`, with the login session and `X-CDP-Console: 1`. Revision conflicts return 409. Eviction previews also return 409 (`code: confirm_evictions`), with a browser list and a `confirmation` to include in the retry. Both console interfaces use this API on the web port.

Deployment parameters use environment variables; runtime preferences use web Settings. With Compose, put deployment variables in `.env` (see [.env.example](.env.example)). Variables not explicitly listed in `compose.yaml` still reach the container through the `env_file` pass-through — that includes native Selkies settings such as `SELKIES_FRAMERATE=30` or `SELKIES_TURN_URL=...`.

`SELKIES_INTERNAL_PORT`, `CDP_INTERNAL_PORT`, `CDP_GATEWAY_INTERNAL_PORT`, `AUTH_INTERNAL_PORT` and `SELKIES_ADDR` are gone: the services behind nginx use unix sockets and the browsers a DevTools pipe (see [What's inside](#whats-inside)). A value still set is ignored, with a warning in the container log.

### Build arguments

| Arg | Default | Description |
| --- | --- | --- |
| `CHROME_VERSION` | `157.0.8103.78` | [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/) version (Stable channel by default; any version in the CfT known-good list works) |
| `NODE_VERSION` | `26` | Node.js major (kept in sync by [`update-chrome-node.mjs`](#keeping-versions-in-sync)) |
| `SELKIES_VERSION` | `2.2.1` | Selkies upstream release; its wheels and the pixelflux/pcmflux dependency wheels are fetched from the GitHub releases, and the webcam/gamepad interposers are built from the same tag's source (see `Dockerfile`) |
| `TZ` | `UTC` | container timezone, exposed as `ENV TZ` (runtime-overridable) |

```bash
docker compose build --build-arg CHROME_VERSION=<version>
```

### Environment variables

**Service toggles**

| Variable         | Default | Description                                                           |
| ---------------- | ------- | --------------------------------------------------------------------- |
| `ENABLE_SELKIES` | `true`  | `false` = skip desktop streaming + audio; keep the HTTP/HTTPS console and virtual desktop          |
| `ENABLE_CDP`     | `true`  | `false` = skip Chromium + public CDP, keep the web settings service (remote-desktop-only container) |
| `CONSOLE_SUBPATH` | `/console` | Public prefix for the console, its API/WebSockets and shared `__auth/` routes; slashes optional, nested paths supported, explicitly empty = site root. See [Serving under a subpath](#serving-under-a-subpath) |
| `ENABLE_AUTH`    | `true`  | built-in login for the web UI + CDP console and the optional CDP API key, managed in the console (see [Login and CDP API key](#login-and-cdp-api-key)); `false` = everything open |
| `AUTH_SETUP_CODE` | *(empty)* | the code the first-start setup form asks for (8+ printable characters, no spaces); empty = a random one on every start, printed in the container log. Set it for scripted setups |

**Ports (Compose)**

For everyday use, set `HTTP_PORT` / `HTTPS_PORT` / `CDP_PORT`; see [Ports](#ports) for defaults and behavior in both network modes.

<details>
<summary>Advanced: legacy port names and listener overrides</summary>

`NGINX_HTTP_PORT` / `NGINX_HTTPS_PORT` remain compatible aliases. Compose prefers a nonempty `HTTP_PORT` / `HTTPS_PORT`, falls back to the corresponding old name, then to `8080` / `8443`. New configurations only need the three access-port variables above.

`NGINX_LISTEN_ADDR` remains a compatible alias, used only when `LISTEN_ADDR` is unset. An unset or empty effective value becomes `127.0.0.1`; explicit `LISTEN_ADDR=` never falls back to the old name. Compose bridge mode applies this address to host port publishing and listens on `0.0.0.0` inside the container; host mode and plain `docker run` apply it to nginx listeners.

Use these overrides for a shared network namespace or peers that require specific container ports. Leave them unset for normal Compose deployments:

| Variable | Image / bridge default | Host overlay defaults to |
| --- | --- | --- |
| `NGINX_LISTEN_HTTP_PORT` | `80` | `HTTP_PORT` (`8080`) |
| `NGINX_LISTEN_HTTPS_PORT` | `443` | `HTTPS_PORT` (`8443`) |
| `CDP_LISTEN_PORT` | `9222` | `CDP_PORT` (`9222`) |

Existing configurations still work: explicit listener values take precedence over the host overlay's derived values. To control access through only the three usual ports, remove these overrides from an existing `.env` or shell environment. In bridge mode, Compose automatically adjusts the container side of each port mapping.

With plain `docker run`, pass listener overrides through `-e` and adjust `-p` to match, e.g. `-e LISTEN_ADDR=0.0.0.0 -e CDP_LISTEN_PORT=9333 -p 127.0.0.1:9222:9333`. With `--network host`, set the listener directly, e.g. `-e NGINX_LISTEN_HTTP_PORT=18080`, without `-p`.

The three listener ports must not collide with each other or with `PORT_FORWARDS` listeners; the entrypoint fails fast on a clash. nginx and the healthcheck always use the actual listener ports.

</details>

**Web UI / TLS**

| Variable                         | Default                                       | Description                                                                                                                                                                                       |
| -------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LISTEN_ADDR` | `127.0.0.1` | Access address; unset/empty means IPv4 loopback. Compose bridge mode uses it for host port binding (the container listens on `0.0.0.0`); host mode and plain `docker run` use it for every nginx listener (web UI, CDP, `PORT_FORWARDS`). `0.0.0.0` = all IPv4 interfaces; use bare addresses for IPv6 |
| `ALLOWED_HOSTS`                  | *(empty)*                                     | host names the web UI and the CDP port answer to, comma-separated (`.example.com` / `*.example.com` = its subdomains too), besides IP addresses and `localhost`; any other `Host` gets 421. Guards an open web UI / console (login skipped, `ENABLE_AUTH=false`) against DNS rebinding — see [Security considerations](#security-considerations). Empty = any host name |
| `ENABLE_HTTPS`                   | `false`                                       | `true` = nginx also serves the web UI over TLS; see [HTTPS](#https) for publishing and certificates                                                                                                                       |

**Extra port forwards**

| Variable        | Default   | Description                                                                                                                                                                                                                                                              |
| --------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT_FORWARDS` | *(empty)* | space/comma-separated `LISTEN=HOST:PORT` entries: nginx also listens on each `LISTEN` port and reverse-proxies it (WebSocket-capable) to `HOST:PORT` — typically a sibling container on the same docker network. See [Docker network (compose)](#docker-network-compose) |

**Selkies**

| Variable                      | Default   | Description                                               |
| ----------------------------- | --------- | --------------------------------------------------------- |
| `SELKIES_ENCODER`             | `h264enc` | native selkies setting (passed through as-is): `h264enc` \| `h265enc` \| `vp8enc` \| `vp9enc` \| `av1enc` \| `h264enc-striped` \| `jpeg` |
| `SELKIES_EXTRA_ARGS`          | *(empty)* | extra CLI flags appended to `selkies` (Selkies' own auth stays off whatever they say — see [Login and CDP API key](#login-and-cdp-api-key)) |
| `SELKIES_VIDEO_STREAMING_MODE` | `false` | Turbo: `true` = encode every frame like a plain video encoder, a still desktop included (constant CPU while a viewer watches, ~2.5% of a core at 1080p); `false` = encode only frames that changed, so a still screen costs next to nothing. The side menu toggles it live for video or games |
| `SELKIES_VIDEO_ON_START` | `true` | video stream starts with the session; `false` = off until the side menu toggle |
| `SELKIES_AUDIO_ENABLED` | `true` | audio support; `false` tears audio down entirely, microphone included |
| `SELKIES_MICROPHONE_ENABLED` | `true` | accept the viewer's microphone (fed to Chromium as the `SelkiesVirtualMic` PulseAudio source) |
| `SELKIES_MICROPHONE_ON_START` | `false` | `true` = ask for the microphone on connect, `false` = wait for the side menu toggle, `demand` = only while an app records |
| `SELKIES_WEBCAM_ENABLED` | `true` | accept the viewer's webcam (forwarded to selkies' virtual V4L2 device) |
| `SELKIES_WEBCAM_ON_START` | `false` | `true` \| `false` \| `demand`, like `SELKIES_MICROPHONE_ON_START` |
| `SELKIES_GAMEPAD_ENABLED` | `true` | gamepad support |
| `SELKIES_GAMEPAD_ON_START` | `false` | poll the viewer's gamepads from the start; `false` = off until the side menu toggle |
| `BROWSER_SUBPATH`           | `/browser` | URL path prefix of the desktop, e.g. `/desk` → `http://host:8080/desk/`; empty = site root; must not overlap the console prefix or its resources (see [Serving under a subpath](#serving-under-a-subpath)) |

**Chromium / CDP**

| Variable                    | Default                                                                                            | Description                                                                                                                                                                                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHROMIUM_EXTRA_ARGS`       | *(empty)*                                                                                          | extra chromium flags, e.g. `--proxy-server=http://host:3128`                                                                                                                                                                                         |
| `CHROMIUM_SANDBOX`          | `auto`                                                                                             | Chromium's own sandbox (main and context browsers): `auto` = on when the browsers run unprivileged (`RUN_USER` not `0`, the default) **and** the container may create user namespaces, `--no-sandbox` otherwise; `off` = always `--no-sandbox`. See [Privilege drop (`RUN_USER`)](#privilege-drop-run_user) |
| `CHROMIUM_ALLOW_FILE_URLS`  | `false`                                                                                            | `true` = the browsers may open `file://` URLs. Blocked by default (a managed `URLBlocklist` policy), because through the browser a page or a CDP client could read any file its user can — the login's session secret included. The CDP commands that name files by path are `CDP_FILE_DIRS`' business |
| `CHROMIUM_ALLOW_DEVTOOLS`   | `true`                                                                                             | `false` = the browsers open no DevTools window (a managed `URLBlocklist` policy: `devtools://*`, `chrome://inspect`). A DevTools window speaks CDP to its page on a channel of its own, past the CDP gateway's checks, and a CDP client can open one (a key press, a click in `chrome://inspect`) — set `false` when a CDP client must not get past `CDP_FILE_DIRS`. The CDP endpoint itself is not affected |

**CDP gateway** (see [CDP gateway](#cdp-gateway-isolated-contexts-with-your-logins))

| Variable                    | Default                     | Description                                                                                                                                                                     |
| --------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CDP_ALLOW_ORIGINS`         | *(empty)*                   | web page origins allowed to use the CDP API, comma-separated (`*` = any), like Chromium's `--remote-allow-origins`; empty = none — see [Connecting Playwright over CDP](#connecting-playwright-over-cdp) |
| `CDP_CONSOLE_ACTIONS`       | `true`                      | allow creating independent browsers and closing individual tabs in the console and sidebar |
| `CDP_CONSOLE_RESTART`       | `true`                      | allow restarting the entire container from the console/sidebar settings; requires a container restart policy |
| `CDP_ALLOW_BROWSER_CLOSE`   | `false`                     | whether a client's `Browser.close` (Puppeteer's `browser.close()`) closes the shared browser (the container keeps running; the next client starts it again); `false` = only that client's connection (and its isolated context) is closed, `Browser.crash*` are refused |
| `CDP_FILE_DIRS`             | `/browser/downloads`        | directories (colon-separated) CDP clients may name local files in: a command that reads a file by path (`DOM.setFileInputFiles`, a drop, a PWA launch, `Extensions.loadUnpacked`) is refused for any other file (symlinks resolved), and a download directory elsewhere is redirected into the first one. The first one is also the browsers' download directory (a managed `DownloadDirectory` policy; created at start and handed to `RUN_USER`). Without this a CDP client could read any file the browser's user can (the login's `auth.json`) and write new files into its directories. `*` = no check and no policy — see [Connecting Playwright over CDP](#connecting-playwright-over-cdp) |

**Desktop / container**

| Variable             | Default        | Description                                                                                                                                                                                                                                                                      |
| -------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TZ`                 | `UTC`          | container timezone (any IANA zone, e.g. `Asia/Shanghai`)                                                                                                                                                                                                                         |
| `DISPLAY_BACKEND`    | `wayland`      | desktop the headed browsers live on: `wayland` = labwc, a headless Wayland compositor + window manager that Selkies captures on the GPU — several times less CPU for animated pages when a GPU is passed in, see [Wayland desktop](#wayland-desktop-display_backendwayland); `x11` = Xvfb (+ picom) — use it with an NVIDIA GPU |
| `RUN_USER`           | `browser`      | the user the desktop stack (Xvfb or labwc, picom, PulseAudio, selkies, chromium, the CDP gateway, the auth service) and the nginx *workers* run as — unset/empty = `browser` (uid 1001, ships in the image); an existing username or `uid[:gid]`; `0` = everything runs as root. PID 1 and the nginx master stay root. See [Privilege drop (`RUN_USER`)](#privilege-drop-run_user) |

### Privilege drop (`RUN_USER`)

By default the desktop stack — Xvfb (or labwc), picom, PulseAudio, selkies
and Chromium (and the CDP gateway with its context browsers, and the auth
service), plus the nginx *workers* — runs as `browser`, the unprivileged user
the image ships (uid 1001). `RUN_USER` picks another user, or opts back into
running everything as root:

```bash
# compose (.env)
#RUN_USER=browser      # the default (unset or empty means the same)
RUN_USER=1000          # a numeric uid[:gid], e.g. to match the uid that
                       # owns ./browser on the host
RUN_USER=0             # no privilege drop: everything runs as root
```

What it does:

* Accepts an existing username (`browser`, uid 1001, ships in the image) or `uid[:gid]`; missing passwd/group entries for a numeric id are synthesized at startup. `0` (also `0:<gid>` or `root`) turns the drop off — none of the points below apply then.
* PID 1 and the nginx **master** stay root: nginx binds the (by default privileged) listen ports and reads the TLS key, and the supervisor prepares the browser profile. Everything else is started via `setpriv`, with no capabilities.
* The browser profile (`/browser/user-data`) is `chown`ed to the user on every start — the first migration of a large root-owned profile (e.g. from a release before 0.2.0, which ran as root by default) can take a moment; afterwards it is a no-op walk.
* GPU device nodes stay usable: the host gid of each `/dev/dri` / NVIDIA node is added to the supplementary group set.
* The CDP/web ports stay as they are. The gain is filesystem/privilege isolation — a compromised browser can no longer write as root.
* **Chromium's sandbox** (`CHROMIUM_SANDBOX=auto`) comes on as well when the container may also create user namespaces: Chromium then confines its renderers in their own user, PID and network namespaces plus seccomp-BPF (check `chrome://sandbox`). Docker's default seccomp profile forbids user namespaces, so this needs a profile that allows them — e.g. `security_opt: ["seccomp=unconfined"]` in a compose override (`--security-opt seccomp=unconfined` with `docker run`), at the cost of the container's own syscall filter. The entrypoint probes it at every start and logs `chromium: sandboxed …` or why not; without it the browsers keep `--no-sandbox`. Chromium's setuid helper is no way around this (it needs `CAP_SYS_ADMIN` for the same namespaces), so the image ships none. As root (`RUN_USER=0`) Chromium cannot sandbox itself at all.

### Timezone and language

Defaults are the container-friendly **UTC** timezone and **system-default English** (`en-US`) browser locale. Set the timezone through the environment. Choose the browser language from the dropdown in web Settings and save it. New browser processes use it without a container restart:

```bash
# with docker run
docker run -e TZ=Asia/Shanghai ...

# with compose (.env)
TZ=Asia/Shanghai
```

**Browser language** offers names such as “English (United States)” and “Chinese (Simplified)” while storing the corresponding locale tags. It sets both the browser UI language and `navigator.language`/`Accept-Language`. After saving, new isolated browsers, browsers woken from hibernation, and the main browser when started again use the selected language; already running browsers retain theirs. Before each process starts, the gateway updates that profile’s language preferences and the child’s environment, including profiles originally created in another language.

## HTTPS

TLS terminates at nginx. The certificate pair is **reused whenever a valid one exists** (self-signed counts as valid; "valid" = parseable cert + matching key) and a self-signed pair is generated **only** when no usable pair is found — into the `./tls` bind mount, so it persists and is reused across restarts. `./tls` is mounted by `compose.https.yaml` only, so without HTTPS no `./tls` directory is created.

**Option A — quick (self-signed):** uncomment one line in `.env`:

```bash
COMPOSE_FILE=compose.yaml:compose.https.yaml
```

This publishes `https://localhost:8443` and turns HTTPS on in one go.

**Option B — bring your own certificate:** drop `fullchain.pem` + `privkey.pem` into `./tls` on the host and use the overlay above (or set `ENABLE_HTTPS=true`). Existing valid pairs are always reused as-is; a broken pair (unparseable, mismatched, or only one of the two files present) stops the container with a clear error instead of being silently replaced.

In bridge mode, `ENABLE_HTTPS=true` *without* the overlay means HTTPS works only inside the docker network (e.g. behind another reverse proxy); the host port stays unpublished. With `compose.host.yaml`, `ENABLE_HTTPS=true` serves HTTPS directly on `HTTPS_PORT`; to also mount `./tls` for persistent certificates, put `compose.https.yaml` before it (its port mapping is dropped, the mount stays). Without the `./tls` mount, a self-signed pair lives inside the container and is regenerated when it is recreated.

## GPU passthrough (optional)

By default everything renders in software (SwiftShader): the container runs anywhere, no GPU required. To render on the host's real GPU instead, add one of the opt-in overlays in `.env`:

```bash
# Intel / AMD — passes /dev/dri through:
COMPOSE_FILE=compose.yaml:compose.gpu.yaml

# NVIDIA — host needs the proprietary driver + nvidia-container-toolkit:
COMPOSE_FILE=compose.yaml:compose.gpu-nvidia.yaml
```

The entrypoint always auto-detects the device at start. On the default Wayland desktop Chromium then renders through its native Wayland/EGL path (see [Wayland desktop](#wayland-desktop-display_backendwayland)); with `DISPLAY_BACKEND=x11` it switches Chromium to the Vulkan/ANGLE backend (`--use-angle=vulkan --enable-features=Vulkan`): WebGL/WebGPU contexts render via Vulkan — the native-GL path cannot work on Xvfb at all — and the display compositor runs on Vulkan too (without the compositing flag chrome://gpu reports WebGL as "Hardware accelerated but at reduced performance": GPU frames read back into a CPU compositor). Verified results: NVIDIA passthrough → `ANGLE (NVIDIA, Vulkan … GeForce RTX …)`, AMD iGPU → `ANGLE (AMD, Vulkan … RADV)` with `webgl/webgpu: enabled` (no readback). SwiftShader stays allowed as a runtime fallback so WebGL remains available without hardware or after a device failure.

The image bakes in the Mesa/VA-API userland for Intel/AMD; NVIDIA GL libraries cannot be baked in (they must match the host driver) — the nvidia container toolkit injects them at container start. Verify with `docker compose exec browser glxinfo -B` / `vainfo` (Intel/AMD) or `nvidia-smi` (NVIDIA), and with `chrome://gpu` in the streamed browser: WebGL should report the hardware renderer. [`examples/webgl-renderer-probe.mjs`](examples/webgl-renderer-probe.mjs) prints the WebGL renderer and the `chrome://gpu` feature status without any dependency: `node examples/webgl-renderer-probe.mjs localhost 9222` (the CDP endpoint; it sends no [API key](#login-and-cdp-api-key), so it works while none is set).

### Wayland desktop (`DISPLAY_BACKEND=wayland`)

The Wayland desktop is the default. With an Intel/AMD GPU passed in, it is far cheaper than Xvfb for anything that animates (video, canvas, carousels — e.g. the baidu.com homepage logo is a looping video). On Xvfb every frame of a browser window is read back from the GPU and copied through the single-threaded software X server, and Selkies copies it out again; one animated page keeps Xvfb at ~100% of a CPU core, and once it saturates every window and the stream slow down. With

```bash
# .env  (DISPLAY_BACKEND=wayland is the default)
COMPOSE_FILE=compose.yaml:compose.gpu.yaml
```

the browsers run in [labwc](https://labwc.github.io/), a headless Wayland compositor + window manager, and Selkies captures its output by screencopy: the frames stay on the GPU from Chromium to the VA-API encoder (dmabuf zero-copy). Measured on an AMD iGPU (Renoir), 1920x1200, baidu.com homepage open, whole-container CPU:

| | `x11` | `wayland` |
| --- | --- | --- |
| nobody watching | 107% | 17% |
| a Selkies viewer connected | 335% (Xvfb saturated) | 29% |

How it differs from `x11`:

* Browser windows are maximized by labwc and keep their tab strip and address bar, and they stay locked that way: only the close button is shown, double/middle clicks on the tab strip do nothing, dragging a window or its edges (Alt+drag included) can neither move nor resize it, and *Minimize* / *Restore* from the tab strip's context menu are undone within a fraction of a second (the watcher that undoes them sleeps while no window is open, so an empty desktop costs no CPU); popups and the context menu are composited natively (no picom). Alt+Tab cycles windows; the CDP console's *Show* raises a window through labwc.
* labwc's own 60 Hz frame clock paces the browsers whether or not anyone watches the stream, and windows covered by others keep rendering, so automation behaves as on Xvfb.
* The mouse pointer is drawn only by the Selkies client, locally and without stream latency (labwc's own pointer is kept out of the video — it would trail behind as a second, "ghost" pointer). It stays an arrow: screencopy carries no cursor shape, so there is no text/hand cursor as on `x11`.
* Selkies' browser-driven resize (**Resize to match the viewer window**, on by default) resizes labwc's output; with **Resize to match the viewer window** = `false` the output stays at **Default resolution**.
* Chromium renders through its native Wayland/EGL path instead of the Vulkan flags above (Chromium does not support Vulkan with Wayland).
* Selkies captures labwc through wlr-screencopy (`PIXELFLUX_HOST_CAPTURE=zwlr`, set by the entrypoint). labwc also offers the newer ext-image-copy-capture, which pixelflux would prefer, but labwc cannot import the GPU buffers pixelflux allocates for it, so with a GPU the stream never starts.

When it does not help: without a GPU everything runs in software either way and costs about the same as `x11` (the `wayland` smoke test in CI runs that way); with **NVIDIA**, Chromium gets no GPU compositing on Wayland from the injected driver stack — set `DISPLAY_BACKEND=x11` there (the entrypoint warns).

## Persistence

| Host path (compose)    | Container path         | Content                                                                    |
| ---------------------- | ---------------------- | -------------------------------------------------------------------------- |
| `./browser/user-data`  | `/browser/user-data`   | Chromium profile: cookies, logins, extensions, `navigator.language` prefs  |
| `./browser/settings`   | `/browser/settings`    | the console's settings (`settings.json`) and the [login + CDP API key](#login-and-cdp-api-key) (`auth.json`) |
| `./browser/contexts`   | `/browser/contexts`    | [CDP gateway](#cdp-gateway-isolated-contexts-with-your-logins) browser contexts — one profile clone each (wiped at every start) |
| `./browser/downloads`  | `/browser/downloads`   | the browsers' downloads, and the files CDP clients may upload by path (`CDP_FILE_DIRS`) |
| `./tls`                | `/etc/nginx/tls`       | TLS certificates (yours or the generated self-signed pair); only with `compose.https.yaml` |

`./browser` is one mount (`BROWSER_DATA_HOST_DIR`, default `./browser`), so the profile and the gateway's clones sit on the same filesystem: on an XFS or btrfs host every isolated context starts from a reflink of the profile instead of a full copy. Both host directories are git-ignored; `./tls` is created only when the HTTPS overlay is in use. The profile is the browser's `--user-data-dir`, so a login made in one run is still there after `docker compose down && up`. On stop the entrypoint closes the browser the orderly way (CDP `Browser.close`, as when its last window is closed) before it signals anything, so even cookies set a moment before reach the profile; a plain signal would drop them. Stale `Singleton*` lock files (a Chromium artifact of the previous container) are cleaned automatically at startup.

### Docker network (compose)

By default compose attaches the container to its own `<project>_default` network. Two `.env` knobs change that:

```bash
NETWORK_NAME=my-net NETWORK_EXTERNAL=false   # compose creates & manages my-net
NETWORK_NAME=existing NETWORK_EXTERNAL=true  # attach to an existing network,
                                             # e.g. shared with a reverse-proxy stack
```

Prefer `NETWORK_EXTERNAL=true` for networks that already exist (older compose versions refuse to adopt them otherwise).

Once the container shares a network with its siblings, `PORT_FORWARDS` exposes selected sibling services under container-local ports — handy when something inside this container (the browser, a script) expects `http://localhost:<port>`:

```bash
# .env — reach container web's GUI at http://localhost:3080
# inside this container (its network-facing port is 80; its :3080 is
# loopback-only inside that container and thus not addressable from here)
PORT_FORWARDS=3080=web:80
# multiple entries, space or comma separated:
#PORT_FORWARDS=3080=web:80 6080=onlyoffice-documentserver:80
```

The forwards are served by the same nginx front door (no extra process): WebSocket-capable, per-request DNS resolution via the container's DNS server (docker's embedded DNS on compose networks) — this container starts fine while a peer is still down (requests 502 until the peer answers) and follows a recreated peer's new IP. A forward listen port must not collide with the HTTP / HTTPS / CDP listeners (80/443/9222 by default in bridge mode; the three configured access ports by default in host mode) or any other forward — the entrypoint refuses to start on a clash.

### Host network (compose)

To let the browser reach apps running on the host itself — e.g. a dev server on `http://localhost:3000` — run the container on the host's network stack (`network_mode: host`) with the `compose.host.yaml` overlay:

```bash
# .env — keep compose.host.yaml LAST when combining overlays,
# e.g. compose.yaml:compose.gpu.yaml:compose.host.yaml
COMPOSE_FILE=compose.yaml:compose.host.yaml
#LISTEN_ADDR=127.0.0.1  # default; empty is the same. 0.0.0.0 = all IPv4 interfaces
```

What changes in this mode:

* Nothing is published; nginx listens directly on `HTTP_PORT` / `HTTPS_PORT` / `CDP_PORT` (8080 / 8443 / 9222 by default), so the URLs stay the same as in bridge mode. HTTPS needs only `ENABLE_HTTPS=true`; to also mount `./tls` for persistent certificates, put `compose.https.yaml` before the host overlay. Existing advanced listener overrides still take precedence; see [Environment variables](#environment-variables).
* Only nginx's listeners take host ports: the services behind it are on unix sockets inside the container's own filesystem and the browsers have no DevTools port, so nothing of the container sits on the host's loopback past nginx (and the [CDP API key](#login-and-cdp-api-key)).
* `NETWORK_NAME` / `NETWORK_EXTERNAL` and `hostname` do not apply. `PORT_FORWARDS` still works but resolves names through the host's DNS (container names do not resolve) — usually you just point the browser at `localhost:<port>` directly.
* With `DISPLAY_BACKEND=x11`, if the host runs its own X server on `:0`, the entrypoint picks the next free display automatically. Xvfb listens on its filesystem socket only, so host processes cannot attach to the unauthenticated container display.

## Service toggles, health and restarts

* Container start == service start: the entrypoint is a minimal PID-1 supervisor that **exits when any service dies**, so `--restart always` / `restart: always` turns that into automatic recovery.
* The shared Compose healthcheck helper normalizes both path prefixes exactly as startup does. Every 30 s it polls the web listener's `<console prefix>/api/settings`, plus `<desktop prefix>/` when Selkies is enabled and the CDP listener's `/json/list` when CDP is enabled. It uses the container-side listen ports and accepts a normal response or 401 for a protected endpoint; redirects also count for the desktop entry page. These probes never start a browser. A plain `docker run` has no healthcheck (the image defines none).
* Both `ENABLE_SELKIES=false` and `ENABLE_CDP=false` at once is a configuration error and fails fast.
* Logs live in `/tmp/*.log` inside the container (`xvfb.log` or `labwc.log`, `picom.log`, `desktop-background.log`, `pulseaudio.log`, `chromium.log`, `cdp-gateway.log`, `nginx/*.log`, …) — `docker compose logs` shows the entrypoint's own output plus Selkies' and nginx's. `nginx/access.log` leaves out the CDP port's `/json/*` requests (CDP clients poll them, often once a second).

## Building from source

```bash
docker compose build            # or: docker build -t agentene/browser .
```

The single-stage Dockerfile installs, each in its own layer: Node.js, Chrome for Testing + its system deps, nginx, Xvfb/PulseAudio/labwc, the official Selkies release wheels, and the CDP gateway's npm dependencies (`npm ci` from its lockfile). Chrome is downloaded straight from the official Chrome for Testing bucket (no Playwright involved); Selkies and its `pixelflux`/`pcmflux` dependencies come from their GitHub releases.

`docker build --check .` passes with no warnings.

## Keeping versions in sync

[`update-chrome-node.mjs`](update-chrome-node.mjs) re-pins Chrome and Node across `Dockerfile`, `compose.yaml` and the build-arg tables of both READMEs from live metadata: the Stable channel of the [Chrome for Testing feed](https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json) and the Node.js release index (newest LTS major). The Chrome version must ship a `linux64` build:

```bash
node update-chrome-node.mjs                  # pin the latest Stable Chrome for Testing
node update-chrome-node.mjs <version>        # pin a specific known-good version
node update-chrome-node.mjs --check          # drift check: exit 1 on drift, change nothing
node update-chrome-node.mjs --node 22        # force the Node major instead of the newest LTS
```

## CI/CD and published images

[![ci](https://github.com/agentene/browser/actions/workflows/ci.yaml/badge.svg)](https://github.com/agentene/browser/actions/workflows/ci.yaml)

Every pull request and every push to `main` runs [`ci.yaml`](.github/workflows/ci.yaml): static checks (hadolint, `docker build --check`, shellcheck, `node --check`, `py_compile`), a full image build, and runtime smoke tests (CDP endpoint, web UI, CDP gateway, Wayland and X11 desktops). Releases are cut from `main` only — `dev` and feature branches are only tested. When a merge to `main` is a release (see below), the same CI run builds and publishes the `linux/amd64` image (the only architecture the Dockerfile builds for); only a `VERSION` change also gets a git tag:

* **GHCR**: `ghcr.io/agentene/browser` (uses the built-in `GITHUB_TOKEN`)
* **Docker Hub**: `agentene/browser` (same `<owner>/<repo>` path as GHCR; needs the `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` repo secrets of an account allowed to push there; skipped otherwise)

Version scheme: the project's own version `X.Y.Z` (semver) lives in [`VERSION`](VERSION) and is bumped by hand. There are two kinds of release:

* **Code release `v<X.Y.Z>`** (e.g. `v0.1.0`) — a git tag pushed when a change of `VERSION` is merged to `main` (typically the `dev` → `main` merge). The image ships whatever Chrome for Testing is pinned at that commit.
* **Chrome release** (e.g. image tag `0.1.0-150.0.7871.100`) — the daily Chrome bump, merged **without a git tag**; `X.Y.Z` stays, the image tag suffix records the Chrome the same code was rebuilt on.

Both kinds publish the same image tags (for a Chrome release these are its only artifact):

| Image tag | Example | Meaning |
| --- | --- | --- |
| `<X.Y.Z>-<chrome-version>` | `0.1.0-150.0.7871.100` | exact build: project version + the Chrome for Testing pinned at that commit — pin this for reproducible deployments |
| `<X.Y.Z>` | `0.1.0` | newest build of that project version (moves with every Chrome bump) |
| `latest` | | newest release |

A merge to `main` that changes neither `VERSION` nor the Chrome pin releases nothing (the run leaves a notice) — so bump `VERSION` on `dev` before merging it. The `publish` job rejects a git tag that is neither `v<VERSION>` nor `v<VERSION>-<chrome-version>` of its commit, or whose commit is not on `main`. Releases publish no `sha-<short>` tag; only a manual run of the workflow on `main` (no tag) does, and nothing else.

### Automatic upstream updates

[`chrome-update.yaml`](.github/workflows/chrome-update.yaml) watches the Chrome for Testing feed for a new Stable release on a daily cron (also runnable manually) and drives the whole loop:

1. `update-chrome-node.mjs` re-pins Chrome and Node across the repo,
2. a bump PR is opened with the diff,
3. `ci.yaml` runs on the PR (lint + full build + smoke tests),
4. the PR squashes via auto-merge once CI is green,
5. the `publish` job in the same run builds the image → it lands on GHCR / Docker Hub as `<X.Y.Z>-<chrome-version>` — no git tag for a Chrome bump,
6. the `cleanup-update-branch` job in `ci.yaml` deletes the merged `chore/chrome-update` branch (kept if a newer bump already reuses it).

The `release-tag` job still tags a merged change of `VERSION` as the code release `v<X.Y.Z>` (if one merge changes both `VERSION` and the Chrome pin, the code release wins). Every git tag is released once: if it already exists, the job skips with a warning — bump `VERSION` to release a code change again.

For the fully automatic path, configure once:

* **Repo secret `CHROME_UPDATE_TOKEN`** — a PAT with `repo` scope (classic) or a fine-grained token with *Contents* + *Pull requests* read/write. It is needed because GitHub never fires `on: pull_request` for PRs created with the built-in `GITHUB_TOKEN` (the bump PR would carry no CI checks). Without the PAT the bump PR still opens and waits for a manual merge (close & reopen it to force CI). Release and publish do not need it: they run in the CI run of the merge itself.
* **Settings → General → Pull Requests → "Allow auto-merge"** enabled, so the PR can merge itself once checks pass.

Without the secret everything still works, just human-gated: the PR opens, you verify, you merge — publishing then runs automatically. A manually pushed git tag also publishes, as long as it is `v<VERSION>` or `v<VERSION>-<chrome-version>` of a commit on `main`; a manual Chrome or `VERSION` bump merged to main is released the same way (git-tagged only when `VERSION` changed).

## Security considerations

* **The CDP endpoint is open until you set a [CDP API key](#login-and-cdp-api-key).** Without one, full browser control is one TCP connect away. Even with one, publish `9222` on localhost or a trusted network only (or behind TLS: the key travels in a header, in clear text over plain HTTP). Compose defaults to `LISTEN_ADDR=127.0.0.1` in both bridge and [host networking](#host-network-compose), including an empty value; remote access requires an explicit different address.
* **CDP gateway contexts inherit your real logins.** Every isolated client starts out signed in wherever the main browser is. That is the point of the feature, and it is also the risk: hand the CDP endpoint only to automation you would trust with those accounts. The `/console/` page and its API follow the [built-in login](#login-and-cdp-api-key) (open when it is skipped or `ENABLE_AUTH=false`). The sidebar shares the same console API and login session.
* **Set up the login right after the first start.** The setup form needs the setup code from the container log, so a visitor who cannot read the log cannot claim the browser; still, the CDP API stays open until a key is set. Skipping leaves the web UI open to everyone who can reach it — and, through DNS rebinding, to any web page a user on that network opens (a site that points its own host name at the container): set `ALLOWED_HOSTS` to the names you reach it by (IP addresses and `localhost` always work) to close that. The CDP API itself is not affected (it refuses every request a page can send: any `Origin`, and any `Sec-Fetch-Site` but `none` — a DNS-rebound page's same-origin GET included). Use HTTPS alongside the login whenever the web UI leaves a trusted network (plain HTTP sends the password and the session cookie in clear text).
* **Browser pages cannot reach the CDP API.** Requests with an `Origin` header are refused unless `CDP_ALLOW_ORIGINS` lists the origin, and requests whose `Sec-Fetch-Site` is anything but `none` (a DNS-rebound page's same-origin GET included) are refused outright. Nothing behind nginx is on a TCP port a page could open (unix sockets, and a DevTools pipe instead of a DevTools port), so a page — in any browser, the container's own included — only ever reaches the services through nginx.
* **CDP clients reach local files only in `CDP_FILE_DIRS`.** The browsers run as the container's user, so through them a CDP client could otherwise read any file that user can — `/browser/settings/auth.json` (the secret that signs login sessions) among them — and write new files into its directories (a fresh `auth.json` would claim the login before its setup). What closes that: `file://` URLs are blocked in the browsers (`CHROMIUM_ALLOW_FILE_URLS=false`), the gateway keeps every path a CDP command names (file inputs, drops, download directories, …) inside `CDP_FILE_DIRS`, and no CDP channel bypasses the gateway (no DevTools port, `Target.exposeDevToolsProtocol` refused). A DevTools window is one, unless `CHROMIUM_ALLOW_DEVTOOLS=false`: set it where a CDP client is not trusted with those files. Only loosen the others if every CDP client may read them. Even with a stolen session, changing the login or the API key needs the current password.
* By default Chromium runs with `--no-sandbox` (Docker's default seccomp profile forbids the user namespaces it needs — standard for containerized Chrome; as root, `RUN_USER=0`, it cannot sandbox at all). Allow user namespaces to get its sandbox (`CHROMIUM_SANDBOX`, see [Privilege drop (`RUN_USER`)](#privilege-drop-run_user)); either way, run the container as a dedicated user/VM you'd be comfortable exposing a browser to.
* Generated TLS keys are self-signed — browsers will warn; that is expected. Bring a real certificate for anything public.
* PID 1 and the nginx master run as **root** (the entrypoint binds the privileged ports 80/443 by default and prepares the profile); the desktop stack and the nginx workers run as the unprivileged `browser` user by default (`RUN_USER`, see [Privilege drop (`RUN_USER`)](#privilege-drop-run_user); `RUN_USER=0` keeps them on root as well). `--security-opt=no-new-privileges` works as-is. `--cap-drop=ALL` on its own stops the container from starting (the entrypoint and nginx still chown, switch uids and bind 80); add back what the startup needs:

  ```bash
  docker run --cap-drop=ALL --security-opt=no-new-privileges \
    --cap-add=CHOWN --cap-add=SETUID --cap-add=SETGID --cap-add=NET_BIND_SERVICE \
    --cap-add=FOWNER --cap-add=DAC_OVERRIDE --cap-add=KILL \
    ...   # the last three are not needed with RUN_USER=0
  ```

## Troubleshooting

| Symptom                                           | Fix                                                                                                                                                                                                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `curl :9222/json/version` fails                   | `docker compose logs`; check `/tmp/chromium.log` inside the container. Port busy? change `CDP_PORT`.                                                                                                                                        |
| Container restarts in a loop with host networking | a listen port is already in use on the host — check `docker compose logs` / `/tmp/nginx/error.log`, then change `HTTP_PORT`, `HTTPS_PORT` or `CDP_PORT`; check any existing advanced listener overrides too. |
| Desktop or console unreachable                                | Check `/tmp/nginx/error.log` and `/tmp/cdp-gateway.log`. Desktop streaming requires `ENABLE_SELKIES=true`; `/console/` is available independently.                                                                                                                       |
| Browser window not in the stream                  | Click **Start browser**, or wake a hibernated browser and use **Show** to bring its window forward.                                                                                                                                                             |
| Isolated session fails with `CDP context limit reached` | `reject` mode is selected, or every running browser is temporarily ineligible for hibernation. Check card reasons, close an idle session, or raise **Maximum running isolated browsers**. Gateway log: `/tmp/cdp-gateway.log`; per-context chromium logs: `$CDP_CONTEXTS_DIR/<context>/chromium.log` while the context is alive (its directory is deleted with it, also after a failed startup — the reason is then in the gateway log). |
| Profile "in use by another process" after restart | normally auto-cleaned; `rm browser/user-data/Singleton*` if it persists.                                                                                                                                                                        |
| Locale not applied to an old profile              | select and save **Browser language** in web Settings, then restart the target browser; no container restart is needed.                                                                                                                            |
| HTTPS errors                                      | a broken or incomplete cert pair fails fast by design — fix or delete `tls/fullchain.pem` + `tls/privkey.pem` (a deleted pair is regenerated self-signed).                                                                                                |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and PRs are welcome — bug fixes, doc improvements and well-argued feature additions alike.

## License

[MIT](LICENSE) — the image additionally bundles Chromium, Selkies, nginx and other third-party software under their own licenses.
