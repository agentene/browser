#!/usr/bin/env bash
# window-lock.sh — CHROMIUM_LOCK_WINDOWS, the part labwc cannot refuse.
#
# chromium's tab strip context menu always offers Minimize and Restore
# (hardcoded on Linux, GSettings does not reach it), and labwc grants both
# requests (still in the release Ubuntu 26.04 ships). Undo them through
# foreign-toplevel management instead:
# re-maximize every window (a no-op for maximized ones — verified, no resize
# reaches the page; labwc does not report the maximized state, so there is
# nothing to wait for) and bring minimized ones back, which also restores
# their rendering (a minimized page is hidden and stalls).
#
# Needs XDG_RUNTIME_DIR and WAYLAND_DISPLAY; runs forever.
while :; do
    wlrctl toplevel maximize >/dev/null 2>&1
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        wlrctl toplevel find state:minimized >/dev/null 2>&1 || break
        wlrctl toplevel focus state:minimized >/dev/null 2>&1
    done
    sleep 0.3
done
