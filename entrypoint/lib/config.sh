# shellcheck shell=bash
# shellcheck disable=SC2034 # the knobs set here are read by the other modules
# config.sh — deployment environment: defaults and validation.
# Browser, capacity, display size and AI input preferences come from settings_load
# (settings.json / the web UI); their schema is cdp-gateway/src/settings-schema.mjs.
# The former preference variables are warned about and ignored by settings.sh.
#
# Environment reference (compose host-side ports and mounts are in compose.yaml):
#   ENABLE_SELKIES=true           start desktop streaming and audio services
#   ENABLE_CDP=true               enable on-demand browsers and public CDP; false keeps web settings
#   ENABLE_AUTH=true              built-in login and CDP API key service
#   AUTH_SETUP_CODE=""            setup code; empty generates and logs one
#   ENABLE_HTTPS=false            additionally serve TLS on the web UI
#   NGINX_LISTEN_HTTP_PORT=80      container HTTP listener
#   NGINX_LISTEN_HTTPS_PORT=443    container HTTPS listener
#   CDP_LISTEN_PORT=9222          container public CDP listener
#   NGINX_LISTEN_ADDR=""           listener address; empty = all interfaces
#   ALLOWED_HOSTS=""               accepted host names (IP addresses/localhost always work)
#   PORT_FORWARDS=""               extra nginx proxies: LISTEN=HOST:PORT, space/comma separated
#   SELKIES_SUBFOLDER=""           web UI path prefix, e.g. /desk
#   SELKIES_EXTRA_ARGS=""          extra Selkies arguments (selkies.sh)
#   DISPLAY_BACKEND=wayland       wayland (labwc) or x11 (Xvfb/picom)
#   TZ=UTC                        container timezone, inherited by processes
#   CHROMIUM_EXTRA_ARGS=""         extra Chromium arguments, appended last
#   CHROMIUM_SANDBOX=auto         auto or off; requires non-root and user namespaces
#   CHROMIUM_ALLOW_FILE_URLS=false allow file:// URLs in browsers
#   CHROMIUM_ALLOW_DEVTOOLS=true  allow DevTools windows
#   CDP_ALLOW_ORIGINS=""           web page origins allowed to use CDP; empty = none
#   CDP_ALLOW_BROWSER_CLOSE=false let a client close the shared browser
#   CDP_FILE_DIRS=/browser/downloads colon-separated permitted CDP local-file directories
#   CDP_CONSOLE_ACTIONS=true      console browser creation and individual tab closing
#   CDP_CONSOLE_RESTART=true      console container restart action (requires restart policy)
#   RUN_USER=browser              runtime uid[:gid] or username (privileges.sh)
#   CHROME_BIN=/opt/chrome-for-testing/chrome alternative binary (chromium.sh)
# Other native SELKIES_* settings pass through, except fixed resizing and the audio startup default.
# Fixed paths: /browser/{user-data,contexts,settings}; sockets /tmp/agentene;
# TLS /etc/nginx/tls/{fullchain,privkey}.pem. X11 RandR ceiling: 8192x4096x24.

config_load() {
    config_removed
    settings_load
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
    # display-wayland.sh), with or without the Selkies viewing service.
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
    # Browser preferences come from settings_load (the web configuration).
    CHROMIUM_USER_DATA_DIR="/browser/user-data"
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
    CDP_CONSOLE_RESTART="${CDP_CONSOLE_RESTART:-true}"
    case "${CDP_CONSOLE_RESTART}" in
        true|false) ;;
        *) die "CDP_CONSOLE_RESTART='${CDP_CONSOLE_RESTART}' must be true or false" ;;
    esac
    # The settings sidebar remains available in desktop-only mode.
    CDP_CONSOLE_PANEL_ACTIVE="${ENABLE_SELKIES}"

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
