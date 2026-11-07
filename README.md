# agentene-browser

**A single Docker container that bundles Chrome for Testing with a live-viewable remote desktop and a public CDP endpoint.**

[![ci](https://github.com/agentene/browser/actions/workflows/ci.yaml/badge.svg)](https://github.com/agentene/browser/actions/workflows/ci.yaml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![docker image size](https://img.shields.io/docker/image-size/agentene/browser)](https://hub.docker.com/r/agentene/browser)
[![docker pulls](https://img.shields.io/docker/pulls/agentene/browser)](https://hub.docker.com/r/agentene/browser)

[English](README.md) | [简体中文](README.zh-CN.md)

The container starts everything it needs in one place and supervises it as PID 1:

```
docker run ─┬─ Xvfb        virtual display (what Selkies streams; labwc with DISPLAY_BACKEND=wayland)
            ├─ PulseAudio  virtual audio
            ├─ Selkies     HTML5 remote desktop  ─┐
            ├─ Chrome      for Testing, CDP ──────┼─ nginx front door
            └─ nginx      one process, 3 ports  ─┘
```

* **Chromium with a public CDP endpoint** — connect [Playwright](https://playwright.dev) / Puppeteer / Selenium from *outside* the container via `connectOverCDP("http://localhost:9222")`.
* **Live-viewable desktop** — the browser runs **headed** on a virtual X11 display by default, and [Selkies](https://github.com/selkies-project/selkies) 2.x streams it to any browser over WebSockets/WebCodecs (WebRTC opt-in, audio included). Watch and interact with your automation as it runs.
* **Persistent profile** — cookies, logins and extensions survive container recreation via a bind mount.
* **HTTPS support** — self-signed by default, or bring your own certificate; existing valid pairs are always reused.
* **Sane defaults** — UTC timezone, `en-US` browser locale; both are one-line overrides.

## Table of contents

- [What's inside](#whats-inside)
- [Quick start](#quick-start)
  - [Docker Compose](#docker-compose)
  - [Plain docker run](#plain-docker-run)
- [Ports](#ports)
- [Connecting Playwright over CDP](#connecting-playwright-over-cdp)
- [CDP gateway (isolated contexts with your logins)](#cdp-gateway-isolated-contexts-with-your-logins)
- [Watching the desktop](#watching-the-desktop)
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
| Xvfb / PulseAudio   | Ubuntu packages              | virtual display + audio for the stream                                  |
| labwc               | Ubuntu package               | headless Wayland desktop, opt-in (`DISPLAY_BACKEND=wayland`)            |

All services are loopback-only inside the container; nginx is the single public front door and every proxy speaks WebSocket (required by both CDP and Selkies signaling).

## Quick start

### Docker Compose

```bash
git clone https://github.com/agentene/browser.git
cd browser

cp .env.example .env        # optional — defaults work out of the box
docker compose up -d --build
```

Then:

* **Desktop stream**: <http://localhost:8080> — the Chromium window, live.
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
  -p 8080:80 \
  -p 9222:9222 \
  -v "$PWD/browser:/browser" \
  agentene/browser
```

Any argument other than the implicit `start` is exec'd instead of the supervisor, e.g. `docker run -it agentene/browser bash` drops to a shell.

## Ports

Two independent sets of variables, both set in `.env`: the **container-side** port is what nginx actually listens on inside the container; the **host-side** port is what docker publishes (compose maps it onto the container-side port automatically).

| Service                | Container port (default) | Set with                  | Host port (default) | Set with                             |
| ---------------------- | ------------------------ | ------------------------- | ------------------- | ------------------------------------ |
| Web UI (HTTP)          | 80                       | `NGINX_LISTEN_HTTP_PORT`  | 8080                | `NGINX_HTTP_PORT`                    |
| Web UI (HTTPS, opt-in) | 443                      | `NGINX_LISTEN_HTTPS_PORT` | 8443                | `NGINX_HTTPS_PORT` + [HTTPS](#https) |
| Chromium CDP           | 9222                     | `CDP_LISTEN_PORT`         | 9222                | `CDP_PORT`                           |

Changing the container-side ports is mainly useful with `network_mode: host` / a shared network namespace, or when peers on the docker network expect specific ports; with plain port publishing the defaults are fine. They must not collide with each other, with `PORT_FORWARDS` listeners, or with the loopback-only `SELKIES_INTERNAL_PORT` / `CDP_INTERNAL_PORT` / `CDP_GATEWAY_INTERNAL_PORT` (the [CDP gateway](#cdp-gateway-isolated-contexts-with-your-logins)) — the entrypoint fails fast on a clash. With `docker run`, pass them via `-e` and adjust `-p` to match (e.g. `-e CDP_LISTEN_PORT=9333 -p 9222:9333`).

On top of these ports, `PORT_FORWARDS` adds extra listeners that are reverse-proxied to sibling containers on the docker network — see [Docker network (compose)](#docker-network-compose). With host networking there is no publishing at all and the container-side ports are bound on the host directly — see [Host network (compose)](#host-network-compose).

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
* Puppeteer works the same way: `puppeteer.connect({ browserURL: "http://localhost:9222" })`.

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
  * it copies the profile, minus caches and the open tabs — an isolated context starts with no pages, like any new context. The copy is a reflink (instant, copy-on-write) when the profile and `CDP_CONTEXTS_DIR` share one mount of an XFS or btrfs filesystem, which the default `/browser` layout provides on such a host; otherwise it is a full copy. The gateway log (`/tmp/cdp-gateway.log`) says which one at startup;
  * starts a Chromium on the copy;
  * copies the live cookies (HttpOnly and session cookies included) and the live localStorage of the origins open in the main browser on top, since Chromium writes both to disk only lazily;
  * routes that context's traffic to the new browser.
  * This takes about 0.2–0.3 s.
* The context's browser lives as long as the context. Closing the context or disconnecting the client (`playwright-cli -s=… close`) destroys it: the process is stopped and its clone deleted. The next session gets a fresh clone, so it always has the main browser's current logins.
* Every isolated context inherits everything in the profile (cookies, localStorage, IndexedDB, service workers, extensions…) at the moment it starts. Later changes in the main browser do not flow into a running isolated context, and changes in one never flow back.

The CDP console lives at **`http://localhost:9222/console/`**, on the CDP port, so the same trust boundary applies. It shows the main browser and every isolated context as a card: on the left a live thumbnail of the tab in front with its title on a banner across the bottom, on the right a scrollable list of all its open tabs with the one in front highlighted. Clicking a tab in the list (or the thumbnail) switches the browser to it and raises its window. The card of the browser whose window is in front on the desktop — what the Selkies stream shows — glows softly and has *Showing* in place of its *Show* button. The cards update live: the page holds a WebSocket (`/console/ws`) over which the gateway pushes only what changed — tabs opened, closed or renamed, another tab in front, a new thumbnail (only while a console is open; at most every 2 seconds for the browser in front on the desktop, every 20 seconds for the others). Each card also offers two actions:

* *Show* raises that browser window in the Selkies stream.
* *Delete* force-closes an isolated context and disconnects its client.

Each isolated context gets its own browser frame color, matching its console card, so windows on the desktop are easy to tell apart. The console pages get their state only over the `/console/ws` WebSocket: a full snapshot on connect, then changes; their actions are plain HTTP calls under `/console/api/`. The console (and the sidebar below) speaks English and Simplified Chinese: it follows the browser's language, and the *中文* / *EN* button in its header switches it (remembered per browser).

The same console also sits **next to the live desktop**: move the pointer to the right edge of the Selkies page and click the handle that appears (on touch screens it always shows). Drag the sidebar's left edge to resize it, up to half the page or 1000px, whichever is less (remembered per browser); its cards follow the width, side by side once there is room. The sidebar has the cards and actions of `/console/`; *Show* raises the window right in the stream you are watching. nginx injects the sidebar script (`cdp-gateway/panel.js`) into the Selkies page and proxies its API and WebSocket (`cdp-console/` next to the page, so `SELKIES_SUBFOLDER` works) to the gateway. With a Selkies login set, both require the **master** password (the WebSocket also only accepts pages of the same origin): users signed in with a view-only password get no handle. Set `ENABLE_CDP_CONSOLE_PANEL=false` to leave the Selkies page untouched.

**Main browser on demand.** With `CHROMIUM_AUTOSTART=false` the container starts without the main browser, so an idle container runs no Chromium at all. The gateway starts it:

* when a CDP client connects (`/json/version`, `/json/new`, a browser WebSocket). Clients need no changes; the first connection just waits the second or two the browser needs to start;
* with **Start browser** on the main browser's card in `/console/` or the Selkies sidebar.

Closing the main browser (its window, or **Stop** on its card) leaves the container running; its CDP clients get disconnected. **Stop** closes it the way closing its window does, so cookies and the session are saved to the profile first. Listings (`/json/list`) and the console do not start it, which is why the compose healthcheck probes `/json/list` when `ENABLE_SELKIES=false`. Isolated contexts need nothing extra: their client connects through the main browser, which starts it.

Set `CHROMIUM_IDLE_TIMEOUT` to a number of minutes to have the gateway close the main browser again once it has been idle that long: no CDP client connected, no isolated context, and nobody watching the Selkies stream (someone may be using the browser by hand). It is closed the same way as with **Stop**, and the next client or *Start browser* brings it back. The desktop stack (Xvfb or labwc, PulseAudio, Selkies) keeps running; without a viewer it costs little.

Limits:

* Each isolated context is a whole browser process, typically a few hundred MB of RAM. `CDP_CONTEXTS_MAX` caps how many run at once; past the cap, creating a context fails with a clear CDP error.
* CDP carries no session names, so an isolated context is tied to one connection. Reopening a playwright-cli session with the same name gets a new one, not the old one.
* Only the *first* isolated context of a connection gets its own profile-cloned browser. Further `browser.newContext()` calls on the same connection create plain incognito contexts inside that browser, without the logins; open a new connection for another logged-in context.
* Context options that need a fresh context (such as a per-context `proxy`) do not apply to an isolated context, which runs with the main browser's settings.

## Watching the desktop

Open <http://localhost:8080>. Selkies streams the virtual display (with audio) straight into the browser tab — keyboard and mouse input go to the container. Since Chromium runs headed by default (`CHROMIUM_HEADLESS=0`), every automation step is visible in the stream. Set `CHROMIUM_LANG`/`CHROMIUM_START_URL` to control the initial browser state.

Protect the stream with a login screen by setting a password (`SELKIES_BASIC_AUTH_PASSWORD`, username defaults to `ubuntu` — see [Environment variables](#environment-variables)).

### Serving under a subpath

To mount the web UI at a path such as `https://example.com/desk/`, set the prefix in `.env` (slashes optional, nested paths like `/tools/desk` work):

```bash
SELKIES_SUBFOLDER=/desk
```

Selkies then serves everything — page, assets, API and WebSockets — under `/desk/`, and nginx redirects `/` and `/desk` to `/desk/`. The outer reverse proxy must forward the path **unchanged** (no prefix stripping) and keep the WebSocket headers, e.g. with nginx:

```nginx
location /desk/ {
    proxy_pass http://docker-host:8080;   # no URI part -> path kept as-is
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 86400s;
}
```

## Configuration

Everything is configured via environment variables; with Compose, put them in `.env` (see [.env.example](.env.example)). Variables not explicitly listed in `compose.yaml` still reach the container through the `env_file` pass-through — that includes native Selkies settings such as `SELKIES_FRAMERATE=30` or `SELKIES_TURN_URL=...`.

### Build arguments

| Arg | Default | Description |
| --- | --- | --- |
| `CHROME_VERSION` | `157.0.8103.38` | [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/) version (Stable channel by default; any version in the CfT known-good list works) |
| `NODE_VERSION` | `26` | Node.js major (kept in sync by [`update-chrome-node.mjs`](#keeping-versions-in-sync)) |
| `SELKIES_VERSION` | `2.1.0` | Selkies upstream release; its wheels and the pixelflux/pcmflux dependency wheels are fetched from the GitHub releases, and the webcam/gamepad interposers are built from the same tag's source (see `Dockerfile`) |
| `TZ` | `UTC` | container timezone, exposed as `ENV TZ` (runtime-overridable) |

```bash
docker compose build --build-arg CHROME_VERSION=<version>
```

### Environment variables

**Service toggles**

| Variable         | Default | Description                                                           |
| ---------------- | ------- | --------------------------------------------------------------------- |
| `ENABLE_SELKIES` | `true`  | `false` = skip web UI + display + audio (CDP-only container)          |
| `ENABLE_CDP`     | `true`  | `false` = skip Chromium + CDP gateway (remote-desktop-only container) |

**Web UI / TLS**

| Variable                         | Default                                       | Description                                                                                                                                                                                       |
| -------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NGINX_LISTEN_HTTP_PORT`         | `80`                                          | container port nginx serves the web UI on over HTTP (see [Ports](#ports))                                                                                                                         |
| `NGINX_LISTEN_HTTPS_PORT`        | `443`                                         | container port nginx serves the web UI on over TLS                                                                                                                                                |
| `NGINX_LISTEN_ADDR`              | *(empty)*                                     | address every nginx listener (web UI, CDP, `PORT_FORWARDS`) binds to; empty = all interfaces. Set `127.0.0.1` with [host networking](#host-network-compose) to keep CDP and the web UI host-local |
| `ENABLE_HTTPS`                   | `false`                                       | `true` = nginx also serves the web UI over TLS on `NGINX_LISTEN_HTTPS_PORT`                                                                                                                       |
| `TLS_CERT_DIR`                   | `/etc/nginx/tls`                              | where certificates are looked up / generated                                                                                                                                                      |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | `$TLS_CERT_DIR/fullchain.pem` / `privkey.pem` | explicit cert/key paths                                                                                                                                                                           |
| `TLS_SELF_SIGNED_CN`             | `localhost`                                   | CN of the generated self-signed certificate                                                                                                                                                       |

**Extra port forwards**

| Variable        | Default   | Description                                                                                                                                                                                                                                                              |
| --------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT_FORWARDS` | *(empty)* | space/comma-separated `LISTEN=HOST:PORT` entries: nginx also listens on each `LISTEN` port and reverse-proxies it (WebSocket-capable) to `HOST:PORT` — typically a sibling container on the same docker network. See [Docker network (compose)](#docker-network-compose) |

**Selkies**

| Variable                      | Default   | Description                                               |
| ----------------------------- | --------- | --------------------------------------------------------- |
| `SELKIES_BASIC_AUTH_PASSWORD` | *(empty)* | set to enable the login screen; empty = no login          |
| `SELKIES_BASIC_AUTH_USER`     | `ubuntu`  | login username                                            |
| `SELKIES_ENCODER`             | `h264enc` | `h264enc` \| `h264enc-striped` \| `openh264enc` \| `jpeg` |
| `SELKIES_EXTRA_ARGS`          | *(empty)* | extra CLI flags appended to `selkies`                     |
| `SELKIES_ENABLE_RESIZE`       | `true`    | browser-driven resize: the virtual display follows the viewer's browser window size (X11 headroom: `SCREEN_GEOMETRY_MAX`); `false` = the display stays at `SCREEN_GEOMETRY` whoever watches |
| `SELKIES_VIDEO_STREAMING_MODE` | `false` | Turbo: `true` = encode every frame like a plain video encoder, a still desktop included (constant CPU while a viewer watches, ~2.5% of a core at 1080p); `false` = encode only frames that changed, so a still screen costs next to nothing. The side menu toggles it live for video or games |
| `SELKIES_VIDEO_ON_START` | `true` | video stream starts with the session; `false` = off until the side menu toggle |
| `SELKIES_AUDIO_ENABLED` | `true` | audio support; `false` tears audio down entirely, microphone included |
| `SELKIES_AUDIO_ON_START` | `false` | audio stream (container → viewer) starts with the session; `false` = off until the side menu toggle |
| `SELKIES_MICROPHONE_ENABLED` | `true` | accept the viewer's microphone (fed to Chromium as the `SelkiesVirtualMic` PulseAudio source) |
| `SELKIES_MICROPHONE_ON_START` | `false` | `true` = ask for the microphone on connect, `false` = wait for the side menu toggle, `demand` = only while an app records |
| `SELKIES_WEBCAM_ENABLED` | `true` | accept the viewer's webcam (forwarded to selkies' virtual V4L2 device) |
| `SELKIES_WEBCAM_ON_START` | `false` | `true` \| `false` \| `demand`, like `SELKIES_MICROPHONE_ON_START` |
| `SELKIES_GAMEPAD_ENABLED` | `true` | gamepad support |
| `SELKIES_GAMEPAD_ON_START` | `false` | poll the viewer's gamepads from the start; `false` = off until the side menu toggle |
| `SELKIES_SUBFOLDER`           | *(empty)* | URL path prefix of the web UI, e.g. `/desk` → `http://host:8080/desk/`; empty = site root (see [Serving under a subpath](#serving-under-a-subpath)) |
| `SELKIES_INTERNAL_PORT`       | `8081`    | loopback port Selkies binds to (behind nginx)             |

**Chromium / CDP**

| Variable                    | Default                                                                                            | Description                                                                                                                                                                                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHROMIUM_HEADLESS`         | `0`                                                                                                | `0` = headed on the desktop (Xvfb or labwc, visible in the stream); `1` = headless                                                                                                                                                                   |
| `CHROMIUM_LANG`             | `en-US`                                                                                            | browser UI locale + `Accept-Language` (e.g. `zh-CN`)                                                                                                                                                                                                 |
| `CHROMIUM_START_URL`        | `about:blank`                                                                                      | page opened at startup                                                                                                                                                                                                                               |
| `CHROMIUM_AUTOSTART`        | `true`                                                                                             | `false` = no main browser at container start: the CDP gateway starts it on the first CDP client or with *Start browser* in the CDP console, and closing it keeps the container running ([details](#cdp-gateway-isolated-contexts-with-your-logins)) |
| `CHROMIUM_IDLE_TIMEOUT`     | `0`                                                                                                | with `CHROMIUM_AUTOSTART=false`: minutes the main browser may sit idle (no CDP client, no isolated context, nobody watching the stream) before it is closed again; `0` = never |
| `CHROMIUM_DEVICE_INTERPOSERS` | `true` | preload Selkies' webcam + gamepad interposers (and fake-udev, built into the image from the Selkies source) into the browsers, isolated contexts included: the viewer's camera shows up as *Selkies Virtual Camera* and its gamepads in the Gamepad API, with no `/dev/video*`, `/dev/uinput` or privileges. Only with `ENABLE_SELKIES=true`; `false` = no preload |
| `CHROMIUM_EXTRA_ARGS`       | *(empty)*                                                                                          | extra chromium flags, e.g. `--proxy-server=http://host:3128`                                                                                                                                                                                         |
| `CHROMIUM_GPU`              | `auto`                                                                                             | `auto` = render on a passed-through GPU when one is visible ([GPU passthrough](#gpu-passthrough-optional)), else SwiftShader software — WebGL always works; `off` = force software; `strict` = never allow SwiftShader (WebGL then requires the GPU) |
| `CHROMIUM_DISABLE_FEATURES` | `HttpsFirstBalancedModeAutoEnable,HttpsUpgrades,HttpsFirstModeV2` (compose; empty without compose) | comma-separated features passed as `--disable-features=` — turns off the HTTPS-First / HTTPS-Upgrade experiments; set empty in `.env` to drop the flag                                                                                               |
| `CHROMIUM_USER_DATA_DIR`    | `/browser/user-data`                                                                               | browser profile directory (inside the `/browser` mount, see [Persistence](#persistence)); keep it inside the mount when overriding it in `.env`                                                                                                                                                                                               |
| `CDP_LISTEN_PORT`           | `9222`                                                                                             | container port of the public CDP endpoint (nginx → the CDP gateway → chromium; see [Ports](#ports))                                                                                                                                                  |
| `CDP_INTERNAL_PORT`         | `9221`                                                                                             | chromium loopback DevTools port (behind nginx)                                                                                                                                                                                                       |

**CDP gateway** (see [CDP gateway](#cdp-gateway-isolated-contexts-with-your-logins))

| Variable                    | Default                     | Description                                                                                                                                                                     |
| --------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CDP_CONTEXTS_MAX`          | `4`                         | most isolated contexts alive at once (each is a whole browser); further ones fail with a CDP error                                                                              |
| `CDP_CONTEXTS_HEADLESS`     | same as `CHROMIUM_HEADLESS` | `1` = context browsers run headless; `0` = headed on the desktop (visible in the stream)                                                                                        |
| `CDP_CONTEXTS_DIR`          | `/browser/contexts`         | one profile-cloned browser per isolated context; wiped at every start, must not be inside `CHROMIUM_USER_DATA_DIR`; keep it on the same mount as the profile so clones can be reflinks           |
| `CDP_GATEWAY_INTERNAL_PORT` | `9220`                      | gateway loopback port (behind nginx)                                                                                                                                            |
| `ENABLE_CDP_CONSOLE_PANEL`  | `true`                      | with Selkies and the CDP endpoint both on: the CDP console as a sidebar on the right edge of the Selkies page (master password required when a Selkies login is set); `false` = no sidebar |

**Desktop / container**

| Variable             | Default        | Description                                                                                                                                                                                                                                                                      |
| -------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TZ`                 | `UTC`          | container timezone (any IANA zone, e.g. `Asia/Shanghai`)                                                                                                                                                                                                                         |
| `DISPLAY_BACKEND`    | `x11`          | desktop the headed browsers live on: `x11` = Xvfb (+ picom); `wayland` = labwc, a headless Wayland compositor + window manager that Selkies captures on the GPU — several times less CPU for animated pages when a GPU is passed in, see [Wayland desktop](#wayland-desktop-display_backendwayland). The four rows below marked *X11 only* do not apply to `wayland` |
| `SCREEN_GEOMETRY`    | `1920x1080x24` | Xvfb screen size `WxHxD` (with `wayland`: the size of labwc's output); also sizes the Selkies stream                                                                                                                                                                             |
| `SCREEN_GEOMETRY_MAX` | `8192x4096x24` | *X11 only.* RandR ceiling `WxHxD` the Xvfb screen is created at, so Selkies' dynamic resize (browser window size → virtual display resolution, on by default, see `SELKIES_ENABLE_RESIZE`) can grow past `SCREEN_GEOMETRY`; the working size is RandR-preset back in at startup. Empty = the fixed screen of `SCREEN_GEOMETRY` (a browser window larger than the screen stays cropped) |
| `DISPLAY`            | `:0`           | *X11 only.* Xvfb display; if that display number is already taken in the network namespace (host networking on a machine running X/Xwayland), the next free one is used and logged                                                                                                           |
| `ENABLE_COMPOSITOR`  | `true`         | *X11 only.* run picom on the Xvfb display so Chromium popup menus (right-click context menu) keep their drop shadows — without a compositor they render as seemingly borderless white sheets; `false` = old flat look                                                                        |
| `CHROMIUM_FOLLOW_SCREEN` | `true` | *X11 only* (labwc keeps the windows maximized itself). Keep the headed Chromium window covering the whole display when the screen is resized (Selkies' browser-driven resize, see `SCREEN_GEOMETRY_MAX`) — no window manager runs on Xvfb, so otherwise the window keeps its startup size (black border on a larger screen, cropped on a smaller one); only the main browser windows follow, popups and undocked DevTools keep their own size; `false` = the window stays as launched |
| `PIXELFLUX_HOST_CAPTURE` | `zwlr` | *Wayland only* (native pixelflux setting). How Selkies captures labwc: `zwlr` = wlr-screencopy; any other value (e.g. `auto`) lets pixelflux prefer ext-image-copy-capture, whose GPU buffers labwc fails to import — with a GPU the stream then never starts |
| `RUN_USER`           | *(empty)*      | run the desktop stack (Xvfb or labwc, picom, PulseAudio, selkies, chromium, the CDP gateway) and the nginx *workers* as this user instead of root — an existing username (e.g. `browser`) or `uid[:gid]`; PID 1 and the nginx master stay root. See [Privilege drop (`RUN_USER`)](#privilege-drop-run_user) |

### Privilege drop (`RUN_USER`)

By default every process in the container runs as root (the historical
behavior). Set `RUN_USER` to move the desktop stack — Xvfb (or labwc), picom,
PulseAudio, selkies and Chromium (and the CDP gateway with its context
browsers), plus the nginx *workers* — to an unprivileged user:

```bash
# compose (.env)
RUN_USER=browser       # or a numeric uid[:gid], e.g. 1000 to match the
                       # uid that owns ./browser on the host
```

What it does:

* Accepts an existing username (`browser`, uid 1001, ships in the image) or `uid[:gid]`; missing passwd/group entries for a numeric id are synthesized at startup.
* PID 1 and the nginx **master** stay root: nginx binds the (by default privileged) listen ports and reads the TLS key, and the supervisor prepares the browser profile. Everything else is started via `setpriv`, with no capabilities.
* The browser profile (`CHROMIUM_USER_DATA_DIR`) is `chown`ed to the user on every start — the first migration of a large root-owned profile can take a moment; afterwards it is a no-op walk.
* GPU device nodes stay usable: the host gid of each `/dev/dri` / NVIDIA node is added to the supplementary group set.
* What it deliberately does *not* change: Chromium keeps `--no-sandbox` (Docker's default seccomp profile blocks the userns sandbox for any uid) and the CDP/web ports stay as they are. The gain is filesystem/privilege isolation — a compromised browser can no longer write as root.

### Timezone and language

Defaults are the container-friendly **UTC** timezone and **system-default English** (`en-US`) browser locale. Both are plain environment overrides — no rebuild needed:

```bash
# with docker run
docker run -e TZ=Asia/Shanghai -e CHROMIUM_LANG=zh-CN ...

# with compose (.env)
TZ=Asia/Shanghai
CHROMIUM_LANG=zh-CN
```

`CHROMIUM_LANG` sets both the browser UI language and `navigator.language`/`Accept-Language`; the entrypoint seeds the persisted profile so the locale applies even to profiles created with a different language (see `entrypoint/lib/chromium.sh` for the gory details).

## HTTPS

TLS terminates at nginx. The certificate pair is **reused whenever a valid one exists** (self-signed counts as valid; "valid" = parseable cert + matching key) and a self-signed pair is generated **only** when no usable pair is found — into the `./tls` bind mount, so it persists and is reused across restarts. `./tls` is mounted by `compose.https.yaml` only, so without HTTPS no `./tls` directory is created.

**Option A — quick (self-signed):** uncomment one line in `.env`:

```bash
COMPOSE_FILE=compose.yaml:compose.https.yaml
```

This publishes `https://localhost:8443` and turns HTTPS on in one go.

**Option B — bring your own certificate:** drop `fullchain.pem` + `privkey.pem` into `./tls` on the host and use the overlay above (or set `ENABLE_HTTPS=true`). Existing valid pairs are always reused as-is; a broken pair (unparseable, mismatched, or only one of the two files present) stops the container with a clear error instead of being silently replaced.

`ENABLE_HTTPS=true` *without* the overlay means HTTPS works only inside the docker network (e.g. behind another reverse proxy) — the host port stays unpublished and `./tls` is not mounted, so a self-signed pair lives inside the container and is regenerated when it is recreated. With `compose.host.yaml`, put `compose.https.yaml` before it (its port mapping is dropped, the mount stays).

## GPU passthrough (optional)

By default everything renders in software (SwiftShader): the container runs anywhere, no GPU required. To render on the host's real GPU instead, add one of the opt-in overlays in `.env`:

```bash
# Intel / AMD — passes /dev/dri through:
COMPOSE_FILE=compose.yaml:compose.gpu.yaml

# NVIDIA — host needs the proprietary driver + nvidia-container-toolkit:
COMPOSE_FILE=compose.yaml:compose.gpu-nvidia.yaml
```

The entrypoint auto-detects the device at start (`CHROMIUM_GPU=auto`, the default) and switches Chromium to the Vulkan/ANGLE backend (`--use-angle=vulkan --enable-features=Vulkan`): WebGL/WebGPU contexts render via Vulkan — the native-GL path cannot work on Xvfb at all — and the display compositor runs on Vulkan too (without the compositing flag chrome://gpu reports WebGL as "Hardware accelerated but at reduced performance": GPU frames read back into a CPU compositor). Verified results: NVIDIA passthrough → `ANGLE (NVIDIA, Vulkan … GeForce RTX …)`, AMD iGPU → `ANGLE (AMD, Vulkan … RADV)` with `webgl/webgpu: enabled` (no readback). `--disable-gpu` is then no longer added in headless mode, and SwiftShader stays allowed as a runtime fallback so WebGL survives a flaky device. `CHROMIUM_GPU=strict` never allows SwiftShader (anti-fingerprinting: the browser must not report a software renderer — WebGL is then unavailable without a GPU); `off` forces the software path even with a GPU attached.

The image bakes in the Mesa/VA-API userland for Intel/AMD; NVIDIA GL libraries cannot be baked in (they must match the host driver) — the nvidia container toolkit injects them at container start. Verify with `docker compose exec browser glxinfo -B` / `vainfo` (Intel/AMD) or `nvidia-smi` (NVIDIA), and with `chrome://gpu` in the streamed browser: WebGL should report the hardware renderer. [`examples/webgl-renderer-probe.mjs`](examples/webgl-renderer-probe.mjs) prints the WebGL renderer and the `chrome://gpu` feature status without any dependency: it defaults to the loopback DevTools port `127.0.0.1:9221` (run it inside the container, e.g. after `docker cp`), or point it at the public endpoint with `node examples/webgl-renderer-probe.mjs localhost 9222`.

### Wayland desktop (`DISPLAY_BACKEND=wayland`)

With an Intel/AMD GPU passed in, the Wayland desktop is far cheaper than Xvfb for anything that animates (video, canvas, carousels — e.g. the baidu.com homepage logo is a looping video). On Xvfb every frame of a browser window is read back from the GPU and copied through the single-threaded software X server, and Selkies copies it out again; one animated page keeps Xvfb at ~100% of a CPU core, and once it saturates every window and the stream slow down. With

```bash
# .env
COMPOSE_FILE=compose.yaml:compose.gpu.yaml
DISPLAY_BACKEND=wayland
```

the browsers run in [labwc](https://labwc.github.io/), a headless Wayland compositor + window manager, and Selkies captures its output by screencopy: the frames stay on the GPU from Chromium to the VA-API encoder (dmabuf zero-copy). Measured on an AMD iGPU (Renoir), 1920x1200, baidu.com homepage open, whole-container CPU:

| | `x11` | `wayland` |
| --- | --- | --- |
| nobody watching | 107% | 17% |
| a Selkies viewer connected | 335% (Xvfb saturated) | 29% |

What changes with it:

* Browser windows are maximized by labwc and keep their tab strip and address bar, and they stay locked that way: only the close button is shown, double/middle clicks on the tab strip do nothing, dragging a window or its edges (Alt+drag included) can neither move nor resize it, and *Minimize* / *Restore* from the tab strip's context menu are undone within a fraction of a second (the watcher that undoes them sleeps while no window is open, so an empty desktop costs no CPU); popups and the context menu are composited natively (no picom). Alt+Tab cycles windows; the CDP console's *Show* raises a window through labwc.
* labwc's own 60 Hz frame clock paces the browsers whether or not anyone watches the stream, and windows covered by others keep rendering, so automation behaves as on Xvfb.
* The mouse pointer is drawn only by the Selkies client, locally and without stream latency (labwc's own pointer is kept out of the video — it would trail behind as a second, "ghost" pointer). It stays an arrow: screencopy carries no cursor shape, so there is no text/hand cursor as on `x11`.
* Selkies' browser-driven resize (`SELKIES_ENABLE_RESIZE`, on by default) resizes labwc's output; with `SELKIES_ENABLE_RESIZE=false` the output stays at `SCREEN_GEOMETRY`.
* Chromium renders through its native Wayland/EGL path instead of the Vulkan flags above (Chromium does not support Vulkan with Wayland).
* Selkies captures labwc through wlr-screencopy (`PIXELFLUX_HOST_CAPTURE=zwlr`, set by the entrypoint). labwc also offers the newer ext-image-copy-capture, which pixelflux would prefer, but labwc cannot import the GPU buffers pixelflux allocates for it, so with a GPU the stream never starts; any other value (e.g. `auto`) gives pixelflux the choice back.

When it does not help: without a GPU everything runs in software either way and costs about the same as `x11` (the `wayland` smoke test in CI runs that way); with **NVIDIA**, Chromium gets no GPU compositing on Wayland from the injected driver stack — keep the default `x11` there (the entrypoint warns).

## Persistence

| Host path (compose)    | Container path         | Content                                                                    |
| ---------------------- | ---------------------- | -------------------------------------------------------------------------- |
| `./browser/user-data`  | `/browser/user-data`   | Chromium profile: cookies, logins, extensions, `navigator.language` prefs  |
| `./browser/contexts`   | `/browser/contexts`    | [CDP gateway](#cdp-gateway-isolated-contexts-with-your-logins) browser contexts — one profile clone each (wiped at every start) |
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

The forwards are served by the same nginx front door (no extra process): WebSocket-capable, per-request DNS resolution via the container's DNS server (docker's embedded DNS on compose networks) — this container starts fine while a peer is still down (requests 502 until the peer answers) and follows a recreated peer's new IP. A forward listen port must not collide with `NGINX_LISTEN_HTTP_PORT` / `NGINX_LISTEN_HTTPS_PORT` / `CDP_LISTEN_PORT` (80/443/9222 by default), the loopback internals (`SELKIES_INTERNAL_PORT` 8081, `CDP_INTERNAL_PORT` 9221, `CDP_GATEWAY_INTERNAL_PORT` 9220) or any other forward — the entrypoint refuses to start on a clash.

### Host network (compose)

To let the browser reach apps running on the host itself — e.g. a dev server on `http://localhost:3000` — run the container on the host's network stack (`network_mode: host`) with the `compose.host.yaml` overlay:

```bash
# .env — keep compose.host.yaml LAST when combining overlays,
# e.g. compose.yaml:compose.gpu.yaml:compose.host.yaml
COMPOSE_FILE=compose.yaml:compose.host.yaml
NGINX_LISTEN_ADDR=127.0.0.1   # recommended: keep CDP + web UI off the network
```

What changes in this mode:

* Nothing is published; nginx binds its ports on the host directly. `NGINX_LISTEN_HTTP_PORT` / `NGINX_LISTEN_HTTPS_PORT` / `CDP_LISTEN_PORT` default to `NGINX_HTTP_PORT` / `NGINX_HTTPS_PORT` / `CDP_PORT` (8080 / 8443 / 9222), so the URLs stay the same as in bridge mode; set them explicitly to override. HTTPS needs only `ENABLE_HTTPS=true` (`compose.https.yaml` is not needed; its port mapping is dropped).
* The loopback-only internals — `SELKIES_INTERNAL_PORT` (8081), `CDP_INTERNAL_PORT` (9221) and `CDP_GATEWAY_INTERNAL_PORT` (9220) — sit on the host's loopback as well (context browsers pick free ports themselves). Move them in `.env` if your own apps use those ports; a bind failure stops the container.
* `NETWORK_NAME` / `NETWORK_EXTERNAL` and `hostname` do not apply. `PORT_FORWARDS` still works but resolves names through the host's DNS (container names do not resolve) — usually you just point the browser at `localhost:<port>` directly.
* If the host runs its own X server on `:0`, the entrypoint picks the next free display automatically. Xvfb listens on its filesystem socket only, so host processes cannot attach to the unauthenticated container display.

## Service toggles, health and restarts

* Container start == service start: the entrypoint is a minimal PID-1 supervisor that **exits when any service dies**, so `--restart always` / `restart: always` turns that into automatic recovery.
* The compose healthcheck polls `http://127.0.0.1:${NGINX_LISTEN_HTTP_PORT}/` (nginx fronting Selkies) every 30 s: a 2xx, a redirect (`SELKIES_SUBFOLDER`) or a 401 (login screen on) counts as healthy, a 502 (Selkies down) does not. With `ENABLE_SELKIES=false` there is no web listener, so it probes `http://127.0.0.1:${CDP_LISTEN_PORT}/json/version` instead. A plain `docker run` has no healthcheck (the image defines none).
* Both `ENABLE_SELKIES=false` and `ENABLE_CDP=false` at once is a configuration error and fails fast.
* Logs live in `/tmp/*.log` inside the container (`xvfb.log` or `labwc.log`, `picom.log`, `pulseaudio.log`, `chromium.log`, `cdp-gateway.log`, `nginx/*.log`, …) — `docker compose logs` shows the entrypoint's own output plus Selkies' and nginx's.

## Building from source

```bash
docker compose build            # or: docker build -t agentene/browser .
```

The single-stage Dockerfile installs, each in its own layer: Node.js, Chrome for Testing + its system deps, nginx, Xvfb/PulseAudio/labwc, the official Selkies release wheels, and the CDP gateway's npm dependencies (`npm ci` from its lockfile). Chrome is downloaded straight from the official Chrome for Testing bucket (no Playwright involved); Selkies and its `pixelflux`/`pcmflux` dependencies come from their GitHub releases.

`docker build --check .` passes with no warnings.

## Keeping versions in sync

[`update-chrome-node.mjs`](update-chrome-node.mjs) re-pins Chrome and Node across `Dockerfile`, `compose.yaml`, `.env.example` and the build-arg tables of both READMEs from live metadata: the Stable channel of the [Chrome for Testing feed](https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json) and the Node.js release index (newest LTS major). The Chrome version must ship a `linux64` build:

```bash
node update-chrome-node.mjs                  # pin the latest Stable Chrome for Testing
node update-chrome-node.mjs <version>        # pin a specific known-good version
node update-chrome-node.mjs --check          # drift check: exit 1 on drift, change nothing
node update-chrome-node.mjs --node 22        # force the Node major instead of the newest LTS
```

## CI/CD and published images

[![ci](https://github.com/agentene/browser/actions/workflows/ci.yaml/badge.svg)](https://github.com/agentene/browser/actions/workflows/ci.yaml)

Every pull request and every push to `main` runs [`ci.yaml`](.github/workflows/ci.yaml): static checks (hadolint, `docker build --check`, shellcheck, `node --check`, `py_compile`), a full image build, and runtime smoke tests (CDP endpoint, web UI, CDP gateway, Wayland desktop). Pushing a `v*` tag (or a manual run of the workflow) builds and publishes the `linux/amd64` image (the only architecture the Dockerfile builds for):

* **GHCR**: `ghcr.io/agentene/browser` (uses the built-in `GITHUB_TOKEN`)
* **Docker Hub**: `agentene/browser` (same `<owner>/<repo>` path as GHCR; needs the `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` repo secrets of an account allowed to push there; skipped otherwise)

Tag scheme (tags follow the Chrome version): `v150.0.7871.100` → `150.0.7871.100`, `150`, `sha-<short>` and `latest`. A manual run of the workflow (no tag) publishes only the `sha-<short>` tag.

### Automatic upstream updates

[`chrome-update.yaml`](.github/workflows/chrome-update.yaml) watches the Chrome for Testing feed for a new Stable release on a daily cron (also runnable manually) and drives the whole loop:

1. `update-chrome-node.mjs` re-pins Chrome and Node across the repo,
2. a bump PR is opened with the diff,
3. `ci.yaml` runs on the PR (lint + full build + smoke tests),
4. the PR squashes via auto-merge once CI is green,
5. the `release-tag` job in `ci.yaml` pushes tag `v<chrome-version>`,
6. the tag event runs the `publish` job → the image lands on GHCR / Docker Hub,
7. the `cleanup-update-branch` job in `ci.yaml` deletes the merged `chore/chrome-update` branch (kept if a newer bump already reuses it).

If `v150.0.7871.100` is already taken (re-release of the same Chrome version), the tag increments to `v150.0.7871.100-r2`, `-r3`, …

For the fully automatic path, configure once:

* **Repo secret `CHROME_UPDATE_TOKEN`** — a PAT with `repo` scope (classic) or a fine-grained token with *Contents* + *Pull requests* read/write. It is needed twice: GitHub never fires `on: pull_request` for PRs created with the built-in `GITHUB_TOKEN` (the bump PR would carry no CI checks), and events created by `GITHUB_TOKEN` never trigger workflows (a release tag pushed with it would never start the publish job). Without the PAT the bump PR still opens and waits for a manual merge (close & reopen it to force CI), but the pushed tag does not auto-publish — re-push the tag from a machine or run the workflow manually.
* **Settings → General → Pull Requests → "Allow auto-merge"** enabled, so the PR can merge itself once checks pass.

Without the secret everything still works, just human-gated: the PR opens, you verify, you merge — tagging and publishing then run automatically. Manual `v*` tags keep working exactly as before, and a manual Chrome bump merged to main is auto-tagged and released the same way.

## Security considerations

* **The CDP endpoint has no authentication.** Full browser control is one TCP connect away — publish `9222` on localhost or a trusted network only, never on a public IP. With [host networking](#host-network-compose) there is no port mapping to restrict this; use `NGINX_LISTEN_ADDR=127.0.0.1`.
* **CDP gateway contexts inherit your real logins.** Every isolated client starts out signed in wherever the main browser is. That is the point of the feature, and it is also the risk: hand the CDP endpoint only to automation you would trust with those accounts. The `/console/` page and its API share the CDP port's (lack of) authentication. The sidebar copy on the web UI port (`cdp-console/`) follows the Selkies login instead: master password only, open when the web UI has no login.
* **The web UI is unauthenticated by default.** Set `SELKIES_BASIC_AUTH_PASSWORD` whenever the stream is reachable by anyone you don't trust; use HTTPS alongside it (plain HTTP + basic auth leaks the password).
* Chromium runs with `--no-sandbox` (standard for containerized Chrome without a seccomp profile that allows userns); run the container as a dedicated user/VM you'd be comfortable exposing a browser to.
* Generated TLS keys are self-signed — browsers will warn; that is expected. Bring a real certificate for anything public.
* The container runs as **root** by default (the entrypoint is PID 1 and binds the privileged ports 80/443 by default). Set `RUN_USER` (see [Privilege drop (`RUN_USER`)](#privilege-drop-run_user)) to move the desktop stack and the nginx workers off root — PID 1 and the nginx master remain root by design. `--security-opt=no-new-privileges` works as-is. `--cap-drop=ALL` on its own stops the container from starting (the entrypoint and nginx still chown, switch uids and bind 80); add back what the startup needs:

  ```bash
  docker run --cap-drop=ALL --security-opt=no-new-privileges \
    --cap-add=CHOWN --cap-add=SETUID --cap-add=SETGID --cap-add=NET_BIND_SERVICE \
    ...   # with RUN_USER also: --cap-add=FOWNER --cap-add=DAC_OVERRIDE --cap-add=KILL
  ```

## Troubleshooting

| Symptom                                           | Fix                                                                                                                                                                                                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `curl :9222/json/version` fails                   | `docker compose logs`; check `/tmp/chromium.log` inside the container. Port busy? change `CDP_PORT`.                                                                                                                                        |
| Container restarts in a loop with host networking | a listen or internal port is already in use on the host — check `docker compose logs` / `/tmp/nginx/error.log`, `/tmp/chromium.log`, then move `NGINX_LISTEN_HTTP_PORT`, `CDP_LISTEN_PORT`, `SELKIES_INTERNAL_PORT`, `CDP_INTERNAL_PORT` or `CDP_GATEWAY_INTERNAL_PORT`. |
| Web UI unreachable                                | `ENABLE_SELKIES=false` set? Check `/tmp/nginx/error.log` and that Selkies came up (its output is in `docker compose logs`).                                                                                                                       |
| Browser window not in the stream                  | `CHROMIUM_HEADLESS=1` set? The default `0` runs headed on the streamed display.                                                                                                                                                             |
| Isolated session fails with `CDP context limit reached` | `CDP_CONTEXTS_MAX` isolated contexts are open: close idle sessions (or delete them on `/console/`) or raise the limit. Gateway log: `/tmp/cdp-gateway.log`; per-context chromium logs: `$CDP_CONTEXTS_DIR/<context>/chromium.log` while the context is alive (its directory is deleted with it, also after a failed startup — the reason is then in the gateway log). |
| Profile "in use by another process" after restart | normally auto-cleaned; `rm browser/user-data/Singleton*` if it persists.                                                                                                                                                                        |
| Locale not applied to an old profile              | the entrypoint seeds prefs at startup; ensure `CHROMIUM_LANG` is set for the *container*, not just for one page.                                                                                                                            |
| HTTPS errors                                      | a broken or incomplete cert pair fails fast by design — fix or delete `tls/fullchain.pem` + `tls/privkey.pem` (a deleted pair is regenerated self-signed).                                                                                                |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and PRs are welcome — bug fixes, doc improvements and well-argued feature additions alike.

## License

[MIT](LICENSE) — the image additionally bundles Chromium, Selkies, nginx and other third-party software under their own licenses.
