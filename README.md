<p align="center">
  <img src="https://img.shields.io/badge/CutFrame-Video%20Editor-6c63ff?style=for-the-badge&labelColor=09090b" alt="CutFrame Badge" />
  <img src="https://img.shields.io/badge/100%25-Offline--First-3ddc84?style=for-the-badge&labelColor=09090b" alt="Offline First" />
  <img src="https://img.shields.io/badge/Zero-Dependencies-ffb84d?style=for-the-badge&labelColor=09090b" alt="Zero Dependencies" />
</p>

# ✂️ CutFrame — Browser-Native AI Video Editor

**CutFrame** is a professional-grade, non-linear video editor that runs entirely in your browser. No installs, no servers, no uploads — just open the page and start editing. It combines a full NLE workflow with on-device AI features powered by WebAssembly and Transformers.js, so everything stays private and works offline.

---

## 🎯 What Is This?

CutFrame is a single-page web application that gives you a real video editing timeline — multi-track, drag-and-drop, split/razor, crop, filters, export — all rendered live on a `<canvas>`. On top of the editing core, it ships four offline AI features:

| Feature | What It Does | Model |
|---|---|---|
| **AI Pose Tracking** | Detects a person's body and auto-centers the crop for 9:16 Reels/Shorts | MediaPipe Pose |
| **AI Background Removal** | Removes the background from video frames in real-time | Xenova/modnet (Transformers.js) |
| **AI Voiceover (TTS)** | Generates speech from text; instant native preview + background neural render | Xenova/speecht5_tts (Transformers.js) |
| **AI Auto-Captions** | Transcribes speech to timed subtitles using Whisper | Xenova/whisper-tiny.en (Transformers.js) |

All models are downloaded once and cached locally in IndexedDB — no cloud round-trips.

---

## ⚙️ How It Works

### Architecture

```
index.html          → UI shell (topbar, panels, modals, timeline DOM)
style.css           → Full design system (dark theme, CSS custom properties)
script.js           → ~2800-line monolith: state, timeline, canvas renderer,
                      AI pipelines, export engine, persistence
service-worker.js   → Offline-first asset caching (stale-while-revalidate)
```

### Core Loop

1. **Import** — Drag files (video, audio, image) into the Media Bin. Each file is stored as a `Blob` in IndexedDB so projects survive page reloads.
2. **Arrange** — Drag clips from the bin onto multi-track timeline rows. Resize, move, split (razor tool), and layer clips across tracks.
3. **Edit** — Select a clip to open the Properties panel: per-clip volume, speed, opacity, color grading (brightness/contrast/saturation/hue), blur, and toggle filters (B&W, sepia, invert, flip, AI BG removal).
4. **Crop** — Enter crop mode for interactive rule-of-thirds cropping with 8-handle resize, aspect presets (1:1, 16:9, 9:16, 2.39:1), or one-click AI Person Center.
5. **Preview** — Spacebar plays the composite in real time on a `<canvas>`, compositing all visible tracks with filters applied per-frame.
6. **Export** — Renders to WebM (VP8/VP9), MP4 (H.264), MOV, or PNG frame sequence using `MediaRecorder` + `captureStream()`.

### Persistence

- **Project state** (clip positions, tracks, settings) → `localStorage`
- **Media blobs** → IndexedDB (`cutframe_v3`)
- **AI models** → IndexedDB (Transformers.js cache) + Service Worker cache
- **Auto-save** triggers ~900ms after any edit

### AI Pipeline

All AI runs **on-device** via:
- **Transformers.js** (`@xenova/transformers`) — ONNX Runtime in WebAssembly for background removal, TTS, and Whisper
- **MediaPipe Pose** — WASM-based body landmark detection for smart cropping

The TTS system uses a **hybrid approach**: the browser's native `SpeechSynthesis` API provides instant playback preview on the timeline, while `speecht5_tts` renders exportable WAV audio in the background.

---

## 🚀 How to Run

### Option 1: Static File Server (Recommended)

```bash
# Clone the repo
git clone https://github.com/Rushikesh-24/Cutframe.git
cd Cutframe

# Serve with any static server — pick one:
npx serve .
# or
python3 -m http.server 8000
# or
php -S localhost:8000
```

Then open **http://localhost:8000** (or whichever port your server uses).

> **Note:** A local server is required because the Service Worker and `import()` for Transformers.js need HTTP(S) — `file://` won't work.

### Option 2: Just Open It

If you only need the core editor (no AI model downloads), you can host the four files on any static host — GitHub Pages, Netlify, Vercel, Cloudflare Pages — and it works out of the box. No build step, no `node_modules`.

### Keyboard Shortcuts

| Key | Action |
|---|---|
| `Space` | Play / Pause |
| `V` | Select tool |
| `C` | Razor tool |
| `S` | Split clip at playhead |
| `Delete` / `Backspace` | Delete selected clip |
| `←` / `→` | Nudge playhead (frame-by-frame) |
| `Home` / `End` | Jump to start / end |
| `Ctrl/⌘ + S` | Force save |
| `Escape` | Deselect / exit crop |

---

## 💎 What Makes It Unique

1. **Zero-dependency, zero-build architecture** — The entire editor is four files: one HTML, one CSS, one JS, one Service Worker. No React, no Webpack, no npm install. It loads in under a second.

2. **True offline-first** — The Service Worker pre-caches the app shell and uses stale-while-revalidate for CDN assets. Once visited, CutFrame works without any network connection, including AI features after initial model download.

3. **On-device AI without a backend** — Background removal, pose-based smart crop, neural TTS, and Whisper captioning all execute in the browser via WASM. Your media never leaves your machine.

4. **Hybrid TTS pipeline** — The voiceover system gives you instant preview through native browser speech synthesis while simultaneously rendering production-quality audio through a neural model in the background — best of both worlds.

5. **Canvas-based real-time compositing** — Rather than relying on `<video>` stacking or DOM-based previews, CutFrame composites all tracks per-frame onto a single `<canvas>`, applying CSS-style filters, crop regions, opacity, and AI masks in real time.

6. **Professional NLE workflow in a web page** — Multi-track timeline, razor/split/trim, per-clip color grading, interactive crop with rule-of-thirds overlay and 8-handle drag, zoom levels from 0.15× to 8×, and multi-format export — features you'd expect from desktop software.

---

## 📂 Project Structure

```
videoEditor/
├── index.html          # App shell & modal markup
├── style.css           # Complete dark-theme design system
├── script.js           # Editor engine, AI pipelines, export
├── service-worker.js   # Offline caching strategy
├── favicon.ico         # App icon
└── README.md           # You are here
```

---

## 🛠 Browser Support

CutFrame targets modern Chromium-based browsers (Chrome, Edge, Arc, Brave) for the best experience. Firefox works for core editing but may lack `MediaRecorder` codec support for MP4/MOV export. Safari has limited `MediaRecorder` and WebAssembly SIMD support.

---

<p align="center">
  <sub>Built with vanilla HTML, CSS, and JavaScript. No frameworks were harmed in the making of this editor.</sub>
</p>
