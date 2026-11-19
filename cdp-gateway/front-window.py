"""Report the PID of the topmost viewable X11 browser window, or JSON null.

Windows map, unmap and restack on the root window. Its notifications wake
the watcher, and closing stdin stops it.
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
ROLE = d.intern_atom("WM_WINDOW_ROLE")


def front_pid():
    # query_tree lists the root's children bottom to top
    for win in reversed(root.query_tree().children):
        try:
            if win.get_attributes().map_state != X.IsViewable:
                continue
            role = win.get_full_property(ROLE, X.AnyPropertyType)
            wpid = win.get_full_property(NET_WM_PID, X.AnyPropertyType)
            if role and role.value == b"browser" and wpid:
                return int(wpid.value[0])
        except error.XError:
            continue
    return None


last = None
stdin = sys.stdin.fileno()
while True:
    while d.pending_events():
        d.next_event()
    state = json.dumps(front_pid())
    if state != last:
        last = state
        print(state, flush=True)
    ready, _, _ = select.select([d, stdin], [], [])
    if stdin in ready and not os.read(stdin, 4096):
        break
