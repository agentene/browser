"""raise-window.py <pid> — raise and focus the browser windows of one chromium.

No window manager runs on the Xvfb display, so nothing restacks windows when
chromium activates a tab; the CDP console calls this to bring an
isolated context's (or the main browser's) window in front of the others.
"""
import sys

from Xlib import X, display, error

pid = int(sys.argv[1])
d = display.Display()
d.set_error_handler(lambda *_: None)  # windows may vanish mid-walk
root = d.screen().root
NET_WM_PID = d.intern_atom("_NET_WM_PID")
ROLE = d.intern_atom("WM_WINDOW_ROLE")

raised = None
for win in root.query_tree().children:
    try:
        if win.get_attributes().map_state != X.IsViewable:
            continue
        wpid = win.get_full_property(NET_WM_PID, X.AnyPropertyType)
        role = win.get_full_property(ROLE, X.AnyPropertyType)
        if not wpid or wpid.value[0] != pid or not role or role.value != b"browser":
            continue
        win.configure(stack_mode=X.Above)
        raised = win
    except error.XError:
        continue

if raised is not None:
    raised.set_input_focus(X.RevertToParent, X.CurrentTime)
d.flush()
sys.exit(0 if raised is not None else 1)
