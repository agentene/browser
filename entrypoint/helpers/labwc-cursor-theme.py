"""Write an all-transparent Xcursor theme for labwc.

Usage: labwc-cursor-theme.py <theme-dir>

The headless output has no cursor plane, so wlroots paints the pointer into
the output image and screencopy hands it to Selkies inside every frame —
while the Selkies client draws its own pointer locally as well: two
pointers, the video one trailing by the stream latency ("ghost"). Chromium
sets its cursors through cursor-shape-v1, i.e. by name from labwc's theme,
so this one leaves only the client's pointer (no latency; it stays an
arrow, as screencopy carries no cursor shape).
"""
import os, struct, sys

theme = sys.argv[1]
os.makedirs(theme + "/cursors", exist_ok=True)
with open(theme + "/index.theme", "w") as f:
    f.write("[Icon Theme]\nName=hidden\n")
# one Xcursor file holding a single transparent 32x32 image (nominal size 24).
# Not 1x1: wlroots sizes the cursor buffer as (int)(width / output scale) *
# scale, which is 0 for a 1x1 image once Selkies sets a scale above 1 (client
# DPI > 96), and the 0x0 allocation logs "gbm_bo_create failed: Invalid
# argument" in labwc.log on every cursor change. 32 covers any scale <= 32.
size = 32
image = struct.pack("<9I", 36, 0xFFFD0002, 24, 1, size, size, 0, 0, 0) + bytes(4 * size * size)
data = struct.pack("<4sIII", b"Xcur", 16, 0x10000, 1) + struct.pack("<3I", 0xFFFD0002, 24, 28) + image
with open(theme + "/cursors/default", "wb") as f:
    f.write(data)
# every cursor-shape-v1 name plus the legacy X names chromium and wlroots use
names = """context-menu help pointer progress wait cell crosshair text vertical-text
alias copy move no-drop not-allowed grab grabbing e-resize n-resize ne-resize nw-resize
s-resize se-resize sw-resize w-resize ew-resize ns-resize nesw-resize nwse-resize
col-resize row-resize all-scroll zoom-in zoom-out left_ptr xterm hand1 hand2 watch
left_ptr_watch fleur crossed_circle question_arrow sb_h_double_arrow sb_v_double_arrow
top_left_corner top_right_corner bottom_left_corner bottom_right_corner top_side
bottom_side left_side right_side dnd-move dnd-copy dnd-link X_cursor""".split()
for name in names:
    link = theme + "/cursors/" + name
    if not os.path.lexists(link):
        os.symlink("default", link)
