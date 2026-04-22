// ══════════════════════════════════
// STATE
// ══════════════════════════════════
let mediaItems = [],
  tracks = [],
  clips = [];
let selectedId = null,
  playheadTime = 0,
  totalDur = 0;
let isPlaying = false,
  rafHandle = null,
  playStartWall = 0,
  playStartPH = 0;
let zoomLevel = 1,
  activeTool = "select",
  masterVol = 1;
let cropMode = false,
  cropActive = false;
let nextId = 1;
const PPS_BASE = 60;
const DB_NAME = "cutframe_v3";
let db = null;
const CROP_MIN = 0.05;
const PREVIEW_BASE_W = 854;
let previewAspect = 854 / 480;
const TARGET_SHORTS_ASPECT = 9 / 16;
const POSE_CDN_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.2";
let mpPose = null;
let mpPoseInitPromise = null;
let poseModelLoadStatus = "idle"; // idle, loading, ready, error

// DOM
const pcanvas = document.getElementById("preview-canvas");
const pctx = pcanvas.getContext("2d");
const ccanvas = document.getElementById("crop-canvas");
const cctx = ccanvas.getContext("2d");
const ruler = document.getElementById("tl-ruler");
const rctx = ruler.getContext("2d");
const tlTracks = document.getElementById("tl-tracks");
const tlOuter = document.getElementById("tl-outer");
const playheadEl = document.getElementById("playhead");
const noClipMsg = document.getElementById("no-clip-msg");
const tlEmptyMsg = document.getElementById("tl-empty-msg");

// ══════════════════════════════════
// UTILS
// ══════════════════════════════════
const uid = () => nextId++;
const fmt = (s) => {
  s = Math.max(0, +s || 0);
  const h = (s / 3600) | 0,
    m = ((s % 3600) / 60) | 0,
    ss = (s % 60) | 0;
  return [h, m, ss].map((v) => ("" + v).padStart(2, "0")).join(":");
};
const pps = () => PPS_BASE * zoomLevel;
const t2x = (t) => t * pps();
const x2t = (x) => x / pps();

function toast(msg, d = 2400) {
  const e = document.getElementById("toast");
  e.textContent = msg;
  e.classList.add("show");
  clearTimeout(e._t);
  e._t = setTimeout(() => e.classList.remove("show"), d);
}

let _saveTimer;
function setDirty() {
  const b = document.getElementById("save-badge");
  b.textContent = "● saving…";
  b.classList.remove("ok");
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(saveProject, 900);
}

// ══════════════════════════════════
// INDEXEDDB
// ══════════════════════════════════
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = (e) => e.target.result.createObjectStore("blobs");
    r.onsuccess = (e) => {
      db = e.target.result;
      res();
    };
    r.onerror = rej;
  });
}
const dbSet = (k, v) =>
  new Promise((res, rej) => {
    const tx = db.transaction("blobs", "readwrite");
    tx.objectStore("blobs").put(v, k);
    tx.oncomplete = res;
    tx.onerror = rej;
  });
const dbGet = (k) =>
  new Promise((res, rej) => {
    const tx = db.transaction("blobs", "readonly");
    const r = tx.objectStore("blobs").get(k);
    r.onsuccess = () => res(r.result);
    r.onerror = rej;
  });
const dbDel = (k) =>
  new Promise((res) => {
    const tx = db.transaction("blobs", "readwrite");
    tx.objectStore("blobs").delete(k);
    tx.oncomplete = res;
  });

// ══════════════════════════════════
// PERSIST
// ══════════════════════════════════
async function saveProject() {
  const proj = {
    nextId,
    zoomLevel,
    masterVol,
    tracks: tracks.map((t) => ({ id: t.id })),
    clips: clips.map((c) => ({ ...c })),
    media: mediaItems.map((m) => ({
      id: m.id,
      name: m.name,
      type: m.type,
      duration: m.duration,
      dbKey: m.dbKey,
    })),
  };
  try {
    localStorage.setItem("cf_proj", JSON.stringify(proj));
    const b = document.getElementById("save-badge");
    b.textContent = "✓ saved";
    b.classList.add("ok");
    setTimeout(() => {
      b.textContent = "● auto-saved";
    }, 2000);
    updateStorLabel();
  } catch (e) {
    toast("⚠ Storage full — try removing media");
  }
}

async function loadProject() {
  const raw = localStorage.getItem("cf_proj");
  if (!raw) return false;
  let proj;
  try {
    proj = JSON.parse(raw);
  } catch {
    return false;
  }
  nextId = proj.nextId || 1;
  zoomLevel = proj.zoomLevel || 1;
  masterVol = proj.masterVol || 1;
  document.getElementById("vol-slider").value = masterVol;
  document.getElementById("vol-pct").textContent =
    Math.round(masterVol * 100) + "%";
  document.getElementById("zoom-val").textContent = zoomLevel + "×";

  for (const mi of proj.media || []) {
    const blob = await dbGet(mi.dbKey).catch(() => null);
    if (!blob) continue;
    const url = URL.createObjectURL(blob);
    const item = {
      id: mi.id,
      name: mi.name,
      type: mi.type,
      duration: mi.duration,
      url,
      dbKey: mi.dbKey,
      el: null,
    };
    mediaItems.push(item);
    await loadEl(item);
    renderMI(item);
  }
  for (const t of proj.tracks || []) {
    const track = { id: t.id };
    tracks.push(track);
    renderTrack(track);
  }
  for (const c of proj.clips || []) {
    const clip = { ...c };
    clips.push(clip);
    renderClip(clip);
  }
  recalc();
  updateStatus();
  if (mediaItems.length || clips.length) {
    noClipMsg.style.display = "none";
    tlEmptyMsg.style.display = "none";
  }
  const b = document.getElementById("save-badge");
  b.textContent = "✓ loaded";
  b.classList.add("ok");
  updateStorLabel();
  return true;
}

function loadEl(item) {
  return new Promise((res) => {
    if (item.type === "image") {
      const img = new Image();
      img.onload = () => {
        item.el = img;
        res();
      };
      img.onerror = res;
      img.src = item.url;
    } else {
      const el = document.createElement(
        item.type === "audio" ? "audio" : "video",
      );
      el.src = item.url;
      el.preload = "auto";
      el.crossOrigin = "anonymous";
      const done = () => {
        if (!item.el) {
          item.el = el;
          if (!item.duration) item.duration = el.duration;
          res();
        }
      };
      el.onloadedmetadata = done;
      el.oncanplay = done;
      el.onerror = res;
      setTimeout(res, 4000);
    }
  });
}

function updateStorLabel() {
  try {
    const n = new Blob([localStorage.getItem("cf_proj") || ""]).size;
    document.getElementById("sb-stor").textContent =
      n > 1e6 ? (n / 1e6).toFixed(1) + "MB" : Math.round(n / 1024) + "KB";
  } catch {}
}

function clearProject() {
  if (clips.length && !confirm("Clear everything?")) return;
  pause();
  clips.forEach((c) => document.getElementById("clip-" + c.id)?.remove());
  tracks.forEach((t) => document.getElementById("track-" + t.id)?.remove());
  mediaItems.forEach((m) => {
    if (m.dbKey) dbDel(m.dbKey);
    URL.revokeObjectURL(m.url);
  });
  clips = [];
  tracks = [];
  mediaItems = [];
  nextId = 1;
  selectedId = null;
  playheadTime = 0;
  document.getElementById("media-list").innerHTML = "";
  noClipMsg.style.display = "flex";
  tlEmptyMsg.style.display = "flex";
  localStorage.removeItem("cf_proj");
  recalc();
  updateStatus();
  renderFrame();
  toast("Cleared");
}

// ══════════════════════════════════
// IMPORT
// ══════════════════════════════════
document.getElementById("btn-import").onclick = () =>
  document.getElementById("file-input").click();
document.getElementById("file-input").onchange = (e) => {
  [...e.target.files].forEach(importFile);
  e.target.value = "";
};

const dz = document.getElementById("drop-zone");
dz.onclick = () => document.getElementById("file-input").click();
dz.ondragover = (e) => {
  e.preventDefault();
  dz.classList.add("dz-over");
};
dz.ondragleave = () => dz.classList.remove("dz-over");
dz.ondrop = (e) => {
  e.preventDefault();
  dz.classList.remove("dz-over");
  [...e.dataTransfer.files].forEach(importFile);
};

async function importFile(file) {
  const isV = file.type.startsWith("video"),
    isA = file.type.startsWith("audio"),
    isI = file.type.startsWith("image");
  if (!isV && !isA && !isI) {
    toast("Unsupported type");
    return;
  }
  const id = uid(),
    dbKey = "m_" + id,
    url = URL.createObjectURL(file);
  const type = isV ? "video" : isA ? "audio" : "image";
  const item = {
    id,
    name: file.name,
    type,
    url,
    duration: isI ? 5 : 0,
    dbKey,
    el: null,
  };
  mediaItems.push(item);
  renderMI(item);
  try {
    await dbSet(dbKey, file);
  } catch {
    toast("⚠ Storage quota hit");
  }
  await loadEl(item);
  renderMI(item);
  if (item.type === "video") captureThumb(item);
  setDirty();
  toast("Imported: " + file.name);
}

function captureThumb(item) {
  const c = document.getElementById("mthumb-" + item.id);
  if (!c || !item.el) return;
  const ctx = c.getContext("2d");
  item.el.currentTime = Math.min(0.5, item.duration * 0.05 || 0);
  const draw = () => {
    try {
      ctx.drawImage(item.el, 0, 0, 44, 27);
    } catch {}
  };
  item.el.onseeked = draw;
  setTimeout(draw, 700);
}

function renderMI(item) {
  let el = document.getElementById("mi-" + item.id);
  if (!el) {
    el = document.createElement("div");
    el.id = "mi-" + item.id;
    el.className = "mi";
    el.draggable = true;
    el.ondragstart = (e) => {
      e.dataTransfer.setData("mId", "" + item.id);
      el.classList.add("drag-src");
    };
    el.ondragend = () => el.classList.remove("drag-src");
    el.onclick = () => {
      document
        .querySelectorAll(".mi")
        .forEach((x) => x.classList.remove("sel"));
      el.classList.add("sel");
    };
    document.getElementById("media-list").appendChild(el);
  }
  const thumb =
    item.type === "image"
      ? `<img src="${item.url}" style="width:100%;height:100%;object-fit:cover">`
      : item.type === "audio"
        ? `<div style="font-size:16px;color:var(--text3)">🎵</div>`
        : item.type === "tts"
          ? `<div style="font-size:14px;color:var(--accent2)">${item._rendered ? '🎵' : '🎙'}</div>`
          : `<canvas id="mthumb-${item.id}" width="44" height="27"></canvas>`;
  const badge = item.type === 'tts' ? (item._rendered ? '✓ audio' : item._rendering ? '⏳ render' : 'tts') : item.type;
  el.innerHTML = `<div class="mi-thumb">${thumb}<div class="mi-badge">${badge}</div></div>
    <div class="mi-info"><div class="mi-name" title="${item.name}">${item.name}</div><div class="mi-dur">${item.duration ? fmt(item.duration) : "…"}</div></div>
    <button class="mi-add" title="Add to timeline" onclick="addClipAuto(${item.id});event.stopPropagation()">＋</button>
    <button class="mi-del" title="Remove" onclick="removeMI(${item.id});event.stopPropagation()">×</button>`;
  if (item.type === "video" && item.el) captureThumb(item);
}

function removeMI(id) {
  const idx = mediaItems.findIndex((m) => m.id === id);
  if (idx < 0) return;
  const item = mediaItems[idx];
  clips
    .filter((c) => c.mediaId === id)
    .forEach((c) => {
      document.getElementById("clip-" + c.id)?.remove();
    });
  clips = clips.filter((c) => c.mediaId !== id);
  if (selectedId && !clips.find((c) => c.id === selectedId)) selectClip(null);
  if (item.dbKey) dbDel(item.dbKey);
  URL.revokeObjectURL(item.url);
  mediaItems.splice(idx, 1);
  document.getElementById("mi-" + id)?.remove();
  recalc();
  updateStatus();
  setDirty();
  toast("Removed");
}

// ══════════════════════════════════
// TRACKS
// ══════════════════════════════════
function addTrack() {
  const track = { id: uid() };
  tracks.push(track);
  renderTrack(track);
  tlEmptyMsg.style.display = "none";
  updateStatus();
  setDirty();
  return track;
}

function renderTrack(track) {
  const row = document.createElement("div");
  row.className = "track-row";
  row.id = "track-" + track.id;
  row.ondragover = (e) => {
    e.preventDefault();
    row.classList.add("tl-over");
  };
  row.ondragleave = () => row.classList.remove("tl-over");
  row.ondrop = (e) => {
    e.preventDefault();
    row.classList.remove("tl-over");
    const mId = parseInt(e.dataTransfer.getData("mId") || "0");
    const cId = parseInt(e.dataTransfer.getData("cId") || "0");
    const offX = parseFloat(e.dataTransfer.getData("offX") || "0");
    const dropX =
      e.clientX - row.getBoundingClientRect().left + tlOuter.scrollLeft;
    if (mId) addClipToTrack(mId, track.id, Math.max(0, x2t(dropX)));
    else if (cId) moveClip(cId, track.id, Math.max(0, x2t(dropX - offX)));
  };
  row.onclick = (e) => {
    if (e.target !== row) return;
    if (activeTool === "razor")
      razorAtRow(
        track.id,
        e.clientX - row.getBoundingClientRect().left + tlOuter.scrollLeft,
      );
    else selectClip(null);
  };
  tlTracks.appendChild(row);
  resizeTl();
}

// ══════════════════════════════════
// CLIPS
// ══════════════════════════════════
function addClipAuto(mid) {
  if (!tracks.length) addTrack();
  const t = tracks[0];
  const end = Math.max(
    0,
    ...clips.filter((c) => c.trackId === t.id).map((c) => c.start + c.duration),
    0,
  );
  addClipToTrack(mid, t.id, end);
  toast("Clip added");
}

function addClipToTrack(mid, tid, start) {
  const media = mediaItems.find((m) => m.id === mid);
  if (!media) return;
  const clip = {
    id: uid(),
    trackId: tid,
    mediaId: mid,
    start: Math.max(0, start),
    duration: media.duration || 5,
    trimIn: 0,
    volume: 1,
    speed: 1,
    opacity: 1,
    brightness: 100,
    contrast: 100,
    saturation: 100,
    hue: 0,
    blur: 0,
    filters: { bw: false, sepia: false, invert: false, flip: false },
    crop: null,
  };
  clips.push(clip);
  renderClip(clip);
  recalc();
  selectClip(clip.id);
  updateStatus();
  setDirty();
  noClipMsg.style.display = "none";
  tlEmptyMsg.style.display = "none";
}

function moveClip(cid, tid, start) {
  const clip = clips.find((c) => c.id === cid);
  if (!clip) return;
  clip.trackId = tid;
  clip.start = start;
  const el = document.getElementById("clip-" + cid);
  const row = document.getElementById("track-" + tid);
  if (el && row) row.appendChild(el);
  updateClipPos(clip);
  recalc();
  setDirty();
}

function renderClip(clip) {
  const media = mediaItems.find((m) => m.id === clip.mediaId);
  if (!media) return;
  const row = document.getElementById("track-" + clip.trackId);
  if (!row) return;
  const el = document.createElement("div");
  el.className = "tl-clip";
  el.id = "clip-" + clip.id;
  el.innerHTML = `<div class="rl"></div>
    <div class="clip-head"><span class="clip-name">${media.name}</span><span class="clip-dur" id="cdur-${clip.id}">${fmt(clip.duration)}</span></div>
    <div class="clip-body"><canvas></canvas></div>
    <div class="rr"></div>`;
  updateClipPos(clip);

  el.addEventListener("mousedown", (e) => {
    if (e.target.classList.contains("rl") || e.target.classList.contains("rr"))
      return;
    if (activeTool === "razor") {
      razorClip(
        clip.id,
        clip.start + x2t(e.clientX - el.getBoundingClientRect().left),
      );
      return;
    }
    selectClip(clip.id);
    const offX = e.clientX - el.getBoundingClientRect().left;
    let moved = false;
    const mv = (ev) => {
      moved = true;
      const hr = document
        .elementFromPoint(ev.clientX, ev.clientY)
        ?.closest(".track-row");
      const tid = hr ? parseInt(hr.id.replace("track-", "")) : clip.trackId;
      const rowEl = document.getElementById("track-" + tid) || row;
      const nx = Math.max(
        0,
        x2t(
          ev.clientX -
            rowEl.getBoundingClientRect().left +
            tlOuter.scrollLeft -
            offX,
        ),
      );
      clip.start = nx;
      clip.trackId = tid;
      if (el.parentElement !== rowEl) rowEl.appendChild(el);
      updateClipPos(clip);
    };
    const up = () => {
      document.removeEventListener("mousemove", mv);
      document.removeEventListener("mouseup", up);
      if (moved) {
        recalc();
        setDirty();
      }
    };
    document.addEventListener("mousemove", mv);
    document.addEventListener("mouseup", up);
    e.preventDefault();
  });
  setupResize(el, clip, "l");
  setupResize(el, clip, "r");
  row.appendChild(el);
  drawWave(clip, el.querySelector(".clip-body canvas"));
}

function setupResize(el, clip, side) {
  const h = el.querySelector(".r" + side);
  h.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    const sx = e.clientX,
      os = clip.start,
      od = clip.duration;
    const mv = (ev) => {
      const dx = x2t(ev.clientX - sx);
      if (side === "r") {
        clip.duration = Math.max(0.1, od + dx);
      } else {
        const ns = Math.max(0, os + dx);
        clip.duration = Math.max(0.1, od - (ns - os));
        clip.start = ns;
      }
      updateClipPos(clip);
      document.getElementById("cdur-" + clip.id).textContent = fmt(
        clip.duration,
      );
      recalc();
    };
    const up = () => {
      document.removeEventListener("mousemove", mv);
      document.removeEventListener("mouseup", up);
      setDirty();
    };
    document.addEventListener("mousemove", mv);
    document.addEventListener("mouseup", up);
    e.preventDefault();
  });
}

function updateClipPos(clip) {
  const el = document.getElementById("clip-" + clip.id);
  if (!el) return;
  el.style.left = t2x(clip.start) + "px";
  el.style.width = Math.max(14, t2x(clip.duration)) + "px";
}

function drawWave(clip, canvas) {
  if (!canvas) return;
  const w = (canvas.width = Math.max(10, t2x(clip.duration)));
  const h = (canvas.height = 34);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(255,255,255,.55)";
  const bars = Math.floor(w / 3);
  for (let i = 0; i < bars; i++) {
    const amp =
      0.2 +
      0.8 * Math.abs(Math.sin(i * 0.4 + clip.id * 0.7) * Math.cos(i * 0.2));
    const bh = amp * h * 0.8;
    ctx.fillRect(i * 3, (h - bh) / 2, 2, bh);
  }
}

// ══════════════════════════════════
// RULER
// ══════════════════════════════════
function drawRuler() {
  const w = ruler.width,
    h = 22;
  rctx.fillStyle = "#09090b";
  rctx.fillRect(0, 0, w, h);
  const ppx = pps();
  let step = ppx < 20 ? 10 : ppx < 50 ? 5 : ppx < 120 ? 2 : 1;
  const end = x2t(w) + step;
  rctx.font = "9px DM Mono,monospace";
  for (let t = 0; t <= end; t += step) {
    const x = t2x(t);
    rctx.fillStyle = "#2a2a33";
    rctx.fillRect(x, 14, 1, 8);
    if (ppx >= 25 || t % (step * 5) === 0) {
      rctx.fillStyle = "#8888a4";
      rctx.fillText(fmt(t), x + 2, 11);
    }
  }
  for (let t = 0; t <= end; t += step * 0.5) {
    if ((t * 100) % (step * 100) !== 0) {
      rctx.fillStyle = "#1e1e25";
      rctx.fillRect(t2x(t), 17, 1, 5);
    }
  }
}

ruler.addEventListener("mousedown", (e) => {
  const seek = (ev) => {
    seekTo(
      Math.max(
        0,
        x2t(
          ev.clientX - ruler.getBoundingClientRect().left + tlOuter.scrollLeft,
        ),
      ),
    );
  };
  seek(e);
  const up = () => {
    document.removeEventListener("mousemove", seek);
    document.removeEventListener("mouseup", up);
  };
  document.addEventListener("mousemove", seek);
  document.addEventListener("mouseup", up);
});

function resizeTl() {
  const minW = Math.max(tlOuter.clientWidth || 600, t2x(totalDur) + 280);
  ruler.width = minW;
  document
    .querySelectorAll(".track-row")
    .forEach((r) => (r.style.minWidth = minW + "px"));
  drawRuler();
  playheadEl.style.height = tlTracks.scrollHeight + 24 + "px";
}

function recalc() {
  totalDur = Math.max(1, ...clips.map((c) => c.start + c.duration), 1);
  resizeTl();
  document.getElementById("tc-tot").textContent = fmt(totalDur);
  document.getElementById("sb-dur").textContent = fmt(totalDur);
}

// ══════════════════════════════════
// PLAYBACK
// ══════════════════════════════════
function togglePlay() {
  isPlaying ? pause() : play();
}

function play() {
  if (!clips.length) {
    toast("No clips");
    return;
  }
  isPlaying = true;
  document.getElementById("btn-play").textContent = "⏸";
  playStartWall = performance.now();
  playStartPH = playheadTime;
  // start videos
  clips.forEach((clip) => {
    const m = mediaItems.find((x) => x.id === clip.mediaId);
    if (!m) return;
    if (m.type === "tts") clip._ttsPlaying = false;
    if (!m.el || !(m.type === "video" || m.type === "audio")) return;
    if (
      playheadTime >= clip.start &&
      playheadTime < clip.start + clip.duration
    ) {
      const lt = Math.max(0, playheadTime - clip.start + (clip.trimIn || 0));
      m.el.currentTime = lt;
      m.el.volume = Math.min(1, Math.max(0, (clip.volume || 1) * masterVol));
      m.el.playbackRate = clip.speed || 1;
      m.el.play().catch(() => {});
    }
  });
  const loop = () => {
    const elapsed = (performance.now() - playStartWall) / 1000;
    playheadTime = playStartPH + elapsed;
    if (playheadTime >= totalDur) {
      playheadTime = totalDur;
      pause();
      return;
    }
    updatePH();
    renderFrame();
    // Sync audio/video volumes and playback per clip
    clips.forEach((clip) => {
      const m = mediaItems.find((x) => x.id === clip.mediaId);
      if (!m) return;
      const inRange =
        playheadTime >= clip.start && playheadTime < clip.start + clip.duration;
        
      if (m.type === "tts" && !m._rendered) {
        if (inRange && !clip._ttsPlaying) {
          clip._ttsPlaying = true;
          speechSynthesis.cancel();
          const u = new SpeechSynthesisUtterance(m.text);
          const voices = speechSynthesis.getVoices();
          if (voices[m.voiceIdx]) u.voice = voices[m.voiceIdx];
          u.rate = clip.speed || 1;
          u.volume = Math.min(1, Math.max(0, (clip.volume || 1) * masterVol));
          u.onend = () => { clip._ttsPlaying = false; };
          window.__activeTTS = window.__activeTTS || [];
          window.__activeTTS.push(u);
          speechSynthesis.speak(u);
        } else if (!inRange && clip._ttsPlaying) {
          clip._ttsPlaying = false;
          speechSynthesis.cancel();
          window.__activeTTS = [];
        }
        return;
      }
      
      if (!m.el || !(m.type === "video" || m.type === "audio")) return;
      if (inRange) {
        const v = Math.min(1, Math.max(0, (clip.volume || 1) * masterVol));
        if (m.el.paused) {
          m.el.currentTime = Math.max(
            0,
            playheadTime - clip.start + (clip.trimIn || 0),
          );
          m.el.volume = v;
          m.el.playbackRate = clip.speed || 1;
          m.el.play().catch(() => {});
        } else {
          m.el.volume = v;
        }
      } else {
        if (!m.el.paused) m.el.pause();
      }
    });
    rafHandle = requestAnimationFrame(loop);
  };
  rafHandle = requestAnimationFrame(loop);
}

function pause() {
  isPlaying = false;
  if (rafHandle) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
  document.getElementById("btn-play").textContent = "▶";
  mediaItems.forEach((m) => {
    if (m.el && m.el.pause) m.el.pause();
  });
  if (window.speechSynthesis) speechSynthesis.cancel();
  clips.forEach(c => c._ttsPlaying = false);
}

function seekTo(t) {
  playheadTime = Math.max(0, Math.min(t, totalDur));
  if (isPlaying) {
    pause();
    setTimeout(play, 40);
  } else {
    updatePH();
    renderFrame();
  }
}
function seekStart() {
  pause();
  playheadTime = 0;
  updatePH();
  renderFrame();
}
function seekEnd() {
  pause();
  playheadTime = totalDur;
  updatePH();
  renderFrame();
}

function updatePH() {
  playheadEl.style.left = t2x(playheadTime) + "px";
  document.getElementById("tc-cur").textContent = fmt(playheadTime);
  const sw = tlOuter.clientWidth,
    sl = tlOuter.scrollLeft,
    x = t2x(playheadTime);
  if (x > sl + sw - 80) tlOuter.scrollLeft = x - sw / 2;
}

// ══════════════════════════════════
// RENDER — Canvas with real filters
// ══════════════════════════════════
function buildFilter(clip) {
  const p = [];
  if ((clip.brightness || 100) !== 100)
    p.push(`brightness(${clip.brightness}%)`);
  if ((clip.contrast || 100) !== 100) p.push(`contrast(${clip.contrast}%)`);
  if ((clip.saturation || 100) !== 100) p.push(`saturate(${clip.saturation}%)`);
  if (clip.hue) p.push(`hue-rotate(${clip.hue}deg)`);
  if (clip.blur) p.push(`blur(${clip.blur}px)`);
  const f = clip.filters || {};
  if (f.bw) p.push("grayscale(100%)");
  if (f.sepia) p.push("sepia(85%)");
  if (f.invert) p.push("invert(100%)");
  return p.join(" ") || "none";
}

function getClipAspect(clip) {
  const m = mediaItems.find((x) => x.id === clip.mediaId);
  if (!m || m.type === "audio") return null;
  const srcW =
    m.type === "video"
      ? m.el?.videoWidth || PREVIEW_BASE_W
      : m.el?.naturalWidth || PREVIEW_BASE_W;
  const srcH =
    m.type === "video" ? m.el?.videoHeight || 480 : m.el?.naturalHeight || 480;
  const crop = normalizeCrop(clip.crop || { x: 0, y: 0, w: 1, h: 1 });
  const w = srcW * crop.w;
  const h = srcH * crop.h;
  if (!w || !h) return null;
  return w / h;
}

function getPreviewAspect() {
  const fallback = PREVIEW_BASE_W / 480;
  if (!clips.length) return fallback;

  if (cropMode && selectedId) {
    const sel = clips.find((c) => c.id === selectedId);
    const asp = sel ? getClipAspect(sel) : null;
    if (asp) return asp;
  }

  for (let ti = tracks.length - 1; ti >= 0; ti--) {
    const active = clips.find(
      (c) =>
        c.trackId === tracks[ti].id &&
        playheadTime >= c.start &&
        playheadTime < c.start + c.duration,
    );
    if (!active) continue;
    const asp = getClipAspect(active);
    if (asp) return asp;
  }

  return fallback;
}

function updatePreviewSize(force = false) {
  const targetAspect = Math.max(0.3, Math.min(4, getPreviewAspect()));
  if (!force && Math.abs(targetAspect - previewAspect) < 0.01) return;
  previewAspect = targetAspect;
  const nextH = Math.max(180, Math.round(PREVIEW_BASE_W / targetAspect));
  pcanvas.width = PREVIEW_BASE_W;
  pcanvas.height = nextH;
  document.getElementById("preview-area").style.minHeight =
    Math.min(560, nextH + 24) + "px";
  syncCropCanvas();
}

function renderFrame() {
  updatePreviewSize();
  const W = pcanvas.width,
    H = pcanvas.height;
  pctx.clearRect(0, 0, W, H);
  pctx.fillStyle = "#000";
  pctx.fillRect(0, 0, W, H);
  let hasContent = false;
  for (let ti = tracks.length - 1; ti >= 0; ti--) {
    const track = tracks[ti];
    clips
      .filter(
        (c) =>
          c.trackId === track.id &&
          playheadTime >= c.start &&
          playheadTime < c.start + c.duration,
      )
      .forEach((clip) => {
        const m = mediaItems.find((x) => x.id === clip.mediaId);
        if (!m || !m.el) return;
        try {
          pctx.save();
          pctx.globalAlpha = clip.opacity ?? 1;
          const filt = buildFilter(clip);
          if (filt !== "none") pctx.filter = filt;
          // source dims
          const srcW =
            m.type === "video"
              ? m.el.videoWidth || W
              : m.type === "image"
                ? m.el.naturalWidth || W
                : W;
          const srcH =
            m.type === "video"
              ? m.el.videoHeight || H
              : m.type === "image"
                ? m.el.naturalHeight || H
                : H;
          let sx = 0,
            sy = 0,
            sw = srcW,
            sh = srcH;
          if (clip.crop) {
            sx = clip.crop.x * srcW;
            sy = clip.crop.y * srcH;
            sw = clip.crop.w * srcW;
            sh = clip.crop.h * srcH;
          }
          if (clip.filters?.flip) {
            pctx.translate(W, 0);
            pctx.scale(-1, 1);
          }
          if (m.type !== "audio" && sw > 0 && sh > 0) {
            if (clip.filters?.removeBg) {
              const cacheKey = `${clip.id}_${(m.el.currentTime || 0).toFixed(1)}`;
              const maskedImg = window.bgMaskCache ? window.bgMaskCache.get(cacheKey) : null;
              if (maskedImg && maskedImg !== 'processing') {
                pctx.drawImage(maskedImg, sx, sy, sw, sh, 0, 0, W, H);
              } else {
                pctx.drawImage(m.el, sx, sy, sw, sh, 0, 0, W, H);
                if (window.getBgMaskAsync) window.getBgMaskAsync(clip, m, m.el.currentTime || 0);
              }
            } else {
              pctx.drawImage(m.el, sx, sy, sw, sh, 0, 0, W, H);
            }
          }
          pctx.restore();
          if (m.type !== "audio") hasContent = true;
        } catch (e) {}
      });
  }
  noClipMsg.style.display = hasContent ? "none" : "flex";
  if (typeof drawCaptionOverlay === 'function' && window.captionsVisible) drawCaptionOverlay(pctx, W, H);
  if (cropMode && selectedId) {
    const c = clips.find((x) => x.id === selectedId);
    if (c) drawCropOverlay(c);
  }
}

// ══════════════════════════════════
// AI POSE DETECTION (MediaPipe Pose)
// ══════════════════════════════════
async function cachePoseScript() {
  try {
    const response = await fetch(`${POSE_CDN_URL}/pose.js`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const scriptText = await response.text();
    await dbSet("pose_script_cached", {
      text: scriptText,
      timestamp: Date.now(),
    });
    return true;
  } catch (e) {
    console.error("Failed to cache Pose script:", e);
    return false;
  }
}

async function ensurePoseDetector() {
  if (mpPose) return mpPose;
  if (mpPoseInitPromise) return mpPoseInitPromise;

  mpPoseInitPromise = (async () => {
    poseModelLoadStatus = "loading";
    updatePoseStatusUI();

    try {
      // Try to load from cache first
      let scriptText = null;
      try {
        const cached = await dbGet("pose_script_cached");
        if (cached && cached.text) {
          scriptText = cached.text;
          console.log("✓ Loaded Pose from cache");
        }
      } catch (e) {
        console.warn("Cache read failed, fetching from CDN", e);
      }

      // If not in cache, fetch from CDN
      if (!scriptText) {
        console.log("Fetching Pose.js from CDN...");
        const response = await fetch(`${POSE_CDN_URL}/pose.js`);
        if (!response.ok)
          throw new Error(`Failed to fetch Pose.js: ${response.status}`);
        scriptText = await response.text();
        // Cache it for next time
        await cachePoseScript().catch(() => {});
      }

      // Execute the script in global context
      const script = document.createElement("script");
      script.textContent = scriptText;
      document.head.appendChild(script);

      // Wait for Pose to be available
      let attempts = 0;
      while (!window.Pose && attempts < 50) {
        await new Promise((r) => setTimeout(r, 100));
        attempts++;
      }

      if (!window.Pose) {
        throw new Error("MediaPipe Pose not available after loading script");
      }

      // Create detector
      const detector = new window.Pose({
        locateFile: (file) => `${POSE_CDN_URL}/${file}`,
      });

      detector.setOptions({
        modelComplexity: 1,
        smoothLandmarks: true,
        enableSegmentation: false,
        smoothSegmentation: false,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
        selfieMode: false,
      });

      mpPose = detector;
      poseModelLoadStatus = "ready";
      updatePoseStatusUI();
      console.log("✓ MediaPipe Pose model ready");
      return detector;
    } catch (err) {
      console.error("Pose detector error:", err);
      poseModelLoadStatus = "error";
      updatePoseStatusUI();
      throw err;
    }
  })();

  return mpPoseInitPromise;
}

function updatePoseStatusUI() {
  const statusEl = document.getElementById("pose-status");
  if (!statusEl) return;

  const statusMap = {
    idle: "⚪ Idle",
    loading: "🟡 Loading model...",
    ready: "🟢 Model ready",
    error: "🔴 Model error",
  };

  statusEl.textContent = statusMap[poseModelLoadStatus] || "⚪ Unknown";
  statusEl.className = `pose-status ${poseModelLoadStatus}`;
}

async function clearPoseCache() {
  try {
    await dbDel("pose_script_cached");
    mpPose = null;
    mpPoseInitPromise = null;
    poseModelLoadStatus = "idle";
    updatePoseStatusUI();
    toast("Pose model cache cleared");
    return true;
  } catch (e) {
    console.error("Failed to clear cache:", e);
    toast("Failed to clear cache");
    return false;
  }
}

async function refreshPoseModel() {
  poseModelLoadStatus = "loading";
  updatePoseStatusUI();
  mpPose = null;
  mpPoseInitPromise = null;

  try {
    // Clear old cache
    await dbDel("pose_script_cached").catch(() => {});

    // Re-initialize
    const detector = await ensurePoseDetector();
    toast("Pose model refreshed ✓");
    return detector;
  } catch (e) {
    console.error("Failed to refresh Pose model:", e);
    poseModelLoadStatus = "error";
    updatePoseStatusUI();
    toast("Failed to refresh Pose model");
    return null;
  }
}

function openSettingsModal() {
  document.getElementById("settings-modal").classList.add("open");
}

function closeSettingsModal() {
  document.getElementById("settings-modal").classList.remove("open");
}

function getPoseLandmarksBounds(landmarks) {
  if (!landmarks?.length) return null;

  // Filter visible landmarks (confidence > 0.3)
  const visiblePoints = landmarks.filter((p) => {
    const v = p.visibility ?? 1;
    return v > 0.3 && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
  });

  if (visiblePoints.length < 5) return null;

  let minX = 1,
    minY = 1,
    maxX = 0,
    maxY = 0;
  for (const p of visiblePoints) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const w = maxX - minX;
  const h = maxY - minY;

  return { cx, cy, w, h, minX, minY, maxX, maxY };
}

function setCropAIStatus(id, msg, tone = "idle") {
  const el = document.getElementById("crop-ai-status-" + id);
  if (!el) return;
  el.textContent = msg;
  el.className = "crop-ai-status " + tone;
}

function waitForVideoSeek(el, targetTime) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.removeEventListener("seeked", onSeek);
      resolve();
    };
    const onSeek = () => finish();
    el.addEventListener("seeked", onSeek);
    const maxT = Math.max(0, (el.duration || 0) - 0.02);
    el.currentTime = Math.max(0, Math.min(maxT, targetTime));
    setTimeout(finish, 400);
  });
}

async function runPoseDetection(detector, videoEl, previewCanvas = null) {
  return new Promise((resolve, reject) => {
    try {
      let resultsReceived = false;
      const timeout = setTimeout(() => {
        if (!resultsReceived) {
          reject(new Error("Pose detection timeout"));
        }
      }, 2000);

      detector.onResults((results) => {
        resultsReceived = true;
        clearTimeout(timeout);

        // Draw preview if canvas provided
        if (previewCanvas && results.image) {
          const ctx = previewCanvas.getContext("2d");
          ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
          ctx.drawImage(
            results.image,
            0,
            0,
            previewCanvas.width,
            previewCanvas.height,
          );

          // Draw pose landmarks
          if (results.poseLandmarks && results.poseLandmarks.length > 0) {
            const landmarks = results.poseLandmarks;

            // Draw skeleton connections
            const connections = [
              [11, 12], // shoulders
              [11, 23], // left shoulder to hip
              [12, 24], // right shoulder to hip
              [23, 24], // hips
              [11, 13],
              [13, 15], // left arm
              [12, 14],
              [14, 16], // right arm
              [23, 25],
              [25, 27], // left leg
              [24, 26],
              [26, 28], // right leg
            ];

            ctx.strokeStyle = "rgba(100, 200, 255, 0.6)";
            ctx.lineWidth = 2;
            for (const [from, to] of connections) {
              const p1 = landmarks[from];
              const p2 = landmarks[to];
              if (
                p1 &&
                p2 &&
                (p1.visibility ?? 1) > 0.3 &&
                (p2.visibility ?? 1) > 0.3
              ) {
                ctx.beginPath();
                ctx.moveTo(
                  p1.x * previewCanvas.width,
                  p1.y * previewCanvas.height,
                );
                ctx.lineTo(
                  p2.x * previewCanvas.width,
                  p2.y * previewCanvas.height,
                );
                ctx.stroke();
              }
            }

            // Draw landmarks as circles
            ctx.fillStyle = "rgba(255, 100, 100, 0.8)";
            for (const p of landmarks) {
              if ((p.visibility ?? 1) > 0.3) {
                ctx.beginPath();
                ctx.arc(
                  p.x * previewCanvas.width,
                  p.y * previewCanvas.height,
                  4,
                  0,
                  Math.PI * 2,
                );
                ctx.fill();
              }
            }

            // Draw bounding box
            const bounds = getPoseLandmarksBounds(landmarks);
            if (bounds) {
              ctx.strokeStyle = "rgba(100, 255, 100, 0.8)";
              ctx.lineWidth = 2;
              ctx.strokeRect(
                bounds.minX * previewCanvas.width,
                bounds.minY * previewCanvas.height,
                bounds.w * previewCanvas.width,
                bounds.h * previewCanvas.height,
              );

              // Draw center point
              ctx.fillStyle = "rgba(255, 255, 100, 0.8)";
              ctx.beginPath();
              ctx.arc(
                bounds.cx * previewCanvas.width,
                bounds.cy * previewCanvas.height,
                6,
                0,
                Math.PI * 2,
              );
              ctx.fill();
            }
          }
        }

        resolve(results);
      });

      detector.send({ image: videoEl });
    } catch (err) {
      reject(err);
    }
  });
}

async function autoCenterPersonInFrame(clipId) {
  const clip = clips.find((c) => c.id === clipId);
  if (!clip) return;

  const media = mediaItems.find((m) => m.id === clip.mediaId);
  if (!media || media.type !== "video" || !media.el) {
    toast("AI center works for video clips only");
    return;
  }

  const btn = document.getElementById("crop-ai-btn-" + clipId);
  if (btn) btn.disabled = true;

  setCropAIStatus(clipId, "Detecting pose...", "loading");

  const wasPlaying = isPlaying;
  if (wasPlaying) pause();

  const videoEl = media.el;
  const restoreTime = videoEl.currentTime || 0;

  // Create preview canvas for showing detection
  const previewCanvas = document.createElement("canvas");
  previewCanvas.width = 450;
  previewCanvas.height = 800;

  try {
    const detector = await ensurePoseDetector();

    // Sample frames throughout the clip
    const sampleCount = Math.min(
      8,
      Math.max(3, Math.round(clip.duration * 0.8)),
    );
    const centersX = [];
    const centersY = [];
    const detectionResults = [];

    for (let i = 0; i < sampleCount; i++) {
      const localTime =
        (clip.trimIn || 0) +
        (i / Math.max(1, sampleCount - 1)) *
          Math.max(0.05, clip.duration - 0.05);

      await waitForVideoSeek(videoEl, localTime);

      try {
        const results = await runPoseDetection(
          detector,
          videoEl,
          previewCanvas,
        );

        if (results?.poseLandmarks) {
          const bounds = getPoseLandmarksBounds(results.poseLandmarks);
          if (bounds && bounds.w > 0 && bounds.h > 0) {
            centersX.push(bounds.cx);
            centersY.push(bounds.cy);
            detectionResults.push({
              time: localTime,
              bounds: bounds,
              landmarks: results.poseLandmarks,
            });
            console.log(
              `Frame ${i}: Person detected at (${bounds.cx.toFixed(2)}, ${bounds.cy.toFixed(2)})`,
            );
          }
        }
      } catch (err) {
        console.warn(`Detection failed at frame ${i}:`, err);
      }
    }

    if (centersX.length === 0) {
      setCropAIStatus(
        clipId,
        "❌ No person detected. Make sure person is visible and well-lit.",
        "idle",
      );
      toast("Could not detect person in video");
      return;
    }

    // Calculate median centers
    centersX.sort((a, b) => a - b);
    centersY.sort((a, b) => a - b);
    const medianX = centersX[Math.floor(centersX.length / 2)];
    const medianY = centersY[Math.floor(centersY.length / 2)];

    console.log(
      `✓ Detected person at center: (${medianX.toFixed(2)}, ${medianY.toFixed(2)})`,
    );

    // Get video dimensions
    const srcW = videoEl.videoWidth || PREVIEW_BASE_W;
    const srcH = videoEl.videoHeight || 480;
    const srcAspect = srcW / Math.max(1, srcH);

    // Calculate crop to center the person at 9:16 aspect
    const normRatio = TARGET_SHORTS_ASPECT / Math.max(0.01, srcAspect);
    const cropW = normRatio <= 1 ? normRatio : 1;
    const cropH = normRatio <= 1 ? 1 : 1 / normRatio;

    // Center the crop on the detected person with some padding
    const padW = cropW * 0.08;
    const padH = cropH * 0.08;
    clip.crop = normalizeCrop({
      x: medianX - cropW / 2,
      y: medianY - cropH / 2 - padH,
      w: cropW,
      h: cropH,
    });

    updateCropUI(clip);
    renderFrame();
    if (cropMode && selectedId === clipId) drawCropOverlay(clip);
    setDirty();

    setCropAIStatus(
      clipId,
      `✓ Person centered! (Detected in ${detectionResults.length}/${sampleCount} frames)`,
      "ok",
    );
    toast(`AI detected person in ${detectionResults.length} frames`);
  } catch (err) {
    console.error("AI pose detection error:", err);
    setCropAIStatus(clipId, `❌ Detection failed: ${err.message}`, "err");
    toast("AI detection failed: " + err.message);
  } finally {
    await waitForVideoSeek(videoEl, restoreTime);
    if (wasPlaying) play();
    if (btn) btn.disabled = false;
  }
}

function normalizeCrop(cr) {
  if (!cr) return { x: 0, y: 0, w: 1, h: 1 };
  let x = Number.isFinite(cr.x) ? cr.x : 0;
  let y = Number.isFinite(cr.y) ? cr.y : 0;
  let w = Number.isFinite(cr.w) ? cr.w : 1;
  let h = Number.isFinite(cr.h) ? cr.h : 1;

  w = Math.max(CROP_MIN, Math.min(1, w));
  h = Math.max(CROP_MIN, Math.min(1, h));
  x = Math.max(0, Math.min(1 - w, x));
  y = Math.max(0, Math.min(1 - h, y));

  return { x, y, w, h };
}

// ══════════════════════════════════
// CROP
// ══════════════════════════════════
function syncCropCanvas() {
  const pr = pcanvas.getBoundingClientRect();
  ccanvas.style.left = pcanvas.offsetLeft + "px";
  ccanvas.style.top = pcanvas.offsetTop + "px";
  ccanvas.style.width = pr.width + "px";
  ccanvas.style.height = pr.height + "px";
  ccanvas.width = Math.round(pr.width);
  ccanvas.height = Math.round(pr.height);
}

function drawCropOverlay(clip) {
  syncCropCanvas();
  const W = ccanvas.width,
    H = ccanvas.height;
  cctx.clearRect(0, 0, W, H);
  cctx.fillStyle = "rgba(0,0,0,.5)";
  cctx.fillRect(0, 0, W, H);
  const cr = normalizeCrop(clip.crop || { x: 0, y: 0, w: 1, h: 1 });
  clip.crop = cr;
  const rx = cr.x * W,
    ry = cr.y * H,
    rw = cr.w * W,
    rh = cr.h * H;
  cctx.clearRect(rx, ry, rw, rh);
  cctx.strokeStyle = "rgba(255,255,255,.95)";
  cctx.lineWidth = 1.4;
  cctx.strokeRect(rx, ry, rw, rh);
  // rule-of-thirds
  cctx.strokeStyle = "rgba(255,255,255,.24)";
  cctx.lineWidth = 0.8;
  for (let i = 1; i < 3; i++) {
    cctx.beginPath();
    cctx.moveTo(rx + (rw * i) / 3, ry);
    cctx.lineTo(rx + (rw * i) / 3, ry + rh);
    cctx.stroke();
    cctx.beginPath();
    cctx.moveTo(rx, ry + (rh * i) / 3);
    cctx.lineTo(rx + rw, ry + (rh * i) / 3);
    cctx.stroke();
  }
  // handles
  const HS = Math.max(8, Math.min(12, Math.round(Math.min(W, H) * 0.02)));
  cctx.fillStyle = "#fff";
  [
    [rx, ry],
    [rx + rw, ry],
    [rx, ry + rh],
    [rx + rw, ry + rh],
    [rx + rw / 2, ry],
    [rx + rw / 2, ry + rh],
    [rx, ry + rh / 2],
    [rx + rw, ry + rh / 2],
  ].forEach(([x, y]) => {
    cctx.beginPath();
    cctx.arc(x, y, HS / 2, 0, Math.PI * 2);
    cctx.fill();
  });
}

function enableCrop(clip) {
  clip.crop = normalizeCrop(clip.crop || { x: 0, y: 0, w: 1, h: 1 });
  cropMode = true;
  cropActive = true;
  ccanvas.classList.add("active");
  syncCropCanvas();
  drawCropOverlay(clip);
  updateCropUI(clip);
  document.getElementById("btn-crop").textContent = "✓ Crop";
  document.getElementById("btn-crop").classList.add("act");

  const rel = (ev) => {
    const r = ccanvas.getBoundingClientRect();
    return {
      rx: (ev.clientX - r.left) / r.width,
      ry: (ev.clientY - r.top) / r.height,
    };
  };
  const hitHandle = (rx, ry, cr) => {
    const mx = 12 / ccanvas.width,
      my = 12 / ccanvas.height;
    const pts = [
      { n: "tl", x: cr.x, y: cr.y },
      { n: "tr", x: cr.x + cr.w, y: cr.y },
      { n: "bl", x: cr.x, y: cr.y + cr.h },
      { n: "br", x: cr.x + cr.w, y: cr.y + cr.h },
      { n: "t", x: cr.x + cr.w / 2, y: cr.y },
      { n: "b", x: cr.x + cr.w / 2, y: cr.y + cr.h },
      { n: "l", x: cr.x, y: cr.y + cr.h / 2 },
      { n: "r", x: cr.x + cr.w, y: cr.y + cr.h / 2 },
    ];
    for (const p of pts)
      if (Math.abs(rx - p.x) < mx && Math.abs(ry - p.y) < my) return p.n;
    if (rx > cr.x && rx < cr.x + cr.w && ry > cr.y && ry < cr.y + cr.h)
      return "move";
    return "new";
  };

  const cursorForHandle = (handle) => {
    if (handle === "tl" || handle === "br") return "nwse-resize";
    if (handle === "tr" || handle === "bl") return "nesw-resize";
    if (handle === "l" || handle === "r") return "ew-resize";
    if (handle === "t" || handle === "b") return "ns-resize";
    if (handle === "move") return "move";
    return "crosshair";
  };

  let dragging = false;
  ccanvas.onpointermove = (ev) => {
    if (!cropMode || dragging) return;
    const { rx, ry } = rel(ev);
    const handle = hitHandle(rx, ry, clip.crop);
    ccanvas.style.cursor = cursorForHandle(handle);
  };

  ccanvas.onpointerdown = (ev) => {
    const { rx, ry } = rel(ev);
    const handle = hitHandle(rx, ry, clip.crop);
    const oc = { ...clip.crop },
      ox = rx,
      oy = ry;
    dragging = true;
    ccanvas.setPointerCapture(ev.pointerId);
    ccanvas.style.cursor = cursorForHandle(handle);

    const mv = (me) => {
      const { rx: cx, ry: cy } = rel(me);
      const dx = cx - ox,
        dy = cy - oy;
      let c = { ...oc };
      if (handle === "new") {
        c = {
          x: Math.min(ox, cx),
          y: Math.min(oy, cy),
          w: Math.abs(cx - ox),
          h: Math.abs(cy - oy),
        };
      } else if (handle === "move") {
        c.x = Math.max(0, Math.min(1 - c.w, oc.x + dx));
        c.y = Math.max(0, Math.min(1 - c.h, oc.y + dy));
      } else {
        if (handle.includes("r")) c.w = Math.max(CROP_MIN, oc.w + dx);
        if (handle.includes("l")) {
          c.x = Math.min(oc.x + oc.w - CROP_MIN, oc.x + dx);
          c.w = Math.max(CROP_MIN, oc.w - dx);
        }
        if (handle.includes("b")) c.h = Math.max(CROP_MIN, oc.h + dy);
        if (handle.includes("t")) {
          c.y = Math.min(oc.y + oc.h - CROP_MIN, oc.y + dy);
          c.h = Math.max(CROP_MIN, oc.h - dy);
        }
      }
      clip.crop = normalizeCrop(c);
      drawCropOverlay(clip);
      updateCropUI(clip);
      renderFrame();
    };
    const up = () => {
      ccanvas.removeEventListener("pointermove", mv);
      ccanvas.removeEventListener("pointerup", up);
      ccanvas.removeEventListener("pointercancel", up);
      dragging = false;
      ccanvas.style.cursor = "crosshair";
      setDirty();
    };
    ccanvas.addEventListener("pointermove", mv);
    ccanvas.addEventListener("pointerup", up);
    ccanvas.addEventListener("pointercancel", up);
    ev.preventDefault();
  };
}

function disableCrop() {
  cropMode = false;
  cropActive = false;
  ccanvas.classList.remove("active");
  ccanvas.onpointerdown = null;
  ccanvas.onpointermove = null;
  ccanvas.style.cursor = "crosshair";
  cctx.clearRect(0, 0, ccanvas.width, ccanvas.height);
  document.getElementById("btn-crop").textContent = "⬜ Crop";
  document.getElementById("btn-crop").classList.remove("act");
}

function updateCropUI(clip) {
  const cr = normalizeCrop(clip.crop || { x: 0, y: 0, w: 1, h: 1 });
  const s = (id, v) => {
    const e = document.getElementById(id);
    if (e) e.value = +(v * 100).toFixed(1);
  };
  ["x", "y", "w", "h"].forEach((axis) => {
    s("ci-" + axis, cr[axis]);
    s("cs-" + axis, cr[axis]);
    const val = document.getElementById("cv-" + axis);
    if (val) val.textContent = Math.round(cr[axis] * 100) + "%";
  });
}

function cropPreset(id, preset) {
  const clip = clips.find((c) => c.id === id);
  if (!clip) return;
  let c = { x: 0, y: 0, w: 1, h: 1 };
  if (preset === "square") c = { x: 0.15, y: 0.15, w: 0.7, h: 0.7 };
  if (preset === "wide") {
    const h = Math.min(1, 1 / (16 / 9));
    c = { x: 0, y: (1 - h) / 2, w: 1, h };
  }
  if (preset === "cinema") {
    const h = Math.min(1, 1 / 2.39);
    c = { x: 0, y: (1 - h) / 2, w: 1, h };
  }
  if (preset === "portrait") {
    const media = mediaItems.find((m) => m.id === clip.mediaId);
    const srcW =
      media?.type === "video"
        ? media.el?.videoWidth || PREVIEW_BASE_W
        : media?.type === "image"
          ? media.el?.naturalWidth || PREVIEW_BASE_W
          : PREVIEW_BASE_W;
    const srcH =
      media?.type === "video"
        ? media.el?.videoHeight || 480
        : media?.type === "image"
          ? media.el?.naturalHeight || 480
          : 480;
    const srcAspect = srcW / srcH;
    const normRatio = TARGET_SHORTS_ASPECT / Math.max(0.01, srcAspect);
    const w = normRatio <= 1 ? normRatio : 1;
    const h = normRatio <= 1 ? 1 : 1 / normRatio;
    c = { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
  }
  clip.crop = normalizeCrop(c);
  updateCropUI(clip);
  renderFrame();
  if (cropMode && selectedId === id) drawCropOverlay(clip);
  setDirty();
}

document.getElementById("btn-crop").onclick = () => {
  if (!selectedId) return;
  const clip = clips.find((c) => c.id === selectedId);
  if (!clip) return;
  cropMode ? disableCrop() : enableCrop(clip);
};

// ══════════════════════════════════
// SELECTION + PROPERTIES
// ══════════════════════════════════
function selectClip(id) {
  selectedId = id;
  document
    .querySelectorAll(".tl-clip")
    .forEach((el) => el.classList.remove("sel"));
  if (id) document.getElementById("clip-" + id)?.classList.add("sel");
  ["btn-split", "btn-delete", "btn-crop"].forEach(
    (bid) => (document.getElementById(bid).disabled = !id),
  );
  if (!id) disableCrop();
  renderProps();
}

function renderProps() {
  const body = document.getElementById("props-body");
  if (!selectedId) {
    body.innerHTML =
      '<div class="no-sel">Select a clip to edit properties</div>';
    return;
  }
  const clip = clips.find((c) => c.id === selectedId);
  if (!clip) return;
  const media = mediaItems.find((m) => m.id === clip.mediaId);
  const f = clip.filters || {};
  const cr = clip.crop;
  body.innerHTML = `
  <div class="ps">
    <div class="ps-t">Clip</div>
    <div class="pr"><span class="pl">Start (s)</span><input class="pv" type="number" value="${clip.start.toFixed(2)}" step="0.01" min="0" onchange="cset(${clip.id},'start',+this.value)"></div>
    <div class="pr"><span class="pl">Duration</span><input class="pv" type="number" value="${clip.duration.toFixed(2)}" step="0.01" min="0.1" onchange="cset(${clip.id},'duration',+this.value)"></div>
    <div class="pr"><span class="pl">Speed</span><input class="pv" type="number" value="${(clip.speed || 1).toFixed(1)}" step="0.1" min="0.1" max="4" onchange="cset(${clip.id},'speed',+this.value)"></div>
  </div>
  <div class="ps">
    <div class="ps-t">Video</div>
    ${sp(clip.id, "opacity", "Opacity", 0, 1, 0.01, clip.opacity ?? 1, "%", 100)}
    ${sp(clip.id, "brightness", "Brightness", 0, 200, 1, clip.brightness ?? 100, "%", 1)}
    ${sp(clip.id, "contrast", "Contrast", 0, 200, 1, clip.contrast ?? 100, "%", 1)}
    ${sp(clip.id, "saturation", "Saturation", 0, 200, 1, clip.saturation ?? 100, "%", 1)}
    ${sp(clip.id, "hue", "Hue", 0, 360, 1, clip.hue ?? 0, "°", 1)}
    ${sp(clip.id, "blur", "Blur", 0, 20, 0.5, clip.blur ?? 0, "px", 1)}
  </div>
  <div class="ps">
    <div class="ps-t">Audio</div>
    ${sp(clip.id, "volume", "Volume", 0, 1, 0.01, clip.volume ?? 1, "%", 100)}
  </div>
  <div class="ps">
    <div class="ps-t">Filters</div>
    <div>
      <span class="fchip${f.bw ? " on" : ""}" onclick="tfilt(${clip.id},'bw',this)">B&amp;W</span>
      <span class="fchip${f.sepia ? " on" : ""}" onclick="tfilt(${clip.id},'sepia',this)">Sepia</span>
      <span class="fchip${f.invert ? " on" : ""}" onclick="tfilt(${clip.id},'invert',this)">Invert</span>
      <span class="fchip${f.flip ? " on" : ""}" onclick="tfilt(${clip.id},'flip',this)">Flip H</span>
    </div>
    <div style="margin-top: 8px">
      <span class="fchip${f.removeBg ? " on" : ""}" style="border-color: var(--accent2); color: var(--accent2);" onclick="toggleBgRemoval(${clip.id},this)">✨ AI Remove BG</span>
    </div>
    <div style="margin-top: 8px">
      <span class="fchip" style="border-color: var(--accent); color: var(--accent);" onclick="autoCaption(${clip.id})">🎤 Auto Caption</span>
    </div>
    <div id="caption-status-${clip.id}" style="font-size:9px; color:var(--text3); margin-top:4px;"></div>
  </div>
  <div class="ps">
    <div class="ps-t">Crop <span style="color:var(--accent2);font-weight:500;font-size:8px">smart controls</span></div>
    <div class="crop-panel">
      <button class="crop-mode-btn${cropMode && selectedId === clip.id ? " on" : ""}" onclick="if(selectedId===${clip.id}){cropMode?disableCrop():enableCrop(clips.find(c=>c.id===${clip.id}))}">
        ${cropMode && selectedId === clip.id ? "Exit Crop Mode" : "Enter Crop Mode"}
      </button>
      <div class="crop-tip">Drag the frame in preview to move or resize.</div>
      <button id="crop-ai-btn-${clip.id}" class="crop-ai-btn" onclick="autoCenterPersonInFrame(${clip.id})" ${media?.type === "audio" ? "disabled" : ""}>AI Center Person</button>
      <div id="crop-ai-status-${clip.id}" class="crop-ai-status">Keep person centered in frame using pose detection</div>
      <div class="crop-presets">
        <button class="crop-preset" onclick="cropPreset(${clip.id},'fit')">Fit</button>
        <button class="crop-preset" onclick="cropPreset(${clip.id},'square')">1:1</button>
        <button class="crop-preset" onclick="cropPreset(${clip.id},'wide')">16:9</button>
        <button class="crop-preset" onclick="cropPreset(${clip.id},'portrait')">9:16</button>
      </div>
      <div class="crop-presets" style="margin-top:6px">
        <button class="crop-preset" onclick="cropPreset(${clip.id},'cinema')">2.39:1</button>
      </div>
    </div>
    <div class="crop-grid modern">
      <div class="cig">
        <label>X <span id="cv-x">${Math.round((cr?.x ?? 0) * 100)}%</span></label>
        <input id="cs-x" type="range" min="0" max="100" step=".5" value="${+((cr?.x || 0) * 100).toFixed(1)}" oninput="cropIn(${clip.id},'x',+this.value/100)">
        <input id="ci-x" type="number" min="0" max="95" step=".5" value="${+((cr?.x || 0) * 100).toFixed(1)}" onchange="cropIn(${clip.id},'x',+this.value/100)">
      </div>
      <div class="cig">
        <label>Y <span id="cv-y">${Math.round((cr?.y ?? 0) * 100)}%</span></label>
        <input id="cs-y" type="range" min="0" max="100" step=".5" value="${+((cr?.y || 0) * 100).toFixed(1)}" oninput="cropIn(${clip.id},'y',+this.value/100)">
        <input id="ci-y" type="number" min="0" max="95" step=".5" value="${+((cr?.y || 0) * 100).toFixed(1)}" onchange="cropIn(${clip.id},'y',+this.value/100)">
      </div>
      <div class="cig">
        <label>Width <span id="cv-w">${Math.round((cr?.w ?? 1) * 100)}%</span></label>
        <input id="cs-w" type="range" min="5" max="100" step=".5" value="${+((cr?.w || 1) * 100).toFixed(1)}" oninput="cropIn(${clip.id},'w',+this.value/100)">
        <input id="ci-w" type="number" min="5" max="100" step=".5" value="${+((cr?.w || 1) * 100).toFixed(1)}" onchange="cropIn(${clip.id},'w',+this.value/100)">
      </div>
      <div class="cig">
        <label>Height <span id="cv-h">${Math.round((cr?.h ?? 1) * 100)}%</span></label>
        <input id="cs-h" type="range" min="5" max="100" step=".5" value="${+((cr?.h || 1) * 100).toFixed(1)}" oninput="cropIn(${clip.id},'h',+this.value/100)">
        <input id="ci-h" type="number" min="5" max="100" step=".5" value="${+((cr?.h || 1) * 100).toFixed(1)}" onchange="cropIn(${clip.id},'h',+this.value/100)">
      </div>
    </div>
    <div style="display:flex;gap:6px">
      <button class="tb-btn" style="flex:1;justify-content:center;font-size:10px" onclick="cropIn(${clip.id},'reset')">↺ Reset</button>
    </div>
  </div>`;
}

function sp(id, key, label, min, max, step, val, unit, mult) {
  const disp = Math.round(val * mult);
  return `<div class="srow"><div class="srow-hdr"><span class="srow-lbl">${label}</span><span class="srow-val" id="sv-${id}-${key}">${disp}${unit}</span></div>
    <input type="range" class="sr" min="${min}" max="${max}" step="${step}" value="${val}"
    oninput="cset(${id},'${key}',+this.value);document.getElementById('sv-${id}-${key}').textContent=Math.round(this.value*${mult})+'${unit}'"></div>`;
}

function cset(id, key, val) {
  const clip = clips.find((c) => c.id === id);
  if (!clip) return;
  clip[key] = val;
  updateClipPos(clip);
  recalc();
  renderFrame();
  if (key === "volume") {
    const m = mediaItems.find((x) => x.id === clip.mediaId);
    if (m && m.el && m.el.volume !== undefined)
      m.el.volume = Math.min(1, Math.max(0, val * masterVol));
  }
  if (key === "speed") {
    const m = mediaItems.find((x) => x.id === clip.mediaId);
    if (m && m.el && m.el.playbackRate !== undefined) m.el.playbackRate = val;
  }
  setDirty();
}

function tfilt(id, fname, chip) {
  const clip = clips.find((c) => c.id === id);
  if (!clip) return;
  if (!clip.filters) clip.filters = {};
  clip.filters[fname] = !clip.filters[fname];
  chip.classList.toggle("on", clip.filters[fname]);
  renderFrame();
  setDirty();
}

function cropIn(id, axis, val) {
  const clip = clips.find((c) => c.id === id);
  if (!clip) return;
  if (axis === "reset") {
    clip.crop = null;
    renderProps();
    renderFrame();
    if (cropMode) disableCrop();
    setDirty();
    return;
  }
  const c = normalizeCrop(clip.crop || { x: 0, y: 0, w: 1, h: 1 });
  if (["x", "y", "w", "h"].includes(axis))
    c[axis] = Math.max(0, Math.min(1, val));
  clip.crop = normalizeCrop(c);
  updateCropUI(clip);
  renderFrame();
  if (cropMode) {
    const c = clips.find((x) => x.id === selectedId);
    if (c) drawCropOverlay(c);
  }
  setDirty();
}

// ══════════════════════════════════
// TOOLS
// ══════════════════════════════════
function setTool(t) {
  activeTool = t;
  document
    .querySelectorAll('.tl-btn[id^="tool-"]')
    .forEach((b) => b.classList.remove("act"));
  document.getElementById("tool-" + t)?.classList.add("act");
  document.getElementById("sb-tool").textContent =
    t.charAt(0).toUpperCase() + t.slice(1);
  document.body.classList.toggle("razor-mode", t === "razor");
  document.getElementById("tl-hint").textContent =
    t === "razor"
      ? "Razor mode: click clip to split at pointer"
      : "Drag media from bin → tracks";
  tlTracks.style.cursor = t === "razor" ? "crosshair" : "default";
}

// ══════════════════════════════════
// RAZOR / SPLIT / DELETE
// ══════════════════════════════════
function razorAtRow(tid, x) {
  const t = x2t(x);
  const c = clips.find(
    (c) => c.trackId === tid && t > c.start && t < c.start + c.duration,
  );
  if (c) razorClip(c.id, t);
}
function razorClip(cid, at) {
  const clip = clips.find((c) => c.id === cid);
  if (!clip || at <= clip.start || at >= clip.start + clip.duration) return;
  const leftDur = at - clip.start;
  const rightDur = clip.start + clip.duration - at;
  const nc = {
    ...clip,
    id: uid(),
    start: at,
    duration: rightDur,
    trimIn: (clip.trimIn || 0) + leftDur,
    filters: { ...clip.filters },
    crop: clip.crop ? { ...clip.crop } : null,
  };
  clip.duration = leftDur;
  clips.push(nc);
  updateClipPos(clip);
  document.getElementById("cdur-" + clip.id).textContent = fmt(clip.duration);
  renderClip(nc);
  document.getElementById("cdur-" + nc.id).textContent = fmt(nc.duration);
  selectClip(nc.id);
  recalc();
  renderFrame();
  setDirty();
  toast("Split");
}
function splitClip() {
  if (!selectedId) return;
  razorClip(selectedId, playheadTime);
}
function deleteSelected() {
  if (!selectedId) return;
  document.getElementById("clip-" + selectedId)?.remove();
  clips = clips.filter((c) => c.id !== selectedId);
  selectClip(null);
  recalc();
  updateStatus();
  setDirty();
  toast("Deleted");
}

// ══════════════════════════════════
// ZOOM
// ══════════════════════════════════
function zoomTl(dir) {
  const lvs = [0.15, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];
  const i = lvs.indexOf(zoomLevel);
  zoomLevel = lvs[Math.max(0, Math.min(lvs.length - 1, i + dir))];
  document.getElementById("zoom-val").textContent = zoomLevel + "×";
  clips.forEach((c) => updateClipPos(c));
  recalc();
}

// ══════════════════════════════════
// MASTER VOLUME
// ══════════════════════════════════
document.getElementById("vol-slider").oninput = function () {
  masterVol = +this.value;
  document.getElementById("vol-pct").textContent =
    Math.round(masterVol * 100) + "%";
  if (isPlaying) {
    clips.forEach((clip) => {
      const m = mediaItems.find((x) => x.id === clip.mediaId);
      if (m && m.el && m.el.volume !== undefined)
        m.el.volume = Math.min(1, Math.max(0, (clip.volume || 1) * masterVol));
    });
  }
  setDirty();
};

// ══════════════════════════════════
// STATUS
// ══════════════════════════════════
function updateStatus() {
  document.getElementById("sb-clips").textContent = clips.length;
  document.getElementById("sb-tracks").textContent = tracks.length;
}

// ══════════════════════════════════
// KEYBOARD
// ══════════════════════════════════
document.addEventListener("keydown", (e) => {
  if (["INPUT", "TEXTAREA"].includes(e.target.tagName)) return;
  if (e.key === " ") {
    e.preventDefault();
    togglePlay();
  }
  if (e.key === "v" || e.key === "V") setTool("select");
  if (e.key === "c" || e.key === "C") setTool("razor");
  if (e.key === "s" || e.key === "S") {
    e.preventDefault();
    splitClip();
  }
  if (e.key === "Delete" || e.key === "Backspace") deleteSelected();
  if (e.key === "ArrowLeft") seekTo(playheadTime - 1 / 30);
  if (e.key === "ArrowRight") seekTo(playheadTime + 1 / 30);
  if (e.key === "Home") seekStart();
  if (e.key === "End") seekEnd();
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    saveProject();
  }
  if (e.key === "Escape") {
    disableCrop();
    selectClip(null);
  }
});

// ══════════════════════════════════
// EXPORT
// ══════════════════════════════════
function openExportModal() {
  if (!clips.length) {
    toast("No clips");
    return;
  }
  document.getElementById("export-modal").classList.add("open");
  document.getElementById("exp-status").textContent = "";
  document.getElementById("exp-prog").style.display = "none";
  document.getElementById("exp-bar").style.width = "0";
  document.getElementById("btn-do-exp").disabled = false;
}
function closeExportModal() {
  document.getElementById("export-modal").classList.remove("open");
}

async function doExport() {
  const fmt_ = document.getElementById("exp-fmt").value;
  const fitMode = document.getElementById("exp-fit")?.value || "cover";
  const [EW, EH] = document
    .getElementById("exp-res")
    .value.split("x")
    .map(Number);
  const FPS = 24,
    frames = Math.ceil(totalDur * FPS);
  const oc = document.createElement("canvas");
  oc.width = EW;
  oc.height = EH;
  const ctx = oc.getContext("2d");
  document.getElementById("exp-prog").style.display = "block";
  document.getElementById("btn-do-exp").disabled = true;
  const setSt = (t) => (document.getElementById("exp-status").textContent = t);
  const setPr = (p) =>
    (document.getElementById("exp-bar").style.width = p + "%");
  const fitFrame = (srcW, srcH, dstW, dstH, mode = "cover") => {
    const srcA = srcW / Math.max(1, srcH);
    const dstA = dstW / Math.max(1, dstH);
    let sx = 0,
      sy = 0,
      sw = srcW,
      sh = srcH;
    let dx = 0,
      dy = 0,
      dw = dstW,
      dh = dstH;

    if (mode === "cover") {
      if (srcA > dstA) {
        sw = sh * dstA;
        sx = (srcW - sw) / 2;
      } else {
        sh = sw / dstA;
        sy = (srcH - sh) / 2;
      }
    } else {
      if (srcA > dstA) {
        dh = dstW / srcA;
        dy = (dstH - dh) / 2;
      } else {
        dw = dstH * srcA;
        dx = (dstW - dw) / 2;
      }
    }

    return {
      sx,
      sy,
      sw,
      sh,
      dx,
      dy,
      dw,
      dh,
    };
  };

  const pickRecorderConfig = (fmt) => {
    const profiles = {
      webm: {
        label: "WebM",
        fallbackExt: "webm",
        mimes: ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"],
      },
      mp4: {
        label: "MP4",
        fallbackExt: "mp4",
        mimes: [
          "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
          "video/mp4;codecs=avc1",
          "video/mp4",
        ],
      },
      mov: {
        label: "MOV",
        fallbackExt: "mov",
        mimes: [
          "video/quicktime;codecs=h264",
          "video/quicktime",
          "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
          "video/mp4",
        ],
      },
    };
    const p = profiles[fmt];
    if (!p || !window.MediaRecorder) return null;
    for (const mime of p.mimes) {
      if (MediaRecorder.isTypeSupported(mime)) {
        const ext = mime.startsWith("video/quicktime")
          ? "mov"
          : mime.startsWith("video/mp4")
            ? "mp4"
            : p.fallbackExt;
        return { mime, ext, label: p.label };
      }
    }
    return null;
  };

  const rf = async (t) => {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, EW, EH);
    for (let ti = tracks.length - 1; ti >= 0; ti--) {
      clips
        .filter(
          (c) =>
            c.trackId === tracks[ti].id &&
            t >= c.start &&
            t < c.start + c.duration,
        )
        .forEach((clip) => {
          const m = mediaItems.find((x) => x.id === clip.mediaId);
          if (!m || !m.el) return;
          try {
            ctx.save();
            ctx.globalAlpha = clip.opacity ?? 1;
            const filt = buildFilter(clip);
            if (filt !== "none") ctx.filter = filt;
            const sw2 =
              m.type === "video"
                ? m.el.videoWidth || EW
                : m.el.naturalWidth || EW;
            const sh2 =
              m.type === "video"
                ? m.el.videoHeight || EH
                : m.el.naturalHeight || EH;
            let sx = 0,
              sy = 0,
              sw = sw2,
              sh = sh2;
            if (clip.crop) {
              sx = clip.crop.x * sw2;
              sy = clip.crop.y * sh2;
              sw = clip.crop.w * sw2;
              sh = clip.crop.h * sh2;
            }
            if (m.type !== "audio" && sw > 0 && sh > 0) {
              const box = fitFrame(sw, sh, EW, EH, fitMode);
              const dsx = sx + box.sx;
              const dsy = sy + box.sy;
              
              const doDraw = (source) => {
                if (clip.filters?.flip) {
                  ctx.drawImage(
                    source,
                    dsx,
                    dsy,
                    box.sw,
                    box.sh,
                    box.dx + box.dw,
                    box.dy,
                    -box.dw,
                    box.dh,
                  );
                } else {
                  ctx.drawImage(
                    source,
                    dsx,
                    dsy,
                    box.sw,
                    box.sh,
                    box.dx,
                    box.dy,
                    box.dw,
                    box.dh,
                  );
                }
              };

              if (clip.filters?.removeBg) {
                const cacheKey = `${clip.id}_${(m.el.currentTime || 0).toFixed(1)}`;
                const maskedImg = window.bgMaskCache ? window.bgMaskCache.get(cacheKey) : null;
                if (maskedImg && maskedImg !== 'processing') {
                  doDraw(maskedImg);
                } else {
                  doDraw(m.el);
                  if (window.getBgMaskAsync) window.getBgMaskAsync(clip, m, m.el.currentTime || 0);
                }
              } else {
                doDraw(m.el);
              }
            }
            ctx.restore();
          } catch (e) {}
        });
    }
  };

  if (fmt_ !== "png") {
    const recCfg = pickRecorderConfig(fmt_);
    if (!recCfg) {
      setSt(
        `${fmt_.toUpperCase()} export not supported in this browser. Try WebM or PNG.`,
      );
      document.getElementById("btn-do-exp").disabled = false;
      toast("Selected format not supported in this browser");
      return;
    }

    setSt(`Recording ${recCfg.label}…`);
    const stream = oc.captureStream(FPS);
    const hiBps = Math.max(8_000_000, Math.round((EW * EH * FPS) / 3));
    let rec;
    try {
      rec = new MediaRecorder(stream, {
        mimeType: recCfg.mime,
        videoBitsPerSecond: hiBps,
      });
    } catch {
      rec = new MediaRecorder(stream, { mimeType: recCfg.mime });
    }
    const chunks = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    rec.onstop = () => {
      downloadBlob(
        new Blob(chunks, { type: recCfg.mime }),
        `cutframe.${recCfg.ext}`,
      );
      setPr(100);
      setSt("✓ Done");
      document.getElementById("btn-do-exp").disabled = false;
      setTimeout(closeExportModal, 1800);
      toast("Exported!");
    };
    rec.start();
    for (let f = 0; f < frames; f++) {
      const t = f / FPS;
      for (const clip of clips) {
        const m = mediaItems.find((x) => x.id === clip.mediaId);
        if (
          m &&
          m.el &&
          m.type === "video" &&
          t >= clip.start &&
          t < clip.start + clip.duration
        )
          m.el.currentTime = Math.max(0, t - clip.start);
      }
      await new Promise((r) => setTimeout(r, 0));
      await rf(t);
      setPr(Math.round((f / frames) * 90));
      setSt(`Frame ${f + 1}/${frames}`);
      await new Promise((r) => setTimeout(r, 1000 / FPS));
    }
    rec.stop();
    setSt("Encoding…");
  } else {
    setSt("Generating PNG frames…");
    for (let f = 0; f < Math.min(frames, 48); f++) {
      const t = f / FPS;
      for (const clip of clips) {
        const m = mediaItems.find((x) => x.id === clip.mediaId);
        if (m && m.el && m.type === "video")
          m.el.currentTime = Math.max(0, t - clip.start);
      }
      await new Promise((r) => setTimeout(r, 0));
      await rf(t);
      const a = document.createElement("a");
      a.href = oc.toDataURL("image/png");
      a.download = `frame_${String(f).padStart(4, "0")}.png`;
      a.click();
      await new Promise((r) => setTimeout(r, 80));
      setPr(Math.round((f / Math.min(frames, 48)) * 100));
    }
    setSt("✓ Frames saved");
    document.getElementById("btn-do-exp").disabled = false;
    setTimeout(closeExportModal, 1500);
  }
}

function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ══════════════════════════════════
// RESIZE
// ══════════════════════════════════
window.addEventListener("resize", () => {
  updatePreviewSize(true);
  resizeTl();
  renderFrame();
});

// ══════════════════════════════════
// INIT
// ══════════════════════════════════
(async () => {
  await openDB();
  const loaded = await loadProject();
  if (!loaded) {
    addTrack();
    addTrack();
  }
  if (!tracks.length) {
    addTrack();
    addTrack();
  }
  updatePreviewSize(true);
  recalc();
  drawRuler();
  setTool("select");
  updateStatus();
  updatePoseStatusUI();
  renderFrame();
  
  if (!localStorage.getItem("cf_onboarding_done")) {
    document.getElementById("onboarding-modal").classList.add("open");
  } else {
    try {
      ensurePoseDetector().catch(() => {});
    } catch (e) {}
  }
  
  toast("CutFrame ready — import media to begin", 3000);
})();

// ══════════════════════════════════
// ONBOARDING & DOWNLOAD MANAGER
// ══════════════════════════════════
window.skipOnboarding = function() {
  document.getElementById("onboarding-modal").classList.remove("open");
  localStorage.setItem("cf_onboarding_done", "true");
}

function showDlProgress(label) {
  document.getElementById("dl-progress").style.display = "flex";
  document.getElementById("dl-label").textContent = label;
  document.getElementById("dl-bar").style.width = "0%";
}
function updateDlProgress(pct) {
  document.getElementById("dl-bar").style.width = pct + "%";
}
function hideDlProgress() {
  document.getElementById("dl-progress").style.display = "none";
}

window.startOnboardingDownloads = async function() {
  const dlBg = document.getElementById("dl-bg").checked;
  const dlPose = document.getElementById("dl-pose").checked;
  const dlTts = document.getElementById("dl-tts").checked;
  const dlWhisper = document.getElementById("dl-whisper").checked;

  document.getElementById("onboarding-modal").classList.remove("open");
  localStorage.setItem("cf_onboarding_done", "true");

  if (dlPose) ensurePoseDetector().catch(() => {});

  const queue = [];
  if (dlBg) queue.push({ label: "BG Remover", fn: downloadBgModel });
  if (dlTts) queue.push({ label: "Voice Engine", fn: downloadTTSModel });
  if (dlWhisper) queue.push({ label: "Captioning", fn: downloadWhisperModel });

  for (const job of queue) {
    showDlProgress(`Downloading ${job.label}…`);
    await job.fn();
  }
  hideDlProgress();
  if (queue.length) toast("All AI models ready!");
}

async function downloadBgModel() {
  await initTransformers();
  bgModel = await tjsPipeline('image-segmentation', 'Xenova/modnet', {
    quantized: true,
    progress_callback: (p) => { if (p.status === 'progress') updateDlProgress(Math.round(p.progress)); }
  });
}

async function downloadTTSModel() {
  await initTransformers();
  ttsSynthesizer = await tjsPipeline('text-to-speech', 'Xenova/speecht5_tts', {
    quantized: true,
    progress_callback: (p) => { if (p.status === 'progress') updateDlProgress(Math.round(p.progress)); }
  });
  const res = await fetch('https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/speaker_embeddings.bin');
  const buffer = await res.arrayBuffer();
  speakerEmbeds = new Float32Array(buffer);
}

async function downloadWhisperModel() {
  await initTransformers();
  whisperModel = await tjsPipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
    quantized: true,
    chunk_length_s: 30,
    stride_length_s: 5,
    progress_callback: (p) => { if (p.status === 'progress') updateDlProgress(Math.round(p.progress)); }
  });
}

// ══════════════════════════════════
// AI OFFLINE FEATURES (Transformers.js)
// ══════════════════════════════════
let tjsPipeline, tjsEnv;
async function initTransformers() {
  if (tjsPipeline) return;
  const tjs = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.1');
  tjsPipeline = tjs.pipeline;
  tjsEnv = tjs.env;
  tjsEnv.allowLocalModels = false;
}

// ── AI Voiceover (Hybrid: Preview + Render) ──
let synthVoices = [];
let ttsSynthesizer = null;
let speakerEmbeds = null;
const ttsAudioCache = new Map();
window.__activeTTS = [];

window.openTTSModal = function() {
  const modal = document.getElementById("tts-modal");
  const voiceSelect = document.getElementById("tts-voice");
  const populateVoices = () => {
    synthVoices = speechSynthesis.getVoices();
    if (synthVoices.length > 0) {
      voiceSelect.innerHTML = synthVoices.map((v, i) =>
        `<option value="${i}">${v.name} (${v.lang})</option>`
      ).join('');
    }
  };
  populateVoices();
  if (speechSynthesis.onvoiceschanged !== undefined) {
    speechSynthesis.onvoiceschanged = populateVoices;
  }
  document.getElementById("tts-status").textContent = ttsSynthesizer
    ? "✓ AI Voice Engine loaded — will render exportable audio"
    : "⚠ AI Voice Engine not loaded — live preview only (not exportable)";
  modal.classList.add("open");
}

window.closeTTSModal = function() {
  document.getElementById("tts-modal").classList.remove("open");
  speechSynthesis.cancel();
  window.__activeTTS = [];
}

window.previewTTS = function() {
  const text = document.getElementById("tts-text").value.trim();
  const voiceIdx = document.getElementById("tts-voice").value;
  if (!text) return;
  speechSynthesis.cancel();
  window.__activeTTS = [];
  const u = new SpeechSynthesisUtterance(text);
  if (synthVoices[voiceIdx]) u.voice = synthVoices[voiceIdx];
  u.onend = () => { window.__activeTTS = []; };
  window.__activeTTS.push(u);
  speechSynthesis.speak(u);
}

window.generateTTS = async function() {
  const text = document.getElementById("tts-text").value.trim();
  const voiceIdx = parseInt(document.getElementById("tts-voice").value || "0");
  if (!text) return;
  speechSynthesis.cancel();
  window.__activeTTS = [];

  // 1. Create temp TTS media item for instant timeline use
  const id = uid();
  const item = {
    id, name: "TTS: " + text.substring(0, 20) + (text.length > 20 ? "…" : ""),
    type: "tts", duration: Math.max(1, text.length * 0.07),
    text, voiceIdx, el: null,
    _rendered: false, _rendering: false,
  };
  mediaItems.push(item);
  renderMI(item);
  closeTTSModal();
  document.getElementById("tts-text").value = "";
  toast("TTS clip added — " + (ttsSynthesizer ? "rendering audio…" : "live preview mode"));

  // 2. If AI Voice Engine is loaded, background-render real audio
  if (ttsSynthesizer) {
    renderTTSAudio(item);
  }
}

async function renderTTSAudio(item) {
  // Check cache first
  const cacheKey = item.text;
  if (ttsAudioCache.has(cacheKey)) {
    swapTTSToAudio(item, ttsAudioCache.get(cacheKey));
    return;
  }

  item._rendering = true;
  renderMI(item);

  try {
    showDlProgress("Rendering voice…");
    const output = await ttsSynthesizer(item.text, { speaker_embeddings: speakerEmbeds });
    const wavBlob = encodeWAV(output.audio, output.sampling_rate);
    ttsAudioCache.set(cacheKey, wavBlob);
    hideDlProgress();
    swapTTSToAudio(item, wavBlob);
  } catch (err) {
    hideDlProgress();
    item._rendering = false;
    renderMI(item);
    toast("TTS render failed: " + err.message);
  }
}

function swapTTSToAudio(item, wavBlob) {
  const url = URL.createObjectURL(wavBlob);
  const audio = new Audio(url);
  audio.preload = "auto";
  audio.addEventListener("loadedmetadata", () => {
    item.el = audio;
    item.url = url;
    item.duration = audio.duration;
    item._rendered = true;
    item._rendering = false;
    // Update any clips that reference this media to match new duration
    clips.filter(c => c.mediaId === item.id).forEach(c => {
      c.duration = audio.duration;
    });
    renderMI(item);
    recalc();
    renderFrame();
    toast("✓ Voice rendered: " + item.name);
  });
  audio.load();
}

function encodeWAV(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const ws = (v, o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  ws(view, 8, 'WAVE');
  ws(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ws(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

// ── AI Background Removal ──
let bgModel = null;
const bgMaskCache = new Map();

window.toggleBgRemoval = function(id, chip) {
  const clip = clips.find(c => c.id === id);
  if (!clip) return;
  if (!clip.filters) clip.filters = {};
  clip.filters.removeBg = !clip.filters.removeBg;
  chip.classList.toggle("on", clip.filters.removeBg);

  if (clip.filters.removeBg && !bgModel) {
    showDlProgress("Loading BG Model…");
    initTransformers().then(async () => {
      bgModel = await tjsPipeline('image-segmentation', 'Xenova/modnet', {
        quantized: true,
        progress_callback: (p) => { if (p.status === 'progress') updateDlProgress(Math.round(p.progress)); }
      });
      hideDlProgress();
      renderFrame();
    });
  } else {
    renderFrame();
  }
  setDirty();
}

window.getBgMaskAsync = async function(clip, m, time) {
  if (!bgModel) return null;
  const cacheKey = `${clip.id}_${time.toFixed(1)}`;
  if (bgMaskCache.has(cacheKey)) {
    if (bgMaskCache.get(cacheKey) === 'processing') return null;
    return bgMaskCache.get(cacheKey);
  }
  bgMaskCache.set(cacheKey, 'processing');
  const oc = document.createElement("canvas");
  const w = m.el.videoWidth || m.el.naturalWidth || PREVIEW_BASE_W;
  const h = m.el.videoHeight || m.el.naturalHeight || 480;
  oc.width = w; oc.height = h;
  const octx = oc.getContext("2d", { willReadFrequently: true });
  octx.drawImage(m.el, 0, 0, w, h);
  const dataUrl = oc.toDataURL("image/jpeg", 0.6);
  try {
    const result = await bgModel(dataUrl);
    const maskRaw = Array.isArray(result) ? result[0].mask : result;
    if (maskRaw && maskRaw.data && maskRaw.channels === 1) {
      const imgData = octx.getImageData(0, 0, w, h);
      for (let i = 0; i < maskRaw.data.length; i++) imgData.data[i * 4 + 3] = maskRaw.data[i];
      octx.putImageData(imgData, 0, 0);
      let maskedImg = new Image();
      maskedImg.src = oc.toDataURL("image/png");
      await new Promise(r => maskedImg.onload = r);
      bgMaskCache.set(cacheKey, maskedImg);
    } else {
      let maskImg = new Image();
      maskImg.src = maskRaw.toDataURL ? maskRaw.toDataURL() : maskRaw;
      await new Promise(r => maskImg.onload = r);
      bgMaskCache.set(cacheKey, maskImg);
    }
    renderFrame();
  } catch (e) {
    console.error("AI BG Removal failed:", e);
    bgMaskCache.delete(cacheKey);
  }
}

// ── AI Auto Captioning (Whisper) ──
let whisperModel = null;
window.captionsVisible = true;

window.toggleCaptions = function() {
  window.captionsVisible = !window.captionsVisible;
  const btn = document.getElementById("btn-cc");
  if (btn) btn.classList.toggle("on", window.captionsVisible);
  renderFrame();
}

window.autoCaption = async function(clipId) {
  const clip = clips.find(c => c.id === clipId);
  if (!clip) return;
  const m = mediaItems.find(x => x.id === clip.mediaId);
  if (!m) return;

  // Need audio or video with audio
  if (m.type !== "video" && m.type !== "audio") {
    toast("Select a video or audio clip to caption");
    return;
  }

  const statusEl = document.getElementById("caption-status-" + clipId);

  // Load whisper if needed
  if (!whisperModel) {
    if (statusEl) statusEl.textContent = "Downloading Whisper model (~75MB)…";
    showDlProgress("Loading Whisper…");
    try {
      await downloadWhisperModel();
    } catch (e) {
      hideDlProgress();
      if (statusEl) statusEl.textContent = "Failed to load Whisper: " + e.message;
      return;
    }
    hideDlProgress();
  }

  if (statusEl) statusEl.textContent = "Extracting audio…";

  try {
    // Extract audio from media element to a float32 buffer
    const audioData = await extractAudioBuffer(m.el, clip);

    if (statusEl) statusEl.textContent = "Transcribing with Whisper…";

    const result = await whisperModel(audioData, {
      return_timestamps: 'word',
      chunk_length_s: 30,
      stride_length_s: 5,
    });

    // Store captions on the clip
    if (!clip.captions) clip.captions = [];
    clip.captions = [];

    if (result.chunks && result.chunks.length > 0) {
      // Group words into ~5-word subtitle lines
      let words = result.chunks;
      for (let i = 0; i < words.length; i += 5) {
        const group = words.slice(i, i + 5);
        const start = group[0].timestamp[0] ?? 0;
        const end = group[group.length - 1].timestamp[1] ?? (start + 2);
        const text = group.map(w => w.text).join('').trim();
        if (text) clip.captions.push({ start, end, text });
      }
    } else if (result.text) {
      // Fallback: single caption for the whole clip
      clip.captions.push({ start: 0, end: clip.duration, text: result.text.trim() });
    }

    if (statusEl) statusEl.textContent = `✓ ${clip.captions.length} caption(s) generated`;
    setDirty();
    renderFrame();
  } catch (e) {
    console.error("Captioning failed:", e);
    if (statusEl) statusEl.textContent = "Caption error: " + e.message;
  }
}

async function extractAudioBuffer(el, clip) {
  // Use OfflineAudioContext to decode the media's audio
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  let audioBuffer;

  if (el.src || el.currentSrc) {
    const response = await fetch(el.src || el.currentSrc);
    const arrayBuf = await response.arrayBuffer();
    audioBuffer = await audioCtx.decodeAudioData(arrayBuf);
  } else {
    throw new Error("No audio source available");
  }

  // Get mono float32 at 16kHz for Whisper
  const offCtx = new OfflineAudioContext(1, audioBuffer.duration * 16000, 16000);
  const source = offCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offCtx.destination);
  source.start();
  const rendered = await offCtx.startRendering();
  await audioCtx.close();
  return rendered.getChannelData(0);
}

function drawCaptionOverlay(ctx, W, H) {
  // Find all clips at current playhead that have captions
  for (const clip of clips) {
    if (playheadTime < clip.start || playheadTime >= clip.start + clip.duration) continue;
    if (!clip.captions || !clip.captions.length) continue;

    const localTime = playheadTime - clip.start;
    const activeCap = clip.captions.find(c => localTime >= c.start && localTime < c.end);
    if (!activeCap) continue;

    // Draw caption box
    const fontSize = Math.max(14, Math.round(W * 0.028));
    ctx.save();
    ctx.font = `bold ${fontSize}px 'Syne', 'DM Mono', sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";

    const text = activeCap.text;
    const metrics = ctx.measureText(text);
    const pad = 8;
    const boxW = metrics.width + pad * 2;
    const boxH = fontSize + pad * 2;
    const x = W / 2;
    const y = H - 24;

    // Semi-transparent dark background
    ctx.fillStyle = "rgba(0,0,0,0.75)";
    const rx = x - boxW / 2;
    const ry = y - boxH;
    ctx.beginPath();
    ctx.roundRect(rx, ry, boxW, boxH, 6);
    ctx.fill();

    // White text
    ctx.fillStyle = "#fff";
    ctx.fillText(text, x, y - pad);
    ctx.restore();
  }
}

