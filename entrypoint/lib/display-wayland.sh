# shellcheck shell=bash
# display-wayland.sh — the Wayland desktop (DISPLAY_BACKEND=wayland): labwc.
#
# labwc on the wlroots headless backend, i.e. a compositor + window manager
# with no screen of its own, which Selkies captures by screencopy
# (selkies.sh). Its headless output runs its own 60 Hz frame clock whether
# or not anyone watches the stream — Selkies' built-in compositor would only
# pace the browsers at a few (and varying) frames per second while no client
# is connected, which stalls Playwright's requestAnimationFrame-based
# "stable" checks into timeouts. With a GPU, labwc composites on it and the
# encoder reads its output in place (dmabuf zero-copy), so animated pages
# cost a fraction of what the per-frame copies through the software X
# server do.
#
# Leaves WAYLAND_DISPLAY exported and DISPLAY unset: everything started
# afterwards (selkies, chromium, the CDP gateway and its browsers) talks
# to labwc; there is no X display.

display_wayland_start() {
    wayland_write_config
    wayland_start_labwc
    wayland_size_output
    wayland_start_window_lock
}

# labwc maximizes every window (window rule) and leaves the frame to chromium
# (client decorations), so the browser keeps its tab strip and address bar.
# Its default keybinds are replaced on purpose — they would take e.g.
# Alt+Left/Right (back/forward in chromium) for window snapping; Alt+Tab
# still cycles windows.
# The windows are locked, always: the default mouse bindings are replaced
# by the click-to-focus ones alone (defining any mousebind drops all defaults), so
# Alt+drag, border drags, title bar buttons and the root menu (whose Exit
# would end labwc, and the container with it) do nothing; and fixedPosition
# refuses the interactive move/resize chromium asks for when its tab strip
# or edges are dragged — on a maximized window that move first restores it
# to a small centered one.
#
# New windows: labwc focuses and raises every window it maps, with no
# option against it. With the CDP console's "new windows to the front" off
# (desktop.raiseNewWindows, settings.sh) a rule lowers each window right as it maps, before its
# first frame, and the keyboard focus follows the pointer, which (every
# window maximized) means the window still in front keeps it. The config
# comes in both variants; the switch helper points rc.xml at one and makes
# labwc reload it.
wayland_write_config() {
    local labwc_mouse button raise focus rule
    labwc_mouse='<mouse><context name="Client">'
    for button in Left Middle Right; do
        labwc_mouse+="<mousebind button=\"${button}\" action=\"Press\"><action name=\"Focus\"/><action name=\"Raise\"/></mousebind>"
    done
    labwc_mouse+='</context></mouse>'
    mkdir -p /tmp/labwc
    for raise in true false; do
        focus="" rule=""
        if [ "${raise}" = "false" ]; then
            focus='<focus><followMouse>yes</followMouse><followMouseRequiresMovement>no</followMouseRequiresMovement></focus>'
            rule='<windowRule identifier="*"><action name="Lower"/></windowRule>'
        fi
        cat >"/tmp/labwc/rc-raise-new-windows-${raise}.xml" <<LABWCRC
<?xml version="1.0"?>
<labwc_config>
  <core><decoration>client</decoration></core>
  ${focus}
  <keyboard>
    <keybind key="A-Tab"><action name="NextWindow"/></keybind>
  </keyboard>
  ${labwc_mouse}
  <windowRules>
    ${rule}
    <windowRule identifier="*"><action name="Maximize"/></windowRule>
    <windowRule identifier="*" fixedPosition="yes"/>
  </windowRules>
</labwc_config>
LABWCRC
    done
    settings_apply_desktop
    # the CDP gateway repoints rc.xml as the run user
    give_to_run_user /tmp/labwc
    # The transparent cursor theme that keeps the pointer out of the
    # captured frames (rationale in the helper).
    python3 "${ENTRYPOINT_HELPERS}/labwc-cursor-theme.py" /tmp/labwc/icons/hidden
}

wayland_start_labwc() {
    # Sockets of an earlier run (docker restart keeps /tmp) would push labwc
    # to another name.
    rm -f "${XDG_RUNTIME_DIR}"/wayland-[0-9]* /tmp/labwc-display

    # GLES on the GPU when there is a Mesa-driven one, else pixman (CPU).
    # WLR_SCENE_DISABLE_VISIBILITY: wlroots otherwise sends no frame
    # callbacks to a window that is fully covered by another one (every
    # browser but the front one), so its requestAnimationFrame stalls at 0 and
    # Playwright actions in it time out; with it, covered windows keep
    # rendering like they do on Xvfb.
    # WLR_SCENE_DISABLE_DIRECT_SCANOUT: a headless output has no planes to
    # scan out, but a maximized browser, alone on the output, is a candidate
    # all the same, and wlroots then offers it scanout dmabuf feedback,
    # which needs a DRM device the headless backend lacks ("Failed to get
    # backend DRM FD" in labwc.log, once per browser with a GPU).
    local labwc_env=(WLR_BACKENDS=headless WLR_SCENE_DISABLE_VISIBILITY=1
        WLR_SCENE_DISABLE_DIRECT_SCANOUT=1
        XCURSOR_PATH=/tmp/labwc/icons XCURSOR_THEME=hidden XCURSOR_SIZE=24)
    if gpu_has_mesa_node; then
        labwc_env+=(WLR_RENDER_DRM_DEVICE="${GPU_RENDER_NODE}")
    else
        labwc_env+=(WLR_RENDERER=pixman)
    fi
    # Verified on an RTX 2080 Ti (CDI): chromium on Wayland gets no GPU
    # compositing from the injected NVIDIA stack (software, at best WebGL
    # with readback), while on X11 it composites on the GPU via Vulkan.
    if [ -e /dev/nvidiactl ] && ! gpu_has_mesa_node; then
        log "WARNING: DISPLAY_BACKEND=wayland with an NVIDIA GPU renders chromium in software; set DISPLAY_BACKEND=x11 to keep it on the GPU"
    fi
    log "starting labwc (headless Wayland desktop, ${labwc_env[*]: -1})"
    # The startup command (-s) reports labwc's auto-picked socket back here.
    start_service /tmp/labwc.log \
        env "${labwc_env[@]}" "${DROP[@]}" labwc -C /tmp/labwc \
        -s "${ENTRYPOINT_HELPERS}/labwc-report-display.sh"
    wait_until 100 0.2 test -s /tmp/labwc-display \
        || die "labwc did not come up within 20s; see /tmp/labwc.log"
    WAYLAND_DISPLAY="$(cat /tmp/labwc-display)"
    export WAYLAND_DISPLAY
    unset DISPLAY
}

# The headless output starts at 1280x720; bring it to SCREEN_GEOMETRY.
# Selkies' browser-driven resize (SELKIES_ENABLE_RESIZE) changes it later
# the same way, through labwc's output management.
wayland_size_output() {
    local output
    output="$("${DROP[@]}" wlr-randr 2>/dev/null | awk 'NR == 1 { print $1 }')"
    if [ -z "${output}" ] \
        || ! "${DROP[@]}" wlr-randr --output "${output}" --custom-mode "${SCREEN_WIDTH}x${SCREEN_HEIGHT}" \
            >/tmp/display-preset.log 2>&1; then
        log "WARN: sizing the labwc output to ${SCREEN_WIDTH}x${SCREEN_HEIGHT} failed (see /tmp/display-preset.log); it stays at its default until a client resizes it"
    fi
}

# The window lock's part labwc cannot refuse: undo Minimize/Restore from
# chromium's tab strip context menu (see the helper).
wayland_start_window_lock() {
    log "starting window lock (re-maximizes/unminimizes browser windows)"
    start_service /tmp/window-lock.log \
        "${DROP[@]}" bash "${ENTRYPOINT_HELPERS}/window-lock.sh"
}
