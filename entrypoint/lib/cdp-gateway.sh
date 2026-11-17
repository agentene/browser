# shellcheck shell=bash
# cdp-gateway.sh — the browser manager and web console (always on).
# Sets: CDP_GATEWAY_PID (the supervised gateway, checked by the stop hook).
#
# A Node gateway between nginx and chromium. Default-context clients pass
# through to the main browser untouched; an isolated client's
# Target.createBrowserContext instead gets a separate chromium on a clone of
# the main profile (logins included), destroyed again when the context is
# disposed or the client disconnects. Details in
# /usr/local/lib/cdp-gateway/gateway.mjs and the README ("CDP gateway").
# Needs chromium.sh to have run first (flags, env). The gateway also owns the
# main browser: it starts it from CHROMIUM_MAIN_FLAGS_FILE on demand and outlives it, so the
# browser closing or crashing does not stop the container. It is the only
# way to the browsers: they speak CDP on a pipe to it (no DevTools port),
# Its console listens on CONSOLE_SOCKET, and CDP on CDP_GATEWAY_SOCKET when
# enabled. nginx fronts each separately; neither listens on TCP.

cdp_gateway_start() {
    local flags_file=""
    if [ "${ENABLE_CDP}" != "true" ]; then CHROMIUM_ENV=(); fi
    if [ "${ENABLE_CDP}" = "true" ]; then
        # Isolated contexts live until their client leaves, so nothing survives a
        # restart: drop the leftover clones. Only the gateway's own context-N
        # dirs — the directory sits on the /browser mount next to the live profile.
        rm -rf "${CDP_CONTEXTS_DIR}"/context-*
        mkdir -p "${CDP_CONTEXTS_DIR}"
        give_to_run_user "${CDP_CONTEXTS_DIR}"

        # The context browsers get the main browser's flags minus its profile and
        # DevTools port (the gateway adds its own), NUL-separated.
        chromium_mode_flags
        flags_file=/tmp/cdp-gateway-chromium-flags
        printf '%s\0' "${CHROMIUM_COMMON_FLAGS[@]}" "${MODE_FLAGS[@]}" \
            "${CHROMIUM_TAIL_FLAGS[@]}" >"${flags_file}"

    fi

    # Preserve the current screen size while someone watches Selkies.
    local viewer_socket=""
    [ "${ENABLE_SELKIES}" = "true" ] && viewer_socket="${SELKIES_SOCKET}"

    # The console's "new windows to the front" (settings.sh): the helper that
    # applies it, when the browsers have a desktop to open windows on.
    local raise_switch="${ENTRYPOINT_HELPERS}/desktop-raise-new-windows.sh"

    local endpoints="console=${CONSOLE_SOCKET}"
    [ "${ENABLE_CDP}" = "true" ] && endpoints="${endpoints} CDP=${CDP_GATEWAY_SOCKET}"
    log "starting CDP gateway on ${endpoints} (main browser on demand, max ${CDP_CONTEXTS_MAX} running contexts, overflow=${CDP_CONTEXTS_OVERFLOW}, max ${CDP_CONTEXTS_HIBERNATED_MAX} sleepers, desktop=${DISPLAY_BACKEND}, data in ${CDP_CONTEXTS_DIR}, web page origins allowed: ${CDP_ALLOW_ORIGINS:-none}, client Browser.close reaches the browser: ${CDP_ALLOW_BROWSER_CLOSE}, local files clients may name: ${CDP_FILE_DIRS}, input overlay: ${CDP_INPUT_OVERLAY})"
    start_service /tmp/cdp-gateway.log \
        env CHROME_BIN="${CHROME_BIN:-}" CHROMIUM_USER_DATA_DIR="${CHROMIUM_USER_DATA_DIR}" \
        CDP_LISTEN_PORT="${CDP_LISTEN_PORT}" CDP_GATEWAY_SOCKET="${CDP_GATEWAY_SOCKET}" \
        CONSOLE_SOCKET="${CONSOLE_SOCKET}" \
        CDP_CONSOLE_ACTIONS="${CDP_CONSOLE_ACTIONS}" \
        CDP_CONSOLE_RESTART="${CDP_CONSOLE_RESTART}" \
        CDP_CONTEXTS_DIR="${CDP_CONTEXTS_DIR}" \
        CDP_GATEWAY_BROWSER_ENABLED="${ENABLE_CDP}" CDP_GATEWAY_DESKTOP_ENABLED=true \
        CDP_GATEWAY_STREAM_ENABLED="${ENABLE_SELKIES}" \
        CDP_GATEWAY_GPU_DEVICE="${GPU_RENDER_NODE}" \
        DISPLAY_BACKEND="${DISPLAY_BACKEND}" \
        CDP_GATEWAY_FLAGS_FILE="${flags_file}" \
        CDP_GATEWAY_VIEWER_SOCKET="${viewer_socket}" \
        CDP_GATEWAY_SCREEN_SIZE="${SCREEN_WIDTH}x${SCREEN_HEIGHT}" \
        CDP_GATEWAY_MAIN_FLAGS_FILE="${CHROMIUM_MAIN_FLAGS_FILE:-}" \
        CDP_GATEWAY_RAISE_SWITCH="${raise_switch}" CDP_GATEWAY_SETTINGS_FILE="${SETTINGS_FILE}" \
        CDP_ALLOW_ORIGINS="${CDP_ALLOW_ORIGINS}" CDP_ALLOW_BROWSER_CLOSE="${CDP_ALLOW_BROWSER_CLOSE}" \
        CDP_FILE_DIRS="${CDP_FILE_DIRS}" \
        "${CHROMIUM_ENV[@]}" \
        "${DROP[@]}" node /usr/local/lib/cdp-gateway/gateway.mjs

    CDP_GATEWAY_PID="${SERVICE_PID}"

    [ "${ENABLE_CDP}" = "true" ] && STOP_HOOKS+=(cdp_gateway_close_browser)
    wait_until 100 0.2 curl -fsS --unix-socket "${CONSOLE_SOCKET}" http://gateway/console/api/settings >/dev/null 2>&1 \
        || die "the settings service did not become ready"
    if [ "${ENABLE_CDP}" = "true" ]; then
        wait_until 100 0.2 curl -fsS --unix-socket "${CDP_GATEWAY_SOCKET}" http://gateway/json/list >/dev/null 2>&1 \
            || die "the CDP service did not become ready"
    fi

}

# STOP_HOOKS entry (supervisor.sh): close the main browser the orderly way
# before the services get their signals, so the cookies and the session it
# holds in memory reach the profile (main-browser.mjs: a SIGTERM drops them).
# The gateway would close it on its own SIGTERM as well, but the supervisor
# may SIGKILL it before it finished; the console's Stop returns once the
# browser has exited. Bounded well inside docker stop's 10s.
cdp_gateway_close_browser() {
    # A console restart already closed the browsers before the gateway
    # exited. There is no socket to ask in that case (or after a crash).
    kill -0 "${CDP_GATEWAY_PID}" 2>/dev/null || return 0
    timeout 8 curl -fsS -o /dev/null -X POST -H 'X-CDP-Console: 1' \
        --unix-socket "${CONSOLE_SOCKET}" http://gateway/console/api/main/stop \
        || log "WARNING: the main browser did not close in time; stopping it with a signal (recent cookies may be lost)"
}
