"""Paint the desktop background on the X11 display (DISPLAY_BACKEND=x11).

Shows the image given as the only argument (an 8-bit RGB/RGBA PNG) at its
own size in the middle of the screen, on a neutral gray — what the Selkies stream
shows once no browser window covers the screen.

The picture goes into a root pixmap advertised in _XROOTPMAP_ID /
ESETROOT_PMAP_ID, which is what picom paints behind the windows (a plain
root window background would stay black under picom). The pixmap belongs to
this connection, so the helper stays running, and redraws it on every RandR
size change of the screen (Selkies' browser-driven resize), which reaches
the root window as a ConfigureNotify. The off-the-shelf setters do not fit:
xwallpaper pads the screen around a centered image in black, and hsetroot
pulls Imlib2's loaders (ghostscript and its fonts) into the image.

The PNG is decoded here with zlib alone (once, at start; the image ships
with the image, so no other kind of PNG needs support). Needs python3-xlib
and DISPLAY.
"""
import struct
import sys
import zlib

from Xlib import X, Xatom, display

BACKGROUND = 0x9AA0A6  # around the picture and under its transparent parts
BG_R, BG_G, BG_B = BACKGROUND >> 16, (BACKGROUND >> 8) & 0xFF, BACKGROUND & 0xFF
BAND_BYTES = 128 * 1024  # stays under the core protocol's request size


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


def main():
    img_w, img_h, rows = read_png(sys.argv[1])
    d = display.Display()
    screen = d.screen()
    root = screen.root
    depth = screen.root_depth
    pmap_atoms = [d.intern_atom("_XROOTPMAP_ID"), d.intern_atom("ESETROOT_PMAP_ID")]
    band = max(1, BAND_BYTES // (img_w * 4))
    current = None  # (pixmap, width, height)

    def paint():
        nonlocal current
        geom = root.get_geometry()
        w, h = geom.width, geom.height
        if current and current[1:] == (w, h):
            return
        pixmap = root.create_pixmap(w, h, depth)
        gc = pixmap.create_gc(foreground=BACKGROUND)
        pixmap.fill_rectangle(gc, 0, 0, w, h)
        # centered at its own size; a screen smaller than the picture crops it
        x0, y0 = (w - img_w) // 2, (h - img_h) // 2
        for top in range(0, img_h, band):
            chunk = rows[top:top + band]
            pixmap.put_image(gc, x0, y0 + top, img_w, len(chunk), X.ZPixmap, depth, 0,
                             b"".join(chunk))
        gc.free()
        for atom in pmap_atoms:
            root.change_property(atom, Xatom.PIXMAP, 32, [pixmap.id])
        root.change_attributes(background_pixmap=pixmap)
        root.clear_area()
        if current:
            current[0].free()
        current = (pixmap, w, h)
        d.flush()

    root.change_attributes(event_mask=X.StructureNotifyMask)
    paint()
    while True:
        # only ConfigureNotify and the like arrive (StructureNotify); a
        # resize sends a burst, so drain it and paint once for the last size
        # (paint() itself skips an unchanged size)
        d.next_event()
        while d.pending_events():
            d.next_event()
        paint()


if __name__ == "__main__":
    main()
