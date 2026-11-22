'use strict';

const video = document.getElementById('video');
const controls = document.getElementById('controls');
const playBtn = document.getElementById('playBtn');
const seek = document.getElementById('seek');
const time = document.getElementById('time');
const replayBtn = document.getElementById('replayBtn');
const speed = document.getElementById('speed');
const muteBtn = document.getElementById('muteBtn');
const volume = document.getElementById('volume');
const fsBtn = document.getElementById('fsBtn');
const loading = document.getElementById('loading');
const loadingText = document.getElementById('loadingText');
const errorBox = document.getElementById('error');
const errorText = document.getElementById('errorText');
const errorRetry = document.getElementById('errorRetry');
const overlay = document.getElementById('overlay');
const modeBadge = document.getElementById('modeBadge');
const dropHint = document.getElementById('dropHint');
const osd = document.getElementById('osd');

let isSeeking = false;
let currentFile = null;
let spaceHeld = false;
let spaceTimer = null;
let spaceBoosted = false;
let savedRate = 1;
let showRemaining = false;
let idleTimer = null;
let osdTimer = null;
let resumeKey = null;

function fmt(s) {
  if (!isFinite(s)) return '00:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}

function showLoading(text) {
  loadingText.textContent = text || 'Booting sandbox…';
  loading.classList.remove('hidden');
  errorBox.classList.add('hidden');
}

function hideLoading() { loading.classList.add('hidden'); }

function showError(msg) {
  hideLoading();
  errorText.textContent = msg;
  errorBox.classList.remove('hidden');
}

function updatePlayBtn() {
  playBtn.textContent = video.paused ? '▶' : '⏸';
}

function updateTime() {
  if (isSeeking) return;
  const dur = video.duration || 0;
  const cur = video.currentTime || 0;
  if (!isFinite(dur) || dur <= 0) {
    time.textContent = `${fmt(cur)} / --:--`;
    return;
  }
  const left = dur - cur;
  time.textContent = showRemaining
    ? `${fmt(cur)} / -${fmt(left)}`
    : `${fmt(cur)} / ${fmt(dur)}`;
  if (dur > 0) seek.value = String(Math.round((cur / dur) * 1000));
}

video.addEventListener('timeupdate', updateTime);
video.addEventListener('loadedmetadata', updateTime);
video.addEventListener('play', updatePlayBtn);
video.addEventListener('pause', updatePlayBtn);
video.addEventListener('ended', () => { updatePlayBtn(); saveResume(); });

playBtn.addEventListener('click', () => togglePlay());
video.addEventListener('click', () => togglePlay());

function togglePlay() {
  if (video.paused) video.play().catch(() => {});
  else video.pause();
}

// seek bar
seek.addEventListener('input', () => {
  isSeeking = true;
  const dur = video.duration || 0;
  if (dur > 0) {
    const t = (parseInt(seek.value, 10) / 1000) * dur;
    time.textContent = `${fmt(t)} / ${fmt(dur)}`;
  }
});
seek.addEventListener('change', () => {
  const dur = video.duration || 0;
  if (dur > 0) video.currentTime = (parseInt(seek.value, 10) / 1000) * dur;
  isSeeking = false;
  saveResume();
});

replayBtn.addEventListener('click', () => {
  video.currentTime = 0;
  video.play().catch(() => {});
});

speed.addEventListener('change', () => { video.playbackRate = parseFloat(speed.value); });

muteBtn.addEventListener('click', () => {
  video.muted = !video.muted;
  muteBtn.textContent = video.muted ? '🔇' : '🔊';
  showOsd(video.muted ? 'Muted' : 'Unmuted');
});

volume.addEventListener('input', () => {
  video.volume = parseFloat(volume.value);
  if (video.volume > 0) { video.muted = false; muteBtn.textContent = '🔊'; }
});

fsBtn.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
});

// time toggle
time.addEventListener('click', () => { showRemaining = !showRemaining; updateTime(); });

// OSD helper
function showOsd(text) {
  if (!osd) return;
  osd.textContent = text;
  osd.classList.remove('hidden');
  if (osdTimer) clearTimeout(osdTimer);
  osdTimer = setTimeout(() => osd.classList.add('hidden'), 1200);
}

function seekBy(delta) {
  if (seek.disabled || !isFinite(video.duration) || video.duration <= 0) { showOsd('Seeking available after encoding'); return; }
  const dur = video.duration || 0;
  const next = Math.min(dur > 0 ? dur : Infinity, Math.max(0, video.currentTime + delta));
  video.currentTime = next;
  const sign = delta >= 0 ? '+' : '';
  showOsd(`Seek ${sign}${delta}s`);
  saveResume();
}

function adjustVolume(delta) {
  let v = video.muted ? 0 : video.volume;
  v = Math.min(1, Math.max(0, v + delta));
  video.volume = v;
  video.muted = v === 0;
  muteBtn.textContent = video.muted ? '🔇' : '🔊';
  volume.value = String(v);
  showOsd(`Volume: ${Math.round(v * 100)}%`);
}

function adjustSpeed(delta) {
  let r = video.playbackRate + delta;
  r = Math.min(4, Math.max(0.25, Math.round(r * 100) / 100));
  video.playbackRate = r;
  speed.value = String(r);
  showOsd(`Speed: ${r}x`);
}

function resetSpeed() {
  video.playbackRate = 1;
  speed.value = '1';
  showOsd('Speed: 1x');
}

function stepFrame(dir) {
  // approximate one frame at 30fps
  video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + dir * (1 / 30)));
  showOsd(`Frame ${dir > 0 ? '+' : '-'}1`);
}

function takeScreenshot() {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || video.clientWidth;
    canvas.height = video.videoHeight || video.clientHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `screenshot-${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showOsd('Screenshot saved');
    }, 'image/png');
  } catch (e) { showOsd('Screenshot failed'); }
}

function togglePip() {
  if (document.pictureInPictureElement) {
    document.exitPictureInPicture().catch(() => {});
  } else if (document.pictureInPictureEnabled) {
    video.requestPictureInPicture().catch(() => {});
  }
}

// keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (spaceHeld) return; // ignore key repeat
    spaceHeld = true;
    spaceBoosted = false;
    savedRate = video.playbackRate;
    if (spaceTimer) clearTimeout(spaceTimer);
    spaceTimer = setTimeout(() => {
      if (!spaceHeld) return;
      spaceBoosted = true;
      video.playbackRate = 2;
      speed.value = '2';
      showOsd('Speed: 2x (hold)');
    }, 200);
    return;
  }
  switch (e.code) {
    case 'KeyK':
      e.preventDefault();
      togglePlay();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      seekBy(e.shiftKey ? -30 : -5);
      break;
    case 'ArrowRight':
      e.preventDefault();
      seekBy(e.shiftKey ? 30 : 5);
      break;
    case 'KeyJ':
      e.preventDefault();
      seekBy(-10);
      break;
    case 'KeyL':
      e.preventDefault();
      seekBy(10);
      break;
    case 'ArrowUp':
      e.preventDefault();
      adjustVolume(0.05);
      break;
    case 'ArrowDown':
      e.preventDefault();
      adjustVolume(-0.05);
      break;
    case 'KeyF':
      e.preventDefault();
      fsBtn.click();
      break;
    case 'Escape':
      if (document.fullscreenElement) { document.exitFullscreen(); e.preventDefault(); }
      break;
    case 'KeyM':
      e.preventDefault();
      muteBtn.click();
      break;
    case 'Period':
      e.preventDefault();
      stepFrame(1);
      break;
    case 'Comma':
      e.preventDefault();
      stepFrame(-1);
      break;
    case 'BracketLeft':
      e.preventDefault();
      adjustSpeed(-0.25);
      break;
    case 'BracketRight':
      e.preventDefault();
      adjustSpeed(0.25);
      break;
    case 'Backspace':
      e.preventDefault();
      resetSpeed();
      break;
    case 'KeyS':
      e.preventDefault();
      takeScreenshot();
      break;
    case 'KeyP':
      e.preventDefault();
      togglePip();
      break;
    default:
      if (/^Digit[0-9]$/.test(e.code)) {
        const n = parseInt(e.code.slice(5), 10);
        const dur = video.duration || 0;
        if (dur > 0) {
          video.currentTime = (n / 10) * dur;
          showOsd(`${n * 10}%`);
          saveResume();
        }
        e.preventDefault();
      }
  }
});

// spacebar hold-to-2x release handling
document.addEventListener('keyup', (e) => {
  if (e.code !== 'Space') return;
  if (!spaceHeld) return;
  spaceHeld = false;
  if (spaceTimer) { clearTimeout(spaceTimer); spaceTimer = null; }
  if (spaceBoosted) {
    video.playbackRate = savedRate || 1;
    speed.value = String(video.playbackRate);
    showOsd(`Speed: ${video.playbackRate}x`);
    spaceBoosted = false;
  } else {
    togglePlay();
  }
});

// mouse interactions
video.addEventListener('dblclick', () => fsBtn.click());
video.addEventListener('wheel', (e) => {
  e.preventDefault();
  adjustVolume(e.deltaY < 0 ? 0.05 : -0.05);
}, { passive: false });

// auto-hide controls
function resetIdle() {
  controls.classList.remove('idle');
  document.body.style.cursor = '';
  if (idleTimer) clearTimeout(idleTimer);
  if (!video.paused) {
    idleTimer = setTimeout(() => {
      controls.classList.add('idle');
      document.body.style.cursor = 'none';
    }, 2000);
  }
}
document.addEventListener('mousemove', resetIdle);
document.addEventListener('mouseleave', () => { /* keep */ });
video.addEventListener('play', resetIdle);
video.addEventListener('pause', () => { controls.classList.remove('idle'); document.body.style.cursor = ''; if (idleTimer) clearTimeout(idleTimer); });

// drag and drop
document.addEventListener('dragover', (e) => { e.preventDefault(); overlay.classList.remove('hidden'); dropHint.textContent = 'Drop .mp4 to play'; });
document.addEventListener('dragleave', () => { overlay.classList.add('hidden'); });
document.addEventListener('drop', (e) => {
  e.preventDefault();
  overlay.classList.add('hidden');
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) openFile(f.path);
});

overlay.addEventListener('click', async () => {
  const f = await window.safeview.pickFile();
  if (f) openFile(f);
});

// resume helpers
function resumeStorageKey(fp) { return 'safeview:resume:' + fp; }
function loadResume(fp) {
  try { return parseFloat(localStorage.getItem(resumeStorageKey(fp))); } catch (e) { return NaN; }
}
function saveResume() {
  if (!currentFile) return;
  try {
    const t = video.currentTime || 0;
    const dur = video.duration || 0;
    if (dur > 0 && t / dur > 0.95) {
      localStorage.removeItem(resumeStorageKey(currentFile));
    } else {
      localStorage.setItem(resumeStorageKey(currentFile), String(t));
    }
  } catch (e) {}
}

async function openFile(filePath) {
  if (!filePath) return;
  currentFile = filePath;
  resumeKey = filePath;
  showLoading('Booting sandbox…');
  video.removeAttribute('src');
  video.load();
  try {
    const poll = setInterval(async () => {
      try {
        const s = await window.safeview.status();
        if (s && s.progress) showLoading(s.progress);
      } catch (e) {}
    }, 500);
    const res = await window.safeview.startVm(filePath);
    clearInterval(poll);
    const status = (res && res.state) ? res : await window.safeview.status();
    if (status.state !== 'ready' || !status.streamUrl) {
      showError(status.error || 'Failed to start sandbox');
      return;
    }
    if (modeBadge) {
      modeBadge.textContent = status.mode === 'native' ? 'Sandboxed' : (status.isolated ? 'Isolated VM' : 'DEV MODE');
      modeBadge.style.color = status.mode === 'native' ? '#7CFC00' : (status.isolated ? '#7CFC00' : '#ff6b6b');
    }
    loadingText.textContent = status.mode === 'dev' ? 'Loading (dev mode)…' : 'Loading video…';
    // Use MediaSource Extensions so we can seek during encoding (duration known upfront).
    const url = status.streamUrl;
    const duration = (status.duration && isFinite(status.duration)) ? status.duration : null;
    const codecCandidates = [];
    if (status.codecs) codecCandidates.push('video/mp4; codecs="' + status.codecs + '"');
    codecCandidates.push('video/mp4; codecs="avc1.64003C,mp4a.40.2"');
    codecCandidates.push('video/mp4; codecs="avc1.640028,mp4a.40.2"');
    codecCandidates.push('video/mp4; codecs="avc1.4D401F,mp4a.40.2"');
    codecCandidates.push('video/mp4; codecs="avc1.42E01E,mp4a.40.2"');
    let sourceBuffer = null;
    const mediaSource = new MediaSource();
    video.src = URL.createObjectURL(mediaSource);
    await new Promise((resolve, reject) => {
      mediaSource.addEventListener('sourceopen', () => resolve(), { once: true });
      mediaSource.addEventListener('error', () => reject(new Error('MediaSource error')), { once: true });
      setTimeout(() => reject(new Error('MediaSource open timeout')), 10000);
    });
    // pick a working codec string
    for (const c of codecCandidates) {
      try {
        if (MediaSource.isTypeSupported(c)) { sourceBuffer = mediaSource.addSourceBuffer(c); break; }
      } catch (e) {}
    }
    if (!sourceBuffer) {
      // fallback to native playback
      video.src = url;
      video.load();
      await new Promise((resolve) => {
        const onCan = () => { cleanup(); resolve(); };
        const onErr = () => { cleanup(); resolve(); };
        function cleanup() { video.removeEventListener('canplay', onCan); video.removeEventListener('error', onErr); }
        video.addEventListener('canplay', onCan, { once: true });
        video.addEventListener('error', onErr, { once: true });
        setTimeout(() => { cleanup(); resolve(); }, 10000);
      });
    } else {
      if (duration) { try { mediaSource.duration = duration; } catch (e) {} }
      // fetch and append stream
      const queue = [];
      let appending = false;
      let fetchDone = false;
      function pump() {
        if (appending || queue.length === 0) return;
        appending = true;
        const chunk = queue.shift();
        try {
          sourceBuffer.appendBuffer(chunk);
        } catch (e) {
          // re-queue on failure
          queue.unshift(chunk);
          appending = false;
          setTimeout(pump, 50);
        }
      }
      sourceBuffer.addEventListener('updateend', () => {
        appending = false;
        if (queue.length > 0) pump();
        else if (fetchDone) {
          try { if (mediaSource.readyState === 'open') mediaSource.endOfStream(); } catch (e) {}
        }
      });
      sourceBuffer.addEventListener('error', () => { /* ignore */ });
      (async () => {
        try {
          const res = await fetch(url);
          if (!res.body) throw new Error('no body');
          const reader = res.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) { fetchDone = true; if (!appending && queue.length === 0) { try { if (mediaSource.readyState === 'open') mediaSource.endOfStream(); } catch (e) {} } break; }
            queue.push(value);
            pump();
          }
        } catch (e) {
          fetchDone = true;
          try { if (mediaSource.readyState === 'open') mediaSource.endOfStream(); } catch (e2) {}
        }
      })();
      // wait until enough data to play
      await new Promise((resolve) => {
        let to = null;
        const onCan = () => { if (to) clearTimeout(to); cleanup(); resolve(); };
        const onErr = () => { if (to) clearTimeout(to); cleanup(); resolve(); };
        video.addEventListener('canplay', onCan, { once: true });
        video.addEventListener('error', onErr, { once: true });
        function cleanup() { video.removeEventListener('canplay', onCan); video.removeEventListener('error', onErr); }
        to = setTimeout(() => { cleanup(); resolve(); }, 15000);
      });
    }
    // resume
    const saved = loadResume(filePath);
    if (isFinite(saved) && saved > 0) {
      try { video.currentTime = saved; } catch (e) {}
      showOsd(`Resumed at ${fmt(saved)}`);
    }
    hideLoading();
    video.play().catch(() => {});
    resetIdle();
    seek.disabled = false;
  } catch (err) {
    showError(String(err && err.message ? err.message : err));
  }
}

// periodic resume save
setInterval(() => { if (!video.paused) saveResume(); }, 5000);

// OS open-with / CLI
window.safeview.onOpenFile((p) => openFile(p));

errorRetry.addEventListener('click', async () => {
  errorBox.classList.add('hidden');
  const f = await window.safeview.pickFile();
  if (f) openFile(f);
});
