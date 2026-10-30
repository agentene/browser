#!/usr/bin/env bash
# window-lock.sh — the window lock's part labwc cannot refuse.
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
# Idle costs nothing: with no window on the desktop (an on-demand main
# browser that is not running, no contexts) it blocks in `wlrctl toplevel
# waitfor` until labwc maps one. Only while windows exist does it poll, two
# wlrctl calls per tick, and it waits between ticks with bash's read timeout
# instead of forking sleep — the old find/focus/sleep loop forked ~10
# processes a second, ~2% of a core, even on an empty desktop.
#
# Needs XDG_RUNTIME_DIR and WAYLAND_DISPLAY; runs forever.

# A pipe nobody writes to: a read timeout on it is a sleep without a fork.
exec {tick}<> <(:)
nap() { read -r -t "$1" -u "${tick}" _; }

while :; do
    if ! wlrctl toplevel waitfor >/dev/null 2>&1; then
        nap 1 # labwc not answering; if it died, the supervisor stops the container
        continue
    fi
    # maximize fails (no match) once the last window is gone
    while wlrctl toplevel maximize >/dev/null 2>&1; do
        for _ in 1 2 3 4 5 6 7 8 9 10; do
            wlrctl toplevel focus state:minimized >/dev/null 2>&1 || break
        done
        nap 0.3
    done
done
