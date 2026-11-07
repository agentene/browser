# Contributing

Thanks for taking the time to improve this project! Issues and pull requests are both welcome.

## Getting started

```bash
git clone https://github.com/agentene/browser.git
cd browser
cp .env.example .env        # optional; defaults work
docker compose up -d --build
```

Verify your change before opening a PR — CI runs exactly these checks:

```bash
# static checks
docker run --rm -i -e HADOLINT_CONFIG=/.hadolint.yaml \
  -v "$PWD/.hadolint.yaml:/.hadolint.yaml" hadolint/hadolint:v2.12.0 < Dockerfile
docker run --rm -v "$PWD:/mnt" -w /mnt koalaman/shellcheck:v0.10.0 \
  docker-entrypoint.sh entrypoint/lib/*.sh entrypoint/helpers/*.sh
node --check update-chrome-node.mjs
for f in cdp-gateway/gateway.mjs cdp-gateway/src/*.mjs cdp-gateway/panel.js; do node --check "$f"; done
npm ci --prefix cdp-gateway && npm test --prefix cdp-gateway   # gateway unit tests
node --check entrypoint/helpers/chromium-close.mjs
python3 -m py_compile entrypoint/helpers/*.py
docker build --check .                        # Dockerfile lint (BuildKit)

# full build + runtime smoke tests
docker compose build
docker run -d --name cdp-smoke -p 9222:9222 -e ENABLE_SELKIES=false \
  agentene/browser:latest
curl -sf http://127.0.0.1:9222/json/version   # then: docker rm -f cdp-smoke
```

CI's `verify` job additionally smoke-tests the web UI, the CDP gateway and
the Wayland desktop (see `.github/workflows/ci.yaml`).

## Repo layout

| Path | Purpose |
| --- | --- |
| `Dockerfile` | single-stage Ubuntu image: Node.js, Chrome for Testing, nginx, Xvfb/picom/labwc/PulseAudio, the CDP gateway's npm deps, the Selkies release wheels |
| `docker-entrypoint.sh` | PID-1 supervisor: Xvfb + picom (or labwc), PulseAudio, Selkies, Chromium (+ CDP gateway), nginx — a thin `main()` over the modules below |
| `entrypoint/lib/` | supervisor modules, one per concern (`config.sh` holds the env knob reference + defaults, `nginx.sh` generates the nginx config) |
| `entrypoint/helpers/` | scripts the services run (labwc helpers, window lock, screen follower, profile seeding, orderly browser close on stop) |
| `compose.yaml` | base compose file |
| `compose.https.yaml`, `compose.gpu.yaml`, `compose.gpu-nvidia.yaml`, `compose.host.yaml` | opt-in overlays: HTTPS, Intel/AMD GPU, NVIDIA GPU, host networking |
| `cdp-gateway/` | CDP gateway (always in front of the CDP port): Node service (`gateway.mjs` entry, modules in `src/`, unit tests in `test/`) + `/console/` dashboard |
| `.env.example` | documented runtime configuration template |
| `update-chrome-node.mjs` | version-sync helper (Chrome for Testing ↔ Node) |
| `.github/workflows/ci.yaml` | lint → build → smoke tests → release-tag → publish |
| `.github/workflows/chrome-update.yaml` | daily Chrome for Testing (Stable) watch → bump PR → auto-merge → release → `chore/chrome-update` branch cleanup (in `ci.yaml`) |
| `examples/` | CDP client examples |

## Guidelines

* **Keep behavior configurable.** New features should come with an environment knob, a default that is safe for the majority, and an entry in `.env.example`, `compose.yaml` and both READMEs.
* **One PR per concern**, with a short rationale. For behavioral changes, explain how you verified it.
* **Scripts must pass their linters** (`shellcheck` for bash — the entrypoint, its modules and helpers; `node --check` for JS; `py_compile` for the Python helpers). The Dockerfile must stay `hadolint`-clean and `docker build --check`-clean.
* **Docs stay in sync**: `README.md` and `README.zh-CN.md` mirror each other; update both.
* **No secrets in the repo** — `.env`, `tls/` and `browser/` are git-ignored on purpose.
* Version bumps of Chrome/Node should go through `node update-chrome-node.mjs` (single source of truth) rather than hand edits.

## Commit style

No strict plugin enforced; a concise conventional-ish subject helps history browsing:

```
feat: add SELKIES_FRAMERATE passthrough docs
fix: clear Singleton locks before chromium launch
docs(cn): mirror HTTPS section of README
```

## Reporting security issues

Please do **not** open public issues for security problems — see [SECURITY.md](SECURITY.md).
