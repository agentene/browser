# shellcheck shell=bash
# settings.sh — the settings the CDP console persists.
#
# The web console owns /browser/settings/settings.json. Shared validation and
# defaults live in cdp-gateway/src/settings-schema.mjs. Live policies apply in
# the gateway; display/browser startup preferences are adapted here before
# any service starts. No preference has an environment fallback.
#
# Sets SETTINGS_FILE and internal startup adapters: CHROMIUM_AUTOSTART,
# CHROMIUM_IDLE_TIMEOUT, CHROMIUM_START_URL, CHROMIUM_LANG, CHROMIUM_HEADLESS,
# CHROMIUM_GPU, CDP_CONTEXTS_MAX, CDP_CONTEXTS_OVERFLOW,
# CDP_CONTEXTS_HIBERNATED_MAX, CDP_INPUT_OVERLAY, SCREEN_GEOMETRY,
# SELKIES_ENABLE_RESIZE, SELKIES_RESIZE_LOCKED, SELKIES_AUDIO_ON_START,
# DESKTOP_RAISE_NEW_WINDOWS.

# Read persisted preferences before config_load derives display sizes or flags.
# These globals are internal adapters, not environment configuration knobs.
settings_load() {
    SETTINGS_FILE=/browser/settings/settings.json
    local knob assignment snapshot
    for knob in CHROMIUM_AUTOSTART CHROMIUM_IDLE_TIMEOUT CHROMIUM_START_URL CHROMIUM_LANG CHROMIUM_HEADLESS CHROMIUM_GPU CDP_CONTEXTS_MAX CDP_CONTEXTS_OVERFLOW CDP_CONTEXTS_HIBERNATED_MAX CDP_INPUT_OVERLAY SCREEN_GEOMETRY SELKIES_ENABLE_RESIZE SELKIES_AUDIO_ON_START; do
        if [ "${!knob+x}" ]; then
            log "WARNING: ${knob} is ignored; configure it in the web settings page"
        fi
        unset "${knob}"
    done
    snapshot="$(mktemp /tmp/browser-settings.XXXXXX)" || die "cannot create settings snapshot"
    node /usr/local/lib/cdp-gateway/src/settings-startup.mjs "${SETTINGS_FILE}" > "${snapshot}" \
        || die "cannot load browser settings"
    while IFS= read -r -d '' assignment; do
        printf -v "${assignment%%=*}" '%s' "${assignment#*=}"
    done < "${snapshot}"
    rm -f "${snapshot}"
}

settings_init() {
    SETTINGS_FILE=/browser/settings/settings.json
    mkdir -p "${SETTINGS_FILE%/*}" || die "cannot create ${SETTINGS_FILE%/*}"
    # the gateway saves it as the run user (write + rename in the directory)
    give_to_run_user "${SETTINGS_FILE%/*}"
    if [ -e "${SETTINGS_FILE}" ]; then
        give_to_run_user "${SETTINGS_FILE}"
    fi
}

# desktop.raiseNewWindows: whether a window that opens on the desktop comes
# to the front (true, the default) or stays behind the one in front. Handed
# to the desktop about to start; labwc / the X11 screen follower apply it
# (desktop-raise-new-windows.sh).
settings_apply_desktop() {
    local raise
    raise="${DESKTOP_RAISE_NEW_WINDOWS}"
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
