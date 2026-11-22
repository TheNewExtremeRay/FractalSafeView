# Fractal SafeView — Security & Limitations

## What this protects against
- Exploits in media decoders (ffmpeg/mpv/GStreamer) are confined to the guest VM; the host only receives decoded video/audio frames over a narrow vsock channel.
- No network in the guest prevents callback/exfiltration and remote payload fetch.
- Read-only, tightly scoped file share prevents the guest from reading the host filesystem.
- Resource limits and a decode timeout prevent a malformed file from hanging the host.

## Caveats (real-world)
- Hypervisor vulnerabilities exist but are rare and patched; keep QEMU/KVM and host kernel updated.
- Container/namespace-based isolation is weaker than a true VM; this project uses a full VM (QEMU) for stronger boundaries.
- The guest decoder must be kept updated; a vulnerable ffmpeg inside the guest can still be exploited, but blast radius is limited to the ephemeral guest.
- Side-channel risks (CPU, cache) are not fully mitigated by this design.
- The host stream proxy and renderer must be hardened against malformed MPEG-TS; treat guest output as untrusted.
- Dev mode (`FRACTAL_DEV=1` fallback) does NOT provide isolation and must never be used for untrusted files in production.

## Teardown
- On window close, QEMU is killed and the stream server closed; no guest state persists between runs (image is read-only).
