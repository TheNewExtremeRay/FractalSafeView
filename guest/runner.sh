#!/bin/sh
# Runs inside the guest as unprivileged 'player' user.
set -e

mkdir -p /mnt/input /mnt/output
mount -t 9p -o trans=virtio,version=9p2000.L,ro input /mnt/input || true
mount -t 9p -o trans=virtio,version=9p2000.L output /mnt/output || true

# Resource limits
ulimit -t 300
ulimit -v 524288

INPUT=$(find /mnt/input -maxdepth 1 -name '*.mp4' | head -n 1)
if [ -z "$INPUT" ]; then
  echo "no input mp4" >&2
  exit 1
fi

# Re-encode (decode + encode) so the host never decodes untrusted bytes.
# Output is a fresh, sanitized MP4.
su -s /bin/sh player -c \
  "ffmpeg -y -i '$INPUT' -map 0:v:0 -map 0:a:0 -c:v libx264 -preset fast -crf 23 -c:a aac -movflags +faststart /mnt/output/safe.mp4" \
  2>/tmp/ffmpeg.log

# Signal completion
touch /mnt/output/ready
sync
# Keep guest alive briefly then exit; QEMU -no-reboot will stop.
sleep 2
exit 0
