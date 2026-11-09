# shellcheck shell=bash
# settings.sh — the settings the CDP console persists.
#
# The console's settings menu changes them at runtime; the CDP gateway
# (cdp-gateway/src/settings.mjs, the file's owner) applies a change and saves
# it to SETTINGS_FILE, a JSON object by section on the /browser mount, so it
# outlives the container:
#   { "desktop": { "raiseNewWindows": true } }
# They are no environment knobs on purpose: the console is their one place.
# The ones the desktop needs before the gateway runs are applied here at
# start. (The console's language is per viewer and stays in the browser.)
#
# Sets: SETTINGS_FILE.

settings_init() {
    SETTINGS_FILE=/browser/settings/settings.json
    mkdir -p "${SETTINGS_FILE%/*}" || die "cannot create ${SETTINGS_FILE%/*}"
    # the gateway saves it as the run user (write + rename in the directory)
    give_to_run_user "${SETTINGS_FILE%/*}"
    if [ -e "${SETTINGS_FILE}" ]; then
        give_to_run_user "${SETTINGS_FILE}"
    fi
}

# settings_get <section.key> <default>: one saved setting, <default> if unset.
settings_get() {
    python3 "${ENTRYPOINT_HELPERS}/settings-get.py" "${SETTINGS_FILE}" "$1" "$2"
}

# desktop.raiseNewWindows: whether a window that opens on the desktop comes
# to the front (true, the default) or stays behind the one in front. Handed
# to the desktop about to start; labwc / the X11 screen follower apply it
# (desktop-raise-new-windows.sh).
settings_apply_desktop() {
    local raise
    raise="$(settings_get desktop.raiseNewWindows true)"
    case "${raise}" in
        true | false) : ;;
        *)
            log "WARN: ${SETTINGS_FILE}: desktop.raiseNewWindows='${raise}' is not true or false -> true"
            raise=true
            ;;
    esac
    DISPLAY_BACKEND="${DISPLAY_BACKEND}" "${ENTRYPOINT_HELPERS}/desktop-raise-new-windows.sh" "${raise}" \
        || die "cannot apply desktop.raiseNewWindows (desktop-raise-new-windows.sh)"
    # the CDP gateway flips it as the run user
    give_to_run_user /tmp/desktop-raise-new-windows
    if [ "${raise}" = "true" ]; then
        log "new windows come to the front of the desktop"
    else
        log "new windows open behind the one in front (${SETTINGS_FILE})"
    fi
}
