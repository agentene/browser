# shellcheck shell=bash
# chromium.sh — the Chrome for Testing browser with a loopback CDP endpoint.
#
# The flags are assembled in three parts — CHROMIUM_COMMON_FLAGS, the
# headless/headed mode part (chromium_mode_flags) and CHROMIUM_TAIL_FLAGS —
# so the CDP gateway (cdp-gateway.sh) launches its per-context browsers
# with the exact same policy. New chromium flags belong in one of those.
# Everything the entrypoint adds goes BEFORE CHROMIUM_EXTRA_ARGS, so user
# flags win (chromium honors the last occurrence of a repeated switch).
#
# With CHROMIUM_AUTOSTART=false the main browser is not started here: its
# command line goes to CHROMIUM_MAIN_FLAGS_FILE and the CDP gateway starts it
# on demand, as its own child (so closing it does not stop the container).
#
# Sets for cdp-gateway.sh: CHROME_BIN, CHROMIUM_COMMON_FLAGS,
# CHROMIUM_TAIL_FLAGS, CHROMIUM_ENV, CHROMIUM_LOCALE_POSIX, CHROMIUM_PID
# (empty when on demand), CHROMIUM_MAIN_FLAGS_FILE.

chromium_start() {
    CHROME_BIN="${CHROME_BIN:-/opt/chrome-for-testing/chrome}"
    [ -x "${CHROME_BIN}" ] || die "chrome binary not found: ${CHROME_BIN}"

    chromium_resolve_gpu
    chromium_resolve_headless
    chromium_build_flags
    chromium_build_env
    chromium_start_follower
    chromium_prepare_profile
    chromium_launch
}

# --- GPU: hardware GL when the container owns a real GPU (gpu.sh) --------------
# In "hw" mode chromium renders via Vulkan/ANGLE (see chromium_build_flags),
# which needs no GL visuals from the software Xvfb display. Sets GPU_HW.
chromium_resolve_gpu() {
    if [ "${CHROMIUM_GPU}" = "auto" ]; then
        if [ -n "${GPU_RENDER_NODE}" ]; then
            CHROMIUM_GPU=hw
        else
            CHROMIUM_GPU=sw
        fi
    fi
    # Render on the device when one is present, except in "off" mode ("off"
    # forces the software path even with a GPU attached). "strict" keeps its
    # name — the SwiftShader decision needs to tell it apart — but still uses
    # a present device.
    if [ -n "${GPU_RENDER_NODE}" ] && [ "${CHROMIUM_GPU}" != "off" ]; then
        GPU_HW=true
    else
        GPU_HW=false
    fi
    log "chromium: GPU mode=${CHROMIUM_GPU}${GPU_RENDER_NODE:+ (${GPU_RENDER_NODE})}"
}

# desktop_ready: true when the display a headed browser needs exists.
desktop_ready() {
    if [ "${DISPLAY_BACKEND}" = "wayland" ]; then
        [ -n "${WAYLAND_DISPLAY:-}" ] && [ -S "${XDG_RUNTIME_DIR}/${WAYLAND_DISPLAY}" ]
    else
        [ -S "/tmp/.X11-unix/X${DISPLAY#*:}" ]
    fi
}

# Headed is the default so the browser window is visible in the Selkies
# stream; but a headed browser needs the desktop of display-*.sh; without it
# (ENABLE_SELKIES=false and no external display) fall back to headless.
chromium_resolve_headless() {
    if [ "${CHROMIUM_HEADLESS}" = "0" ] && [ "${ENABLE_SELKIES}" != "true" ] && ! desktop_ready; then
        log "WARNING: no ${DISPLAY_BACKEND} display for a headed chromium -> falling back to headless"
        CHROMIUM_HEADLESS=1
    fi
}

# chromium_mode_flags <headless 0|1>: the mode-specific part, into MODE_FLAGS
chromium_mode_flags() {
    MODE_FLAGS=()
    if [ "$1" = "1" ]; then
        # --disable-gpu only without a usable device: new headless renders
        # on the GPU when one is passed in (see gpu.sh).
        MODE_FLAGS+=(--headless)
        [ "${GPU_HW}" = "true" ] || MODE_FLAGS+=(--disable-gpu)
    elif [ "${DISPLAY_BACKEND}" = "wayland" ]; then
        # Headed in labwc, which maximizes every browser window itself (see
        # its rc.xml in display-wayland.sh), so no geometry is pinned here.
        MODE_FLAGS+=(--ozone-platform=wayland --start-maximized --no-first-run)
    else
        # Headed on the Xvfb display (default): the browser window shows up in
        # the Selkies stream, so automation can be watched live.
        # No window manager runs on this Xvfb display, so --start-maximized
        # would be inert; chrome would otherwise restore a stale window position
        # from the persisted profile (e.g. +184+163, off the screen) and
        # shaves 1px off a window size that exactly matches the screen.
        # Pin the window to the top-left corner and ask for one extra pixel
        # per axis: the result covers the screen exactly (the spillover is
        # clipped by the screen edges).
        MODE_FLAGS+=(--window-position="0,0" \
            --window-size="$((SCREEN_WIDTH + 1)),$((SCREEN_HEIGHT + 1))" \
            --no-first-run)
    fi
}

chromium_build_flags() {
    CHROMIUM_COMMON_FLAGS=(--no-sandbox
        # shared memory goes to /tmp instead of /dev/shm, so docker's 64 MB
        # default /dev/shm is enough and no --shm-size / shm_size is needed
        # (verified: 12 heavy tabs, 0 KB used in /dev/shm, no crash)
        --disable-dev-shm-usage
        # suppress the "Chrome for testing is only for automated testing"
        # banner bar (verified pixel-level: the ~36px band disappears)
        --disable-infobars
        # skip the field-trial testing config Chrome for Testing bakes in,
        # as Playwright's own launches do: one of its experiments throttles
        # requestAnimationFrame to 15 fps once a page has painted nothing
        # for ~5 s (verified headed and headless, X11 and Wayland), which
        # slows Playwright's rAF-based actionability checks on static pages
        --disable-field-trial-config)

    CHROMIUM_TAIL_FLAGS=()
    # Hardware GL via the Vulkan/ANGLE backend. Explicit on purpose:
    # chromium's automatic backend selection prefers the native-GL path,
    # which cannot work on the software Xvfb display (no window-system GL
    # visuals -> "Couldn't find an EGLConfig", the GPU process exits and
    # chrome://gpu ends up all-disabled). Vulkan renders offscreen and
    # presents to the X window via xcb, which needs no GL visuals.
    # Verified on nvidia CDI passthrough (RTX 2080 Ti): WebGL then reports
    # "ANGLE (NVIDIA, Vulkan 1.4.341 (NVIDIA GeForce RTX 2080 Ti))", while
    # auto selection lands on SwiftShader and forced "--use-angle=gl" kills
    # WebGL entirely. --enable-features=Vulkan additionally moves the
    # display compositor (viz) onto Vulkan: without it viz composites in
    # software and chrome://gpu reports WebGL/WebGPU as "enabled_readback"
    # ("Hardware accelerated but at reduced performance" — GPU frames are
    # read back into the CPU compositor). With it, verified on the AMD
    # iGPU (RADV): gpu_compositing=enabled, webgl/webgpu=enabled (no
    # readback). If the Vulkan stack is unusable, chromium falls back
    # internally and SwiftShader (allowed below) keeps WebGL alive.
    # Both are appended before CHROMIUM_EXTRA_ARGS so a user's own
    # --enable-features there still wins (chromium keeps the last
    # occurrence of a repeated switch).
    # X11 only: on Wayland chromium renders through EGL natively (ANGLE GL on
    # the GPU, verified on the AMD iGPU: gpu_compositing=enabled, radeonsi),
    # and declares itself incompatible with Vulkan ("'--ozone-platform=
    # wayland' is not compatible with Vulkan"; with the flags a context
    # browser's GPU process crashed and its page stopped rendering).
    if [ "${GPU_HW}" = "true" ] && [ "${DISPLAY_BACKEND}" = "x11" ]; then
        CHROMIUM_TAIL_FLAGS+=(--use-angle=vulkan --enable-features=Vulkan)
    fi
    # Software WebGL fallback: Chrome 137+ gates SwiftShader behind
    # --enable-unsafe-swiftshader; without the switch WebGL is unavailable.
    # Allowed in every mode except "strict" — the browser must never report
    # a SwiftShader renderer there — so WebGL works without a GPU (auto/off)
    # and survives a device that errors out mid-run (auto with hardware).
    if [ "${CHROMIUM_GPU}" != "strict" ]; then
        CHROMIUM_TAIL_FLAGS+=(--enable-unsafe-swiftshader)
    fi
    # Keep plain http:// pages as they are (typical for CDP automation
    # against internal or intercepted sites): no HTTPS-First / HTTPS-Upgrade.
    # Appended before CHROMIUM_EXTRA_ARGS so a --disable-features passed
    # there still wins (chromium keeps the last occurrence of a repeated
    # switch).
    CHROMIUM_TAIL_FLAGS+=("--disable-features=HttpsFirstBalancedModeAutoEnable,HttpsUpgrades,HttpsFirstModeV2")
    if [ -n "${CHROMIUM_EXTRA_ARGS:-}" ]; then
        # split the flag string into words — same semantics as an unquoted
        # expansion, but robust for the array append
        local extra_flags
        read -r -a extra_flags <<< "${CHROMIUM_EXTRA_ARGS}"
        CHROMIUM_TAIL_FLAGS+=("${extra_flags[@]}")
    fi

    chromium_mode_flags "${CHROMIUM_HEADLESS}"
    # The Wayland app_id the CDP console raises the main window by (the
    # gateway gives each context browser its own, cdp-<context>).
    local main_window_flags=()
    if [ "${DISPLAY_BACKEND}" = "wayland" ] && [ "${CHROMIUM_HEADLESS}" = "0" ]; then
        main_window_flags=(--class=cdp-main)
    fi
    CHROMIUM_FLAGS=("${CHROMIUM_COMMON_FLAGS[@]}"
        --user-data-dir="${CHROMIUM_USER_DATA_DIR}"
        --remote-debugging-port="${CDP_INTERNAL_PORT}"
        "${MODE_FLAGS[@]}" "${main_window_flags[@]}" "${CHROMIUM_TAIL_FLAGS[@]}")
}

# Environment of the browsers (main and contexts), into CHROMIUM_ENV and
# CHROMIUM_LOCALE_POSIX.
chromium_build_env() {
    # Chromium on Linux ignores --lang for both UI and Accept-Language; the
    # LANG env var is what selects them (verified with LANG=zh_CN.UTF-8:
    # Chinese UI, zh-CN navigator.language, zh-CN,zh selected_languages).
    # Map the BCP-47 spelling (e.g. en-US) to the POSIX one (en_US.UTF-8).
    CHROMIUM_LOCALE_POSIX="$(echo "${CHROMIUM_LANG}" | tr '-' '_').UTF-8"

    # Title bar behavior of the Wayland browsers (main and contexts; the
    # buttons and click actions of chromium's own frame come from GSettings
    # org.gnome.desktop.wm.preferences, read here from a keyfile instead of
    # a dconf daemon): only the close button, and double/middle clicks on
    # the tab strip do nothing — the default double-click un-maximizes the
    # window. Verified: a double-click keeps the window maximized with
    # 'none', and restores it to 945x1060 without. The right-click context
    # menu (with Minimize/Restore) ignores these settings; the window lock
    # loop next to labwc (display-wayland.sh) undoes what it does.
    CHROMIUM_ENV=()
    if [ "${DISPLAY_BACKEND}" = "wayland" ]; then
        mkdir -p /tmp/chromium-config/glib-2.0/settings
        cat >/tmp/chromium-config/glib-2.0/settings/keyfile <<'GSKEYFILE'
[org/gnome/desktop/wm/preferences]
button-layout=':close'
action-double-click-titlebar='none'
action-middle-click-titlebar='none'
GSKEYFILE
        # XDG_CONFIG_HOME is also where chromium keeps its crashpad
        # database: a dropped chromium that cannot write there dies at
        # startup ("chrome_crashpad_handler: --database is required").
        give_to_run_user -R /tmp/chromium-config
        CHROMIUM_ENV=(GSETTINGS_BACKEND=keyfile XDG_CONFIG_HOME=/tmp/chromium-config)
    fi
    CHROMIUM_ENV=(LANG="${CHROMIUM_LOCALE_POSIX}" LC_ALL="${CHROMIUM_LOCALE_POSIX}" "${CHROMIUM_ENV[@]}")
    chromium_device_interposers
}

# The viewer's webcam and gamepads (Selkies' webcam_enabled/gamepad_enabled)
# reach applications through Selkies' sockets in XDG_RUNTIME_DIR, which the
# interposers built into the image (Dockerfile) turn into /dev/video0 and
# /dev/input/js*/event1000+ for the processes they are preloaded into;
# fake-udev lists those pads to chromium's libudev-based gamepad discovery.
# The browsers alone get them: Selkies must keep seeing the real device nodes.
chromium_device_interposers() {
    local dir=/usr/local/lib/selkies-interposers
    [ "${ENABLE_SELKIES}" = "true" ] || return 0
    # The input interposer adds its nodes to a /dev/input listing, so the
    # directory has to exist; a container's /dev has none.
    [ -d /dev/input ] || mkdir -m1777 /dev/input 2>/dev/null \
        || log "WARNING: cannot create /dev/input; gamepads may not reach chromium"
    CHROMIUM_ENV+=(LD_PRELOAD="${dir}/selkies_v4l2_interposer.so:${dir}/selkies_input_interposer.so:${dir}/libudev.so.1${LD_PRELOAD:+:${LD_PRELOAD}}")
}

# Screen follower (X11, headed only). The launch flags size the window for
# the startup screen only, and no window manager runs on this display to
# re-maximize it, so after Selkies' browser-driven resize the window stayed
# at SCREEN_GEOMETRY: a larger screen showed it in one corner next to black,
# a smaller one cropped it. The helper refits chromium's main windows on
# every screen change. Started before chromium so the first window is
# caught at map time. Once started it is supervised like every service.
# X11 only: labwc keeps the windows maximized on the Wayland desktop.
chromium_start_follower() {
    if [ "${CHROMIUM_HEADLESS}" != "0" ] || [ "${DISPLAY_BACKEND}" != "x11" ]; then
        return 0
    fi
    log "starting chromium screen follower on display ${DISPLAY}"
    start_service /tmp/chromium-follow-screen.log \
        "${DROP[@]}" python3 -u "${ENTRYPOINT_HELPERS}/chromium-follow-screen.py"
}

chromium_prepare_profile() {
    # A persisted profile carries Singleton* lock files from the previous
    # run, bound to the old container hostname/pid; chrome refuses to start
    # on them ("profile in use by another process"). They are runtime-only
    # artifacts, so clear them before every launch.
    rm -f "${CHROMIUM_USER_DATA_DIR}"/SingletonLock \
          "${CHROMIUM_USER_DATA_DIR}"/SingletonSocket \
          "${CHROMIUM_USER_DATA_DIR}"/SingletonCookie
    # Seed the profile's language prefs (rationale in the helper).
    "${DROP[@]}" mkdir -p "${CHROMIUM_USER_DATA_DIR}/Default"
    "${DROP[@]}" python3 "${ENTRYPOINT_HELPERS}/chromium-seed-prefs.py" \
        "${CHROMIUM_USER_DATA_DIR}/Default/Preferences" "${CHROMIUM_LANG}"
}

# STOP_HOOKS entry (supervisor.sh): close the main browser through CDP before
# the services get their signals, so the cookies and the session it holds in
# memory reach the profile (see the helper for why a signal is not enough).
# Covers an on-demand browser too: the supervisor would SIGKILL the gateway
# before it finished closing it. Bounded well inside docker stop's 10s.
chromium_close() {
    timeout 8 node "${ENTRYPOINT_HELPERS}/chromium-close.mjs" "${CDP_INTERNAL_PORT}" 6000 \
        || log "WARNING: chromium did not close in time; stopping it with a signal (recent cookies may be lost)"
}

chromium_launch() {
    CHROMIUM_PID=""
    CHROMIUM_MAIN_FLAGS_FILE=/tmp/cdp-gateway-main-flags
    STOP_HOOKS+=(chromium_close)
    if [ "${CHROMIUM_AUTOSTART}" = "false" ]; then
        # NUL-separated, read by the gateway; the log file is pre-created for
        # the (possibly dropped) gateway, which appends a run per start
        printf '%s\0' "${CHROMIUM_FLAGS[@]}" "${CHROMIUM_START_URL}" >"${CHROMIUM_MAIN_FLAGS_FILE}"
        : >/tmp/chromium.log
        give_to_run_user /tmp/chromium.log
        log "chromium: on demand (CHROMIUM_AUTOSTART=false) — the CDP gateway starts it on the first CDP client or from the console"
        return 0
    fi
    log "starting chromium (headless=${CHROMIUM_HEADLESS}) with CDP on 127.0.0.1:${CDP_INTERNAL_PORT}"
    start_service /tmp/chromium.log \
        env "${CHROMIUM_ENV[@]}" "${DROP[@]}" "${CHROME_BIN}" "${CHROMIUM_FLAGS[@]}" "${CHROMIUM_START_URL}"
    # shellcheck disable=SC2034 # read by cdp-gateway.sh
    CHROMIUM_PID="${SERVICE_PID}"

    # Wait for the loopback DevTools endpoint before forwarding.
    wait_until 100 0.2 curl -fsS "http://127.0.0.1:${CDP_INTERNAL_PORT}/json/version" >/dev/null 2>&1 \
        || log "WARNING: chromium DevTools endpoint not up yet; nginx forwards anyway (see /tmp/chromium.log)"
}
