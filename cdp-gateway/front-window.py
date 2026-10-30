"""front-window.py — report which chromium's browser window is in front.

Prints the _NET_WM_PID of the topmost viewable browser window on the X
display (0 when there is none) at start and on every change, one per line.
No window manager runs on the Xvfb display, so the stacking order only
changes when windows map, unmap or get raised (raise-window.py); those
events wake it, nothing is polled. The CDP gateway runs it while a console
is connected, and it exits when the gateway closes its stdin.
"""
import os
import select
import sys

from Xlib import X, display, error

d = display.Display()
d.set_error_handler(lambda *_: None)  # windows may vanish mid-walk
root = d.screen().root
root.change_attributes(event_mask=X.SubstructureNotifyMask)
NET_WM_PID = d.intern_atom("_NET_WM_PID")
ROLE = d.intern_atom("WM_WINDOW_ROLE")


def front():
    # query_tree lists the root's children bottom to top
    for win in reversed(root.query_tree().children):
        try:
            if win.get_attributes().map_state != X.IsViewable:
                continue
            role = win.get_full_property(ROLE, X.AnyPropertyType)
            wpid = win.get_full_property(NET_WM_PID, X.AnyPropertyType)
            if role and role.value == b"browser" and wpid:
                return wpid.value[0]
        except error.XError:
            continue
    return 0


last = None
stdin = sys.stdin.fileno()
while True:
    while d.pending_events():
        d.next_event()
    pid = front()
    if pid != last:
        last = pid
        print(pid, flush=True)
    ready, _, _ = select.select([d, stdin], [], [])
    if stdin in ready and not os.read(stdin, 4096):
        break
