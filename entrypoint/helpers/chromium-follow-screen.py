"""Keep chromium's main windows covering the whole X screen.

No window manager runs on the Xvfb display, so after Selkies'
browser-driven resize a window stays at its startup size. A RandR size
change reaches the root window as a ConfigureNotify; on each one (and on
every newly mapped window) this moves chromium's main windows
(WM_WINDOW_ROLE "browser") to 0,0 at the full screen size. Popups, app
windows and undocked DevTools carry other roles and stay as chromium placed
them. Needs python3-xlib and DISPLAY.
"""
from Xlib import X, display, error

d = display.Display()
d.set_error_handler(lambda *_: None)  # windows may vanish mid-configure
root = d.screen().root
ROLE = d.intern_atom("WM_WINDOW_ROLE")
root.change_attributes(event_mask=X.StructureNotifyMask | X.SubstructureNotifyMask)


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


fit_all()
while True:
    ev = d.next_event()
    if ev.type == X.ConfigureNotify and ev.window.id == root.id:
        fit_all()
    elif ev.type == X.MapNotify:
        g = root.get_geometry()
        fit(ev.window, g.width, g.height)
        d.flush()
