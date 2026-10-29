# shellcheck shell=bash
# gpu.sh — GPU detection (gpu_detect).
#
# compose.gpu.yaml (Intel/AMD: /dev/dri passthrough) or
# compose.gpu-nvidia.yaml (nvidia runtime) pass a host GPU in; detect it
# here, for chromium's GPU policy (chromium.sh) and the Wayland compositor
# (display-wayland.sh, selkies.sh). Only DEVICE NODES count as evidence:
# /proc/driver/nvidia is visible in every container on a host with the
# kernel module loaded (it reflects the host kernel, not the container), and
# the nvidia toolkit only creates /dev/nvidiactl inside the container when
# the passthrough actually worked. A /dev/dri node owned by nvidia-drm is
# skipped — Mesa cannot drive it (only the injected nvidia GL stack can,
# detected via /dev/nvidiactl below).
#
# Sets GPU_RENDER_NODE: a Mesa render node (/dev/dri/renderD*), the
# "nvidia (/dev/nvidiactl)" marker, or empty without a GPU.

gpu_detect() {
    local node
    GPU_RENDER_NODE=""
    for node in /dev/dri/renderD*; do
        [ -e "${node}" ] || continue
        grep -q 'DRIVER=nvidia' "/sys/class/drm/${node##*/}/device/uevent" \
            2>/dev/null && continue
        GPU_RENDER_NODE="${node}"
        break
    done
    if [ -z "${GPU_RENDER_NODE}" ] && [ -e /dev/nvidiactl ]; then
        GPU_RENDER_NODE="nvidia (/dev/nvidiactl)"
    fi
    return 0
}

# gpu_has_mesa_node: true when GPU_RENDER_NODE is a device path Mesa drives.
gpu_has_mesa_node() {
    [[ "${GPU_RENDER_NODE}" == /dev/* ]]
}
