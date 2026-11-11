"""front-window.py — report chromium's browser windows, the one in front first.

Prints the viewable browser windows on the X display as one JSON line,
[[_NET_WM_PID, title], ...] from the topmost down ([] when there is none),
at start and on every change. Chromium titles a window after the tab in
front of it, so the titles say which tab that is. No window manager runs on
the Xvfb display, so the stacking order only changes when windows map, unmap
or get raised (raise-window.py), and a title when chromium sets it; those
events wake it, nothing is polled. The CDP gateway runs it while a console
is connected, and it exits when the gateway closes its stdin.
"""
import json
import os
import select
import sys

from Xlib import X, display, error

d = display.Display()
d.set_error_handler(lambda *_: None)  # windows may vanish mid-walk
root = d.screen().root
root.change_attributes(event_mask=X.SubstructureNotifyMask)
NET_WM_PID = d.intern_atom("_NET_WM_PID")
NET_WM_NAME = d.intern_atom("_NET_WM_NAME")
ROLE = d.intern_atom("WM_WINDOW_ROLE")
watched = set()  # the browser windows whose title changes wake us


def windows():
    global watched
    found = []
    seen = set()
    # query_tree lists the root's children bottom to top
    for win in reversed(root.query_tree().children):
        try:
            if win.get_attributes().map_state != X.IsViewable:
                continue
            role = win.get_full_property(ROLE, X.AnyPropertyType)
            wpid = win.get_full_property(NET_WM_PID, X.AnyPropertyType)
            if not (role and role.value == b"browser" and wpid):
                continue
            if win.id not in watched:
                win.change_attributes(event_mask=X.PropertyChangeMask)
            seen.add(win.id)
            name = win.get_full_property(NET_WM_NAME, X.AnyPropertyType)
            value = name.value if name else b""
            title = value.decode("utf-8", "replace") if isinstance(value, bytes) else str(value)
            found.append([int(wpid.value[0]), title])
        except error.XError:
            continue
    watched = seen
    return found


last = None
stdin = sys.stdin.fileno()
while True:
    while d.pending_events():
        d.next_event()
    state = json.dumps(windows(), ensure_ascii=False)
    if state != last:
        last = state
        print(state, flush=True)
    ready, _, _ = select.select([d, stdin], [], [])
    if stdin in ready and not os.read(stdin, 4096):
        break
