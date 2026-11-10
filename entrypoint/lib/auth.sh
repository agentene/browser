# shellcheck shell=bash
# auth.sh — the built-in login and the CDP API key (ENABLE_AUTH=true).
#
# A small Node service on loopback (/usr/local/lib/auth-server/server.mjs)
# that nginx asks about every request (auth_request, nginx.sh):
#   * the web UI and the CDP console (on either port) need a session cookie;
#     until the first visitor sets up the administrator login (or skips it)
#     every page shows the setup form, then the login form in place;
#   * the CDP API needs the API key once one is set (Authorization: Bearer
#     <key> or X-API-Key: <key>); without one it stays open, as before.
# Login, the skip choice and the key are changed in the CDP console's
# settings (the service's ui.js) and persisted in AUTH_FILE on the /browser
# mount — no env knobs on purpose, like the console settings (settings.sh).
# Deleting the file resets it (picked up within a second).

auth_start() {
    # the service saves AUTH_FILE as the run user (write + rename in the
    # directory settings_init created and handed over)
    if [ -e "${AUTH_FILE}" ]; then
        give_to_run_user "${AUTH_FILE}"
    fi
    log "starting auth service on 127.0.0.1:${AUTH_INTERNAL_PORT} (${AUTH_FILE})"
    start_service /tmp/auth-server.log \
        env AUTH_INTERNAL_PORT="${AUTH_INTERNAL_PORT}" AUTH_FILE="${AUTH_FILE}" \
        ENABLE_CDP="${ENABLE_CDP}" \
        "${DROP[@]}" node /usr/local/lib/auth-server/server.mjs
    # nginx answers 500 to every protected request until the service is up
    wait_until 50 0.1 curl -sf -o /dev/null "http://127.0.0.1:${AUTH_INTERNAL_PORT}/api/state" \
        || die "the auth service did not come up on 127.0.0.1:${AUTH_INTERNAL_PORT} (see /tmp/auth-server.log)"
}
