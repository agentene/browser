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
