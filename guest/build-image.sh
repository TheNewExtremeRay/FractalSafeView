#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/guest/image"
mkdir -p "$OUT_DIR"
IMG="$OUT_DIR/safeview.img"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2; exit 1
fi
if ! command -v virt-make-fs >/dev/null 2>&1; then
  echo "virt-make-fs (libguestfs) is required to pack the image" >&2; exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Build rootfs
docker run --rm -v "$TMP:/out" alpine:3.20 sh -c '
  apk add --no-cache ffmpeg tini coreutils
  mkdir -p /out/rootfs/mnt/input /out/rootfs/mnt/output /out/rootfs/opt/safeview
  cp -a /bin /sbin /lib /usr /etc /out/rootfs/
  adduser -D -s /bin/sh player || true
'
# install runner
cp "$ROOT/guest/runner.sh" "$TMP/rootfs/opt/safeview/runner.sh"
chmod +x "$TMP/rootfs/opt/safeview/runner.sh"

# init: run runner then halt
cat > "$TMP/rootfs/sbin/init" <<'EOF'
#!/bin/sh
mount -t proc proc /proc
mount -t sysfs sys /sys
mount -t devtmpfs dev /dev
# run sanitizer as player
/opt/safeview/runner.sh
poweroff -f
EOF
chmod +x "$TMP/rootfs/sbin/init"

# Pack
virt-make-fs --type=ext4 --size=+512M "$TMP/rootfs" "$IMG"
echo "Built guest image: $IMG"
