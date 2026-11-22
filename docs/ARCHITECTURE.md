# Fractal SafeView — Architecture

## Components

1. **Host App (Electron)** — `src/main`, `src/preload`, `src/renderer`
   - Main process: window lifecycle, IPC, file picker, CLI/open-with handling, VM manager.
   - Renderer: distraction-free player UI (video element + controls). Never decodes media itself in production mode.
   - Preload: context-isolated bridge (`window.safeview`).

2. **VM Lifecycle Manager** — `src/main/vm-manager.js`
   - Validates the selected .mp4 (exists, extension, non-empty).
   - Picks a free localhost port for the stream proxy.
   - Spawns QEMU with strict flags (see below) or falls back to dev mode.
   - Arms a playback/decode timeout; tears down on close.

3. **Guest Image** — `guest/build-image.sh`, `guest/runner.sh`
   - Minimal Alpine rootfs with ffmpeg/mpv only; unprivileged `player` user.
   - No services, no package manager at runtime, no network stack usage.

4. **Media Pipeline**
   - Host shares ONLY the target .mp4 (or its parent dir scoped to that file) read-only via virtio-9p.
   - Guest `runner.sh` mounts it read-only, runs ffmpeg as `player`, streams MPEG-TS over vsock to host.
   - Host receives the stream and feeds it to the renderer's `<video>` element (via MediaSource or a local proxy).
   - On close/timeout, QEMU is killed (SIGKILL) and tmp state discarded.

## Isolation flags (QEMU)

- `-nic none` — no virtual NIC, no network at all.
- `-m 512 -smp 2` — CPU/memory caps.
- 9p share marked `readonly=on`, scoped to the target file's directory (prefer copying the single file into a staging dir and sharing that).
- Guest decoder runs as unprivileged user with `ulimit` CPU/memory caps and a 5-minute timeout.
- Image is read-only (`-drive ...,readonly=on`); overlay/tmpfs for any writes.

## Transport

- vsock (AF_VSOCK) between guest and host — no TCP/IP, no host network exposure.
- MPEG-TS over vsock → host proxy on 127.0.0.1 → renderer `<video src>`.

## Packaging

- Internal/build name: `fractal-safeview` (package name, artifact prefix `FractalSafeView-`).
- User-facing name: `SafeView` (productName, window title, shortcut, file association label).
- Configured in `package.json` `build` section for electron-builder.
