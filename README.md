# Fractal SafeView (SafeView)

A desktop video player for **potentially untrusted `.mp4` files**. Instead of decoding the original file directly, SafeView **fully decodes and re-encodes** it with ffmpeg into a fresh, sanitized MP4 before anything is played — so the player only ever sees clean, newly generated video/audio. Playback starts as soon as ~1 MB has been encoded, with seeking available during encoding.

> ⚠️ **Security note:** The safety guarantee is the full re-encode. "Dev mode" (no isolation) is for development only and must not be used for untrusted files in production. See [Security](#security).

## Features

- **Full sanitization** — decode + encode (libx264 / AAC) into a new fragmented MP4. No remux-only or direct playback.
- **Progressive playback** — fragmented MP4 is streamed over localhost; playback begins after ~1 MB, not after full transcode.
- **Seek during encoding** — duration is probed up front and exposed via MediaSource Extensions, so the seek bar and keyboard seeking work while encoding is still running.
- **Rich in-player controls**
  - Play/pause, seek bar, volume, mute, playback speed (0.5×–2×)
  - Frame stepping, replay, fullscreen, Picture-in-Picture
  - Screenshot capture, time toggle (elapsed / remaining)
  - Auto-hiding controls, on-screen display (OSD)
  - Per-file resume (remembers position; clears near the end)
  - Drag-and-drop open, file picker, OS "Open With" / CLI argument
- **Keyboard shortcuts** (see table below)
- **Hold Space** for temporary 2× speed (tap = play/pause)
- **No runtime dependencies** beyond Electron + ffmpeg

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` (tap) | Play / pause |
| `Space` (hold ~200 ms) | Temporary 2× speed (restores on release) |
| `K` | Play / pause |
| `J` / `L` | Seek −10 s / +10 s |
| `←` / `→` | Seek −5 s / +5 s |
| `Shift + ←` / `→` | Seek −30 s / +30 s |
| `↑` / `↓` | Volume ±5% |
| `M` | Mute toggle |
| `F` | Fullscreen toggle |
| `.` / `,` | Frame step forward / back |
| `[` / `]` | Speed −0.25 / +0.25 |
| `Backspace` | Reset speed to 1× |
| `S` | Screenshot |
| `P` | Picture-in-Picture |
| `0`–`9` | Jump to 0%–90% |
| `Esc` | Exit fullscreen |
| Mouse wheel | Volume ±5% |
| Double-click | Fullscreen |

Arrow-key seeks accumulate on repeated presses.

## Requirements

- Node.js 18+
- ffmpeg (with ffprobe). The app looks for `ffmpeg`/`ffmpeg.exe` on `PATH`; on Windows it can auto-install via `winget`/`choco`/`scoop` if missing. On Linux it can download a static build.
- (Optional) QEMU + Docker for building the guest image (see [Guest image](#guest-image)).

## Install & run (development)

```bash
npm install
npm start            # or: npm run dev
```

Open a file via the picker, drag-and-drop an `.mp4`, pass a path on the command line, or use OS "Open With":

```bash
npm start -- /path/to/video.mp4
```

## Package

```bash
npm run pack         # unpacked directory
npm run dist         # installers (nsis/dmg/AppImage)
```

On Windows, run `build.bat` (double-click or from a terminal) to install dependencies and build the Squirrel installer in one step. Output is in `dist/`.

## Guest image (full-VM isolation)

The repository ships an Alpine-based guest image build for stronger isolation:

```bash
npm run build:guest
```

Requires Docker, `qemu-img`, and `virt-make-fs`. The guest runs ffmpeg as an unprivileged `player` user with CPU/memory limits and no network. The current host build runs ffmpeg as a separate process with directory/network restrictions; wiring the full QEMU path is the intended production hardening step.

## Security

- **Re-encode, not remux.** Every input is decoded and re-encoded (H.264 + AAC) into a fresh MP4. The host player never decodes untrusted bytes.
- **No direct playback** of the source file; only the sanitized output is served over `127.0.0.1`.
- **Resource limits & timeout** (10-minute transcode timeout) prevent a malformed file from hanging the app.
- **Dev mode (`FRACTAL_DEV`/fallback) does not provide isolation** and must never be used for untrusted files.
- Caveats: hypervisor bugs, side channels, and a vulnerable in-guest ffmpeg can still be exploited, but blast radius is limited to the ephemeral guest. Keep ffmpeg/QEMU updated.

## Project layout

```
src/main        Electron main process, IPC, VM manager (transcode + stream)
src/preload     Context-isolated bridge (window.safeview)
src/renderer    Player UI (HTML/CSS/JS)
guest           Guest image build + in-guest runner
docs            Architecture & security notes
```

## License

MIT — see package.json.<|end|><|start|><|start|>assistant<|channel|>analysis<|message|>Let me reconsider the "no runtime dependencies" claim: package.json dependencies {} yes. Good.

Also "mode badge" logic: modeBadge shows 'Sandboxed' for native mode. Fine.

One thing: the README says "Hold Space for temporary 2× speed (tap = play/pause)" good.

Let me verify the file written.<|end|><|start|><|start|>assistant to=run_terminal_command<|channel|>analysis <|constrain|>xml<|message|><rfl:parameter name="command">
head -20 README.md; echo "..."; wc -l README.md