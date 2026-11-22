# Fractal SafeView — Detailed Documentation

> **Project:** Fractal SafeView (user-facing name "SafeView")
> **Package name:** `fractal-safeview`
> **Version:** 0.1.0
> **License:** MIT
> **Author:** Fractal
> **Type:** Electron desktop application (AudioVideo category)
>
> This document is a complete, file-by-file, behavior-by-behavior description of the repository as it exists. It deliberately describes the *implemented* behavior, including places where the implementation differs from the high-level architecture described in `docs/ARCHITECTURE.md`.

---

## 1. Purpose

SafeView is a desktop video player whose stated goal is to play **potentially untrusted `.mp4` files** in an isolated way so that the host never decodes untrusted media bytes. The user-facing experience is a distraction-free player window; internally the app re-encodes (decodes + encodes) the source into a fresh, sanitized MP4 and streams that sanitized file to the renderer's `<video>` element.

The product is distributed as an Electron app with installers named `FractalSafeView-<version>-<os>-<arch>.<ext>` and shortcut/app name `SafeView`.

---

## 2. Repository Layout

```
Fractal SafeView/
├── assets/                  # App icons (icon.icns, icon.ico, icon.png)
├── dist/                    # electron-builder output (gitignored-ish; contains builder-debug.yml)
├── docs/
│   ├── ARCHITECTURE.md      # High-level intended architecture
│   ├── SECURITY.md          # Security model & caveats
│   └── DETAILED_DOCUMENTATION.md  # This file
├── guest/
│   ├── build-image.sh       # Builds an Alpine rootfs image (Docker + virt-make-fs)
│   └── runner.sh           # In-guest decode/re-encode script
├── node_modules/            # Electron, electron-builder (no runtime deps)
├── src/
│   ├── main/
│   │   ├── index.js        # Electron main process: window, IPC, menus, open-with
│   │   ├── cli.js          # CLI argument parsing
│   │   └── vm-manager.js   # "VM" lifecycle manager (actually ffmpeg transcoder)
│   ├── preload/
│   │   └── index.js        # contextBridge -> window.safeview
│   └── renderer/
│       ├── index.html      # Player UI markup
│       ├── player.js       # Player logic & controls
│       └── styles.css      # Player styles
├── package.json
├── run.bat                  # Launch from source (Windows)
├── run-dev.bat              # Launch with FRACTAL_ALLOW_DEV=1
└── README.md
```

There are **no runtime npm dependencies** (`"dependencies": {}`). Only `electron` and `electron-builder` are devDependencies.

---

## 3. Technology Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron 33 (`electron .`) |
| Packaging | electron-builder 25 |
| Main process | Node.js (CommonJS, `'use strict'`) |
| Renderer | Vanilla HTML/CSS/JS (no framework, no bundler) |
| Media processing | `ffmpeg` (external binary, auto-discovered/downloaded) |
| IPC | Electron `ipcMain`/`ipcRenderer` with context isolation |
| Guest image (intended) | Alpine 3.20 rootfs, ext4, ffmpeg + tini, unprivileged `player` user |

---

## 4. High-Level Architecture (Intended vs. Implemented)

### 4.1 Intended (per docs/ARCHITECTURE.md)

1. Host app (Electron) — window, IPC, file picker, CLI/open-with, VM manager.
2. VM Lifecycle Manager — validates `.mp4`, picks free localhost port, spawns **QEMU** with strict isolation flags, or falls back to dev mode.
3. Guest image — minimal Alpine with ffmpeg/mpv, unprivileged `player`, no network.
4. Media pipeline — host shares only the target `.mp4` read-only via virtio-9p; guest decodes with ffmpeg and streams MPEG-TS over **vsock** to host; host proxies to renderer `<video>`.
5. Teardown — SIGKILL QEMU, discard tmp state.

Isolation flags: `-nic none`, `-m 512 -smp 2`, read-only 9p share, resource limits, 5-min timeout, read-only image.

### 4.2 Implemented (actual code)

The actual `VmManager` (`src/main/vm-manager.js`) **does not spawn QEMU or use vsock**. Instead it:

- Validates the file.
- Ensures an `ffmpeg` binary exists (discover or download/install).
- Creates a temp work dir with restricted permissions.
- Starts a local HTTP server on `127.0.0.1` serving a transcoded `safe.mp4`.
- Spawns `ffmpeg` to re-encode the source into `safe.mp4` (libx264/aac, ultrafast, CRF 23).
- Waits for ffmpeg to finish and the output file to be non-empty.
- Returns a `streamUrl` (`http://127.0.0.1:<port>/safe.mp4`) that the renderer plays directly.
- Tears down on close/timeout (kills ffmpeg, closes server, deletes work dir).

`status().isolated` is **hard-coded to `false`**, and `mode` is set to `'native'` on success. The renderer's mode badge maps `mode === 'native'` → "Sandboxed" (green). So despite the "Sandboxed"/"Isolated VM" labeling, the running implementation is a **local ffmpeg transcode**, not a VM. The guest image build scripts exist but are not invoked by the app.

> Note: `docs/SECURITY.md` explicitly warns that dev mode (`FRACTAL_DEV=1` fallback) does NOT provide isolation. In the current implementation *no* mode provides VM isolation; the ffmpeg path is the only path.

---

## 5. Application Startup & Lifecycle

### 5.1 Entry

`package.json` → `"main": "src/main/index.js"`. Launched via `npm start` (`electron .`) or `run.bat`.

### 5.2 `src/main/index.js`

- Requires Electron modules, `VmManager`, `parseArgs`.
- Module-level singletons: `mainWindow`, `tray` (unused), `vmManager`.
- `createWindow(filePath)`:
  - If a non-destroyed window exists, focus it and forward `open-file` if `filePath`.
  - Otherwise create a `BrowserWindow` (960×640, min 480×320, title "SafeView", black bg, hidden until ready) with:
    - `preload: src/preload/index.js`
    - `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
  - Load `src/renderer/index.html`.
  - On `ready-to-show`: show window; send `open-file` if filePath.
  - On `closed`: `await vmManager.teardown()`; set `mainWindow = null`.
  - Build minimal menu (fileMenu, viewMenu, windowMenu, Help→About).
- `app.whenReady()`:
  - Parse CLI file: `const { file } = parseArgs(process.argv);`
  - `createWindow(file)`.
  - On `activate`: create window if none.
  - Register `open-file` (OS "Open With"): prevent default; forward to window or create window with filePath.
- `window-all-closed`: quit unless macOS.
- IPC handlers (see §8).

### 5.3 CLI parsing (`src/main/cli.js`)

`parseArgs(argv)` returns `{ file }`. It finds the first argv token matching `/\.mp4$/i` that does not start with `--`. Used both for direct launch (`electron . file.mp4`) and open-with.

### 5.4 `run.bat` / `run-dev.bat`

- `run.bat`: cd to script dir; run `node_modules/.bin/electron.cmd .` with all args; else print "npm install" hint.
- `run-dev.bat`: sets `FRACTAL_ALLOW_DEV=1` then calls `run.bat`.

---

## 6. Main Process — Window, Menu, File Picker

Key behaviors:

- **Single window** model: reusing existing window on repeated launches/open-with.
- **File open dialog**: `pick-file` IPC opens a native open dialog filtered to `mp4`, returns first path or `null`.
- **VM control IPC**: `vm:start`, `vm:stop`, `vm:status` (see §8).
- **About dialog**: shows "Fractal SafeView 0.1.0… Internal build name: Fractal SafeView."

---

## 7. VM Manager (`src/main/vm-manager.js`) — Detailed

### 7.1 State

Instance fields:

| Field | Purpose |
|---|---|
| `state` | `'idle' | 'booting' | 'ready' | 'error'` |
| `filePath` | Source path |
| `mode` | `'native'` (set on success) / `'error'` |
| `ffmpegProc` | Child process |
| `streamServer` | HTTP server |
| `streamPort`, `streamUrl` | Local proxy endpoint |
| `error` | Error string |
| `startedAt` | Timestamp |
| `timeoutMs` | 10 minutes (decode/playback timeout) |
| `timeoutTimer`, `pollTimer` | Timers |
| `workDir`, `outputFile` | Temp dir + `safe.mp4` |
| `ffmpegBin` | Resolved ffmpeg path |
| `ffmpegStderr` | Captured stderr (capped 20k) |
| `progress` | Human-readable progress string |
| `cacheDir` | `%APPDATA%/SafeView/cache` (or LOCALAPPDATA / tmpdir) |

### 7.2 `status()`

Returns `{ state, filePath, streamUrl, error, mode, isolated: false, progress }`.

### 7.3 `start(filePath)` flow

1. `teardown()` any previous run.
2. Reset `error`, set `filePath`, `streamUrl = null`.
3. Validate: file exists; regex `/\.mp4$/i`; non-empty size. On failure `_fail(...)`.
4. Set `state = 'booting'`, `startedAt`, `progress = 'Preparing sandbox...'`.
5. Ensure ffmpeg binary:
   - `_findFfmpeg()` (PATH via `where`/`command -v`, then fixed locations `C:\ffmpeg\bin\ffmpeg.exe`, `/usr/bin/ffmpeg`, `/usr/local/bin/ffmpeg`).
   - If missing: `progress = 'Downloading ffmpeg...'`; `_ensureFfmpeg()`.
   - If still missing: `_fail('Could not obtain ffmpeg...')`.
6. Create isolated work dir: `fs.mkdtempSync(os.tmpdir()/safeview-)`; `outputFile = workDir/safe.mp4`.
7. `_restrictDir(workDir)`:
   - Windows: `icacls "<dir>" /inheritance:r /grant:r "<USER>:(OI)(CI)F" /grant:r "SYSTEM:(OI)(CI)F"`.
   - Else: `chmod 700`.
8. `_blockNetwork()`: Windows only, best-effort adds an outbound firewall rule blocking the ffmpeg binary (`netsh advfirewall`). Requires admin.
9. `progress = 'Transcoding in sandbox...'`.
10. Allocate free port (`_freePort` via ephemeral TCP listener).
11. Create HTTP server `_serveOutput`; listen on `127.0.0.1:port`; set `streamUrl`.
12. Spawn ffmpeg:
    - args: `-y -i <filePath> -map 0:v:0 -map 0:a? -c:v libx264 -preset ultrafast -crf 23 -pix_fmt yuv420p -c:a aac -f mp4 -movflags frag_keyframe+empty_moov+default_base_moof -flush_packets 1 -` (stdout; tee'd to `safe.mp4` cache)
    - cwd = workDir
    - env = `{ PATH, TEMP: workDir, TMP: workDir }`
    - stdio ignore/pipe/pipe, `windowsHide: true`
13. Parse stderr for `time=HH:MM:SS.xx` and `size= NkB` to update `progress`.
14. On non-zero exit (while not idle/ready): set state error with tail of stderr.
15. `_waitForOutput()` (polls every 500ms):
    - Rejects if state error or ffmpeg exited non-zero.
    - When buffered stdout reaches 1MB (or ffmpeg finishes with data) → resolve; encoding continues in background.
    - Updates progress with MB and elapsed seconds.
    - Stagnation guard: if elapsed > 60s and size unchanged for 120s → kill & reject "Transcode stalled."
    - Deadline: 30 minutes → kill & reject "Timed out transcoding."
16. On success: `state = 'ready'`; `_armTimeout()` (10-min timer → teardown); return status.

### 7.4 `_ensureFfmpeg()`

- **Windows**: try package managers in order if available:
  - `winget install --id Gyan.FFmpeg -e --silent --accept-package-agreements --accept-source-agreements`
  - `choco install ffmpeg -y`
  - `scoop install ffmpeg`
  - After each, re-run `_findFfmpeg()`. Returns first found or null.
- **Linux/mac**: download static build:
  - cacheDir created.
  - If `cacheDir/ffmpeg` exists → return it.
  - Download `https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz` (with redirect following) to `ffmpeg.tar.xz`.
  - Extract with `tar --force-local -xf ... -C extractDir`.
  - Find `ffmpeg` file recursively; copy to `binPath`; chmod 755.
  - Cleanup extract dir & tar. Returns binPath or null.

### 7.5 `_serveOutput(req, res)`

HTTP handler for the local proxy:

- If output file missing → 404 "not ready".
- Read file size.
- If `Range` header present: parse `bytes=start-end`, respond 206 with Content-Range, Content-Length, Content-Type `video/mp4`, stream range.
- Else: 200 with Content-Length, Accept-Ranges, stream whole file.

### 7.6 `teardown()`

- Clear `timeoutTimer`, `pollTimer`.
- Kill ffmpeg (SIGKILL).
- Close HTTP server.
- Delete workDir recursively.
- Reset all fields to idle/null.

### 7.7 `_armTimeout()`

Sets a 10-minute timer that calls `teardown()` (no state transition to error). Used as playback/decode timeout.

### 7.8 `_freePort()`

Creates a TCP server on port 0 (ephemeral), reads assigned port, closes, resolves port.

### 7.9 Notable implementation details / quirks

- `isolated` is always `false` in status.
- `mode` always `'native'` on success (never `'dev'`), so renderer badge shows "Sandboxed".
- The renderer references `status.mode === 'dev'` and `status.isolated` for badge color/text, but these never trigger in current code.
- No QEMU, vsock, or 9p is used despite docs.
- `_blockNetwork` only runs on Windows and requires admin; otherwise silently fails.
- The ffmpeg env is minimal (`PATH`, `TEMP`, `TMP`), which is a form of sandboxing but not isolation.
- Output is a fully re-encoded MP4 (decode + encode), so the host's video element decodes the *sanitized* output, not the original. This matches the stated security goal at the decode level, but without VM isolation the ffmpeg decoder itself runs on the host.

---

## 8. IPC API (Preload Bridge)

`src/preload/index.js` exposes `window.safeview` via `contextBridge`:

| Method | IPC channel | Description |
|---|---|---|
| `pickFile()` | `pick-file` | Open native file dialog; returns path or null |
| `startVm(filePath)` | `vm:start` | Start transcoding; returns status object |
| `stopVm()` | `vm:stop` | Teardown; returns `{ ok: true }` |
| `status()` | `vm:status` | Returns status object |
| `onOpenFile(cb)` | listens `open-file` | Registers callback for OS open-with / CLI file |

Context isolation + sandbox means renderer has no direct Node access.

---

## 9. Renderer (`src/renderer/`)

### 9.1 `index.html`

Structure:
- `#app` (flex column, full height)
  - `#modeBadge` (top-right badge: "…")
  - `#stage` (flex:1, black)
    - `#video` (playsinline)
    - `#overlay` (hidden by default) with `#dropHint`
    - `#loading` (hidden) spinner + `#loadingText`
    - `#error` (hidden) `#errorText` + `#errorRetry` button
  - `#controls`
    - `#playBtn` (▶/⏸)
    - `#seekWrap` → `#seek` range (0–1000) + `#time`
    - `#replayBtn` (↺)
    - `#speed` select (0.5, 1, 1.25, 1.5, 2)
    - `#muteBtn` + `#volume` range (0–1)
    - `#fsBtn` (⛶)

Loads `styles.css` and `player.js`.

### 9.2 `player.js` — behavior

State: `isSeeking`, `currentFile`.

Helpers:
- `fmt(s)` → `MM:SS` (or 00:00 if not finite).
- `showLoading(text)`, `hideLoading()`, `showError(msg)`.
- `updatePlayBtn()` sets ▶/⏸.
- `updateTime()` updates time label and seek slider (skipped while seeking).

Event wiring:
- `timeupdate`, `loadedmetadata` → updateTime; `play`/`pause` → updatePlayBtn; `ended` → updatePlayBtn.
- Play button & video click → togglePlay.
- Seek slider `input` (live preview of time) sets `isSeeking=true`; `change` commits `currentTime` and clears flag.
- Replay → currentTime=0 + play.
- Speed change → playbackRate.
- Mute button toggles muted + icon.
- Volume slider → volume; unmutes if >0.
- Fullscreen button toggles fullscreen.
- Keyboard shortcuts (ignored when focus in INPUT/SELECT):
  - Space → toggle play
  - ArrowLeft → -5s
  - ArrowRight → +5s
  - KeyF → fullscreen
  - KeyM → mute
- Drag & drop: dragover shows overlay hint; drop reads `file.path` and calls `openFile`.
- Overlay click → pickFile → openFile.
- Error retry button → pickFile → openFile.

`openFile(filePath)`:
1. Set currentFile, showLoading("Booting sandbox…").
2. Clear video src + load.
3. Poll `status()` every 500ms to update loading text with progress.
4. `startVm(filePath)`; clear poll.
5. Derive status (from result or re-fetch).
6. If not ready or no streamUrl → showError.
7. Set modeBadge text/color based on mode/isolated.
8. Update loading text ("Loading (dev mode)…" if dev else "Loading video…").
9. Set `video.src = streamUrl`; load; wait for `canplay` (or `error` → "Failed to decode video").
10. hideLoading; play (catch ignore).

Also registers `onOpenFile` → openFile.

### 9.3 `styles.css`

Dark theme (#0a0a0a background), flex layout, spinner animation, hidden utility, mode badge, controls bar. Full-screen video with object-fit contain. Standard form styling.

---

## 10. Guest Image (`guest/`)

### 10.1 `build-image.sh`

Requirements: Docker, `virt-make-fs` (libguestfs).

Steps:
1. Create `guest/image/`, output `safeview.img`.
2. Docker run `alpine:3.20`: `apk add ffmpeg tini coreutils`; create dirs `/mnt/input`, `/mnt/output`, `/opt/safeview`; copy `/bin /sbin /lib /usr /etc` to rootfs; `adduser -D -s /bin/sh player`.
3. Copy `runner.sh` → rootfs `/opt/safeview/runner.sh`, chmod +x.
4. Write `/sbin/init` that mounts proc/sys/devtmpfs, runs runner, then `poweroff -f`.
5. Pack rootfs into ext4 image with `virt-make-fs --type=ext4 --size=+512M`.

### 10.2 `runner.sh` (runs inside guest as `player`)

- Mount 9p shares: `input` → `/mnt/input` (ro), `output` → `/mnt/output`.
- `ulimit -t 300` (CPU 5 min), `ulimit -v 524288` (512MB virtual mem).
- Find first `*.mp4` in `/mnt/input`.
- Run ffmpeg as `player`: decode + encode → `/mnt/output/safe.mp4` (libx264 fast, CRF 23, aac, faststart).
- `touch /mnt/output/ready`; sync; sleep 2; exit.

> This guest path is the intended isolated pipeline but is **not wired into the Electron app**; the app uses local ffmpeg instead.

---

## 11. Packaging & Build

`package.json` `build`:
- `appId`: `com.fractal.safeview`
- `productName`: `SafeView`
- `artifactName`: `FractalSafeView-${version}-${os}-${arch}.${ext}`
- `directories.output`: `dist`
- `files`: `src/**/*`, `guest/**/*`, `assets/**/*`
- Windows: nsis, icon `assets/icon.ico`
- macOS: dmg, icon `assets/icon.icns`
- Linux: AppImage, icon `assets/icon.png`, category AudioVideo
- nsis: shortcutName SafeView, desktop+startmenu shortcuts, not oneClick
- fileAssociations: `.mp4` → "MP4 Video (SafeView)", role Viewer

Scripts:
- `npm start` → `electron .`
- `npm run dev` → `electron . --dev`
- `npm run build:guest` → `bash guest/build-image.sh`
- `npm run pack` → `electron-builder --dir`
- `npm run dist` → `electron-builder`

---

## 12. Security Model (Summary)

Per `docs/SECURITY.md`:
- Protects against decoder exploits by confining them to guest VM; host receives decoded frames over narrow vsock channel.
- No guest network → no callback/exfil.
- Read-only, scoped file share.
- Resource limits + decode timeout.
- Caveats: hypervisor vulns, container weaker than VM, guest ffmpeg must stay updated, side channels, host proxy/renderer must treat guest output as untrusted, dev mode not isolated.
- Teardown: QEMU killed, stream server closed, no guest state persists.

**Reality check against implementation:** The running app performs a local ffmpeg transcode on the host. It does not use QEMU/vsock/9p. The `isolated` flag is always false. Therefore the current implementation does **not** deliver the VM-level isolation promised by the docs; it only sanitizes the file via re-encoding and runs ffmpeg with a minimal environment and (best-effort, Windows-only, admin-required) network block. This gap is the single most important thing to be aware of.

---

## 13. Configuration & Environment

- `FRACTAL_DEV=1` / `FRACTAL_ALLOW_DEV=1`: referenced by docs/bats; the renderer's mode badge has a dev branch, but the VM manager never sets `mode = 'dev'` in current code, so these flags have no effect on the badge.
- `APPDATA` / `LOCALAPPDATA` / `tmpdir`: used for cache dir and work dirs.
- No `.env` files; no external services.

---

## 14. Data Flow (End-to-End, as implemented)

1. User opens `.mp4` (file dialog, drag-drop, CLI arg, or OS open-with).
2. Renderer calls `window.safeview.startVm(filePath)` → IPC `vm:start`.
3. Main: `VmManager.start()` validates, ensures ffmpeg, creates work dir, starts HTTP proxy on 127.0.0.1, spawns ffmpeg to produce `safe.mp4`.
4. Renderer polls `status()` every 500ms to show progress.
5. On ready, renderer sets `<video src>` to `http://127.0.0.1:<port>/safe.mp4` (range-request capable).
6. Video element decodes the sanitized MP4.
7. On window close: `teardown()` kills ffmpeg, closes server, deletes work dir. 10-min timeout also triggers teardown.

---

## 15. Known Limitations / Issues

- **No actual VM isolation** (see §4.2, §12).
- `isolated` always false; `mode` always 'native' on success → badge always "Sandboxed" (green), potentially misleading.
- Dev-mode flags have no effect.
- `_blockNetwork` is Windows-only and requires admin; silently no-ops otherwise.
- `tray` variable in main is unused.
- Guest image pipeline not integrated.
- `_armTimeout` teardown does not update `state` to error/idle-with-error; it just tears down, leaving renderer to discover missing stream.
- `ffmpegProc.on('exit')` sets error state but `_waitForOutput` may already have resolved; race possible on late failures.
- No tests in repository (`detected_test_files: 0`).
- ffmpeg download (Linux/mac) pulls from a third-party static build URL; Windows relies on package managers.

---

## 16. How to Run / Develop

```bash
npm install
npm start            # or: run.bat (Windows)
npm run dev          # sets dev flag (no behavioral change currently)
```

Build guest image (optional, requires Docker + libguestfs):
```bash
npm run build:guest
```

Package:
```bash
npm run pack         # unpacked dir
npm run dist         # installers -> dist/
```

If ffmpeg is not installed, the app attempts to obtain it (package managers on Windows; static download on Linux/mac). Dev mode (no isolation) is documented but the fallback is not actually gated by `FRACTAL_DEV` in current code.

---

## 17. File-by-File Reference

| File | Role |
|---|---|
| `package.json` | Manifest, scripts, electron-builder config |
| `src/main/index.js` | Main process: window, menu, IPC, open-with |
| `src/main/cli.js` | CLI `.mp4` arg extraction |
| `src/main/vm-manager.js` | Transcode lifecycle, HTTP proxy, ffmpeg acquisition |
| `src/preload/index.js` | Context-isolated bridge `window.safeview` |
| `src/renderer/index.html` | Player markup |
| `src/renderer/player.js` | Controls, drag/drop, openFile orchestration |
| `src/renderer/styles.css` | Dark theme styling |
| `guest/build-image.sh` | Alpine rootfs → ext4 image |
| `guest/runner.sh` | In-guest ffmpeg re-encode |
| `docs/ARCHITECTURE.md` | Intended architecture |
| `docs/SECURITY.md` | Security model & caveats |
| `run.bat` / `run-dev.bat` | Windows launchers |
| `assets/*` | Icons |

---

*Generated from full repository analysis. Describes implementation as of version 0.1.0.*