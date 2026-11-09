#!/usr/bin/env bash
# desktop-raise-new-windows.sh true|false — whether a window that opens on
# the desktop comes to the front (true, what window managers usually do) or
# opens behind the window in front (false), so that e.g. the browser an
# automation run starts does not cover the one someone is watching. Applies
# to the windows opened from then on.
#
# The entrypoint runs it at start with the saved setting (settings.sh), the
# CDP gateway whenever the console's switch is flipped. What the desktop
# reads is /tmp/desktop-raise-new-windows (true/false):
#   x11      the screen follower (chromium-follow-screen.py) reads it each
#            time a window is created or asks to be activated
#   wayland  labwc cannot read it, so its config comes in one variant per
#            setting (display-wayland.sh); rc.xml points at the one in
#            effect, and SIGHUP makes labwc reload it
#
# Needs DISPLAY_BACKEND.
set -u

case "${1:-}" in
    true | false) ;;
    *)
        echo "usage: $0 true|false" >&2
        exit 2
        ;;
esac

printf '%s\n' "$1" >/tmp/desktop-raise-new-windows || exit 1
if [ "${DISPLAY_BACKEND:-}" = "wayland" ]; then
    ln -sfn "rc-raise-new-windows-$1.xml" /tmp/labwc/rc.xml || exit 1
    # not running yet (entrypoint): it reads rc.xml when it starts
    pkill -HUP -x labwc || true
fi
