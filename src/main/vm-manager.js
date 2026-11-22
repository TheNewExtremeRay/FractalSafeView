'use strict';

const { spawn, exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const os = require('os');
const https = require('https');

const execP = (cmd, opts = {}) => new Promise((resolve, reject) => {
  exec(cmd, opts, (err, stdout, stderr) => {
    if (err) reject(Object.assign(err, { stdout, stderr }));
    else resolve({ stdout, stderr });
  });
});

const READY_THRESHOLD = 1 * 1024 * 1024; // 1 MB buffered before starting playback

class VmManager {
  constructor() {
    this.state = 'idle';
    this.filePath = null;
    this.mode = 'native';
    this.ffmpegProc = null;
    this.streamServer = null;
    this.streamPort = null;
    this.streamUrl = null;
    this.error = null;
    this.startedAt = null;
    this.timeoutMs = 10 * 60 * 1000;
    this.timeoutTimer = null;
    this.workDir = null;
    this.outputFile = null;
    this.ffmpegBin = null;
    this.ffmpegStderr = '';
    this.progress = null;
    this.cacheDir = path.join(process.env.APPDATA || process.env.LOCALAPPDATA || os.tmpdir(), 'SafeView', 'cache');
    this.ffmpegDone = false;
    this.pollTimer = null;
    this.ffmpegStdout = null;
    this.fileStream = null;
    this.stdoutBuffer = [];
    this.stdoutClients = [];
    this.bufferedBytes = 0;
    this.duration = null;
    this.codecs = null;
  }

  status() {
    return {
      state: this.state,
      filePath: this.filePath,
      streamUrl: this.streamUrl,
      error: this.error,
      mode: this.mode,
      isolated: false,
      progress: this.progress,
      done: this.ffmpegDone,
      duration: this.duration,
      codecs: this.codecs,
    };
  }

  async start(filePath) {
    await this.teardown();
    this.error = null;
    this.filePath = filePath;
    this.streamUrl = null;
    this.ffmpegDone = false;
    this.stdoutBuffer = [];
    this.stdoutClients = [];
    this.bufferedBytes = 0;

    if (!filePath || !fs.existsSync(filePath)) return this._fail('File not found');
    if (!/\.mp4$/i.test(filePath)) return this._fail('Only .mp4 files are supported');
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return this._fail('Empty file');

    this.state = 'booting';
    this.startedAt = Date.now();
    this.progress = 'Preparing sandbox...';
    this.duration = this._probeDuration(filePath);
    this.codecs = this._probeCodecs(filePath);

    if (!this.ffmpegBin) this.ffmpegBin = this._findFfmpeg();
    if (!this.ffmpegBin) {
      this.progress = 'Downloading ffmpeg (one-time setup)...';
      this.ffmpegBin = await this._ensureFfmpeg();
    }
    if (!this.ffmpegBin) {
      return this._fail('Could not obtain ffmpeg. Please install ffmpeg and retry.');
    }

    this.workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safeview-'));
    this.outputFile = path.join(this.workDir, 'safe.mp4');

    this._restrictDir(this.workDir);
    this._blockNetwork();

    this.progress = 'Transcoding in sandbox...';

    this.streamPort = await this._freePort();
    this.streamServer = http.createServer((req, res) => this._serveOutput(req, res));
    await new Promise((resolve) => this.streamServer.listen(this.streamPort, '127.0.0.1', resolve));
    this.streamUrl = `http://127.0.0.1:${this.streamPort}/safe.mp4`;

    this.fileStream = fs.createWriteStream(this.outputFile);

    // Stream fragmented MP4 to stdout so playback can start before encoding finishes.
    const args = [
      '-y',
      '-i', filePath,
      '-map', '0:v:0',
      '-map', '0:a?',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-flush_packets', '1',
      '-',
    ];

    this.ffmpegStderr = '';
    this.ffmpegProc = spawn(this.ffmpegBin, args, {
      cwd: this.workDir,
      env: { PATH: process.env.PATH || '', TEMP: this.workDir, TMP: this.workDir },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.ffmpegStdout = this.ffmpegProc.stdout;
    this.ffmpegStdout.on('data', (chunk) => {
      if (this.fileStream) this.fileStream.write(chunk);
      if (this.stdoutClients.length === 0) {
        this.stdoutBuffer.push(chunk);
        this.bufferedBytes += chunk.length;
      } else {
        for (const res of [...this.stdoutClients]) {
          try { res.write(chunk); } catch (e) {}
        }
      }
    });
    this.ffmpegStdout.on('end', () => {
      if (this.fileStream) { this.fileStream.end(); this.fileStream = null; }
      this.ffmpegDone = true;
      for (const res of [...this.stdoutClients]) { try { res.end(); } catch (e) {} }
      this.stdoutClients = [];
      this.stdoutBuffer = [];
    });

    this.ffmpegProc.stderr.on('data', (d) => {
      const s = d.toString();
      this.ffmpegStderr += s;
      if (this.ffmpegStderr.length > 20000) this.ffmpegStderr = this.ffmpegStderr.slice(-20000);
      const m = s.match(/time=(\d+):(\d+):(\d+)\.(\d+)/);
      if (m) {
        const sec = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]);
        const sizeMatch = s.match(/size=\s*(\d+)kB/);
        const mb = sizeMatch ? (parseInt(sizeMatch[1]) / 1024).toFixed(1) : '?';
        this.progress = `Transcoding... ${mb} MB (${sec}s)`;
      }
    });

    this.ffmpegProc.on('exit', (code) => {
      this.ffmpegDone = true;
      if (code !== 0 && this.state !== 'idle' && this.state !== 'ready') {
        const tail = this.ffmpegStderr.slice(-2000).trim();
        this.state = 'error';
        this.error = `ffmpeg exited (code ${code})\n${tail}`;
      }
    });

    await this._waitForOutput();

    this.state = 'ready';
    this._armTimeout();
    return this.status();
  }

  _fail(msg) {
    this.state = 'error';
    this.mode = 'error';
    this.error = msg;
    return this.status();
  }

  _findFfmpeg() {
    const names = process.platform === 'win32' ? ['ffmpeg.exe', 'ffmpeg'] : ['ffmpeg'];
    for (const c of names) {
      try {
        const out = execSync(process.platform === 'win32' ? `where ${c}` : `command -v ${c}`, { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
        if (out && fs.existsSync(out)) return out;
      } catch (e) {}
    }
    const paths = process.platform === 'win32'
      ? ['C:\\\\ffmpeg\\\\bin\\\\ffmpeg.exe']
      : ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
    for (const p of paths) if (fs.existsSync(p)) return p;
    return null;
  }

  async _ensureFfmpeg() {
    if (process.platform === 'win32') {
      const attempts = [];
      if (this._hasCmd('winget')) attempts.push(['winget', ['install', '--id', 'Gyan.FFmpeg', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements']]);
      if (this._hasCmd('choco')) attempts.push(['choco', ['install', 'ffmpeg', '-y']]);
      if (this._hasCmd('scoop')) attempts.push(['scoop', ['install', 'ffmpeg']]);
      for (const [cmd, args] of attempts) {
        try { await execP(`${cmd} ${args.join(' ')}`, { timeout: 10 * 60 * 1000 }); } catch (e) {}
        const b = this._findFfmpeg();
        if (b) return b;
      }
      return null;
    }
    fs.mkdirSync(this.cacheDir, { recursive: true });
    const binPath = path.join(this.cacheDir, 'ffmpeg');
    if (fs.existsSync(binPath)) return binPath;
    const url = 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz';
    const tarPath = path.join(this.cacheDir, 'ffmpeg.tar.xz');
    await this._downloadFile(url, tarPath);
    const extractDir = path.join(this.cacheDir, 'ffmpeg-extract');
    fs.mkdirSync(extractDir, { recursive: true });
    const t = tarPath.replace(/\\/g, '/');
    const e = extractDir.replace(/\\/g, '/');
    await execP(`tar --force-local -xf "${t}" -C "${e}"`);
    const found = this._findFile(extractDir, 'ffmpeg');
    if (!found) { try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch (e) {} return null; }
    fs.copyFileSync(found, binPath);
    try { fs.chmodSync(binPath, 0o755); } catch (e) {}
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch (e) {}
    try { fs.unlinkSync(tarPath); } catch (e) {}
    return binPath;
  }

  _findFile(dir, name) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { const r = this._findFile(p, name); if (r) return r; }
      else if (e.name === name || e.name === name + '.exe') return p;
    }
    return null;
  }

  async _downloadFile(url, dest) {
    if (fs.existsSync(dest)) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    return new Promise((resolve, reject) => {
      const get = (u) => {
        https.get(u, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { get(res.headers.location); return; }
          if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
          const file = fs.createWriteStream(dest);
          res.pipe(file);
          file.on('finish', () => file.close(() => resolve()));
          file.on('error', reject);
        }).on('error', reject);
      };
      get(url);
    });
  }

  _hasCmd(cmd) {
    try { execSync(process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`, { stdio: 'ignore' }); return true; } catch (e) { return false; }
  }

  _restrictDir(dir) {
    try {
      if (process.platform === 'win32') {
        const user = process.env.USERNAME || 'Users';
        execSync(`icacls "${dir}" /inheritance:r /grant:r "${user}:(OI)(CI)F" /grant:r "SYSTEM:(OI)(CI)F"`, { stdio: 'ignore' });
      } else {
        fs.chmodSync(dir, 0o700);
      }
    } catch (e) { /* best effort */ }
  }

  _blockNetwork() {
    try {
      if (process.platform === 'win32' && this.ffmpegBin) {
        const name = path.basename(this.ffmpegBin);
        execSync(`netsh advfirewall firewall add rule name="SafeView-block-${name}" dir=out program="${this.ffmpegBin}" action=block`, { stdio: 'ignore' });
      }
    } catch (e) { /* requires admin, best effort */ }
  }

  _serveOutput(req, res) {
    // After encoding completes, serve the cached file with full range support.
    if (this.ffmpegDone && this.outputFile && fs.existsSync(this.outputFile)) {
      let size = 0;
      try { size = fs.statSync(this.outputFile).size; } catch (e) { size = 0; }
      if (size > 0) {
        const range = req.headers.range;
        if (range) {
          const m = /bytes=(\d+)-(\d*)/.exec(range);
          if (m) {
            const start = parseInt(m[1], 10);
            if (start < size) {
              const end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : (size - 1);
              res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${size}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': end - start + 1,
                'Content-Type': 'video/mp4',
              });
              fs.createReadStream(this.outputFile, { start, end }).pipe(res);
              return;
            }
          }
        }
        res.writeHead(200, { 'Content-Length': size, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' });
        fs.createReadStream(this.outputFile).pipe(res);
        return;
      }
    }

    // Streaming mode: keep connection open until encoding finishes.
    if (!this.ffmpegProc || this.ffmpegDone) {
      res.statusCode = 404; res.end('not ready'); return;
    }
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
    });
    // Register client first, then flush any buffered prefix.
    this.stdoutClients.push(res);
    for (const c of this.stdoutBuffer) { try { res.write(c); } catch (e) {} }
    this.stdoutBuffer = [];
    res.on('close', () => {
      const i = this.stdoutClients.indexOf(res);
      if (i >= 0) this.stdoutClients.splice(i, 1);
    });
  }

  _waitForOutput() {
    this.progress = 'Transcoding...';
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 30 * 60 * 1000;
      let lastBytes = -1;
      let lastGrowth = Date.now();
      const check = () => {
        if (this.state === 'error') { reject(new Error(this.error || 'Transcode failed')); return; }
        if (this.ffmpegDone && this.bufferedBytes === 0 && this.ffmpegProc && this.ffmpegProc.exitCode !== null && this.ffmpegProc.exitCode !== 0) {
          reject(new Error('Transcode failed: ' + this.ffmpegStderr.slice(-1000)));
          return;
        }
        // Ready once enough data buffered, or ffmpeg finished with data.
        if (this.bufferedBytes >= READY_THRESHOLD || (this.ffmpegDone && this.bufferedBytes > 0)) {
          this.progress = 'Loading video…';
          resolve();
          return;
        }
        // Fallback: some data and a short wait.
        const elapsed = Date.now() - started;
        if (this.bufferedBytes >= 256 * 1024 && elapsed > 15000) {
          this.progress = 'Loading video…';
          resolve();
          return;
        }
        const mb = (this.bufferedBytes / 1024 / 1024).toFixed(1);
        const elapsedSec = Math.round(elapsed / 1000);
        this.progress = `Transcoding... ${mb} MB (${elapsedSec}s)`;

        if (this.bufferedBytes === lastBytes) {
          if (elapsedSec > 60 && (Date.now() - lastGrowth) > 120000) {
            try { this.ffmpegProc.kill('SIGKILL'); } catch (e) {}
            reject(new Error('Transcode stalled.\n' + this.ffmpegStderr.slice(-1000)));
            return;
          }
        } else {
          lastBytes = this.bufferedBytes;
          lastGrowth = Date.now();
        }
        if (this.ffmpegProc && this.ffmpegProc.exitCode !== null && this.ffmpegProc.exitCode !== 0 && !this.ffmpegDone) {
          reject(new Error('Transcode failed: ' + this.ffmpegStderr.slice(-1000)));
          return;
        }
        if (Date.now() > deadline) {
          try { this.ffmpegProc.kill('SIGKILL'); } catch (e) {}
          reject(new Error('Timed out transcoding.\n' + this.ffmpegStderr.slice(-1000)));
          return;
        }
        this.pollTimer = setTimeout(check, 500);
      };
      check();
    });
  }

  _armTimeout() {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = setTimeout(() => { this.teardown(); }, this.timeoutMs);
  }

  async teardown() {
    if (this.timeoutTimer) { clearTimeout(this.timeoutTimer); this.timeoutTimer = null; }
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    this.ffmpegDone = true;
    for (const res of [...this.stdoutClients]) { try { res.end(); } catch (e) {} }
    this.stdoutClients = [];
    this.stdoutBuffer = [];
    if (this.ffmpegProc) { try { this.ffmpegProc.kill('SIGKILL'); } catch (e) {} this.ffmpegProc = null; }
    if (this.fileStream) { try { this.fileStream.end(); } catch (e) {} this.fileStream = null; }
    if (this.streamServer) { try { this.streamServer.close(); } catch (e) {} this.streamServer = null; }
    if (this.workDir) { try { fs.rmSync(this.workDir, { recursive: true, force: true }); } catch (e) {} this.workDir = null; }
    this.outputFile = null;
    this.streamUrl = null;
    this.state = 'idle';
    this.filePath = null;
    this.mode = 'native';
    this.progress = null;
    this.ffmpegStderr = '';
  }

  _probeDuration(filePath) {
    try {
      const bin = this.ffmpegBin ? path.basename(this.ffmpegBin).replace(/\.exe$/i, '') : 'ffprobe';
      // find ffprobe next to ffmpeg
      let probe = this.ffmpegBin ? this.ffmpegBin.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1') : null;
      if (!probe || !fs.existsSync(probe)) {
        // try PATH
        probe = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
      }
      const out = execSync(`"${probe}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`, { encoding: 'utf8', timeout: 30000 });
      const v = parseFloat(out.trim());
      return isFinite(v) ? v : null;
    } catch (e) {
      return null;
    }
  }

  _probeCodecs(filePath) {
    try {
      let probe = this.ffmpegBin ? this.ffmpegBin.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1') : null;
      if (!probe || !fs.existsSync(probe)) probe = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
      const out = execSync(`"${probe}" -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,codec_name -of json "${filePath}"`, { encoding: 'utf8', timeout: 30000 });
      const info = JSON.parse(out);
      const s = info.streams && info.streams[0];
      if (!s) return null;
      const w = s.width || 1280, h = s.height || 720;
      let fps = 30;
      if (s.r_frame_rate) {
        const parts = s.r_frame_rate.split('/');
        if (parts.length === 2 && parseFloat(parts[1]) > 0) fps = parseFloat(parts[0]) / parseFloat(parts[1]);
        else fps = parseFloat(s.r_frame_rate) || 30;
      }
      const maxdim = Math.max(w, h);
      let levelHex = '28'; // 4.0
      if (maxdim <= 720 && fps <= 30) levelHex = '1F'; // 3.1
      else if (maxdim <= 1080 && fps <= 30) levelHex = '28'; // 4.0
      else if (maxdim <= 1080 && fps <= 60) levelHex = '2A'; // 4.2
      else if (maxdim <= 2160 && fps <= 30) levelHex = '33'; // 5.1
      else if (maxdim <= 2160) levelHex = '34'; // 5.2
      else levelHex = '3C'; // 6.0
      return `avc1.6400${levelHex},mp4a.40.2`;
    } catch (e) {
      return null;
    }
  }

  _freePort() {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => { const port = srv.address().port; srv.close(() => resolve(port)); });
      srv.on('error', reject);
    });
  }
}

module.exports = { VmManager };
