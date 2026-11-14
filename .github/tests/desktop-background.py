"""Exercise background geometry, bounded buffers and X11 input/stacking inside a fresh desktop container. Feed this file to docker exec -i ... python3 -; use WAYLAND_DEBUG=client for the Wayland client and install grim in the disposable test container. The test is not shipped in the image."""
import os
import math
from pathlib import Path
import re
import struct
import subprocess
import time
import zlib


def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT).strip()


# Independent reference PNG decoder, retained from the original Python implementation. The runtime clients now decode PNGs with Cairo.
BACKGROUND = 0x9AA0A6  # around the picture and under its transparent parts
BG_R, BG_G, BG_B = BACKGROUND >> 16, (BACKGROUND >> 8) & 0xFF, BACKGROUND & 0xFF


def read_png(path):
    """(width, height, rows) with rows as BGRX bytes composited on BACKGROUND."""
    with open(path, "rb") as f:
        data = f.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path}: not a PNG")
    pos, idat, ihdr = 8, [], None
    while pos < len(data):
        length, kind = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if kind == b"IHDR":
            ihdr = struct.unpack(">IIBBBBB", body)
        elif kind == b"IDAT":
            idat.append(body)
        elif kind == b"IEND":
            break
    if ihdr is None:
        raise ValueError(f"{path}: no IHDR")
    width, height, depth, color, _, _, interlace = ihdr
    if depth != 8 or color not in (2, 6) or interlace:
        raise ValueError(f"{path}: only 8-bit non-interlaced RGB/RGBA PNGs are supported")
    bpp = 4 if color == 6 else 3
    stride = width * bpp
    raw = zlib.decompress(b"".join(idat))

    rows, prev = [], bytearray(stride)
    for y in range(height):
        start = y * (stride + 1)
        kind = raw[start]
        line = bytearray(raw[start + 1:start + 1 + stride])
        if kind == 1:  # Sub
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif kind == 2:  # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif kind == 3:  # Average
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif kind == 4:  # Paeth
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pred = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                line[i] = (line[i] + pred) & 0xFF
        elif kind != 0:
            raise ValueError(f"{path}: bad filter type {kind}")
        prev = line

        out = bytearray(width * 4)
        for x in range(width):
            r, g, b = line[x * bpp], line[x * bpp + 1], line[x * bpp + 2]
            if bpp == 4:
                a = line[x * bpp + 3]
                # over the background color
                r = (r * a + BG_R * (255 - a)) // 255
                g = (g * a + BG_G * (255 - a)) // 255
                b = (b * a + BG_B * (255 - a)) // 255
            out[x * 4:x * 4 + 3] = bytes((b, g, r))
        rows.append(bytes(out))
    return width, height, rows



img_w, img_h, rows = read_png('/usr/local/lib/docker-entrypoint/assets/desktop-background.png')
backend = os.environ['DISPLAY_BACKEND']
os.environ.pop('WAYLAND_DEBUG', None)  # Only the already-started background client needs protocol tracing.
if backend == 'wayland':
    os.environ['WAYLAND_DISPLAY'] = Path('/tmp/labwc-display').read_text().strip()
    os.environ.setdefault('XDG_RUNTIME_DIR', '/tmp')
    output = run('wlr-randr').split()[0]
    process = ['pgrep', '-x', 'swaybg']
else:
    from Xlib import X, display
    from Xlib.ext import shape

    socket = next(Path('/tmp/.X11-unix').glob('X*'))
    os.environ['DISPLAY'] = ':' + socket.name[1:]
    connection = display.Display()
    root = connection.screen().root
    atoms = [connection.intern_atom(name) for name in ('_XROOTPMAP_ID', 'ESETROOT_PMAP_ID')]
    process = ['pgrep', '-f', '(^|/)x11-desktop-background ']
    image_window = next(w for w in root.query_tree().children
                        if w.get_wm_class() == ('desktop-background', 'AgenteneDesktopBackground'))
    root_pixmap_id = int(root.get_full_property(atoms[0], X.AnyPropertyType).value[0])
    root_pixmap = connection.create_resource_object('pixmap', root_pixmap_id)
    assert not image_window.shape_get_rectangles(shape.SK.Input).rectangles, 'background intercepts pointer input'
    assert image_window.get_attributes().override_redirect, 'background is a managed application window'
    assert not image_window.get_wm_hints().input, 'background can take keyboard focus'

pid = run(*process)


def wait_for(check, message):
    deadline = time.monotonic() + 5
    while not check():
        if time.monotonic() >= deadline:
            raise AssertionError(message)
        time.sleep(0.05)


def check_x11(width, height):
    def positioned():
        geom = image_window.get_geometry()
        return (geom.x, geom.y, geom.width, geom.height) == (
            (width - img_w) // 2, (height - img_h) // 2, img_w, img_h)
    wait_for(positioned, f'background did not follow {width}x{height}')
    props = [root.get_full_property(atom, X.AnyPropertyType) for atom in atoms]
    assert all(prop.value[0] == root_pixmap_id for prop in props), 'root tile reallocated on resize'
    geom = root_pixmap.get_geometry()
    assert (geom.width, geom.height) == (1, 1), 'screen-sized root pixmap returned'
    gray = bytes((BG_B, BG_G, BG_R))
    assert root_pixmap.get_image(0, 0, 1, 1, X.ZPixmap, 0xFFFFFF).data[:3] == gray
    points = [(0, 0), (width - 1, height - 1)]
    points += [(width // 2 + dx, height // 2 + dy)
               for dx in (-100, 0, 100) for dy in (-50, 0, 50)]
    for x, y in points:
        ix, iy = x - (width - img_w) // 2, y - (height - img_h) // 2
        if 0 <= ix < img_w and 0 <= iy < img_h:
            actual = image_window.get_image(ix, iy, 1, 1, X.ZPixmap, 0xFFFFFF).data[:3]
            expected = rows[iy][ix * 4:ix * 4 + 3]
            # Cairo rounds alpha composition, while the independent PNG reference decoder floors it.
            assert all(abs(a - b) <= 1 for a, b in zip(actual, expected)), (x, y, actual, expected)

    # Reproduce a newly created browser lowering itself. The background must return below it without stealing focus.
    probe = root.create_window(0, 0, 32, 32, 0, connection.screen().root_depth,
                               X.InputOutput, X.CopyFromParent, background_pixel=0)
    try:
        probe.map()
        connection.sync()
        probe.set_input_focus(X.RevertToParent, X.CurrentTime)
        probe.configure(stack_mode=X.Below)
        connection.sync()
        def below():
            children = [w.id for w in root.query_tree().children]
            return children.index(image_window.id) < children.index(probe.id)
        wait_for(below, 'desktop picture covers a lowered browser')
        assert connection.get_input_focus().focus.id == probe.id, 'background stole keyboard focus'
    finally:
        probe.destroy()
        connection.sync()


def check_wayland(width, height, scale):
    # Read the actual compositor output, not just the client's allocation log. A missing parent/child commit can otherwise pass every size and process-survival check with a black desktop.
    data = subprocess.check_output(['grim', '-o', output, '-s', '1', '-t', 'ppm', '-'])
    header = re.match(rb'P6\s+(\d+)\s+(\d+)\s+255\s', data)
    assert header, 'unexpected capture format'
    w, h = map(int, header.groups())
    assert abs(w - width / scale) <= 1 and abs(h - height / scale) <= 1, (w, h, width, height, scale)
    pixels = memoryview(data)[header.end():]
    def pixel(x, y):
        offset = (y * w + x) * 3
        return pixels[offset:offset + 3]
    integer_scale = math.ceil(scale)
    if w > img_w / integer_scale + 32 and h > img_h / integer_scale + 32:
        gray = (BG_R, BG_G, BG_B)
        # grim downsamples high-DPI captures; sample inside the frame to avoid its resampling kernel blending the outermost pixels with black outside the image.
        for x, y in ((16, 16), (w - 17, h - 17)):
            assert all(abs(a - b) <= 1 for a, b in zip(pixel(x, y), gray)), ('background color missing', list(pixel(x, y)))
    # Allow resampling around the center at odd dimensions and fractional scales. The shipped picture has a bright center, so a missing image over the gray parent cannot pass.
    radius = integer_scale + 1
    reference = [rows[y][x * 4:x * 4 + 3][::-1]
                 for y in range(img_h // 2 - radius, img_h // 2 + radius + 1)
                 for x in range(img_w // 2 - radius, img_w // 2 + radius + 1)]
    actual = pixel(w // 2, h // 2)
    for channel in range(3):
        values = [p[channel] for p in reference]
        assert min(values) - 2 <= actual[channel] <= max(values) + 2, 'centered image missing or misplaced'


captured = set()
sizes = [(3840, 2160), (4096, 2160), (1280, 720), (640, 360), (641, 361)] * 2
for width, height in sizes:
    for scale in ((1, 1.25, 2, 2.5) if backend == 'wayland' else (1,)):
        if backend == 'wayland':
            run('wlr-randr', '--output', output, '--custom-mode', f'{width}x{height}', '--scale', str(scale))
        else:
            run('selkies', 'resize', f'{width}x{height}')
            # RandR's generated CVT mode rounds the requested width up to a multiple of eight.
            actual = root.get_geometry()
            assert width <= actual.width < width + 8 and actual.height == height
            check_x11(actual.width, actual.height)
        time.sleep(0.3)
        assert run(*process) == pid, 'background process exited or restarted'
        # grim needs a second full-output SHM buffer even for cropped captures. Keep pixel readback within Docker's 64 MiB budget; larger modes still exercise sizing, bounded allocations and process survival.
        can_capture = width * height * 8 <= 64 * 1024 * 1024 - 512 * 1024
        if backend == 'wayland' and can_capture and (width, height, scale) not in captured:
            check_wayland(width, height, scale)
            captured.add((width, height, scale))
        print(f'{backend}: {width}x{height} scale={scale}, background pid={pid}', flush=True)

log = Path('/tmp/desktop-background.log').read_text()
assert not any(word in log.lower() for word in ('failed', 'error', 'traceback')), log
if backend == 'wayland':
    pools = [int(size) for size in re.findall(r'wl_shm[#@]\d+\.create_pool\([^\n]*, (\d+)\)', log)]
    assert pools, 'start the test container with WAYLAND_DEBUG=client to inspect background buffers'
    # The largest advertised integer scale in this test is 3. Padding must stay below two logical pixels in each dimension.
    limit = (img_w + 6) * (img_h + 6) * 4
    assert max(pools) <= limit, f'background buffer grew with the output: {max(pools)} > {limit}'
    assert 'create_u32_rgba_buffer' in log and 'get_subsurface' in log, 'missing color/image split'
    print(f'largest background buffer: {max(pools)} bytes (limit {limit})', flush=True)
print(f'{backend}: background size, geometry and input regression OK', flush=True)
