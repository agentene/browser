# shellcheck shell=bash
# privileges.sh — the RUN_USER privilege drop (privileges_setup).
#
# RUN_USER runs the desktop stack — Xvfb or labwc, picom, PulseAudio, Selkies,
# Chromium — and the nginx workers as an unprivileged user. PID 1 and the
# nginx MASTER stay root: nginx binds the (by default privileged) listen
# ports and reads the TLS key, and the supervisor must keep chown-ing the
# browser profile. Unset or empty (default) = browser, the unprivileged user
# the image ships (uid 1001). Root mode is opt-in: RUN_USER=0 (or 0:<gid>,
# or root) runs everything as root, the pre-0.2 behavior: DROP stays an
# empty array and every "${DROP[@]}" prefix is a no-op.
#
# Sets: DROP (command prefix), RUN_UID, RUN_GID, RUN_NAME, RUN_GROUPS (all
# empty in root mode — RUN_UID is THE root-mode test for other modules),
# RUN_NGINX_USER (nginx `user` directive value, empty = default).

privileges_setup() {
    RUN_USER="${RUN_USER:-browser}"
    DROP=()
    RUN_UID="" RUN_GID="" RUN_NAME="" RUN_GROUPS=""
    RUN_NGINX_USER=""

    privileges_resolve_user
    if [ "${RUN_UID}" = "0" ]; then
        RUN_UID="" RUN_GID="" RUN_NAME=""
        log "RUN_USER=${RUN_USER}: everything runs as root (no privilege drop)"
        return 0
    fi
    privileges_prepare_home
    privileges_build_drop
    # shellcheck disable=SC2034 # read by nginx.sh
    RUN_NGINX_USER="${RUN_NAME}"
    privileges_own_profile
    privileges_clear_root_leftovers
    privileges_clear_run_user_leftovers

    log "RUN_USER: desktop stack + nginx workers run as ${RUN_NAME} (uid=${RUN_UID} gid=${RUN_GID}${RUN_GROUPS:+ groups=${RUN_GROUPS}}); PID 1 + nginx master stay root"
}

# RUN_USER -> RUN_UID/RUN_GID/RUN_NAME. uid 0 (0, 0:<gid>, root, any name
# with uid 0) returns RUN_UID=0 and nothing else: the caller's root mode.
privileges_resolve_user() {
    if [[ "${RUN_USER}" =~ ^[0-9]+(:[0-9]+)?$ ]]; then
        RUN_UID="${RUN_USER%%:*}"
        RUN_GID="${RUN_USER#*:}"
        [ "${RUN_GID}" != "${RUN_USER}" ] || RUN_GID="${RUN_UID}"
        # all zeros (0, 00, ...) is root
        if [[ "${RUN_UID}" =~ ^0+$ ]]; then
            RUN_UID=0
            return 0
        fi
        # nginx's `user` directive takes a NAME and the daemons want a HOME:
        # synthesize passwd/group entries for bare numeric ids (idempotent —
        # an entry created on an earlier `docker restart` is simply reused).
        getent group "${RUN_GID}" >/dev/null 2>&1 \
            || groupadd -g "${RUN_GID}" "run${RUN_GID}"
        RUN_NAME="$(getent passwd "${RUN_UID}" | cut -d: -f1 || true)"
        if [ -z "${RUN_NAME}" ]; then
            useradd -o -u "${RUN_UID}" -g "${RUN_GID}" -d /tmp/run-home \
                -s /usr/sbin/nologin "run${RUN_UID}"
            RUN_NAME="run${RUN_UID}"
        fi
    else
        local passwd_entry
        RUN_NAME="${RUN_USER}"
        passwd_entry="$(getent passwd "${RUN_NAME}")" \
            || die "RUN_USER=${RUN_USER}: no such user in /etc/passwd (use a name like browser, or uid[:gid])"
        RUN_UID="$(echo "${passwd_entry}" | cut -d: -f3)"
        RUN_GID="$(echo "${passwd_entry}" | cut -d: -f4)"
    fi
}

# A writable HOME of the run user: chromium's crashpad handler and pulse's
# cookie file live under it (verified: with root's /root left in place both
# fail with permission errors).
privileges_prepare_home() {
    local run_home
    run_home="$(getent passwd "${RUN_UID}" | cut -d: -f6)"
    mkdir -p "${run_home}"
    give_to_run_user "${run_home}"
    export HOME="${run_home}"
}

# GPU device nodes are root:<gid> 0660 — a dropped Chromium (Vulkan/ANGLE)
# or a hardware Selkies encoder needs the device gids kept in the
# supplementary group set (the gids come from the nodes, which belong to the
# HOST, not from the container's /etc/group).
privileges_build_drop() {
    local dev dev_gid
    RUN_GROUPS=""
    for dev in /dev/dri/* /dev/nvidiactl /dev/nvidia[0-9]*; do
        [ -e "${dev}" ] || continue
        dev_gid="$(stat -c %g "${dev}" 2>/dev/null || true)"
        [ -n "${dev_gid}" ] || continue
        case ",${RUN_GROUPS}," in
            *",${dev_gid},"*) : ;;
            *) RUN_GROUPS="${RUN_GROUPS:+${RUN_GROUPS},}${dev_gid}" ;;
        esac
    done
    # setpriv demands an explicit group decision alongside --regid.
    # shellcheck disable=SC2034 # DROP prefixes the daemons of the other modules
    if [ -n "${RUN_GROUPS}" ]; then
        DROP=(setpriv --reuid="${RUN_UID}" --regid="${RUN_GID}" --groups="${RUN_GROUPS}")
    else
        DROP=(setpriv --reuid="${RUN_UID}" --regid="${RUN_GID}" --clear-groups)
    fi
}

# The browser profile is opened read-write by chromium: own it by the run
# user (covers fresh root-created dirs and leftovers from earlier root-mode
# starts alike; a no-op walk once everything is owned).
privileges_own_profile() {
    local chown_begin
    mkdir -p "${CHROMIUM_USER_DATA_DIR}"
    chown_begin="$(date +%s)"
    give_to_run_user -R "${CHROMIUM_USER_DATA_DIR}"
    log "RUN_USER: ${CHROMIUM_USER_DATA_DIR} now owned by ${RUN_UID}:${RUN_GID} ($(( $(date +%s) - chown_begin ))s)"
}

# Root-owned runtime leftovers (e.g. after `docker restart` of a container
# that previously ran as root) would block the dropped daemons: the pulse
# socket dir is 0700 and a stale X socket cannot be unlinked across uids.
# Remove them; each daemon recreates its own as the run user. The X socket
# dir is pre-created here too — a non-root Xvfb refuses to create it
# "securely" itself (_XSERVTransmkdir error).
privileges_clear_root_leftovers() {
    rm -rf "${PULSE_RUNTIME_PATH}"
    rm -f /tmp/.X11-unix/X*
    mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
}

# The reverse: files directly in /tmp that the previous start handed to the
# run user (give_to_run_user) and this start rewrites as root. /tmp survives
# `docker restart` (and so `restart: always` after a service exited), and
# with fs.protected_regular (systemd's default) the kernel refuses even root
# an O_CREAT open of a file in a sticky world-writable directory owned by
# someone else — the rewrite would fail with EACCES and abort every start.
# Remove them; their writers recreate them as root and hand them over again.
privileges_clear_run_user_leftovers() {
    rm -f /tmp/desktop-raise-new-windows /tmp/chromium.log
}
