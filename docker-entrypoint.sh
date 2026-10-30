#!/usr/bin/env bash
# docker-entrypoint.sh — one-shot supervisor for this image's services.
#
# Starts, in order:
#   1. Xvfb            virtual X11 display (Selkies captures it)
#      picom           compositing manager for that display (keeps popup
#                       menu shadows visible; see ENABLE_COMPOSITOR)
#      or, with DISPLAY_BACKEND=wayland:
#      labwc           headless Wayland compositor + window manager
#                       (Selkies captures it by screencopy)
#   2. PulseAudio      audio server (Selkies captures it via pcmflux)
#   3. Selkies         HTML5 remote desktop on 127.0.0.1:${SELKIES_INTERNAL_PORT:-8081}
#   4. Chromium        Chrome for Testing with a CDP endpoint on loopback
#      CDP gateway     optional gateway in front of it (ENABLE_CDP_GATEWAY);
#                       with CHROMIUM_AUTOSTART=false the gateway starts the
#                       main browser on demand instead, as its own child
#   5. nginx           the public front door (web UI over HTTP/HTTPS, the CDP
#                       endpoint, PORT_FORWARDS), on the container ports
#                       NGINX_LISTEN_HTTP_PORT / NGINX_LISTEN_HTTPS_PORT /
#                       CDP_LISTEN_PORT. NGINX_HTTP_PORT / NGINX_HTTPS_PORT /
#                       CDP_PORT are a different thing: they only pick the
#                       HOST-side ports docker publishes (compose "ports:" /
#                       docker -p).
#
# Container start == service start ("开机自启"): this script is the image
# ENTRYPOINT; combine with `docker run --restart=always` for boot persistence.
#
# Any first argument other than "start" (or no argument) is exec'd as a
# command instead, e.g. `docker run -it <image> bash` drops to a shell.
#
# This file only wires the stages together; each one lives in its own
# module under ${ENTRYPOINT_HOME}/lib (entrypoint/lib in the repo):
#
#   common.sh           log/die and small shared helpers
#   config.sh           every env knob: defaults + validation (the reference)
#   privileges.sh       RUN_USER privilege drop (the DROP command prefix)
#   supervisor.sh       PID 1 duties: start_service, traps, the wait loop
#   gpu.sh              GPU device detection
#   display-x11.sh      Xvfb + picom          (DISPLAY_BACKEND=x11)
#   display-wayland.sh  labwc + helpers       (DISPLAY_BACKEND=wayland)
#   audio.sh            PulseAudio
#   selkies.sh          Selkies
#   chromium.sh         chromium flags, profile, launch
#   cdp-gateway.sh      CDP gateway           (ENABLE_CDP_GATEWAY)
#   tls.sh              HTTPS certificate reuse / self-signing
#   nginx.sh            nginx config generation + start
#
# and the standalone scripts the services run under ${ENTRYPOINT_HOME}/helpers.
set -uo pipefail

# --- passthrough mode: run whatever command was given -----------------------
if [ "${1:-start}" != "start" ]; then
    exec "$@"
fi

ENTRYPOINT_HOME=/usr/local/lib/docker-entrypoint
ENTRYPOINT_HELPERS="${ENTRYPOINT_HOME}/helpers"

# shellcheck source=entrypoint/lib/common.sh
. "${ENTRYPOINT_HOME}/lib/common.sh"
# shellcheck source=entrypoint/lib/config.sh
. "${ENTRYPOINT_HOME}/lib/config.sh"
# shellcheck source=entrypoint/lib/privileges.sh
. "${ENTRYPOINT_HOME}/lib/privileges.sh"
# shellcheck source=entrypoint/lib/supervisor.sh
. "${ENTRYPOINT_HOME}/lib/supervisor.sh"
# shellcheck source=entrypoint/lib/gpu.sh
. "${ENTRYPOINT_HOME}/lib/gpu.sh"
# shellcheck source=entrypoint/lib/display-x11.sh
. "${ENTRYPOINT_HOME}/lib/display-x11.sh"
# shellcheck source=entrypoint/lib/display-wayland.sh
. "${ENTRYPOINT_HOME}/lib/display-wayland.sh"
# shellcheck source=entrypoint/lib/audio.sh
. "${ENTRYPOINT_HOME}/lib/audio.sh"
# shellcheck source=entrypoint/lib/selkies.sh
. "${ENTRYPOINT_HOME}/lib/selkies.sh"
# shellcheck source=entrypoint/lib/chromium.sh
. "${ENTRYPOINT_HOME}/lib/chromium.sh"
# shellcheck source=entrypoint/lib/cdp-gateway.sh
. "${ENTRYPOINT_HOME}/lib/cdp-gateway.sh"
# shellcheck source=entrypoint/lib/tls.sh
. "${ENTRYPOINT_HOME}/lib/tls.sh"
# shellcheck source=entrypoint/lib/nginx.sh
. "${ENTRYPOINT_HOME}/lib/nginx.sh"

main() {
    config_load
    nginx_prepare
    privileges_setup
    supervisor_init
    gpu_detect

    if [ "${ENABLE_SELKIES}" = "true" ]; then
        case "${DISPLAY_BACKEND}" in
            x11) display_x11_start ;;
            wayland) display_wayland_start ;;
        esac
        audio_start
        selkies_start
    fi

    if [ "${ENABLE_CDP}" = "true" ]; then
        chromium_start
        if [ "${ENABLE_CDP_GATEWAY}" = "true" ]; then
            cdp_gateway_start
        fi
    fi

    if [ "${ENABLE_SELKIES}" = "true" ]; then
        selkies_wait_ready
    fi
    nginx_start

    log "all services up (supervising ${pids[*]}); ready"
    supervisor_wait
}

main "$@"
