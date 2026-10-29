# AGENTS.md

Guidance for AI coding agents (Codex, Claude Code, Cursor, …) working in this
repository. Human-oriented intro and rationale: [CONTRIBUTING.md](CONTRIBUTING.md).
User-facing docs: [README.md](README.md) / [README.zh-CN.md](README.zh-CN.md).

## What this repo is

A single Docker image (`chendefine/playwright-cdp-selkies`) bundling a
Chrome for Testing browser, a live-viewable Selkies remote desktop, and a
public CDP endpoint behind one nginx front door. It is an infrastructure
repo, not an application codebase: the deliverables are a Dockerfile, a bash
PID-1 supervisor, compose files, a Node version-sync script, and mirrored
bilingual docs. There is no unit-test suite — "testing" means static lint +
image build + runtime smoke tests.

| Path | Role |
| --- | --- |
| `Dockerfile` | Single-stage ubuntu:26.04 image: Node.js, pinned Chrome for Testing (Stable, downloaded straight from the CfT bucket — no Playwright involved), nginx, Xvfb/picom/labwc/PulseAudio, the CDP gateway's npm deps, pinned Selkies wheels. **Source of truth for pinned versions.** |
| `docker-entrypoint.sh` | PID-1 supervisor, kept thin: passthrough mode, sources the modules below, runs the stages Xvfb → picom (or labwc) → PulseAudio → Selkies → Chromium (+ CDP gateway) → nginx, then supervises |
| `entrypoint/lib/*.sh` | The supervisor's modules, one per concern (installed to `/usr/local/lib/docker-entrypoint/lib`): `common` (log/die/helpers), `config` (**the env knob reference + defaults/validation**; a few module-local knobs — `SELKIES_ENCODER`/`SELKIES_ENABLE_RESIZE`/`SELKIES_EXTRA_ARGS`/`PIXELFLUX_HOST_CAPTURE`, `CDP_CONTEXTS_HEADLESS`, `RUN_USER`, `CHROME_BIN` — are defaulted in their own module), `privileges` (RUN_USER → `DROP`), `supervisor` (`start_service`, traps, wait loop), `gpu`, `display-x11`, `display-wayland`, `audio`, `selkies`, `chromium`, `cdp-gateway`, `tls`, `nginx` (**generates `/tmp/nginx/nginx.conf` at every container start**). Function definitions only — no side effects at source time |
| `entrypoint/helpers/` | Standalone scripts the services run (labwc cursor theme + startup hook, window lock, X11 screen follower, chromium prefs seeding) — formerly heredocs in the entrypoint |
| `.shellcheckrc` | Lets shellcheck follow the module `source` statements |
| `compose.yaml` | Base stack; reads `.env` (`env_file` passes unlisted vars through, e.g. native `SELKIES_*`) |
| `compose.https.yaml`, `compose.gpu.yaml`, `compose.gpu-nvidia.yaml`, `compose.host.yaml` | Opt-in overlays (HTTPS publishing + the `./tls` cert mount; Intel/AMD `/dev/dri`; NVIDIA CDI; host networking — keep it last in `COMPOSE_FILE`) |
| `.env.example` | Every runtime knob, documented |
| `cdp-gateway/` | Opt-in CDP gateway (`ENABLE_CDP_GATEWAY`): `gateway.mjs` (Node, sole dep `ws` pinned via `package-lock.json`, installed with `npm ci` in the image), `dashboard.html` (`/console/` on the CDP port), `raise-window.py` (X restacking for the dashboard; `wlrctl` on Wayland) |
| `update-chrome-node.mjs` | Version-sync script — resolves the Stable channel of the Chrome for Testing feed + the newest Node LTS, and rewrites the Chrome/Node pins in `Dockerfile` + `compose.yaml` + `.env.example` + the README build-arg tables together |
| `.github/workflows/ci.yaml` | lint → build → smoke tests (CDP, web UI, CDP gateway, Wayland) → release-tag → publish (GHCR + Docker Hub, `linux/amd64` only) |
| `.github/workflows/chrome-update.yaml` | Daily cron: re-pin to the latest Stable Chrome for Testing → bump PR → auto-merge → release |
| `examples/` | CDP client examples (`connect-playwright.mjs`, `webgl-renderer-probe.mjs`) |
| `README.md` / `README.zh-CN.md` | Mirrored EN / zh-CN user docs |

Untracked local state — never commit: `.env`, `tls/`, `browser/`
(all git-ignored, as are `cdp-gateway/node_modules/` from a local `npm install`, the scratch dirs `detect/`, `.playwright-cli/`, `.docker-tmp/`, and `*.log` / `__pycache__/`).

## Commands

Static checks — CI runs exactly these; all must pass before any commit:

```bash
docker run --rm -i -e HADOLINT_CONFIG=/.hadolint.yaml \
  -v "$PWD/.hadolint.yaml:/.hadolint.yaml" hadolint/hadolint:v2.12.0 < Dockerfile
docker run --rm -v "$PWD:/mnt" -w /mnt koalaman/shellcheck:v0.10.0 \
  docker-entrypoint.sh entrypoint/lib/*.sh entrypoint/helpers/*.sh
node --check update-chrome-node.mjs
node --check cdp-gateway/gateway.mjs
python3 -m py_compile entrypoint/helpers/*.py
docker build --check .
```

Build and smoke-test:

```bash
docker compose build

# CDP path (Selkies off)
docker run -d --name cdp-smoke -p 9222:9222 -e ENABLE_SELKIES=false \
  chendefine/playwright-cdp-selkies:latest
curl -sf http://127.0.0.1:9222/json/version | jq -e '.Browser and .webSocketDebuggerUrl'
docker rm -f cdp-smoke

# Web-UI path (CDP off)
docker run -d --name web-smoke -p 8080:80 -e ENABLE_CDP=false \
  chendefine/playwright-cdp-selkies:latest
curl -sf http://127.0.0.1:8080/ | grep -qi '<html'
docker rm -f web-smoke
```

CI additionally smoke-tests the CDP gateway (an isolated context is created,
driven and disposed with raw CDP) and the Wayland desktop
(`DISPLAY_BACKEND=wayland`) — see the `verify` job in `ci.yaml`.

When a smoke test fails: container logs live in `/tmp/*.log` (`xvfb.log`,
`labwc.log`, `picom.log`, `chromium.log`, `pulseaudio.log`,
`cdp-gateway.log`, `nginx/error.log`, …); `docker logs` shows the
entrypoint's own output plus Selkies' and nginx's stdout/stderr (both run
with `start_service -`).

Version sync:

```bash
node update-chrome-node.mjs                  # pin the latest Stable Chrome for Testing (+ newest Node LTS)
node update-chrome-node.mjs <version>        # pin a specific CfT known-good version
node update-chrome-node.mjs --check          # drift check: exit 1 on drift (manual; no workflow runs it)
node update-chrome-node.mjs --node 22        # force the Node major
```

## Hard rules

1. **Never hand-edit the Chrome/Node pins.** They live in three files
   (`Dockerfile`, `compose.yaml`, `.env.example`) plus the mirrored
   build-arg default tables in both READMEs; only
   `update-chrome-node.mjs` keeps them all in sync (the README tables
   used to drift before the script covered them). Beyond those tables,
   never hardcode the pinned version in docs or comments — link to the
   Dockerfile instead.
2. **A `SELKIES_VERSION` bump** may need matching `PIXELFLUX_VERSION` /
   `PCMFLUX_VERSION` (the releases selkies pins) in the Dockerfile, and
   `SELKIES_PYTAG` if the base image's Python changes (ubuntu:26.04 →
   `cp314`). The build fails fast when a wheel does not exist (curl -f).
3. **There is no static nginx config in the repo.** Listener/proxy/TLS
   changes go into the heredocs in `entrypoint/lib/nginx.sh` (certificates:
   `entrypoint/lib/tls.sh`) that generate `/tmp/nginx/nginx.conf`;
   `nginx -t` runs on the generated file before start.
4. **Two separate port sets — keep them apart.** Container-side listen ports
   are `NGINX_LISTEN_HTTP_PORT` / `NGINX_LISTEN_HTTPS_PORT` / `CDP_LISTEN_PORT` (defaults
   80/443/9222); host-side published ports are `NGINX_HTTP_PORT` /
   `NGINX_HTTPS_PORT` / `CDP_PORT`. Compose `ports:` and the healthcheck
   must reference the container-side variables, never a literal port.
5. **New behavior needs an env knob** with a default that is safe for the
   majority, plus matching entries in `entrypoint/lib/config.sh` (default,
   validation, reference comment), `.env.example`,
   `compose.yaml` and BOTH READMEs — same PR.
6. **Docs are a deliverable.** `README.md` and `README.zh-CN.md` mirror each
   other; update both or the change is incomplete.
7. **Lint gates are hard:** shellcheck-clean (keep the existing
   `# shellcheck disable=... # reason` style), hadolint-clean under
   `.hadolint.yaml` (each `ignored` rule there documents its justification —
   extend that pattern instead of silencing inline), `docker build --check`-
   clean, `node --check`-clean.
8. **No secrets or runtime state in git.** `.env`, `tls/`,
   `browser/` are ignored on purpose; never weaken that.

## Architecture invariants — do not break

* **PID-1 semantics.** Any argv other than `start` is `exec`'d as a command
  (passthrough mode — `docker run -it <image> bash` depends on it; it runs
  before any module is sourced). In start mode the supervisor exits when ANY
  supervised service dies, so `restart: always` recovers the container. New
  daemons must be started with `start_service <log|-> <cmd...>`
  (`entrypoint/lib/supervisor.sh`), which puts them in the `pids` array the
  cleanup trap and the wait loop watch; never background something any
  other way.
* **Entrypoint module layout.** `docker-entrypoint.sh` only sources
  `entrypoint/lib/*.sh` and calls the stage functions in order from
  `main()`. Modules define functions only; cross-module state lives in
  UPPER_CASE globals (documented at the top of the module that sets them),
  function-local temporaries are `local`. Add a new service as a new module
  (plus its `. ` line with a `# shellcheck source=` directive) rather than
  growing an existing one; scripts a service *runs* (Python, long-lived
  loops) go to `entrypoint/helpers/` as files, not heredocs. Runtime paths
  under `/tmp` (logs, `/tmp/labwc-display`, …) are part of the contract
  with CI and users — keep them stable.
* **Host networking must keep working.** With `compose.host.yaml` the
  container shares the host's network namespace: every port (including the
  loopback internals) is a host port, there is no docker DNS, and X abstract
  sockets are shared — hence Xvfb's `-nolisten local` and the free-display
  probe. Never hardcode a port, `127.0.0.11`, or `:0`.
* **Loopback-only internals; nginx is the only public front door.** Selkies
  (`127.0.0.1:${SELKIES_INTERNAL_PORT}`) and Chromium DevTools
  (`127.0.0.1:${CDP_INTERNAL_PORT}`) bind loopback only (`SELKIES_ADDR` in
  `config.sh` is an undocumented escape hatch — keep its default). Every public
  listener is an nginx proxy and must stay WebSocket-capable (CDP and
  Selkies signaling both need the Upgrade/Connection headers).
* **Entrypoint shell style:** `set -uo pipefail` deliberately WITHOUT `-e`
  (it covers the sourced modules too);
  fatal conditions use `die`, warnings use `log`. Preserve that pattern —
  commands whose failure must abort startup need an explicit check.
* **TLS policy:** reuse any parseable cert/key pair that belongs together
  (self-signed counts as valid); self-sign ONLY when no usable pair exists;
  a broken pair fails fast, never gets silently replaced.
* **CDP proxy details (nginx → chromium, gateway off):** the DevTools Host header is rewritten to the
  loopback upstream (DNS-rebinding protection) and `webSocketDebuggerUrl`
  hosts inside JSON responses are `sub_filter`'ed back to the public
  host:port the client dialed. Changing either side breaks
  `connectOverCDP` from outside the container.
* **CDP gateway (`ENABLE_CDP_GATEWAY=true`) takes over the CDP
  port.** nginx then proxies the whole CDP listener to the gateway
  without `sub_filter`; the gateway itself rewrites the Host header to the
  loopback upstream and the ws:// URLs back to the dialed host. Clients must
  never need changes: default-context traffic passes through verbatim, and
  only an isolated `Target.createBrowserContext` gets its own browser (a
  separate chromium on a profile clone, killed with its context). Context
  browsers get the main browser's flags via `chromium_mode_flags` +
  `CHROMIUM_COMMON_FLAGS`/`CHROMIUM_TAIL_FLAGS` — new chromium flags belong
  in one of those so context browsers inherit them. The gateway is in
  `pids`; context chromiums are its children and are cleaned up by it.
* **Two display backends (`DISPLAY_BACKEND=x11|wayland`, default x11).**
  `wayland` replaces Xvfb/picom with labwc on the wlroots *headless*
  backend, which Selkies captures as an external compositor
  (`--wayland-host-display`, screencopy, dmabuf zero-copy with a GPU).
  Keep it headless: Selkies' built-in compositor paces clients at a few,
  varying fps while no viewer is connected, which stalls Playwright's
  rAF-based actionability checks. labwc runs with
  `WLR_SCENE_DISABLE_VISIBILITY=1` (otherwise covered windows get no frame
  callbacks at all) and an all-transparent Xcursor theme (the headless
  output paints the pointer into the captured frames, doubling the
  client-drawn one), maximizes every window by rule, and the CDP console
  raises windows with `wlrctl` by app_id (`cdp-main`, `cdp-<context>`).
  Selkies captures labwc through wlr-screencopy (`PIXELFLUX_HOST_CAPTURE=zwlr`,
  exported in `entrypoint/lib/selkies.sh`): pixelflux's preferred
  ext-image-copy-capture path breaks on labwc 0.9 with a GPU (labwc rejects
  the dmabufs, no stream) — re-test before dropping it.
  Chromium's Vulkan flags are X11-only (Chromium rejects Vulkan with
  Wayland). X11-only knobs: `DISPLAY`, `SCREEN_GEOMETRY_MAX`,
  `ENABLE_COMPOSITOR`, `CHROMIUM_FOLLOW_SCREEN`.
* **GPU policy is one knob:** `CHROMIUM_GPU=auto|off|strict`. Hardware GL
  goes through Vulkan/ANGLE (`--use-angle=vulkan --enable-features=Vulkan`)
  because native GL cannot work on the Xvfb display; SwiftShader stays
  allowed as a runtime fallback unless `strict`.
* **Chromium flag order matters:** the entrypoint appends its flags before
  `CHROMIUM_EXTRA_ARGS` so user flags win (Chromium honors the last
  occurrence of a repeated switch). Keep new flags on the entrypoint side of
  that boundary.

## Releases

Routine releases are fully automated — do not hand-tag Chrome bumps.
Image tags follow the Chrome version (4 parts, e.g. `v150.0.7871.100`; not
semver). Merging to main a change of the `ARG CHROME_VERSION` pin makes the
`release-tag` job in `ci.yaml` push `v<chrome-version>` (`-r2`, `-r3`, … on
re-release),
which triggers the `publish` job (GHCR always; Docker Hub when the
`DOCKERHUB_*` secrets exist). The daily `chrome-update.yaml` cron opens
the bump PR and auto-merges it once CI is green. Manual `v*` tags still
work.

## Commit style

Conventional-ish subjects: `feat:`, `fix:`, `docs(cn):`, `chore:`, `ci:`.
One PR per concern, with a short rationale and how it was verified (which
smoke test ran, which logs were checked).
