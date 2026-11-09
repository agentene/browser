# shellcheck shell=bash
# display-x11.sh — the X11 desktop (DISPLAY_BACKEND=x11): Xvfb + picom.
#
# Selkies captures the Xvfb display through XShm; picom only supplies the
# compositing chromium needs for its popup shadows.

display_x11_start() {
    x11_pick_display
    x11_start_xvfb
    x11_preset_size
    x11_start_compositor
    x11_set_new_windows
}

# X clients try the display's ABSTRACT socket (@/tmp/.X11-unix/X<n>) before
# the filesystem one, and abstract sockets live in the network namespace.
# With network_mode: host a host X server (Xorg/Xwayland) on the same display
# number would capture chromium/selkies and make Xvfb fail — so skip to the
# next display number nobody uses there.
x11_pick_display() {
    local disp_num disp_wanted
    disp_num="${DISPLAY#*:}"
    disp_wanted="${disp_num}"
    while grep -q "[[:space:]]@/tmp/\.X11-unix/X${disp_num}\$" /proc/net/unix 2>/dev/null; do
        disp_num=$((disp_num + 1))
        [ "${disp_num}" -le $((disp_wanted + 100)) ] || die "no free X display found from :${disp_wanted} upwards"
    done
    if [ "${disp_num}" != "${disp_wanted}" ]; then
        log "display :${disp_wanted} is already taken in this network namespace (host network?) -> using :${disp_num}"
    fi
    DISPLAY=":${disp_num}"
}

# An X screen can never grow past the geometry it was created with, so a
# fixed -screen of SCREEN_GEOMETRY caps Selkies' browser-driven resize at the
# working size: a browser larger than the screen stays cropped ("screen
# cannot be larger than ..." in the selkies log). Create the screen at the
# SCREEN_GEOMETRY_MAX ceiling instead and preset the working size right after
# (x11_preset_size) — the same shape the official `selkies session` brings its
# display up in (XVFB_ARGS 8192x4096 + a RandR preset).
x11_start_xvfb() {
    XVFB_SCREEN="${SCREEN_GEOMETRY_MAX}"

    log "starting Xvfb on display ${DISPLAY} (screen ${XVFB_SCREEN}, working ${SCREEN_GEOMETRY})"
    # -nolisten local: no abstract socket, only /tmp/.X11-unix/X<n> inside
    # the container's filesystem. -ac turns X access control off, so an
    # abstract socket would let any process sharing the network namespace
    # (every host process, with network_mode: host) drive the browser.
    # TCP is off by default, and every extension Selkies/picom need
    # (Composite, DAMAGE, RANDR, RENDER, XTEST) is on by default (verified).
    start_service /tmp/xvfb.log \
        "${DROP[@]}" Xvfb "${DISPLAY}" -screen 0 "${XVFB_SCREEN}" \
        -nolisten local -ac -noreset
    local xsocket="/tmp/.X11-unix/X${DISPLAY#*:}"
    wait_until 50 0.2 test -S "${xsocket}" \
        || die "Xvfb did not create ${xsocket}; see /tmp/xvfb.log"
}

# Preset the working size through the same RandR path a browser resize
# takes (mode creation + screen size; `selkies resize` defaults to 60 Hz where
# nothing configured one). Cosmetic on failure: the display then stays at
# the ceiling until the first client resize.
x11_preset_size() {
    [ "${XVFB_SCREEN}" != "${SCREEN_GEOMETRY}" ] || return 0
    if ! "${DROP[@]}" selkies resize "${SCREEN_WIDTH}x${SCREEN_HEIGHT}" >/tmp/display-preset.log 2>&1; then
        log "WARN: presetting ${SCREEN_WIDTH}x${SCREEN_HEIGHT} failed (see /tmp/display-preset.log); the display stays at ${XVFB_SCREEN} until a client resizes it"
    fi
}

# Compositing manager for the fresh display. No WM runs here and Xvfb has no
# compositor of its own, and without a compositing manager chromium refuses
# to alpha-blend its popup windows: the right-click context menu loses its
# drop shadow and — being a plain white sheet — looks borderless against
# light pages. picom only needs to RUN: chromium paints the shadow itself
# into an ARGB popup window, picom supplies the blending. picom's own
# decorations stay off (shadow=false) so nothing is painted on top of
# chromium's; the backend is pinned to xrender because the GLX backend has
# nothing to grab on the GL-less Xvfb display. Cosmetic, so a picom that
# fails to start only warns; once running it is supervised like every
# service (its exit later stops the container).
x11_start_compositor() {
    printf 'shadow = false\nfading = false\nbackend = "xrender"\n' >/tmp/picom.conf
    log "starting picom compositor on display ${DISPLAY}"
    start_service /tmp/picom.log "${DROP[@]}" picom --config /tmp/picom.conf
    sleep 0.5
    kill -0 "${SERVICE_PID}" 2>/dev/null || log "WARNING: picom exited early; popup menus will render without shadows (see /tmp/picom.log)"
}

# Whether new windows come to the front (DESKTOP_RAISE_NEW_WINDOWS; the CDP
# console's switch changes it later). No window manager runs here: the
# screen follower (chromium.sh) applies it, reading the setting the helper
# writes.
x11_set_new_windows() {
    DISPLAY_BACKEND=x11 "${ENTRYPOINT_HELPERS}/desktop-raise-new-windows.sh" \
        "${DESKTOP_RAISE_NEW_WINDOWS}" || die "cannot write /tmp/desktop-raise-new-windows"
    # the CDP gateway flips the switch as the run user
    give_to_run_user /tmp/desktop-raise-new-windows
}
