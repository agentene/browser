# shellcheck shell=bash
# desktop-background.sh — the desktop's background picture.
#
# What the Selkies stream shows where no browser window covers the screen
# (every window is maximized, so in practice: once the browsers are closed,
# or before the first one starts with CHROMIUM_AUTOSTART=false). The image
# ships with the image (entrypoint/assets/desktop-background.png) and is not
# a knob: it is drawn at its own size, centered on a neutral gray (#9aa0a6, easy
# on the eyes; its transparent parts show the gray too — the X11 helper
# holds the same color), at every screen size.
#
#   wayland  swaybg, patched to stretch one solid-color pixel over the output and center a small image subsurface. Its memfd buffers are bounded by the image size, including at fractional output scales.
#   x11      x11-desktop-background, a native Cairo/Xlib helper: a tiled 1x1 root color and an image-sized, input-transparent window kept below every browser. Resizing only moves the image; it never reallocates a screen-sized pixmap.
#
# Cosmetic, so a background that fails to start only warns and is dropped
# from the supervised services; once running it is supervised like every
# service (its exit later stops the container).

desktop_background_start() {
    local image="${ENTRYPOINT_HOME}/assets/desktop-background.png"
    log "starting the desktop background (${image##*/})"
    case "${DISPLAY_BACKEND}" in
        wayland)
            start_service /tmp/desktop-background.log \
                "${DROP[@]}" swaybg --output '*' --image "${image}" \
                --mode center --color '#9AA0A6'
            ;;
        x11)
            start_service /tmp/desktop-background.log \
                "${DROP[@]}" x11-desktop-background \
                "${image}"
            ;;
    esac
    sleep 0.5
    if ! kill -0 "${SERVICE_PID}" 2>/dev/null; then
        log "WARNING: the desktop background exited early; the desktop stays black (see /tmp/desktop-background.log)"
        unset 'pids[-1]'
    fi
}
