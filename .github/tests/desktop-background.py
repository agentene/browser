"""Run inside a fresh desktop container with Docker's 64 MiB /dev/shm.

Exercise the actual output resize path, keeping the same background process
alive throughout. Wayland includes fractional scale (a 4K output at 1.25
needs an approximately 81 MiB swaybg buffer). X11 checks server-side pixels
and pixmap lifetime as well as survival, including cropping on small screens.
The test is fed to `docker exec -i ... python3 -`; it is not shipped.
"""
import importlib.util
import os
from pathlib import Path
import subprocess
import time


def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT).strip()


backend = os.environ["DISPLAY_BACKEND"]
if backend == "wayland":
    os.environ["WAYLAND_DISPLAY"] = Path("/tmp/labwc-display").read_text().strip()
    os.environ.setdefault("XDG_RUNTIME_DIR", "/tmp")
    output = run("wlr-randr").split()[0]
    process = ["pgrep", "-x", "swaybg"]
else:
    from Xlib import X, display, error

    socket = next(Path("/tmp/.X11-unix").glob("X*"))
    os.environ["DISPLAY"] = ":" + socket.name[1:]
    connection = display.Display()
    root = connection.screen().root
    atoms = [connection.intern_atom(name) for name in ("_XROOTPMAP_ID", "ESETROOT_PMAP_ID")]
    process = ["pgrep", "-f", "^python3 -u .*/x11-desktop-background.py "]
    spec = importlib.util.spec_from_file_location(
        "background", "/usr/local/lib/docker-entrypoint/helpers/x11-desktop-background.py")
    background = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(background)
    img_w, img_h, rows = background.read_png(
        "/usr/local/lib/docker-entrypoint/assets/desktop-background.png")


pid = run(*process)
previous_pixmap = None


def check_x11(width, height):
    global previous_pixmap
    # Wait for the helper to publish the fully drawn replacement pixmap.
    deadline = time.monotonic() + 5
    while True:
        props = [root.get_full_property(atom, X.AnyPropertyType) for atom in atoms]
        if all(props) and props[0].value[0] == props[1].value[0]:
            pixmap = connection.create_resource_object("pixmap", int(props[0].value[0]))
            try:
                geom = pixmap.get_geometry()
            except error.BadDrawable:
                # The helper can replace it between the property read and
                # GetGeometry; try the newly published pixmap next time.
                geom = None
            if geom and (geom.width, geom.height) == (width, height):
                break
        if time.monotonic() >= deadline:
            raise AssertionError(f"root pixmap did not follow {width}x{height}")
        time.sleep(0.05)
    # Gray corners on large outputs; the picture remains centered at native
    # size, and is cropped on smaller ones. Sample across the picture too.
    points = [(0, 0), (width - 1, height - 1)]
    points += [(width // 2 + dx, height // 2 + dy)
               for dx in (-100, 0, 100) for dy in (-50, 0, 50)]
    for x, y in points:
        ix, iy = x - (width - img_w) // 2, y - (height - img_h) // 2
        expected = bytes((background.BG_B, background.BG_G, background.BG_R))
        if 0 <= ix < img_w and 0 <= iy < img_h:
            expected = rows[iy][ix * 4:ix * 4 + 3]
        actual = pixmap.get_image(x, y, 1, 1, X.ZPixmap, 0xFFFFFF).data[:3]
        assert actual == expected, (width, height, x, y, actual, expected)
    if previous_pixmap and previous_pixmap.id != pixmap.id:
        try:
            previous_pixmap.get_geometry()
        except error.BadDrawable:
            pass
        else:
            raise AssertionError("old root pixmap leaked after resize")
    previous_pixmap = pixmap


# Repeated large/small transitions catch retained buffers and replacement
# pixmaps. Distinct large sizes also catch two >32 MiB buffers coexisting.
sizes = [(3840, 2160), (4096, 2160), (1280, 720), (640, 360)] * 3
for width, height in sizes:
    for scale in ((1, 1.25, 2) if backend == "wayland" else (1,)):
        if backend == "wayland":
            run("wlr-randr", "--output", output, "--custom-mode", f"{width}x{height}",
                "--scale", str(scale))
        else:
            run("selkies", "resize", f"{width}x{height}")
            check_x11(width, height)
        time.sleep(0.3)
        assert run(*process) == pid, "background process exited or restarted"
        print(f"{backend}: {width}x{height} scale={scale}, background pid={pid}", flush=True)

log = Path("/tmp/desktop-background.log").read_text()
assert not any(word in log.lower() for word in ("failed", "error", "traceback")), log
print(f"{backend}: background resize regression OK", flush=True)
