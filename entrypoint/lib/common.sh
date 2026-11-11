# shellcheck shell=bash
# common.sh — logging and small helpers shared by every module.
#
# Sourced by docker-entrypoint.sh; defines functions only.

log() { echo "[entrypoint] $*"; }
die() { echo "[entrypoint] ERROR: $*" >&2; exit 1; }

# wait_until <tries> <interval> <command...>: polls the command until it
# succeeds, <tries> times <interval> seconds apart; the exit status is the
# command's last result.
wait_until() {
    local tries="$1" interval="$2" _
    shift 2
    for _ in $(seq 1 "${tries}"); do
        "$@" && return 0
        sleep "${interval}"
    done
    "$@"
}

# give_to_run_user [-R] <path...>: chown to the RUN_USER (privileges.sh);
# a no-op in root mode (RUN_USER=0).
give_to_run_user() {
    [ -n "${RUN_UID}" ] || return 0
    local opts=()
    if [ "${1:-}" = "-R" ]; then
        opts=(-R)
        shift
    fi
    # shellcheck disable=SC2153 # RUN_GID is set by privileges.sh
    chown "${opts[@]}" "${RUN_UID}:${RUN_GID}" "$@"
}

# sockets_init: SOCKET_DIR (config.sh) afresh — the unix sockets nginx
# reaches Selkies, the CDP gateway and the auth service on. /tmp survives
# `docker restart`, and a socket left from an earlier start would make its
# service fail to bind. The run user's: its services create the sockets.
sockets_init() {
    rm -rf "${SOCKET_DIR}"
    mkdir -m 0755 "${SOCKET_DIR}" || die "cannot create ${SOCKET_DIR}"
    give_to_run_user "${SOCKET_DIR}"
}
