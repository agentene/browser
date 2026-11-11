# Security Policy

## Supported versions

Only the latest published image tag (and `main`) receive updates. Pin by digest or a full Chrome-version tag (e.g. `150.0.7871.100`) if you need reproducibility.

## Reporting a vulnerability

Please report vulnerabilities **privately** to the repository owner via
[GitHub security advisories](https://github.com/agentene/browser/security/advisories/new)
("Report a vulnerability"), or email the maintainer if an address is listed on
the GitHub profile. Do **not** open a public issue for security problems.

Include if possible: steps to reproduce, affected versions/tags, impact
assessment, and any mitigations. You should hear back within a week.

## Security posture of the image

Understand this posture **before** exposing any port:

| Surface | Default | Notes |
| --- | --- | --- |
| CDP endpoint (port 9222) | **no authentication** | Full browser control for anyone who can reach it. Publish to localhost/trusted networks only. |
| Selkies web UI (port 80/443) | no authentication | Set `SELKIES_BASIC_AUTH_PASSWORD` (+ HTTPS) whenever untrusted parties can connect. |
| TLS | off (`ENABLE_HTTPS=false`); when on, self-signed and generated once unless you bring a pair | Bring your own certificate for anything public. |
| Chromium sandbox | `--no-sandbox` | Standard for containerized Chromium; run the container on a host/VM you'd be comfortable exposing a browser to. |
| Container user | PID 1 + nginx master: root (binds ports 80/443); desktop stack + nginx workers: `browser` (uid 1001) | `RUN_USER` picks another user, `RUN_USER=0` keeps everything on root. `--cap-drop=ALL` alone stops the container from starting; add back `CHOWN SETUID SETGID NET_BIND_SERVICE FOWNER DAC_OVERRIDE KILL` (the last three not with `RUN_USER=0`), see the README. |

These are deliberate trade-offs for a single-container developer tool, not
oversights. See [Security considerations](README.md#security-considerations)
for hardening options.
