#!/usr/bin/env bash
# Check the configured listeners and web paths without launching Chromium.
set -uo pipefail

# shellcheck source=entrypoint/lib/common.sh
. /usr/local/lib/docker-entrypoint/lib/common.sh
# shellcheck source=entrypoint/lib/config.sh
. /usr/local/lib/docker-entrypoint/lib/config.sh

config_web_paths
config_nginx

# A wildcard listener accepts probes on the corresponding loopback address.
case "${LISTEN_PREFIX}" in
    '0.0.0.0:') probe_prefix='127.0.0.1:' ;;
    '[::]:') probe_prefix='[::1]:' ;;
    *) probe_prefix="${LISTEN_PREFIX}" ;;
esac

probe() {
    local status
    status="$(curl --noproxy '*' -s --max-time 2 -o /dev/null -w '%{http_code}' "$1")" || return 1
    case "${status}" in
        200|401) return 0 ;;
        3??) [ "${2:-}" = redirect ] ;;
        *) return 1 ;;
    esac
}

probe "http://${probe_prefix}${HTTP_PORT}${CONSOLE_SUBPATH}/api/settings" || exit 1
if [ "${ENABLE_SELKIES:-true}" = true ]; then
    probe "http://${probe_prefix}${HTTP_PORT}${BROWSER_SUBPATH}/" redirect || exit 1
fi
if [ "${ENABLE_CDP:-true}" = true ]; then
    probe "http://${probe_prefix}${CDP_PORT}/json/list" || exit 1
fi
