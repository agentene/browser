# shellcheck shell=bash
# supervisor.sh — PID 1 duties: start, watch and stop the services.
#
# Every daemon goes through start_service, which records its pid in `pids`:
# the cleanup trap stops exactly those, and supervisor_wait exits the
# container as soon as any of them dies (so `restart: always` recovers it).
# Never background a daemon any other way. A module whose service needs an
# orderly shutdown beyond a signal adds a function to STOP_HOOKS; the
# cleanup runs them, in order, before it signals anything.

supervisor_init() {
    pids=()
    STOP_HOOKS=()
    trap 'supervisor_cleanup; exit 0' TERM INT
    trap 'supervisor_cleanup' EXIT
}

supervisor_cleanup() {
    trap - TERM INT EXIT
    local hook
    for hook in "${STOP_HOOKS[@]}"; do
        "${hook}"
    done
    [ ${#pids[@]} -gt 0 ] && kill "${pids[@]}" 2>/dev/null
    # give services a moment to exit, then force-kill the survivors
    for _ in $(seq 1 20); do
        kill -0 "${pids[@]}" 2>/dev/null || break
        sleep 0.1
    done
    kill -KILL "${pids[@]}" 2>/dev/null
    wait "${pids[@]}" 2>/dev/null
    log "stopped"
}

# start_service <logfile|-> <command...>: runs the command in the background
# as a supervised service, its output into <logfile> ("-" = the container's
# own stdout/stderr). Its pid is left in SERVICE_PID.
start_service() {
    local log_file="$1"
    shift
    if [ "${log_file}" = "-" ]; then
        "$@" &
    else
        "$@" >"${log_file}" 2>&1 &
    fi
    SERVICE_PID=$!
    pids+=("${SERVICE_PID}")
}

# Exit (and let docker restart) if any service dies. Check before every
# wait: wait -n only returns for a child that exits AFTER it is called, so a
# service that already died during startup (e.g. chromium while the DevTools
# endpoint was awaited) would go unnoticed and leave a "healthy" container
# without it.
supervisor_wait() {
    local pid
    while :; do
        for pid in "${pids[@]}"; do
            if ! kill -0 "${pid}" 2>/dev/null; then
                log "service pid ${pid} exited; shutting down"
                exit 1
            fi
        done
        # returns as soon as one child exits, whatever its status
        wait -n 2>/dev/null || true
        sleep 0.2
    done
}
