# shellcheck shell=bash
# cdp-gateway.sh — the CDP gateway (always on with ENABLE_CDP).
#
# A Node gateway between nginx and chromium. Default-context clients pass
# through to the main browser untouched; an isolated client's
# Target.createBrowserContext instead gets a separate chromium on a clone of
# the main profile (logins included), destroyed again when the context is
# disposed or the client disconnects. Details in
# /usr/local/lib/cdp-gateway/gateway.mjs and the README ("CDP gateway").
# Needs chromium.sh to have run first (flags, env, main browser pid). With
# CHROMIUM_AUTOSTART=false the gateway also owns the main browser: it starts
# it on demand from CHROMIUM_MAIN_FLAGS_FILE and outlives it.

cdp_gateway_start() {
    # Isolated contexts live until their client leaves, so nothing survives a
    # restart: drop the leftover clones. Only the gateway's own context-N
    # dirs — the directory itself may be shared (e.g. CDP_CONTEXTS_DIR=/browser
    # next to the live profile, or /tmp).
    rm -rf "${CDP_CONTEXTS_DIR}"/context-*
    mkdir -p "${CDP_CONTEXTS_DIR}"
    give_to_run_user "${CDP_CONTEXTS_DIR}"

    # Context browsers follow the main browser's display mode unless told
    # otherwise, and fall back to headless like the main browser does without
    # a display.
    CDP_CONTEXTS_HEADLESS="${CDP_CONTEXTS_HEADLESS:-${CHROMIUM_HEADLESS}}"
    if [ "${CDP_CONTEXTS_HEADLESS}" = "0" ] && ! desktop_ready; then
        log "WARNING: no ${DISPLAY_BACKEND} display for headed CDP contexts -> they run headless"
        CDP_CONTEXTS_HEADLESS=1
    fi
    # The context browsers get the main browser's flags minus its profile and
    # DevTools port (the gateway adds its own), NUL-separated.
    chromium_mode_flags "${CDP_CONTEXTS_HEADLESS}"
    local flags_file=/tmp/cdp-gateway-chromium-flags
    printf '%s\0' "${CHROMIUM_COMMON_FLAGS[@]}" "${MODE_FLAGS[@]}" \
        "${CHROMIUM_TAIL_FLAGS[@]}" >"${flags_file}"

    # The console sidebar on the Selkies page (nginx.sh) is guarded by
    # Selkies' master password, resolved like selkies.sh does (empty = the
    # web UI has no login, so neither has the sidebar). Only the master
    # password: a view-only login must not manage contexts.
    local console_password=""
    if [ "${CDP_CONSOLE_PANEL_ACTIVE}" = "true" ] && [ "${SELKIES_ENABLE_BASIC_AUTH:-}" != "false" ]; then
        console_password="${SELKIES_BASIC_AUTH_PASSWORD:-${PASSWORD:-${PASSWD:-}}}"
    fi

    # Selkies viewers keep the idle timer from closing the main browser
    # (someone may be using it by hand); no stream, nobody to watch.
    local viewer_port=""
    [ "${ENABLE_SELKIES}" = "true" ] && viewer_port="${SELKIES_INTERNAL_PORT}"

    log "starting CDP gateway on 127.0.0.1:${CDP_GATEWAY_INTERNAL_PORT} (main browser autostart=${CHROMIUM_AUTOSTART} idle-timeout=${CHROMIUM_IDLE_TIMEOUT}m, max ${CDP_CONTEXTS_MAX} contexts, headless=${CDP_CONTEXTS_HEADLESS}, data in ${CDP_CONTEXTS_DIR})"
    start_service /tmp/cdp-gateway.log \
        env CHROME_BIN="${CHROME_BIN}" CHROMIUM_USER_DATA_DIR="${CHROMIUM_USER_DATA_DIR}" \
        CDP_INTERNAL_PORT="${CDP_INTERNAL_PORT}" CDP_LISTEN_PORT="${CDP_LISTEN_PORT}" \
        CDP_GATEWAY_INTERNAL_PORT="${CDP_GATEWAY_INTERNAL_PORT}" \
        CDP_CONTEXTS_MAX="${CDP_CONTEXTS_MAX}" CDP_CONTEXTS_DIR="${CDP_CONTEXTS_DIR}" \
        CDP_CONTEXTS_HEADLESS="${CDP_CONTEXTS_HEADLESS}" DISPLAY_BACKEND="${DISPLAY_BACKEND}" \
        CDP_GATEWAY_FLAGS_FILE="${flags_file}" CDP_CONSOLE_WEB_PASSWORD="${console_password}" \
        CDP_MAIN_CHROMIUM_PID="${CHROMIUM_PID}" CHROMIUM_AUTOSTART="${CHROMIUM_AUTOSTART}" \
        CHROMIUM_IDLE_TIMEOUT="${CHROMIUM_IDLE_TIMEOUT}" CDP_GATEWAY_VIEWER_PORT="${viewer_port}" \
        CDP_GATEWAY_MAIN_FLAGS_FILE="${CHROMIUM_MAIN_FLAGS_FILE}" "${CHROMIUM_ENV[@]}" \
        "${DROP[@]}" node /usr/local/lib/cdp-gateway/gateway.mjs
}
