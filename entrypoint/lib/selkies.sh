# shellcheck shell=bash
# selkies.sh — the Selkies HTML5 remote desktop, on a unix socket behind nginx.
#
# Extra settings ride the native SELKIES_* env vars (CLI > env > default),
# e.g. SELKIES_ENCODER (selkies' own default: h264enc).

selkies_start() {
    local extra_args=()
    selkies_backend_args
    selkies_media_defaults
    [ -n "${SELKIES_EXTRA_ARGS:-}" ] && read -r -a extra_args <<< "${SELKIES_EXTRA_ARGS}"

    log "starting selkies on ${SELKIES_SOCKET} (${DISPLAY_BACKEND}, path ${SELKIES_SUBFOLDER:-/}, fronted by nginx)"
    # TLS terminates at nginx, so selkies itself always serves plain HTTP on
    # the socket nginx proxies to. A unix socket, not a loopback port: a page
    # in the browser could open a loopback port's origin and use the desktop
    # past nginx's login (config.sh). Authentication belongs to nginx: Basic
    # Auth and token-based secure mode stay disabled even when extra args or
    # native env settings request them.
    start_service - \
        "${DROP[@]}" selkies \
        --unix-socket="${SELKIES_SOCKET}" \
        --subfolder="${SELKIES_SUBFOLDER}" \
        --enable-resize="${SELKIES_ENABLE_RESIZE:-true}" \
        "${SELKIES_BACKEND_ARGS[@]}" \
        "${extra_args[@]}" \
        --enable-basic-auth=false \
        --master-token=
}

# Hold nginx back until Selkies answers on its socket: it binds only after
# attaching to the display (~0.5 s after its start on X11 and Wayland alike,
# by which time chromium is up and nginx would already be serving), so the
# first web UI requests got 502s and the "ready" line came early. Any HTTP
# answer counts. The socket is then
# opened to the nginx workers, who are nobody with RUN_USER=0 (Selkies:
# root); otherwise they are Selkies' own user anyway.
selkies_wait_ready() {
    if wait_until 150 0.2 curl -sS -o /dev/null --unix-socket "${SELKIES_SOCKET}" http://selkies/ >/dev/null 2>&1; then
        chmod 0666 "${SELKIES_SOCKET}"
    else
        log "WARNING: selkies is not answering on ${SELKIES_SOCKET} after 30s; nginx serves 502 until it does"
    fi
}

# Media defaults, as the native SELKIES_* env vars so a user value (including
# a "|locked" suffix) wins. Every media path is available but only the video
# stream starts with the session: audio, microphone, webcam and gamepads wait
# for the side menu toggle (selkies itself starts audio and gamepads, and has
# microphone and webcam off).
# Turbo (video_streaming_mode) is off: selkies would encode every frame even
# of a still desktop, ~2.5% of a core at 1080p for as long as a viewer
# watches; damage-gated, a still screen costs next to nothing and changes
# still stream at the full frame rate. The side menu turns it on for video
# or games.
selkies_media_defaults() {
    export SELKIES_VIDEO_STREAMING_MODE="${SELKIES_VIDEO_STREAMING_MODE:-false}"
    export SELKIES_VIDEO_ON_START="${SELKIES_VIDEO_ON_START:-true}"
    export SELKIES_AUDIO_ENABLED="${SELKIES_AUDIO_ENABLED:-true}"
    export SELKIES_AUDIO_ON_START="${SELKIES_AUDIO_ON_START:-false}"
    export SELKIES_MICROPHONE_ENABLED="${SELKIES_MICROPHONE_ENABLED:-true}"
    export SELKIES_MICROPHONE_ON_START="${SELKIES_MICROPHONE_ON_START:-false}"
    export SELKIES_WEBCAM_ENABLED="${SELKIES_WEBCAM_ENABLED:-true}"
    export SELKIES_WEBCAM_ON_START="${SELKIES_WEBCAM_ON_START:-false}"
    export SELKIES_GAMEPAD_ENABLED="${SELKIES_GAMEPAD_ENABLED:-true}"
    export SELKIES_GAMEPAD_ON_START="${SELKIES_GAMEPAD_ON_START:-false}"
    # Tell selkies the browsers get the input interposer (chromium.sh), so
    # uinput_gamepad=auto never also registers kernel pads where /dev/uinput
    # happens to be writable: chromium would see every pad twice.
    export SELKIES_INTERPOSER="${SELKIES_INTERPOSER:-/usr/local/lib/selkies-interposers/selkies_input_interposer.so}"
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
    # AMD GPU, and still so with 2.2.3 (repeated capture failures, black
    # picture).
    export PIXELFLUX_HOST_CAPTURE=zwlr
    # Without the browser-driven resize selkies sizes a captured host to its
    # own default (1024x768) when a stream starts; pin it to the
    # SCREEN_GEOMETRY labwc was started at instead, like the fixed Xvfb
    # screen (an explicit SELKIES_MANUAL_* setting still wins).
    if [ "${SELKIES_ENABLE_RESIZE:-true}" != "true" ] \
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
