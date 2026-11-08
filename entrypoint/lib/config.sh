# shellcheck shell=bash
# shellcheck disable=SC2034 # the knobs set here are read by the other modules
# config.sh — runtime knobs: defaults + validation (config_load).
#
# Every knob is an environment variable; .env.example lists the commonly
# changed ones for compose users, the READMEs document them all. The
# reference below is the entrypoint's view of them.
#
#   NGINX_LISTEN_HTTP_PORT=80            container port nginx serves the web UI on (HTTP)
#   NGINX_LISTEN_HTTPS_PORT=443          container port nginx serves the web UI on (TLS)
#   CDP_LISTEN_PORT=9222        container port of the public CDP endpoint
#                               (the three above are what nginx binds INSIDE the
#                               container — useful with network_mode: host or
#                               when sharing a network namespace)
#   NGINX_LISTEN_ADDR=""        address every nginx listener binds to; empty =
#                               all interfaces. With network_mode: host set
#                               127.0.0.1 to keep the unauthenticated CDP
#                               endpoint (and the web UI) off the network.
#   ENABLE_HTTPS=false          true = nginx also serves HTTPS on NGINX_LISTEN_HTTPS_PORT. The
#                               certificate pair is REUSED whenever a valid one
#                               already exists (mounted or generated on an
#                               earlier start — self-signed counts as valid);
#                               only when no usable pair is found is a fresh
#                               self-signed one generated.
#   SELKIES_INTERNAL_PORT=8081  loopback port Selkies binds to (behind nginx)
#   SELKIES_SUBFOLDER=""         URL path prefix the web UI is served under
#                                (e.g. /desk -> http://host:port/desk/); empty
#                                = the site root. Selkies' native setting; nginx
#                                additionally redirects / and /desk to /desk/
#   SELKIES_BASIC_AUTH_PASSWORD  set it to enable the login screen
#   SELKIES_ENABLE_RESIZE=true   browser-driven resize of the virtual display;
#                                false = fixed at SCREEN_GEOMETRY
#   SELKIES_EXTRA_ARGS=""        extra selkies CLI flags (word-split)
#   (selkies.sh exports the image's media defaults as native SELKIES_* env
#   vars — only video starts with the session, Turbo is off; every other
#   native SELKIES_* setting, e.g. SELKIES_ENCODER, passes through as-is)
#   DISPLAY_BACKEND=wayland      desktop the browser windows live on: wayland =
#                                labwc, a headless Wayland compositor +
#                                window manager that Selkies captures by
#                                screencopy; x11 = Xvfb (+ picom), captured
#                                by Selkies through XShm (pick it with an
#                                NVIDIA GPU, see display-wayland.sh). With a GPU the
#                                wayland frames stay on it from chromium to
#                                the encoder (dmabuf, zero-copy) instead of
#                                being copied through the software X server
#                                every frame, which cuts the CPU cost of
#                                animated pages several times over.
#   SCREEN_GEOMETRY=1920x1080x24 Xvfb screen size (the working size; also
#                                sizes the Selkies stream); the initial
#                                output size with DISPLAY_BACKEND=wayland
#   TZ=UTC                      container timezone (default UTC; -e TZ=...
#                               overrides at runtime, no rebuild needed)
#   CHROMIUM_LANG=en-US         browser UI locale + Accept-Language (default
#                               system English; e.g. zh-CN for Chinese)
#   CHROMIUM_GPU=auto            GPU/rendering policy (device detection in
#                               gpu.sh): auto = hardware GL
#                               when a GPU is passed into the container
#                               (compose.gpu.yaml / compose.gpu-nvidia.yaml
#                               overlay), SwiftShader software rendering
#                               otherwise — WebGL always works; off = force
#                               software rendering even with a GPU attached;
#                               strict = never allow SwiftShader (anti-
#                               fingerprinting): hardware GL only, WebGL
#                               unavailable without a GPU
#   CHROMIUM_START_URL=about:blank  page the main browser opens at startup
#   CHROMIUM_AUTOSTART=true      false = do not start the main browser with
#                                the container (the CDP gateway then owns
#                                it): an idle container runs
#                                no chromium at all. The gateway starts it on
#                                the first CDP client (/json/version, a
#                                browser WebSocket) or from the CDP console
#                                ("Start"); closing it leaves the container
#                                running instead of restarting it
#   CHROMIUM_IDLE_TIMEOUT=0      (CHROMIUM_AUTOSTART=false only) minutes the
#                                on-demand main browser may sit idle before
#                                the gateway closes it (orderly, like Stop);
#                                idle = no CDP client connected, no isolated
#                                context, nobody watching the Selkies stream.
#                                0 = never
#   CHROMIUM_EXTRA_ARGS=""      extra chromium flags (word-split), appended
#                               after the entrypoint's own so they win
#   CDP_INTERNAL_PORT=9221      chromium loopback DevTools port (behind nginx)
#   (the CDP gateway always sits between nginx and chromium: every isolated
#   CDP context — Target.createBrowserContext, e.g. a playwright-cli session
#   with isolated: true — gets its own chromium on a clone of the main
#   profile, so it inherits the main browser's logins without sharing state;
#   destroyed when the context closes. Dashboard: /console/ on the CDP port.
#   Clients need no changes.)
#   CDP_CONTEXTS_MAX=4           most isolated contexts alive at once (each is
#                                a whole browser); more get a CDP error
#   CDP_GATEWAY_INTERNAL_PORT=9220 gateway loopback port (behind nginx)
#   CHROMIUM_HEADLESS=1          run the browser headless instead (default 0:
#                                the browser window opens on the desktop
#                                and is visible live in the Selkies stream)
#   ENABLE_SELKIES=true          set false to skip Selkies + display + audio
#   ENABLE_CDP=true              set false to skip Chromium + the CDP gateway
#   PORT_FORWARDS=""             extra reverse proxies served by nginx, e.g.
#                                "3080=peer:80 6080=other:6080" (space or
#                                comma separated): each LISTEN=HOST:PORT entry
#                                makes nginx listen on container port LISTEN
#                                and forward it to HOST:PORT — typically a
#                                sibling container on the same docker network.
#                                See nginx.sh (nginx_parse_port_forwards) for
#                                details (late peer startup, WebSocket
#                                support, collision rules).
#   RUN_USER=""                  (resolved in privileges.sh) privilege drop
#                                for the desktop stack (Xvfb/labwc,
#                                picom, PulseAudio, selkies, chromium, the CDP
#                                gateway) and the nginx workers. Empty (default) = everything
#                                runs as root (the historical behavior). A
#                                user name that exists in /etc/passwd (e.g.
#                                browser) or uid[:gid] (missing passwd/group
#                                entries are synthesized at startup) runs those
#                                daemons as that user instead. PID 1 and the
#                                nginx master always stay root: nginx binds the
#                                (possibly privileged) listen ports and reads the
#                                TLS key, and the supervisor keeps preparing
#                                the browser profile (chowned to the user on
#                                every start).
#
# Fixed by the image (no knobs; an env value is ignored): the browser data
# paths (profile /browser/user-data, isolated-context clones
# /browser/contexts), the TLS pair /etc/nginx/tls/{fullchain,privkey}.pem
# (self-signed CN=localhost), the first X display tried (:0), the Xvfb RandR
# ceiling (8192x4096x24), picom + the chromium screen follower on X11, the
# wlr-screencopy capture of labwc, the Selkies device interposers in the
# browsers, the CDP console sidebar, headless isolated contexts exactly when
# the main browser is headless, and the HTTPS-First/-Upgrade features
# disabled in chromium (CHROMIUM_EXTRA_ARGS can still pass its own
# --disable-features=..., the last occurrence wins).

config_load() {
    config_display
    config_selkies
    config_nginx
    config_tls
    config_chromium
    config_cdp_gateway
    config_check_ports
    config_runtime_env
}

config_display() {
    # First X display tried; x11_pick_display moves on to a free one.
    DISPLAY=":0"
    SCREEN_GEOMETRY="${SCREEN_GEOMETRY:-1920x1080x24}"
    # Working size, split once for the display/selkies/chromium modules.
    SCREEN_WIDTH="${SCREEN_GEOMETRY%%x*}"
    SCREEN_HEIGHT="$(printf '%s' "${SCREEN_GEOMETRY}" | cut -dx -f2)"
    # RandR ceiling (WxHxD) the Xvfb screen is created at, giving Selkies'
    # browser-driven resize room to grow past SCREEN_GEOMETRY; matches the
    # official selkies-session framebuffer (8192x4096).
    SCREEN_GEOMETRY_MAX="8192x4096x24"

    ENABLE_SELKIES="${ENABLE_SELKIES:-true}"
    ENABLE_CDP="${ENABLE_CDP:-true}"
    [ "${ENABLE_SELKIES}" = "true" ] || [ "${ENABLE_CDP}" = "true" ] \
        || die "nothing to start (ENABLE_SELKIES and ENABLE_CDP both false?)"
    # Desktop the headed browser windows live on (display-x11.sh /
    # display-wayland.sh); only meaningful with ENABLE_SELKIES=true, which
    # owns the display either way.
    DISPLAY_BACKEND="${DISPLAY_BACKEND:-wayland}"
    case "${DISPLAY_BACKEND}" in
        x11|wayland) : ;;
        *) die "DISPLAY_BACKEND='${DISPLAY_BACKEND}' must be x11 or wayland" ;;
    esac
}

config_selkies() {
    # Selkies itself is loopback-only; nginx is the public front door.
    SELKIES_INTERNAL_PORT="${SELKIES_INTERNAL_PORT:-8081}"
    SELKIES_ADDR="${SELKIES_ADDR:-127.0.0.1}"
    # URL path prefix of the web UI (empty = root). Normalized to the form both
    # selkies and the nginx locations expect: "/a/b" — leading slash, no
    # trailing one. Restricted to URL-safe path characters, as the value lands
    # verbatim in nginx location/return directives.
    SELKIES_SUBFOLDER="${SELKIES_SUBFOLDER:-}"
    SELKIES_SUBFOLDER="${SELKIES_SUBFOLDER#"${SELKIES_SUBFOLDER%%[!/]*}"}"   # strip leading /
    SELKIES_SUBFOLDER="${SELKIES_SUBFOLDER%"${SELKIES_SUBFOLDER##*[!/]}"}"   # strip trailing /
    case "${SELKIES_SUBFOLDER:+/${SELKIES_SUBFOLDER}/}" in   # empty = root, nothing to check
        *[!A-Za-z0-9._~/-]*|*//*|*/./*|*/../*)
            die "SELKIES_SUBFOLDER='${SELKIES_SUBFOLDER}' must be a plain URL path like /desk or /a/b" ;;
    esac
    [ -n "${SELKIES_SUBFOLDER}" ] && SELKIES_SUBFOLDER="/${SELKIES_SUBFOLDER}"
    return 0
}

config_nginx() {
    # nginx public listen ports INSIDE the container (host-side publishing of
    # these ports is a separate choice made by docker: compose "ports:" /
    # docker -p — NGINX_HTTP_PORT / NGINX_HTTPS_PORT / CDP_PORT in compose).
    NGINX_LISTEN_HTTP_PORT="${NGINX_LISTEN_HTTP_PORT:-80}"        # web UI over HTTP (always on)
    NGINX_LISTEN_HTTPS_PORT="${NGINX_LISTEN_HTTPS_PORT:-443}"     # web UI over HTTPS (ENABLE_HTTPS=true only)
    CDP_LISTEN_PORT="${CDP_LISTEN_PORT:-9222}"  # public CDP endpoint
    ENABLE_HTTPS="${ENABLE_HTTPS:-false}"   # true = also serve HTTPS on ${NGINX_LISTEN_HTTPS_PORT}
    # Address every nginx listener binds to (empty = all interfaces). Matters with
    # network_mode: host, where there is no docker port mapping to restrict
    # exposure: 127.0.0.1 keeps the unauthenticated CDP endpoint host-local.
    NGINX_LISTEN_ADDR="${NGINX_LISTEN_ADDR:-}"
    case "${NGINX_LISTEN_ADDR}" in
        '') LISTEN_PREFIX="" ;;
        *[!0-9A-Fa-f.:\[\]]*) die "NGINX_LISTEN_ADDR='${NGINX_LISTEN_ADDR}' must be an IPv4/IPv6 address" ;;
        \[*) LISTEN_PREFIX="${NGINX_LISTEN_ADDR}:" ;;
        *:*) LISTEN_PREFIX="[${NGINX_LISTEN_ADDR}]:" ;;   # bare IPv6 -> [addr]:port
        *) LISTEN_PREFIX="${NGINX_LISTEN_ADDR}:" ;;
    esac
    # Extra reverse proxies served by the same nginx front door (empty = none).
    # Parsed and validated in nginx.sh.
    PORT_FORWARDS="${PORT_FORWARDS:-}"
}

config_tls() {
    # TLS: reuse any valid existing pair (mounted or generated on an earlier
    # start); generate a self-signed one only when no usable pair is found.
    # The directory is where compose.https.yaml mounts ./tls.
    TLS_CERT_DIR="/etc/nginx/tls"
    TLS_CERT_FILE="${TLS_CERT_DIR}/fullchain.pem"
    TLS_KEY_FILE="${TLS_CERT_DIR}/privkey.pem"
    TLS_SELF_SIGNED_CN="localhost"
    # fallback location for generated pairs when TLS_CERT_DIR is not writable
    # (e.g. a read-only mount); container-local, so it survives `docker restart`
    TLS_FALLBACK_DIR="/etc/nginx/tls-selfsigned"
}

config_chromium() {
    CDP_INTERNAL_PORT="${CDP_INTERNAL_PORT:-9221}" # chromium loopback DevTools port
    CHROMIUM_HEADLESS="${CHROMIUM_HEADLESS:-0}"
    CHROMIUM_START_URL="${CHROMIUM_START_URL:-about:blank}"
    # Main browser at container start (true) or on demand through the CDP
    # gateway (false).
    CHROMIUM_AUTOSTART="${CHROMIUM_AUTOSTART:-true}"
    case "${CHROMIUM_AUTOSTART}" in
        true|false) : ;;
        *) die "CHROMIUM_AUTOSTART='${CHROMIUM_AUTOSTART}' must be true or false" ;;
    esac
    # Minutes until the gateway closes an idle on-demand main browser; 0 = never.
    CHROMIUM_IDLE_TIMEOUT="${CHROMIUM_IDLE_TIMEOUT:-0}"
    case "${CHROMIUM_IDLE_TIMEOUT}" in
        ''|*[!0-9]*) die "CHROMIUM_IDLE_TIMEOUT='${CHROMIUM_IDLE_TIMEOUT}' must be a number of minutes (0 = never)" ;;
    esac
    if [ "${CHROMIUM_IDLE_TIMEOUT}" -gt 0 ] && [ "${CHROMIUM_AUTOSTART}" != "false" ]; then
        die "CHROMIUM_IDLE_TIMEOUT needs CHROMIUM_AUTOSTART=false (only an on-demand main browser can be closed and started again)"
    fi
    # The persisted profile, on the /browser mount.
    CHROMIUM_USER_DATA_DIR="/browser/user-data"
    # Browser UI locale + Accept-Language; en-US by default (env override: any
    # other locale, e.g. zh-CN).
    CHROMIUM_LANG="${CHROMIUM_LANG:-en-US}"
    # Single GPU/rendering policy knob; the device detection lives in gpu.sh.
    # auto = hardware GL when a GPU is visible, else SwiftShader software;
    # off = always software (the historical behavior); strict = hardware
    # only, never allow SwiftShader.
    CHROMIUM_GPU="${CHROMIUM_GPU:-auto}"
}

config_cdp_gateway() {
    # CDP gateway: isolated CDP contexts become profile-cloned browsers
    # (cdp-gateway.sh).
    CDP_GATEWAY_INTERNAL_PORT="${CDP_GATEWAY_INTERNAL_PORT:-9220}" # gateway loopback port (behind nginx)
    CDP_CONTEXTS_MAX="${CDP_CONTEXTS_MAX:-4}"
    case "${CDP_CONTEXTS_MAX}" in
        ''|*[!0-9]*|0) die "CDP_CONTEXTS_MAX='${CDP_CONTEXTS_MAX}' must be a positive number" ;;
    esac
    # The profile clones (wiped on every start) sit on the /browser mount next
    # to the profile, so they are reflinks where the filesystem supports it.
    CDP_CONTEXTS_DIR="/browser/contexts"
    # The CDP console sidebar on the Selkies page (nginx.sh, cdp-gateway.sh)
    # needs the web UI to sit in and the gateway to talk to.
    CDP_CONSOLE_PANEL_ACTIVE=false
    if [ "${ENABLE_SELKIES}" = "true" ] && [ "${ENABLE_CDP}" = "true" ]; then
        CDP_CONSOLE_PANEL_ACTIVE=true
    fi
}

# Every port knob must be a plain TCP port number; a typo would otherwise
# only surface as an obscure nginx/selkies/chromium startup failure.
config_check_ports() {
    local port_var port_val
    for port_var in NGINX_LISTEN_HTTP_PORT NGINX_LISTEN_HTTPS_PORT CDP_LISTEN_PORT \
                    SELKIES_INTERNAL_PORT CDP_INTERNAL_PORT CDP_GATEWAY_INTERNAL_PORT; do
        port_val="${!port_var}"
        case "${port_val}" in
            ''|*[!0-9]*) die "${port_var}='${port_val}' is not a port number" ;;
        esac
        { [ "${port_val}" -ge 1 ] && [ "${port_val}" -le 65535 ]; } \
            || die "${port_var}=${port_val} is outside 1-65535"
    done
}

config_runtime_env() {
    XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp}"
    export DISPLAY XDG_RUNTIME_DIR
    PULSE_RUNTIME_PATH="${PULSE_RUNTIME_PATH:-${XDG_RUNTIME_DIR}/pulse}"
    PULSE_SERVER="${PULSE_SERVER:-unix:${PULSE_RUNTIME_PATH}/native}"
    export PULSE_RUNTIME_PATH PULSE_SERVER
}
