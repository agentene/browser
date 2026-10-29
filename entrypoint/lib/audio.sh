# shellcheck shell=bash
# audio.sh — PulseAudio (Selkies captures it via pcmflux).

audio_start() {
    log "starting PulseAudio (socket ${PULSE_SERVER})"
    # PulseAudio demands a 0700 runtime dir owned by its own uid ("Failed to
    # create secure directory" + exit otherwise), so a plain root mkdir -p
    # breaks the RUN_USER mode: hand the dir over when dropping privileges.
    if [ -n "${RUN_UID}" ]; then
        # shellcheck disable=SC2153 # RUN_GID is set by privileges.sh
        install -d -o "${RUN_UID}" -g "${RUN_GID}" -m 700 "${PULSE_RUNTIME_PATH}"
    else
        mkdir -p "${PULSE_RUNTIME_PATH}"
    fi
    start_service /tmp/pulseaudio.log \
        "${DROP[@]}" pulseaudio --daemonize=no --exit-idle-time=-1 --disallow-exit
    wait_until 50 0.2 test -S "${PULSE_SERVER#unix:}" \
        || log "WARNING: PulseAudio socket missing; streaming continues without audio (see /tmp/pulseaudio.log)"
}
