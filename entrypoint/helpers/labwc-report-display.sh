#!/bin/sh
# labwc startup command (-s): report labwc's own auto-picked socket
# (wayland-N) back to the entrypoint, which waits for this file.
printf %s "$WAYLAND_DISPLAY" >/tmp/labwc-display
