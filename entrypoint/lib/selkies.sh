# shellcheck shell=bash
# selkies.sh — the Selkies HTML5 remote desktop, on loopback behind nginx.
#
# Extra settings ride the native SELKIES_* env vars (CLI > env > default).

selkies_start() {
    local auth_flag extra_args=()
    auth_flag="$(selkies_auth_flag)"
    selkies_backend_args
    [ -n "${SELKIES_EXTRA_ARGS:-}" ] && read -r -a extra_args <<< "${SELKIES_EXTRA_ARGS}"

    log "starting selkies on ${SELKIES_ADDR}:${SELKIES_INTERNAL_PORT} (${DISPLAY_BACKEND}, encoder ${SELKIES_ENCODER:-h264enc}, path ${SELKIES_SUBFOLDER:-/}, fronted by nginx)"
    # TLS terminates at nginx, so selkies itself always serves plain HTTP on
    # the loopback port nginx proxies to.
    start_service - \
        "${DROP[@]}" selkies \
        --addr="${SELKIES_ADDR}" \
        --port="${SELKIES_INTERNAL_PORT}" \
        --subfolder="${SELKIES_SUBFOLDER}" \
        --encoder="${SELKIES_ENCODER:-h264enc}" \
        --enable-resize="${SELKIES_ENABLE_RESIZE:-false}" \
        "${SELKIES_BACKEND_ARGS[@]}" \
        "${auth_flag}" \
        "${extra_args[@]}"
}

# Hold nginx back until Selkies answers on its loopback port: it binds only
# after attaching to the display (~0.5 s after its start on X11 and Wayland
# alike, by which time chromium is up and nginx would already be serving),
# so the first web UI requests got 502s and the "ready" line came early.
# Any HTTP answer counts (a login-protected UI replies 401).
selkies_wait_ready() {
    wait_until 150 0.2 curl -sS -o /dev/null "http://127.0.0.1:${SELKIES_INTERNAL_PORT}/" >/dev/null 2>&1 \
        || log "WARNING: selkies is not answering on 127.0.0.1:${SELKIES_INTERNAL_PORT} after 30s; nginx serves 502 until it does"
}

# Enable the login screen only when a password is around; Selkies refuses to
# start with auth enabled and no password. Username resolves natively from
# SELKIES_BASIC_AUTH_USER / CUSTOM_USER / USERNAME / USER and falls back to
# selkies' built-in default "ubuntu" (e.g. no USER in the image).
selkies_auth_flag() {
    if [ -n "${SELKIES_ENABLE_BASIC_AUTH:-}" ]; then
        echo "--enable-basic-auth=${SELKIES_ENABLE_BASIC_AUTH}"
    elif [ -n "${SELKIES_BASIC_AUTH_PASSWORD:-}${PASSWORD:-}${PASSWD:-}" ]; then
        echo "--enable-basic-auth=true"
    else
        log "no SELKIES_BASIC_AUTH_PASSWORD set -> serving without login" >&2
        echo "--enable-basic-auth=false"
    fi
}

# Display-backend specific selkies flags, into SELKIES_BACKEND_ARGS.
selkies_backend_args() {
    SELKIES_BACKEND_ARGS=()
    [ "${DISPLAY_BACKEND}" = "wayland" ] || return 0
    # Capture labwc (display-wayland.sh) as an external compositor: frames
    # come in by screencopy into GPU buffers the encoder reads in place, and
    # input/clipboard go back through labwc's virtual keyboard/pointer and
    # data-control protocols. Selkies still brings up its own (idle)
    # compositor as well. Render and encode on the GPU labwc and chromium
    # use: the frames only stay on the GPU when it is the same one, and
    # selkies' own pick is the first GPU it finds — on a host with an extra
    # NVIDIA card that can be one the container has no driver for, which
    # silently degrades to x264 on the CPU.
    SELKIES_BACKEND_ARGS=(--wayland=true --wayland-host-display="${WAYLAND_DISPLAY}")
    # Capture through wlr-screencopy. labwc >= 0.9 also offers
    # ext-image-copy-capture, which pixelflux prefers, but labwc fails to
    # import the GPU buffers pixelflux allocates for it (EGL_BAD_MATCH every
    # frame, the stream never starts) — verified with pixelflux 2.2.1 on an
    # AMD GPU. Any other value set by the user (e.g. auto) lets pixelflux
    # pick again.
    export PIXELFLUX_HOST_CAPTURE="${PIXELFLUX_HOST_CAPTURE-zwlr}"
    # Without the browser-driven resize selkies sizes a captured host to its
    # own default (1024x768) when a stream starts; pin it to the
    # SCREEN_GEOMETRY labwc was started at instead, like the fixed Xvfb
    # screen (an explicit SELKIES_MANUAL_* setting still wins).
    if [ "${SELKIES_ENABLE_RESIZE:-false}" != "true" ] \
        && [ -z "${SELKIES_MANUAL_WIDTH:-}${SELKIES_MANUAL_HEIGHT:-}${SELKIES_MANUAL_RESOLUTION:-}" ]; then
        SELKIES_BACKEND_ARGS+=(--manual-resolution=true
            --manual-width="${SCREEN_WIDTH}"
            --manual-height="${SCREEN_HEIGHT}")
    fi
    if gpu_has_mesa_node; then
        [ -n "${SELKIES_RENDER_DRI:-}${DRINODE:-}" ] \
            || SELKIES_BACKEND_ARGS+=(--render-dri="${GPU_RENDER_NODE}")
        [ -n "${SELKIES_ENCODE_DRI:-}${DRI_NODE:-}" ] \
            || SELKIES_BACKEND_ARGS+=(--encode-dri="${GPU_RENDER_NODE}")
    fi
    return 0
}
