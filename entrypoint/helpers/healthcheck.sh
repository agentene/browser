#!/usr/bin/env bash
# Check public routes without launching Chromium. Use the same prefix
# normalization as startup, including explicit empty/root prefixes.
set -uo pipefail

# shellcheck source=entrypoint/lib/common.sh
. /usr/local/lib/docker-entrypoint/lib/common.sh
# shellcheck source=entrypoint/lib/config.sh
. /usr/local/lib/docker-entrypoint/lib/config.sh

config_subfolder CONSOLE_SUBFOLDER /console
config_subfolder SELKIES_SUBFOLDER ""

probe() {
    local status
    status="$(curl -s --max-time 2 -o /dev/null -w '%{http_code}' "$1")" || return 1
    case "${status}" in
        200|401) return 0 ;;
        3??) [ "${2:-}" = redirect ] ;;
        *) return 1 ;;
    esac
}

probe "http://127.0.0.1:${NGINX_LISTEN_HTTP_PORT:-80}${CONSOLE_SUBFOLDER}/api/settings" || exit 1
if [ "${ENABLE_SELKIES:-true}" = true ]; then
    probe "http://127.0.0.1:${NGINX_LISTEN_HTTP_PORT:-80}${SELKIES_SUBFOLDER}/" redirect || exit 1
fi
if [ "${ENABLE_CDP:-true}" = true ]; then
    probe "http://127.0.0.1:${CDP_LISTEN_PORT:-9222}/json/list" || exit 1
fi
