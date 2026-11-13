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
#   ALLOWED_HOSTS=""            host names the web UI and the CDP port answer
#                               to (comma-separated; a leading dot or *.
#                               matches subdomains), besides IP addresses and
#                               localhost: any other Host header gets 421.
#                               Stops DNS rebinding — a site pointing its own
#                               name at this container — from using an open
#                               web UI / console (login skipped or
#                               ENABLE_AUTH=false). Empty = any host name
#   ENABLE_HTTPS=false          true = nginx also serves HTTPS on NGINX_LISTEN_HTTPS_PORT. The
#                               certificate pair is REUSED whenever a valid one
#                               already exists (mounted or generated on an
#                               earlier start — self-signed counts as valid);
#                               only when no usable pair is found is a fresh
#                               self-signed one generated.
#   SELKIES_SUBFOLDER=""         URL path prefix the web UI is served under
#                                (e.g. /desk -> http://host:port/desk/); empty
#                                = the site root. Selkies' native setting; nginx
#                                additionally redirects / and /desk to /desk/
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
#   CHROMIUM_AUTOSTART=true      the CDP gateway owns the main browser and
#                                starts it with the container; false = only
#                                when a CDP client uses the default context
#                                (/json/new, a page opened there — connecting
#                                and isolated contexts do not need it) or from
#                                the CDP console ("Start"), so an idle
#                                container runs no main browser at all.
#                                Either way closing (or a crash of) the
#                                main browser leaves the
#                                container running; the next client or
#                                "Start" brings it back
#   CHROMIUM_IDLE_TIMEOUT=0      minutes the main browser may sit idle before
#                                the gateway closes it (orderly, like Stop);
#                                idle = no CDP client connected, no isolated
#                                context, nobody watching the Selkies stream.
#                                0 = never
#   CHROMIUM_EXTRA_ARGS=""      extra chromium flags (word-split), appended
#                               after the entrypoint's own so they win
#   CHROMIUM_SANDBOX=auto        chromium's own sandbox (main and context
#                                browsers): auto = on when the browsers run
#                                unprivileged (RUN_USER not 0) AND the container
#                                allows user namespaces (docker's default
#                                seccomp profile does not — see the README),
#                                --no-sandbox otherwise; off = always
#                                --no-sandbox. Chromium cannot sandbox itself
#                                as root.
#   CHROMIUM_ALLOW_FILE_URLS=false  true = the browsers may open file:// URLs.
#                                Blocked by default (managed policy
#                                URLBlocklist): a page or CDP client could
#                                otherwise read whatever the browser's user
#                                can. The CDP commands that name local files
#                                are CDP_FILE_DIRS' business, not this one's
#   CHROMIUM_ALLOW_DEVTOOLS=true  false = the browsers open no DevTools
#                                window (managed policy URLBlocklist:
#                                devtools://*, chrome://inspect): a DevTools
#                                window speaks CDP to its page on a channel of
#                                its own, which the CDP gateway never sees, so
#                                a CDP client that opens one (a key press, a
#                                click in chrome://inspect) gets past
#                                CDP_FILE_DIRS. The CDP endpoint itself is not
#                                affected
#   (the CDP gateway always sits between nginx and chromium: every isolated
#   CDP context — Target.createBrowserContext, e.g. a playwright-cli session
#   with isolated: true — gets its own chromium on a clone of the main
#   profile, so it inherits the main browser's logins without sharing state;
#   destroyed when the context closes. Dashboard: /console/ on the CDP port.
#   Clients need no changes.)
#   CDP_CONTEXTS_MAX=4           most isolated contexts alive at once (each is
#                                a whole browser); more get a CDP error
#   CDP_ALLOW_ORIGINS=""         web page origins allowed to use the CDP API
#                                (comma-separated, * = any), like chromium's
#                                --remote-allow-origins: the gateway refuses
#                                every CDP request that carries an Origin
#                                header (a browser page's WebSocket or fetch)
#                                or comes cross-site, so no site a user has
#                                open can drive the browser. CDP clients
#                                (Playwright, Puppeteer, ...) send no Origin;
#                                e.g. devtools://devtools for a DevTools
#                                frontend
#   CDP_ALLOW_BROWSER_CLOSE=false whether a CDP client's Browser.close (e.g.
#                                Puppeteer's browser.close()) reaches the
#                                shared main browser. false: the gateway
#                                answers it and ends only that client's
#                                connection (and its isolated context);
#                                Browser.crash* are refused. true: passed
#                                through — the browser exits (the container
#                                keeps running; the next client restarts it)
#   CDP_CONSOLE_ACTIONS=true     the console's / sidebar's New browser (+)
#                                and per-tab close (×) buttons; false =
#                                hidden, and their API routes refused
#   CDP_INPUT_OVERLAY=text       what the Selkies page draws over the stream of
#                                the CDP clients' input, which never moves the
#                                desktop's own pointer: text = their pointer,
#                                clicks, wheel, key combos and the text typed
#                                (a password / one-time-code / card field, or
#                                a focus inside a frame, shows as ••••); keys
#                                = the same with only a count of the
#                                characters typed; off = no overlay. Needs
#                                Selkies and CDP both on; seen by the sidebar's
#                                users (the built-in login), each can
#                                hide it in the sidebar's settings
#   CDP_FILE_DIRS=/browser/downloads  directories (colon-separated) CDP
#                                clients may name local files in: file
#                                inputs, drops, PWA launches, unpacked
#                                extensions (DOM.setFileInputFiles, ...) read
#                                only from them — anything else is refused —
#                                and a download directory outside them is
#                                redirected into the first (the gateway's
#                                file-access.mjs; symlinks resolved). The
#                                browsers' own download directory is the
#                                first one too (managed policy
#                                DownloadDirectory; created and handed to
#                                RUN_USER at start). Otherwise a CDP client
#                                could read any file the browser's user can
#                                (/browser/settings/auth.json, the login's
#                                session secret) and write new ones into its
#                                directories. * = no check, no policy
#   CHROMIUM_HEADLESS=1          run the browser headless instead (default 0:
#                                the browser window opens on the desktop
#                                and is visible live in the Selkies stream)
#   ENABLE_SELKIES=true          set false to skip Selkies + display + audio
#   ENABLE_CDP=true              set false to skip Chromium + the CDP gateway
#   ENABLE_AUTH=true             built-in login (auth.sh): the web UI and the
#                                CDP console need a session — the first visit
#                                sets up the administrator login (or skips
#                                it) — and the CDP API needs the API key once
#                                one is set (Authorization: Bearer <key> or
#                                X-API-Key). Login, skip choice and key are
#                                changed in the console's settings and
#                                persisted in /browser/settings/auth.json.
#                                false = no login, no API key (the CDP
#                                endpoint and the web UI are open, as before)
#   AUTH_SETUP_CODE=""           the code the setup form asks for, so that
#                                reaching the page first is not enough to
#                                claim the browser; empty = a random one on
#                                every start, printed in the container log
#                                (docker logs). Set one for scripted setups
#                                (POST <base>/__auth/api/setup {code, ...})
#   PORT_FORWARDS=""             extra reverse proxies served by nginx, e.g.
#                                "3080=peer:80 6080=other:6080" (space or
#                                comma separated): each LISTEN=HOST:PORT entry
#                                makes nginx listen on container port LISTEN
#                                and forward it to HOST:PORT — typically a
#                                sibling container on the same docker network.
#                                See nginx.sh (nginx_parse_port_forwards) for
#                                details (late peer startup, WebSocket
#                                support, collision rules).
#   RUN_USER=browser             (resolved in privileges.sh) the user the
#                                desktop stack (Xvfb/labwc, picom, PulseAudio,
#                                selkies, chromium, the CDP gateway, the auth
#                                service) and the nginx workers run as. Unset
#                                or empty = browser, the unprivileged user the
#                                image ships (uid 1001). A user name that
#                                exists in /etc/passwd or uid[:gid] (missing
#                                passwd/group entries are synthesized at
#                                startup) runs those daemons as that user
#                                instead; 0 (or 0:<gid>, root) = everything
#                                runs as root, no privilege drop. PID 1 and the
#                                nginx master always stay root: nginx binds the
#                                (possibly privileged) listen ports and reads the
#                                TLS key, and the supervisor keeps preparing
#                                the browser profile (chowned to the user on
#                                every start).
#
# Removed (a value set is ignored, with a warning): SELKIES_INTERNAL_PORT,
# CDP_INTERNAL_PORT, CDP_GATEWAY_INTERNAL_PORT, AUTH_INTERNAL_PORT and
# SELKIES_ADDR. The services behind nginx listen on no TCP port any more —
# a page in the browser can open a loopback port's origin and talk to what
# listens there past nginx (and past the CDP gateway, for chromium's own
# DevTools port): Selkies, the CDP gateway and the auth service sit on unix
# sockets in SOCKET_DIR, and the browsers speak CDP on a pipe to the gateway
# only (--remote-debugging-pipe, cdp-gateway/src/pipe.mjs).
#
# Fixed by the image (no knobs; an env value is ignored): the browser data
# paths (profile /browser/user-data, isolated-context clones
# /browser/contexts, the CDP console's persisted settings
# /browser/settings/settings.json — settings.sh — and the login + API key
# /browser/settings/auth.json — auth.sh), the TLS pair /etc/nginx/tls/{fullchain,privkey}.pem
# (self-signed CN=localhost), the internal unix sockets (SOCKET_DIR
# /tmp/agentene: selkies.sock, cdp-gateway.sock, auth.sock), the first X
# display tried (:0), the Xvfb RandR
# ceiling (8192x4096x24), picom + the chromium screen follower on X11, the
# wlr-screencopy capture of labwc, the Selkies device interposers in the
# browsers, the CDP console sidebar, headless isolated contexts exactly when
# the main browser is headless, and the HTTPS-First/-Upgrade features
# disabled in chromium (CHROMIUM_EXTRA_ARGS can still pass its own
# --disable-features=..., the last occurrence wins).

config_load() {
    config_removed
    config_sockets
    config_display
    config_selkies
    config_nginx
    config_tls
    config_chromium
    config_cdp_gateway
    config_auth
    config_check_ports
    config_runtime_env
}

# Knobs that are gone: a value still set (an old .env) is named, not used.
config_removed() {
    local knob
    for knob in SELKIES_INTERNAL_PORT CDP_INTERNAL_PORT CDP_GATEWAY_INTERNAL_PORT AUTH_INTERNAL_PORT SELKIES_ADDR; do
        [ -n "${!knob:-}" ] || continue
        log "WARNING: ${knob}=${!knob} is ignored: the internal services listen on unix sockets in /tmp/agentene, the browsers on no port at all (see the README)"
        unset "${knob}"
    done
}

# The unix sockets nginx reaches the services behind it on (sockets_init
# creates the directory; the services their sockets).
config_sockets() {
    SOCKET_DIR=/tmp/agentene
    SELKIES_SOCKET="${SOCKET_DIR}/selkies.sock"
    CDP_GATEWAY_SOCKET="${SOCKET_DIR}/cdp-gateway.sock"
    AUTH_SOCKET="${SOCKET_DIR}/auth.sock"
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
    # official `selkies session` framebuffer (8192x4096).
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
    # Host names nginx answers to besides IP addresses and localhost (empty =
    # any; nginx.sh turns the list into a map).
    ALLOWED_HOSTS="${ALLOWED_HOSTS:-}"
    case "${ALLOWED_HOSTS}" in
        *[!A-Za-z0-9.,*\ -]*) die "ALLOWED_HOSTS='${ALLOWED_HOSTS}' must be a comma-separated list of host names like browser.example.com or .example.com" ;;
    esac
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
    CHROMIUM_HEADLESS="${CHROMIUM_HEADLESS:-0}"
    CHROMIUM_START_URL="${CHROMIUM_START_URL:-about:blank}"
    # The CDP gateway starts the main browser at container start (true) or
    # on demand only (false).
    CHROMIUM_AUTOSTART="${CHROMIUM_AUTOSTART:-true}"
    case "${CHROMIUM_AUTOSTART}" in
        true|false) : ;;
        *) die "CHROMIUM_AUTOSTART='${CHROMIUM_AUTOSTART}' must be true or false" ;;
    esac
    # Minutes until the gateway closes an idle main browser; 0 = never.
    CHROMIUM_IDLE_TIMEOUT="${CHROMIUM_IDLE_TIMEOUT:-0}"
    case "${CHROMIUM_IDLE_TIMEOUT}" in
        ''|*[!0-9]*) die "CHROMIUM_IDLE_TIMEOUT='${CHROMIUM_IDLE_TIMEOUT}' must be a number of minutes (0 = never)" ;;
    esac
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
    # The browsers' own sandbox (chromium.sh): auto = when possible.
    CHROMIUM_SANDBOX="${CHROMIUM_SANDBOX:-auto}"
    case "${CHROMIUM_SANDBOX}" in
        auto|off) : ;;
        *) die "CHROMIUM_SANDBOX='${CHROMIUM_SANDBOX}' must be auto or off" ;;
    esac
    # file:// URLs (a managed policy blocks them unless true; chromium.sh).
    CHROMIUM_ALLOW_FILE_URLS="${CHROMIUM_ALLOW_FILE_URLS:-false}"
    case "${CHROMIUM_ALLOW_FILE_URLS}" in
        true|false) : ;;
        *) die "CHROMIUM_ALLOW_FILE_URLS='${CHROMIUM_ALLOW_FILE_URLS}' must be true or false" ;;
    esac
    # DevTools windows (a managed policy blocks them when false; chromium.sh).
    CHROMIUM_ALLOW_DEVTOOLS="${CHROMIUM_ALLOW_DEVTOOLS:-true}"
    case "${CHROMIUM_ALLOW_DEVTOOLS}" in
        true|false) : ;;
        *) die "CHROMIUM_ALLOW_DEVTOOLS='${CHROMIUM_ALLOW_DEVTOOLS}' must be true or false" ;;
    esac
}

config_cdp_gateway() {
    # CDP gateway: isolated CDP contexts become profile-cloned browsers
    # (cdp-gateway.sh).
    CDP_CONTEXTS_MAX="${CDP_CONTEXTS_MAX:-4}"
    case "${CDP_CONTEXTS_MAX}" in
        ''|*[!0-9]*|0) die "CDP_CONTEXTS_MAX='${CDP_CONTEXTS_MAX}' must be a positive number" ;;
    esac
    # The profile clones (wiped on every start) sit on the /browser mount next
    # to the profile, so they are reflinks where the filesystem supports it.
    CDP_CONTEXTS_DIR="/browser/contexts"
    # Web page origins that may use the CDP API (the gateway's cdp-origin.mjs
    # parses the list); empty = none.
    CDP_ALLOW_ORIGINS="${CDP_ALLOW_ORIGINS:-}"
    case "${CDP_ALLOW_ORIGINS}" in
        *[!A-Za-z0-9.:/_*,\ \[\]-]*)
            die "CDP_ALLOW_ORIGINS='${CDP_ALLOW_ORIGINS}' must be a comma-separated list of origins like https://tools.example:8443 (or *)" ;;
    esac
    # Whether a client's Browser.close reaches the shared browser (the
    # gateway's browser-exit.mjs).
    CDP_ALLOW_BROWSER_CLOSE="${CDP_ALLOW_BROWSER_CLOSE:-false}"
    case "${CDP_ALLOW_BROWSER_CLOSE}" in
        true|false) ;;
        *) die "CDP_ALLOW_BROWSER_CLOSE='${CDP_ALLOW_BROWSER_CLOSE}' must be true or false" ;;
    esac
    # Where CDP clients may name local files (the gateway's file-access.mjs;
    # the first one is also the browsers' download directory, chromium.sh).
    # Plain absolute paths only: they end up in the policy JSON as they are.
    CDP_FILE_DIRS="${CDP_FILE_DIRS:-/browser/downloads}"
    if [ "${CDP_FILE_DIRS}" != "*" ]; then
        local dir dirs
        IFS=: read -r -a dirs <<<"${CDP_FILE_DIRS}"
        [ "${#dirs[@]}" -gt 0 ] || die "CDP_FILE_DIRS is empty (use * to allow any directory)"
        for dir in "${dirs[@]}"; do
            case "${dir}" in
                /*) : ;;
                *) die "CDP_FILE_DIRS='${CDP_FILE_DIRS}': '${dir}' is not an absolute path (colon-separated absolute directories, or *)" ;;
            esac
            case "${dir}" in
                *[!A-Za-z0-9._/@+=,~-]*) die "CDP_FILE_DIRS='${CDP_FILE_DIRS}': '${dir}' may only contain letters, digits and ._/@+=,~-" ;;
            esac
        done
    fi
    # Console browser creation and individual tab closing.
    CDP_CONSOLE_ACTIONS="${CDP_CONSOLE_ACTIONS:-true}"
    case "${CDP_CONSOLE_ACTIONS}" in
        true|false) ;;
        *) die "CDP_CONSOLE_ACTIONS='${CDP_CONSOLE_ACTIONS}' must be true or false" ;;
    esac
    # The CDP console sidebar on the Selkies page (nginx.sh, cdp-gateway.sh)
    # needs the web UI to sit in and the gateway to talk to.
    CDP_CONSOLE_PANEL_ACTIVE=false
    if [ "${ENABLE_SELKIES}" = "true" ] && [ "${ENABLE_CDP}" = "true" ]; then
        CDP_CONSOLE_PANEL_ACTIVE=true
    fi
    # The CDP clients' input drawn over the Selkies stream (the gateway's
    # input-overlay.mjs, cdp-gateway/overlay.js), next to the sidebar: off
    # without it.
    CDP_INPUT_OVERLAY="${CDP_INPUT_OVERLAY:-text}"
    case "${CDP_INPUT_OVERLAY}" in
        text|keys|off) : ;;
        *) die "CDP_INPUT_OVERLAY='${CDP_INPUT_OVERLAY}' must be text, keys or off" ;;
    esac
    [ "${CDP_CONSOLE_PANEL_ACTIVE}" = "true" ] || CDP_INPUT_OVERLAY=off
}

config_auth() {
    # The built-in login + CDP API key (auth.sh); its state is console-managed
    # and persisted next to the console settings, on the /browser mount.
    ENABLE_AUTH="${ENABLE_AUTH:-true}"
    case "${ENABLE_AUTH}" in
        true|false) : ;;
        *) die "ENABLE_AUTH='${ENABLE_AUTH}' must be true or false" ;;
    esac
    AUTH_FILE="/browser/settings/auth.json"
    # The setup form's code (auth.sh makes a random one when empty).
    AUTH_SETUP_CODE="${AUTH_SETUP_CODE:-}"
    case "${AUTH_SETUP_CODE}" in
        *[![:graph:]]*) die "AUTH_SETUP_CODE must be printable ASCII without spaces" ;;
    esac
    if [ -n "${AUTH_SETUP_CODE}" ] && [ "${#AUTH_SETUP_CODE}" -lt 8 ]; then
        die "AUTH_SETUP_CODE needs at least 8 characters"
    fi
}

# Every port knob must be a plain TCP port number; a typo would otherwise
# only surface as an obscure nginx startup failure.
config_check_ports() {
    local port_var port_val
    for port_var in NGINX_LISTEN_HTTP_PORT NGINX_LISTEN_HTTPS_PORT CDP_LISTEN_PORT; do
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
