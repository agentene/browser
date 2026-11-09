"""Keep chromium's main windows covering the whole X screen, and decide
whether new windows come to the front.

No window manager runs on the Xvfb display, so after Selkies'
browser-driven resize a window stays at its startup size. A RandR size
change reaches the root window as a ConfigureNotify; on each one (and on
every newly mapped window) this moves chromium's main windows
(WM_WINDOW_ROLE "browser") to 0,0 at the full screen size. Popups, app
windows and undocked DevTools carry other roles and stay as chromium placed
them.

New windows: a window is created on top of the others, and with no window
manager chromium raises and focuses its own window whenever it activates
one, a new window included. This advertises _NET_ACTIVE_WINDOW (EWMH) so
that chromium sends the activation here as a request instead, and handles
both according to /tmp/desktop-raise-new-windows (desktop-raise-new-windows.sh):
true raises and focuses as chromium did; false creates windows at the bottom
of the stack and grants activation only to the window already in front.
The CDP console's Show restacks directly (raise-window.py), so it always
works. Needs python3-xlib and DISPLAY.
"""
from Xlib import X, Xatom, display, error

d = display.Display()
d.set_error_handler(lambda *_: None)  # windows may vanish mid-configure
root = d.screen().root
ROLE = d.intern_atom("WM_WINDOW_ROLE")
ACTIVE = d.intern_atom("_NET_ACTIVE_WINDOW")
SETTING = "/tmp/desktop-raise-new-windows"


def advertise_active_window():
    # the EWMH proof that a window manager is present: a window that names
    # itself in _NET_SUPPORTING_WM_CHECK, as the root does
    check = root.create_window(-1, -1, 1, 1, 0, 0, X.InputOnly, X.CopyFromParent)
    wm_check = d.intern_atom("_NET_SUPPORTING_WM_CHECK")
    for win in (root, check):
        win.change_property(wm_check, Xatom.WINDOW, 32, [check.id])
    check.change_property(d.intern_atom("_NET_WM_NAME"), d.intern_atom("UTF8_STRING"), 8,
                          b"chromium-follow-screen")
    root.change_property(d.intern_atom("_NET_SUPPORTED"), Xatom.ATOM, 32, [ACTIVE])


def raise_new_windows():
    try:
        with open(SETTING) as f:
            return f.read().strip() != "false"
    except OSError:
        return True


def front_window():
    # query_tree lists the root's children bottom to top
    for win in reversed(root.query_tree().children):
        try:
            attrs = win.get_attributes()
            if attrs.map_state == X.IsViewable and not attrs.override_redirect:
                return win.id
        except error.XError:
            continue
    return None


def activate(win, timestamp):
    if raise_new_windows():
        win.configure(stack_mode=X.Above)
    elif win.id != front_window():
        return
    win.set_input_focus(X.RevertToParent, timestamp)


def fit(win, w, h):
    try:
        if win.get_attributes().override_redirect:
            return
        role = win.get_full_property(ROLE, X.AnyPropertyType)
        if not role or role.value != b"browser":
            return
        g = win.get_geometry()
        if (g.x, g.y, g.width, g.height) == (0, 0, w, h):
            return
        win.configure(x=0, y=0, width=w, height=h)
        print(f"0x{win.id:x}: {g.width}x{g.height}+{g.x}+{g.y} -> {w}x{h}+0+0", flush=True)
    except error.XError:
        pass


def fit_all():
    g = root.get_geometry()
    for win in root.query_tree().children:
        fit(win, g.width, g.height)
    d.flush()


root.change_attributes(event_mask=X.StructureNotifyMask | X.SubstructureNotifyMask)
advertise_active_window()
fit_all()
print("ready", flush=True)
while True:
    ev = d.next_event()
    if ev.type == X.ConfigureNotify and ev.window.id == root.id:
        fit_all()
    elif ev.type == X.MapNotify:
        g = root.get_geometry()
        fit(ev.window, g.width, g.height)
        d.flush()
    elif ev.type == X.CreateNotify:
        if ev.parent.id == root.id and not ev.override and not raise_new_windows():
            ev.window.configure(stack_mode=X.Below)
            d.flush()
    elif ev.type == X.ClientMessage and ev.client_type == ACTIVE:
        activate(ev.window, ev.data[1][1])  # data: source, timestamp, …
        d.flush()
