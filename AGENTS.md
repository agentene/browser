# AGENTS.md

Guidance for AI coding agents (Codex, Claude Code, Cursor, …) working in this
repository. Human-oriented intro and rationale: [CONTRIBUTING.md](CONTRIBUTING.md).
User-facing docs: [README.md](README.md) / [README.zh-CN.md](README.zh-CN.md).

## What this repo is

A single Docker image (`agentene/browser`) bundling a
Chrome for Testing browser, a live-viewable Selkies remote desktop, and a
public CDP endpoint behind one nginx front door. It is an infrastructure
repo, not an application codebase: the deliverables are a Dockerfile, a bash
PID-1 supervisor, compose files, a Node version-sync script, and mirrored
bilingual docs. Apart from the CDP gateway's small `node --test` suite
there are no unit tests — "testing" means static lint + image build +
runtime smoke tests.

| Path | Role |
| --- | --- |
| `Dockerfile` | Single-stage ubuntu:26.04 image: Node.js, pinned Chrome for Testing (Stable, downloaded straight from the CfT bucket — no Playwright involved), nginx, Xvfb/picom/labwc/PulseAudio, the CDP gateway's npm deps, pinned Selkies wheels. **Source of truth for pinned versions.** |
| `docker-entrypoint.sh` | PID-1 supervisor, kept thin: passthrough mode, sources the modules below, runs the stages labwc (or Xvfb → picom) → PulseAudio → Selkies → Chromium (+ CDP gateway) → nginx, then supervises |
| `entrypoint/lib/*.sh` | The supervisor's modules, one per concern (installed to `/usr/local/lib/docker-entrypoint/lib`): `common` (log/die/helpers), `config` (**the env knob reference + defaults/validation**; a few module-local knobs — `SELKIES_ENABLE_RESIZE`/`SELKIES_EXTRA_ARGS`, `RUN_USER`, `CHROME_BIN` — are defaulted in their own module; settings the image fixes on purpose (data/TLS paths, X11 tuning, …) are constants there, not knobs), `privileges` (RUN_USER → `DROP`), `settings` (the CDP console's persisted settings, `/browser/settings/settings.json` — no env knobs; applied at start), `supervisor` (`start_service`, traps, wait loop), `gpu`, `display-x11`, `display-wayland`, `audio`, `selkies`, `chromium`, `cdp-gateway`, `tls`, `nginx` (**generates `/tmp/nginx/nginx.conf` at every container start**). Function definitions only — no side effects at source time |
| `entrypoint/helpers/` | Standalone scripts the services run (labwc cursor theme + startup hook, window lock, X11 screen follower, the new-windows-to-the-front switch, chromium prefs seeding, the orderly Browser.close the supervisor's stop hook runs) — formerly heredocs in the entrypoint |
| `.shellcheckrc` | Lets shellcheck follow the module `source` statements |
| `compose.yaml` | Base stack; reads `.env` (`env_file` passes unlisted vars through, e.g. native `SELKIES_*`) |
| `compose.https.yaml`, `compose.gpu.yaml`, `compose.gpu-nvidia.yaml`, `compose.host.yaml` | Opt-in overlays (HTTPS publishing + the `./tls` cert mount; Intel/AMD `/dev/dri`; NVIDIA CDI; host networking — keep it last in `COMPOSE_FILE`) |
| `.env.example` | The commonly changed runtime knobs, documented (the full reference is the READMEs' Configuration section + `entrypoint/lib/config.sh`) |
| `cdp-gateway/` | CDP gateway (always in front of the CDP port): `gateway.mjs` (Node entry point; the gateway itself is the ES modules in `src/`, one per concern — the module map is in `gateway.mjs`'s header; sole dep `ws` pinned via `package-lock.json`, installed with `npm ci` in the image; `test/` holds `node --test` unit tests, not shipped in the image), `dashboard.html` (`/console/` on the CDP port), `panel.js` (the same console as a sidebar nginx injects into the Selkies page whenever Selkies and CDP are both on), `raise-window.py` (X restacking for the dashboard; `wlrctl` on Wayland), `front-window.py` (reports the X window in front, for the console's front marker) |
| `VERSION` | The project's own version, `X.Y.Z` (semver, hand-edited). Release tags are `v<VERSION>` (code) and `v<VERSION>-<chrome-version>` (Chrome bump) — see [Releases](#releases) |
| `update-chrome-node.mjs` | Version-sync script — resolves the Stable channel of the Chrome for Testing feed + the newest Node LTS, and rewrites the Chrome/Node pins in `Dockerfile` + `compose.yaml` + the README build-arg tables together |
| `.github/workflows/ci.yaml` | lint → build → smoke tests (CDP, web UI, CDP gateway, Wayland, X11) → release-tag → publish (GHCR + Docker Hub, `linux/amd64` only) |
| `.github/workflows/chrome-update.yaml` | Daily cron: re-pin to the latest Stable Chrome for Testing → bump PR → auto-merge → release (ci.yaml's `cleanup-update-branch` then deletes `chore/chrome-update`) |
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
grep -qxE '[0-9]+\.[0-9]+\.[0-9]+' VERSION                   # X.Y.Z, one line
node --check update-chrome-node.mjs
for f in cdp-gateway/gateway.mjs cdp-gateway/src/*.mjs cdp-gateway/panel.js; do node --check "$f"; done
npm ci --prefix cdp-gateway && npm test --prefix cdp-gateway   # gateway unit tests
node --check entrypoint/helpers/chromium-close.mjs
python3 -m py_compile entrypoint/helpers/*.py
docker build --check .
```

Build and smoke-test:

```bash
docker compose build

# CDP path (Selkies off)
docker run -d --name cdp-smoke -p 9222:9222 -e ENABLE_SELKIES=false \
  agentene/browser:latest
curl -sf http://127.0.0.1:9222/json/version | jq -e '.Browser and .webSocketDebuggerUrl'
docker rm -f cdp-smoke

# Web-UI path (CDP off)
docker run -d --name web-smoke -p 8080:80 -e ENABLE_CDP=false \
  agentene/browser:latest
curl -sf http://127.0.0.1:8080/ | grep -qi '<html'
docker rm -f web-smoke
```

CI additionally smoke-tests the CDP gateway (an isolated context is created,
driven and disposed with raw CDP), the default Wayland desktop and the X11
one (`DISPLAY_BACKEND=x11`) — see the `verify` job in `ci.yaml`.

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

1. **Never hand-edit the Chrome/Node pins.** They live in two files
   (`Dockerfile`, `compose.yaml`) plus the mirrored
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
   validation, reference comment), `compose.yaml` and BOTH READMEs —
   same PR; also `.env.example` when it is a knob most users will want to
   change (it lists only those).
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
* **The CDP gateway always owns the CDP port** (not a knob — there is
  no direct nginx → chromium path). nginx proxies the whole CDP listener
  to the gateway without `sub_filter`; the gateway itself rewrites the
  Host header to the loopback upstream (DevTools' DNS-rebinding
  protection) and the ws:// URLs in JSON bodies back to the dialed host —
  changing either breaks `connectOverCDP` from outside. Clients must
  never need changes: default-context traffic passes through verbatim, and
  only an isolated `Target.createBrowserContext` gets its own browser (a
  separate chromium on a profile clone, killed with its context). Context
  browsers get the main browser's flags via `chromium_mode_flags` +
  `CHROMIUM_COMMON_FLAGS`/`CHROMIUM_TAIL_FLAGS` — new chromium flags belong
  in one of those so context browsers inherit them. The gateway is in
  `pids`; context chromiums are its children and are cleaned up by it.
* **Two display backends (`DISPLAY_BACKEND=wayland|x11`, default wayland).**
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
  forced in `entrypoint/lib/selkies.sh`): pixelflux's preferred
  ext-image-copy-capture path breaks on labwc 0.9 with a GPU (labwc rejects
  the dmabufs, no stream) — re-test before dropping it.
  Chromium's Vulkan flags are X11-only (Chromium rejects Vulkan with
  Wayland). X11-only, always on: picom, the chromium screen follower, the
  8192x4096 RandR ceiling and the free-display probe from `:0`.
* **GPU policy is one knob:** `CHROMIUM_GPU=auto|off|strict`. Hardware GL
  goes through Vulkan/ANGLE (`--use-angle=vulkan --enable-features=Vulkan`)
  because native GL cannot work on the Xvfb display; SwiftShader stays
  allowed as a runtime fallback unless `strict`.
* **Chromium flag order matters:** the entrypoint appends its flags before
  `CHROMIUM_EXTRA_ARGS` so user flags win (Chromium honors the last
  occurrence of a repeated switch). Keep new flags on the entrypoint side of
  that boundary.

## Releases

Version scheme — two parts, joined by `-` on Chrome releases:

* **Project version** `X.Y.Z` (semver) lives in the root `VERSION` file and
  is changed by hand, in the PR that makes the change: patch for fixes,
  minor for features / new knobs, major for breaking changes (removed or
  renamed knobs, changed defaults users must react to). Bump it whenever an
  image-affecting change should be released.
* **Chrome version** — the 4-part `ARG CHROME_VERSION` pin (only
  `update-chrome-node.mjs` touches it). A Chrome bump does NOT change
  `VERSION`; it only adds a suffixed release.

Two kinds of git release tag:

* **Code release** `v<VERSION>` (e.g. `v0.1.0`) — a merge to main that
  changes `VERSION` (the `dev` → `main` merge). Wins if the same merge also
  moves the Chrome pin.
* **Chrome release** `v<VERSION>-<chrome-version>` (e.g.
  `v0.1.0-150.0.7871.100`) — a merge to main that changes only the
  `ARG CHROME_VERSION` pin (the daily bump).

Both publish the same Docker image tags: `<VERSION>-<chrome-version>` (the
Chrome pinned at that commit), the floating `<VERSION>` and `latest` — no
`sha-<short>` (only a tagless manual dispatch on main publishes that).

A tag is immutable: each is released once (an existing tag is skipped with a
warning) — to re-release a code change, bump `VERSION`.

Releases are cut from `main` only: develop on `dev` / feature branches, bump
`VERSION` there, and the merge to `main` is the release (a merge that
changes neither `VERSION` nor the Chrome pin releases nothing). Routine
releases are fully automated — do not hand-tag. In the main-push CI run, the
`release-tag` job pushes the tag (with `GITHUB_TOKEN`, so it triggers no
second run) and the `publish` job builds the image right after it (GHCR
always; Docker Hub when the `DOCKERHUB_*` secrets exist). `publish` refuses a
tag that is neither `v<VERSION>` nor `v<VERSION>-<CHROME_VERSION>` of its own
commit, or whose commit is not on `main`, so a manual tag must follow the
same scheme. The daily
`chrome-update.yaml` cron opens the bump PR and auto-merges it once CI is
green; the `cleanup-update-branch` job in `ci.yaml` then deletes the merged
`chore/chrome-update` branch.

## Commit style

Conventional-ish subjects: `feat:`, `fix:`, `docs(cn):`, `chore:`, `ci:`.
One PR per concern, with a short rationale and how it was verified (which
smoke test ran, which logs were checked).
