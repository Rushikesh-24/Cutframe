// ══════════════════════════════════════════════════════════
// CUTFRAME AI ASSISTANT — ai-assistant.js
// Integrates Ollama for video understanding + smart editing
// ══════════════════════════════════════════════════════════

(function () {
  "use strict";

  // ── Config ──────────────────────────────────────────────
  const AI_CFG = {
    ollamaBase: "http://localhost:11434",
    defaultModel: "gemma3",
    chatHistoryLimit: 20,
    frameInterval: 2, // seconds between sampled frames
    maxFrames: 100, // max frames to send per analysis
    frameQuality: 0.45, // jpeg quality for frames
    frameThumb: 160, // thumbnail width for frames
  };

  // ── State ────────────────────────────────────────────────
  const AI = {
    connected: false,
    model: AI_CFG.defaultModel,
    availableModels: [],
    chatHistory: [], // [{role, content}]
    mediaMetadata: new Map(), // mediaId → {transcript, scenes, objects, silence, summary, frames}
    panelOpen: false,
    analysing: false,
    activeRequest: null, // AbortController
  };

  // ── Helpers ──────────────────────────────────────────────
  function $id(id) {
    return document.getElementById(id);
  }
  function fmtTime(s) {
    s = Math.max(0, +s || 0);
    const h = (s / 3600) | 0,
      m = ((s % 3600) / 60) | 0,
      ss = (s % 60) | 0;
    return [h, m, ss].map((v) => String(v).padStart(2, "0")).join(":");
  }

  // ── Ollama API ───────────────────────────────────────────
  async function ollamaFetch(path, body, signal) {
    const url = `${AI_CFG.ollamaBase}${path}`;

    // Debug: log what we're sending (without full base64 to keep console readable)
    if (path === "/api/chat") {
      const debugMsgs = (body.messages || []).map((m) => ({
        role: m.role,
        content:
          typeof m.content === "string"
            ? m.content.slice(0, 120) + (m.content.length > 120 ? "…" : "")
            : "[array]",
        images: m.images
          ? `[${m.images.length} image(s), first=${m.images[0]?.slice(0, 20)}…]`
          : undefined,
      }));
      console.group("[CutFrame AI] Ollama request → " + body.model);
      console.log("messages:", debugMsgs);
      console.groupEnd();
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error("[CutFrame AI] Ollama error:", res.status, errText);
      throw new Error(`Ollama ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    console.log(
      "[CutFrame AI] Ollama reply:",
      data.message?.content?.slice(0, 120),
    );
    return data;
  }

  // Ollama /api/chat — handles both plain text messages and vision messages.
  // Vision messages must use the Ollama format:
  //   { role: 'user', content: 'text', images: ['base64...'] }
  // NOT the OpenAI image_url format.
  async function ollamaChat(messages, signal) {
    // Normalise messages: convert any that carry images in content array
    const normalised = messages.map((msg) => {
      if (!Array.isArray(msg.content)) return msg;
      // Extract text parts and image parts separately
      const textParts = msg.content
        .filter((c) => c.type === "text")
        .map((c) => c.text);
      const imageParts = msg.content.filter((c) => c.type === "image_url");
      const b64Images = imageParts
        .map((c) => {
          const url = c.image_url?.url || "";
          // Strip the data:image/jpeg;base64, prefix — Ollama wants raw base64
          return url.replace(/^data:[^;]+;base64,/, "");
        })
        .filter(Boolean);

      const out = { role: msg.role, content: textParts.join("\n") };
      if (b64Images.length > 0) out.images = b64Images;
      return out;
    });

    const data = await ollamaFetch(
      "/api/chat",
      {
        model: AI.model,
        messages: normalised,
        stream: false,
      },
      signal,
    );
    return data.message?.content || "";
  }

  async function checkOllamaConnection() {
    try {
      const res = await fetch(`${AI_CFG.ollamaBase}/api/tags`, {
        method: "GET",
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      AI.availableModels = (data.models || []).map((m) => m.name);
      AI.connected = true;
      return true;
    } catch {
      AI.connected = false;
      return false;
    }
  }

  // ── Panel DOM helpers ─────────────────────────────────────
  function updateConnectionUI() {
    const badge = $id("ai-conn-badge");
    const topBtn = $id("btn-ai-assistant");
    const notConn = $id("ai-not-connected");
    const chatWrap = $id("ai-chat-wrap");
    if (!badge) return;

    if (AI.connected) {
      badge.className = "connected";
      badge.innerHTML = `<span class="ai-conn-dot"></span>${AI.model}`;
      if (topBtn) {
        topBtn.classList.add("connected");
      }
      if (notConn) notConn.style.display = "none";
      if (chatWrap) chatWrap.style.display = "flex";
      populateModelSelect();
      updateAnalyseRowVisibility();
    } else {
      badge.className = "error";
      badge.innerHTML = `<span class="ai-conn-dot"></span>Offline`;
      if (topBtn) topBtn.classList.remove("connected");
      if (notConn) notConn.style.display = "flex";
      if (chatWrap) chatWrap.style.display = "none";
    }
  }

  function populateModelSelect() {
    const sel = $id("ai-model-select");
    if (!sel || !AI.availableModels.length) return;
    sel.innerHTML = "";
    AI.availableModels.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m;
      if (m === AI.model) opt.selected = true;
      sel.appendChild(opt);
    });
    // If saved model not in list, add it
    if (!AI.availableModels.includes(AI.model)) {
      const opt = document.createElement("option");
      opt.value = AI.model;
      opt.textContent = AI.model + " (configured)";
      opt.selected = true;
      sel.insertBefore(opt, sel.firstChild);
    }
  }

  function updateContextBar() {
    const bar = $id("ai-context-bar");
    if (!bar) return;

    // Get selected clip info from global state
    const selClip =
      typeof selectedId !== "undefined" && typeof clips !== "undefined"
        ? clips.find((c) => c.id === selectedId)
        : null;
    const selMedia =
      selClip && typeof mediaItems !== "undefined"
        ? mediaItems.find((m) => m.id === selClip.mediaId)
        : null;

    bar.innerHTML = "";

    // Timeline duration chip
    const dur = typeof totalDur !== "undefined" ? totalDur : 0;
    const durChip = document.createElement("div");
    durChip.className = "ai-ctx-chip" + (dur > 0 ? " active" : "");
    durChip.innerHTML = `⏱ ${fmtTime(dur)}`;
    bar.appendChild(durChip);

    // Clip count
    const clipCount = typeof clips !== "undefined" ? clips.length : 0;
    const clipChip = document.createElement("div");
    clipChip.className = "ai-ctx-chip" + (clipCount > 0 ? " active" : "");
    clipChip.innerHTML = `🎬 ${clipCount} clip${clipCount !== 1 ? "s" : ""}`;
    bar.appendChild(clipChip);

    // Selected clip
    if (selMedia) {
      const selChip = document.createElement("div");
      selChip.className = "ai-ctx-chip active";
      selChip.innerHTML = `📌 ${selMedia.name.slice(0, 14)}${selMedia.name.length > 14 ? "…" : ""}`;
      bar.appendChild(selChip);
    }

    // Analysis status
    const metaCount = AI.mediaMetadata.size;
    if (metaCount > 0) {
      const metaChip = document.createElement("div");
      metaChip.className = "ai-ctx-chip active";
      metaChip.innerHTML = `🔍 ${metaCount} analysed`;
      bar.appendChild(metaChip);
    }
  }

  // ── Video Frame Extraction ────────────────────────────────
  async function extractFrames(mediaItem) {
    if (mediaItem.type !== "video" && mediaItem.type !== "image") return [];
    const el = mediaItem.el;
    if (!el) return [];

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const frames = [];

    if (mediaItem.type === "image") {
      canvas.width = AI_CFG.frameThumb;
      canvas.height = Math.round(
        AI_CFG.frameThumb * (el.naturalHeight / el.naturalWidth),
      );
      ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
      frames.push({
        time: 0,
        dataUrl: canvas.toDataURL("image/jpeg", AI_CFG.frameQuality),
      });
      return frames;
    }

    const dur = el.duration || 0;
    if (!dur || isNaN(dur)) return [];

    const step = Math.max(AI_CFG.frameInterval, dur / AI_CFG.maxFrames);
    const aspect = el.videoHeight > 0 ? el.videoWidth / el.videoHeight : 16 / 9;
    canvas.width = AI_CFG.frameThumb;
    canvas.height = Math.round(AI_CFG.frameThumb / aspect);

    const times = [];
    for (let t = 0; t < dur; t += step) times.push(t);
    if (times.length > AI_CFG.maxFrames) times.splice(AI_CFG.maxFrames);

    for (const t of times) {
      await new Promise((res) => {
        el.currentTime = t;
        el.onseeked = res;
        setTimeout(res, 800);
      });
      ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
      frames.push({
        time: t,
        dataUrl: canvas.toDataURL("image/jpeg", AI_CFG.frameQuality),
      });
    }

    el.currentTime = 0;
    return frames;
  }

  // ── Silence Detection ──────────────────────────────────────
  async function detectSilence(mediaItem, threshold = 0.01, minDur = 0.8) {
    const el = mediaItem.el;
    if (!el || (mediaItem.type !== "video" && mediaItem.type !== "audio"))
      return [];

    try {
      const audioCtx = new AudioContext();
      const res = await fetch(el.src || el.currentSrc);
      const buf = await res.arrayBuffer();
      const decoded = await audioCtx.decodeAudioData(buf);
      await audioCtx.close();

      const data = decoded.getChannelData(0);
      const sr = decoded.sampleRate;
      const silences = [];
      let silStart = null;

      for (let i = 0; i < data.length; i++) {
        const rms = Math.abs(data[i]);
        if (rms < threshold) {
          if (silStart === null) silStart = i / sr;
        } else if (silStart !== null) {
          const dur = i / sr - silStart;
          if (dur >= minDur)
            silences.push({ start: silStart, end: i / sr, dur });
          silStart = null;
        }
      }
      return silences;
    } catch {
      return [];
    }
  }

  // ── AI Video Analysis ─────────────────────────────────────
  async function analyseMedia(mediaItem) {
    if (!AI.connected || AI.analysing) return;
    if (AI.mediaMetadata.has(mediaItem.id)) return; // already done

    AI.analysing = true;
    showAnalysisBar(`Analysing ${mediaItem.name}…`);
    updateAnalysisProgress(10);

    const meta = {
      frames: [],
      summary: "",
      objects: [],
      scenes: [],
      silence: [],
      transcript: "",
    };
    AI.mediaMetadata.set(mediaItem.id, meta);

    try {
      // 1. Extract frames
      appendAiMsg(
        "assistant",
        `🔍 Extracting frames from **${mediaItem.name}**…`,
        true,
      );
      meta.frames = await extractFrames(mediaItem);
      updateAnalysisProgress(35);

      // 2. Detect silence (for video/audio)
      if (mediaItem.type === "video" || mediaItem.type === "audio") {
        meta.silence = await detectSilence(mediaItem);
        updateAnalysisProgress(50);
      }

      // 3. Ask Ollama to analyse frames
      if (meta.frames.length > 0) {
        appendAiMsg(
          "assistant",
          `🤖 Sending ${meta.frames.length} frames to ${AI.model}…`,
          true,
        );

        // Detect if the ACTIVE model supports vision.
        // minicpm-v, llava, moondream, bakllava, gemma3 etc. all support images.
        const VISION_MODELS = [
          "llava",
          "moondream",
          "bakllava",
          "minicpm",
          "phi3-vision",
          "gemma3",
          "vision",
          "cogvlm",
          "idefics",
        ];
        const isVision = VISION_MODELS.some((v) =>
          AI.model.toLowerCase().includes(v),
        );

        let analysisPrompt;
        if (isVision && meta.frames.length > 0) {
          // Attempt vision - send first few frames as images
          const framesToSend = meta.frames.slice(0, 6);
          analysisPrompt = buildVisionMessages(framesToSend, mediaItem);
        } else {
          analysisPrompt = buildTextAnalysisMessages(meta, mediaItem);
        }

        let result = await ollamaChat(analysisPrompt);

        // Language guard: auto-translate if CJK detected
        const hasCJK = /[\u3000-\u9fff\uac00-\ud7af]/.test(result);
        if (hasCJK && result.length > 20) {
          appendAiMsg(
            "assistant",
            "⚠ Analysis response not in English — translating…",
            true,
          );
          try {
            const tx = await ollamaChat([
              {
                role: "system",
                content:
                  "Translate to English only. Output translation only, nothing else.",
              },
              { role: "user", content: result },
            ]);
            if (tx && tx.trim()) result = tx;
          } catch {}
          removeThinkingMsgs();
        }

        meta.summary = result;
        updateAnalysisProgress(80);

        // Parse structured data from result
        parseAnalysisResult(result, meta);
      }

      updateAnalysisProgress(100);
      hideAnalysisBar();
      AI.analysing = false;

      // Replace thinking message with summary
      removeThinkingMsgs();
      const shortSummary =
        meta.summary.slice(0, 280) + (meta.summary.length > 280 ? "…" : "");
      appendAiMsg(
        "assistant",
        `✅ **Analysis complete** for *${mediaItem.name}*\n\n${shortSummary}`,
        false,
        [
          {
            label: "🎬 Ask about this clip",
            action: () => {
              $id("ai-prompt").value = `What happens in "${mediaItem.name}"?`;
              $id("ai-prompt").focus();
            },
          },
          {
            label: "✂ Find key moments",
            action: () => sendPrompt(`Find key moments in "${mediaItem.name}"`),
          },
        ],
      );

      // Update media item badge
      updateMediaBadge(mediaItem.id, "✓ AI");
      updateContextBar();
    } catch (err) {
      hideAnalysisBar();
      AI.analysing = false;
      removeThinkingMsgs();
      appendAiMsg("assistant", `⚠ Analysis failed: ${err.message}`);
      AI.mediaMetadata.delete(mediaItem.id);
    }
  }

  function buildVisionMessages(frames, mediaItem) {
    // Ollama vision format: images is a top-level array of raw base64 strings.
    // The content field is plain text — NOT an array like OpenAI's API.
    const b64Images = frames.map((f) =>
      f.dataUrl.replace(/^data:[^;]+;base64,/, ""),
    );

    const frameTimestamps = frames.map((f) => fmtTime(f.time)).join(", ");

    const prompt = `IMPORTANT: You MUST respond entirely in ENGLISH. Do not use any other language.

You are a video analysis AI assistant integrated into a video editor called CutFrame.
You are looking at ${frames.length} sampled frames from "${mediaItem.name}" (duration: ${fmtTime(mediaItem.duration || 0)}).
Frame timestamps: ${frameTimestamps}

Describe what you see in the frames, then respond with ALL of the following sections:

SUMMARY: [2-3 sentences in English describing the overall video content]
OBJECTS: [comma-separated list of visible objects, people, or subjects]
SCENE ${frames[0] ? fmtTime(frames[0].time) : "0:00:00"}: [describe what is visible at this timestamp]
HIGHLIGHT ${frames[Math.floor(frames.length / 2)] ? fmtTime(frames[Math.floor(frames.length / 2)].time) : "0:00:00"}: [most interesting moment and why]

Keep your response concise and in ENGLISH only.`;

    // System message enforcing English, then user message with images
    return [
      {
        role: "system",
        content:
          "You are a helpful video analysis assistant. You ALWAYS respond in English only, regardless of the language of any text you see in images. Never respond in Chinese, Japanese, or any other language. English only.",
      },
      {
        role: "user",
        content: prompt,
        images: b64Images,
      },
    ];
  }

  function buildTextAnalysisMessages(meta, mediaItem) {
    const silenceStr =
      meta.silence.length > 0
        ? `Silence detected at: ${meta.silence.map((s) => `${fmtTime(s.start)}-${fmtTime(s.end)}`).join(", ")}`
        : "No significant silence detected.";

    return [
      {
        role: "user",
        content: `You are a video analysis AI. Analyse this media file:
Name: "${mediaItem.name}"
Type: ${mediaItem.type}
Duration: ${fmtTime(mediaItem.duration || 0)}
Frame timestamps sampled: ${meta.frames.map((f) => fmtTime(f.time)).join(", ")}
${silenceStr}

Based on the file name and metadata, provide:
SUMMARY: A likely description of the content.
OBJECTS: Common objects/subjects that might appear.
SCENE 0:00:00: Likely opening content
HIGHLIGHT 0:00:00: Most important moment guess

Be concise and practical.`,
      },
    ];
  }

  function parseAnalysisResult(text, meta) {
    // Extract objects
    const objMatch = text.match(/OBJECTS?:\s*(.+?)(?:\n|$)/i);
    if (objMatch) {
      meta.objects = objMatch[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }

    // Extract scenes with timestamps
    meta.scenes = [];
    const sceneRe = /SCENE\s+([\d:]+):\s*(.+?)(?=\n|$)/gi;
    let m;
    while ((m = sceneRe.exec(text)) !== null) {
      meta.scenes.push({ time: parseTimestamp(m[1]), desc: m[2].trim() });
    }

    // Extract highlights
    meta.highlights = [];
    const hlRe = /HIGHLIGHT\s+([\d:]+):\s*(.+?)(?=\n|$)/gi;
    while ((m = hlRe.exec(text)) !== null) {
      meta.highlights.push({ time: parseTimestamp(m[1]), reason: m[2].trim() });
    }
  }

  function parseTimestamp(str) {
    const parts = str.split(":").map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0] || 0;
  }

  // ── Prompt → Action Engine ────────────────────────────────
  const INTENT_PATTERNS = [
    {
      intent: "summarise",
      re: /^(summar|what('s| is) (this|the)|tell me about|describe|overview|what happen)/i,
    },
    {
      intent: "find_objects",
      re: /^(find|detect|show|locate|where|when).*(gun|weapon|car|person|people|face|text|logo|violence|fire|water|animal|child)/i,
    },
    {
      intent: "detect_silence",
      re: /(silence|silent|quiet|pause|dead air|no.?sound)/i,
    },
    {
      intent: "cut_scenes",
      re: /(cut|remove|delete|trim|strip).*(scene|part|section|clip|moment)/i,
    },
    {
      intent: "remove_silence",
      re: /(remove|cut|trim|strip).*(silence|silent|pause|quiet)/i,
    },
    {
      intent: "highlight",
      re: /(highlight|best|top|key moment|interesting|clip reel|boring|dull|engaging)/i,
    },
    { intent: "captions", re: /(caption|subtitle|transcri|closed cap)/i },
    {
      intent: "seek",
      re: /^(go to|jump to|seek to|show me at|what('s| is) at)\s+\d/i,
    },
    {
      intent: "split_shorts",
      re: /(split|divide|chop|break).*(short|reel|tiktok|vertical|9.?16)/i,
    },
    { intent: "blur_faces", re: /(blur|hide|anonymi).*(face|person|people)/i },
    {
      intent: "crop_reel",
      re: /(crop|format|convert|make).*(reel|short|vertical|9.?16|tiktok|portrait)/i,
    },
    // Complex semantic edits: "cut where X does Y", "move clip where X to start", etc.
    {
      intent: "complex_edit",
      re: /(cut|trim|move|reorder|place|bring).+(where|when|while|as|until|till|holding|carrying|doing|appears?|shows?|walks?|sits?|stands?)/i,
    },
    { intent: "general_qa", re: /./ }, // catch-all
  ];

  function detectIntent(prompt) {
    for (const p of INTENT_PATTERNS) {
      if (p.re.test(prompt.trim())) return p.intent;
    }
    return "general_qa";
  }

  async function sendPrompt(promptText) {
    promptText = (promptText || $id("ai-prompt")?.value || "").trim();
    if (!promptText) return;
    if (!AI.connected) {
      toast("⚠ AI not connected — check Ollama");
      return;
    }

    if ($id("ai-prompt")) $id("ai-prompt").value = "";
    appendAiMsg("user", promptText);
    const typingEl = showTyping();
    const intent = detectIntent(promptText);

    try {
      AI.activeRequest = new AbortController();
      setSendLoading(true);
      let reply = "";

      // ── Fast-path: local intent handlers (no LLM needed) ──
      if (intent === "remove_silence" || intent === "detect_silence") {
        reply = await handleRemoveSilence();
      } else if (intent === "seek") {
        reply = handleSeek(promptText);
      } else if (intent === "crop_reel") {
        reply = handleCropReel();
      } else if (intent === "captions") {
        reply = handleCaptions();
      } else if (intent === "highlight") {
        // Hybrid: LLM finds the moments, then we offer to build the reel
        reply = await handleHighlightQuery(promptText);
      } else if (intent === "complex_edit") {
        reply = await handleComplexEdit(promptText);
      } else {
        // ── LLM path: build messages WITH video frames attached ──
        reply = await sendToLLM(promptText, intent);
      }

      // ── CJK guard ──
      reply = await ensureEnglish(reply);

      removeEl(typingEl);
      setSendLoading(false);
      const actions = buildActionsForIntent(intent, reply, promptText);
      appendAiMsg("assistant", reply, false, actions);

      // Store plain-text version in history (no images — keep history lean)
      AI.chatHistory.push({ role: "user", content: promptText });
      AI.chatHistory.push({ role: "assistant", content: reply });
      if (AI.chatHistory.length > AI_CFG.chatHistoryLimit * 2) {
        AI.chatHistory.splice(0, 4); // drop oldest pair
      }
    } catch (err) {
      removeEl(typingEl);
      setSendLoading(false);
      if (err.name !== "AbortError") {
        appendAiMsg("assistant", `⚠ Error: ${err.message}`);
        console.error("[CutFrame AI]", err);
      }
    }
  }

  // Build the full message array for an LLM call, injecting video frames when available.
  async function sendToLLM(promptText, intent) {
    const VISION_MODELS = [
      "llava",
      "moondream",
      "bakllava",
      "minicpm",
      "phi3-vision",
      "gemma3",
      "vision",
      "cogvlm",
      "idefics",
    ];
    const isVision = VISION_MODELS.some((v) =>
      AI.model.toLowerCase().includes(v),
    );

    // Collect all frames from analysed media (up to 4 frames per media, max 6 total)
    const allFrames = [];
    const frameSourceInfo = [];
    if (isVision && typeof mediaItems !== "undefined") {
      for (const m of mediaItems) {
        const meta = AI.mediaMetadata.get(m.id);
        if (meta && meta.frames && meta.frames.length > 0) {
          const pick = meta.frames
            .filter(
              (_, i) =>
                i % Math.max(1, Math.ceil(meta.frames.length / 4)) === 0,
            )
            .slice(0, 4);
          pick.forEach((f) =>
            allFrames.push({
              frame: f,
              mediaName: m.name,
              duration: m.duration,
            }),
          );
          frameSourceInfo.push(
            `"${m.name}" (${fmtTime(m.duration || 0)}, ${pick.length} frames)`,
          );
        }
      }
    }

    // If we have no pre-analysed frames but there ARE media items, extract a few live frames now
    if (
      isVision &&
      allFrames.length === 0 &&
      typeof mediaItems !== "undefined" &&
      mediaItems.length > 0
    ) {
      const firstVideo = mediaItems.find(
        (m) => m.type === "video" || m.type === "image",
      );
      if (firstVideo) {
        appendAiMsg(
          "assistant",
          `🎞 Sampling frames from "${firstVideo.name}"…`,
          true,
        );
        const freshFrames = await extractFrames(firstVideo);
        const pick = freshFrames
          .filter(
            (_, i) => i % Math.max(1, Math.ceil(freshFrames.length / 4)) === 0,
          )
          .slice(0, 4);
        pick.forEach((f) =>
          allFrames.push({
            frame: f,
            mediaName: firstVideo.name,
            duration: firstVideo.duration,
          }),
        );
        frameSourceInfo.push(
          `"${firstVideo.name}" (${fmtTime(firstVideo.duration || 0)}, ${pick.length} live frames)`,
        );
        removeThinkingMsgs();
      }
    }

    const systemMsg = {
      role: "system",
      content: buildSystemContext(),
    };

    // Build the user message — with or without frames
    if (isVision && allFrames.length > 0) {
      const b64Images = allFrames.map((f) =>
        f.frame.dataUrl.replace(/^data:[^;]+;base64,/, ""),
      );

      const frameDesc = allFrames
        .map((f) => `  • [${fmtTime(f.frame.time)}] from "${f.mediaName}"`)
        .join("\n");

      const userContent = `You are looking at ${allFrames.length} video frame(s) from the user's project.
Frames:\n${frameDesc}

User question: ${promptText}

IMPORTANT: Answer in ENGLISH only. Use the actual frame images above to answer. Do not say you cannot see the video — you are looking at sampled frames right now.`;

      const userMsg = {
        role: "user",
        content: userContent,
        images: b64Images,
      };

      return await ollamaChat([systemMsg, userMsg], AI.activeRequest.signal);
    } else {
      // Text-only path (non-vision model or no media imported yet)
      const history = AI.chatHistory.slice(-8); // last 4 exchanges
      const userMsg = { role: "user", content: promptText };
      return await ollamaChat(
        [systemMsg, ...history, userMsg],
        AI.activeRequest.signal,
      );
    }
  }

  // Auto-translate if response is not English
  async function ensureEnglish(text) {
    const hasCJK = /[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff]/.test(text);
    if (!hasCJK || text.length < 10) return text;
    appendAiMsg(
      "assistant",
      "⚠ Response in wrong language — translating to English…",
      true,
    );
    try {
      const tx = await ollamaChat([
        {
          role: "system",
          content:
            "You are a translator. Output ONLY the English translation of the text below. Nothing else.",
        },
        { role: "user", content: text },
      ]);
      removeThinkingMsgs();
      if (tx && tx.trim()) return tx;
    } catch {
      removeThinkingMsgs();
    }
    return text;
  }

  function buildSystemContext() {
    // Gather all clips info
    const clipsInfo =
      typeof clips !== "undefined" && clips.length > 0
        ? clips
            .map((c) => {
              const m =
                typeof mediaItems !== "undefined"
                  ? mediaItems.find((x) => x.id === c.mediaId)
                  : null;
              const meta = m ? AI.mediaMetadata.get(m.id) : null;
              const objStr = meta?.objects?.length
                ? ` — objects: ${meta.objects.slice(0, 5).join(", ")}`
                : "";
              return `  • Clip "${m?.name || "unknown"}" on timeline at ${fmtTime(c.start)}–${fmtTime(c.start + c.duration)}${objStr}`;
            })
            .join("\n")
        : "  (no clips on timeline yet)";

    // Full analysis summaries for every analysed file
    const analysisDump = [...AI.mediaMetadata.entries()]
      .map(([id, meta]) => {
        const m =
          typeof mediaItems !== "undefined"
            ? mediaItems.find((x) => x.id === id)
            : null;
        if (!m) return "";
        const lines = [
          `  FILE: "${m.name}" | type: ${m.type} | duration: ${fmtTime(m.duration || 0)}`,
        ];
        if (meta.summary)
          lines.push(`  SUMMARY: ${meta.summary.slice(0, 400)}`);
        if (meta.objects?.length)
          lines.push(`  OBJECTS DETECTED: ${meta.objects.join(", ")}`);
        if (meta.scenes?.length)
          lines.push(
            `  SCENES: ${meta.scenes.map((s) => `[${fmtTime(s.time)}] ${s.desc}`).join(" | ")}`,
          );
        if (meta.silence?.length)
          lines.push(
            `  SILENCE SEGMENTS: ${meta.silence.map((s) => `${fmtTime(s.start)}–${fmtTime(s.end)}`).join(", ")}`,
          );
        if (meta.frames?.length)
          lines.push(
            `  FRAMES SAMPLED: ${meta.frames.length} frames at ${meta.frames.map((f) => fmtTime(f.time)).join(", ")}`,
          );
        return lines.join("\n");
      })
      .filter(Boolean)
      .join("\n\n");

    const mediaList =
      typeof mediaItems !== "undefined" && mediaItems.length > 0
        ? mediaItems
            .map(
              (m) => `  • "${m.name}" (${m.type}, ${fmtTime(m.duration || 0)})`,
            )
            .join("\n")
        : "  (no media imported)";

    return `You are CutFrame AI, an intelligent video editing assistant built into a browser video editor.
CRITICAL RULE: You MUST respond in ENGLISH only. No Chinese. No Japanese. No Korean. English only, always.

═══ PROJECT STATE ═══
Timeline duration: ${fmtTime(typeof totalDur !== "undefined" ? totalDur : 0)}
Clips on timeline: ${typeof clips !== "undefined" ? clips.length : 0}
Tracks: ${typeof tracks !== "undefined" ? tracks.length : 0}

MEDIA IN BIN:
${mediaList}

CLIPS ON TIMELINE:
${clipsInfo}

${analysisDump ? `═══ VIDEO ANALYSIS DATA ═══\n${analysisDump}` : "(No video analysis run yet — user needs to open the AI panel after importing media)"}

═══ INSTRUCTIONS ═══
• You have full knowledge of the user's video content from the analysis data above.
• When referencing timestamps write them as [HH:MM:SS] so users can click to seek.
• Give direct, actionable answers. Never say you cannot see the video — use the analysis data.
• For editing suggestions be specific: which clip, which timestamp, what action.
• ENGLISH ONLY.`;
  }

  // ── Intent Handlers ───────────────────────────────────────
  async function handleRemoveSilence() {
    const silentRanges = [];
    if (typeof clips === "undefined") return "No clips on timeline.";

    for (const clip of clips) {
      const m =
        typeof mediaItems !== "undefined"
          ? mediaItems.find((x) => x.id === clip.mediaId)
          : null;
      if (!m) continue;
      let meta = AI.mediaMetadata.get(m.id);
      if (!meta) {
        // Quick silence detection
        const silence = await detectSilence(m);
        meta = { silence };
        AI.mediaMetadata.set(m.id, meta);
      }
      if (meta.silence?.length) {
        meta.silence.forEach((s) => {
          silentRanges.push({
            clipId: clip.id,
            clipName: m.name,
            start: clip.start + s.start,
            end: clip.start + s.end,
            dur: s.dur,
          });
        });
      }
    }

    if (!silentRanges.length) {
      return "No significant silence detected in your timeline. Silence threshold: 0.01 RMS, minimum duration: 0.8s.";
    }

    // Store for action button
    window._aiSilentRanges = silentRanges;

    return `Found **${silentRanges.length} silent segment(s)** totalling ${fmtTime(silentRanges.reduce((a, b) => a + b.dur, 0))}:\n\n${silentRanges.map((r) => `• [${fmtTime(r.start)}] – [${fmtTime(r.end)}] (${r.dur.toFixed(1)}s) in "${r.clipName}"`).join("\n")}\n\nUse "✂ Remove Silence" button below to apply cuts.`;
  }

  async function handleDetectSilence() {
    return handleRemoveSilence();
  }

  function handleSeek(prompt) {
    const tsMatch = prompt.match(/(\d{1,2}:\d{2}(?::\d{2})?)/);
    if (tsMatch) {
      const t = parseTimestamp(tsMatch[1]);
      if (typeof playheadTime !== "undefined") {
        window.playheadTime = t;
        if (typeof renderFrame === "function") renderFrame();
        if (typeof updatePlayheadPos === "function") updatePlayheadPos();
      }
      return `Jumped to [${fmtTime(t)}] on the timeline.`;
    }
    return 'Please specify a timestamp like "go to 0:42" or "what is at 1:30".';
  }

  function handleCropReel() {
    // Try to trigger existing crop functionality
    const cropBtn = $id("btn-crop");
    if (cropBtn && !cropBtn.disabled) {
      toast("Opening crop tool for Reels format…");
      if (typeof toggleCrop === "function") toggleCrop();
    }
    return 'To crop for Reels (9:16), use the ⬜ Crop button in the toolbar and select "Reels 9:16" preset in the Properties panel.';
  }

  function handleCaptions() {
    const selClip =
      typeof selectedId !== "undefined" && typeof clips !== "undefined"
        ? clips.find((c) => c.id === selectedId)
        : null;
    if (selClip && typeof autoCaption === "function") {
      autoCaption(selClip.id);
      return `Starting auto-captioning for selected clip. This uses Whisper (~75MB download on first use).`;
    }
    return "Select a video/audio clip first, then use the CC button in the toolbar or the caption option in clip Properties to add auto-captions via Whisper AI.";
  }

  function buildActionsForIntent(intent, reply, prompt) {
    const actions = [];

    if (intent === "remove_silence" && window._aiSilentRanges?.length) {
      actions.push({
        label: "✂ Remove Silence",
        danger: false,
        action: () => applySilenceCuts(window._aiSilentRanges),
      });
    }

    if (intent === "highlight") {
      if (window._aiPendingHighlight && window._aiHighlightMoments?.length) {
        const isBoring = window._aiHighlightIsBoring;
        actions.push({
          label: isBoring ? "✂ Remove Boring Parts" : "🎬 Build Highlight Reel",
          action: () => handleHighlightReel(reply),
        });
      }
    }

    if (intent === "complex_edit") {
      const pending = window._aiPendingEdit;
      if (pending) {
        actions.push({
          label: "✅ Apply Edit",
          action: () => applyComplexEdit(pending),
        });
      }
    }

    // Add clickable seek buttons for ANY intent that returned timestamps
    // (the chips in the bubble handle inline seeks; these are extra convenience buttons)
    const tsMentions = [...reply.matchAll(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g)];
    if (tsMentions.length > 0 && intent !== "seek") {
      tsMentions.slice(0, 5).forEach((m) => {
        const t = parseTimestamp(m[1]);
        actions.push({
          label: `⏱ ${m[1]}`,
          action: () => {
            window.playheadTime = t;
            if (typeof seekTo === "function") {
              try {
                seekTo(t);
              } catch (e) {}
            }
            if (typeof setPlayheadTime === "function") {
              try {
                setPlayheadTime(t);
              } catch (e) {}
            }
            if (typeof updatePlayheadPos === "function") {
              try {
                updatePlayheadPos();
              } catch (e) {}
            }
            if (typeof renderFrame === "function") {
              try {
                renderFrame(t);
              } catch (e) {}
            }
            const pv =
              document.getElementById("preview-video") ||
              document.querySelector("#preview-area video") ||
              document.querySelector("video");
            if (pv && isFinite(t)) {
              try {
                pv.currentTime = t;
              } catch (e) {}
            }
            if (typeof toast === "function") toast("⏱ Seeked to " + m[1]);
          },
        });
      });
    }

    return actions;
  }

  // ── Highlight Reel ────────────────────────────────────────
  // Step 1: Ask LLM to identify highlight / boring moments with timestamps
  async function handleHighlightQuery(promptText) {
    const isBoring = /boring|dull|slow|skip/i.test(promptText);
    const systemCtx = buildSystemContext();

    // Build a vision message if frames available, so the LLM can actually see
    const VISION_MODELS = [
      "llava",
      "moondream",
      "bakllava",
      "minicpm",
      "phi3-vision",
      "gemma3",
      "vision",
      "cogvlm",
      "idefics",
    ];
    const isVision = VISION_MODELS.some((v) =>
      AI.model.toLowerCase().includes(v),
    );

    const allFrames = [];
    if (isVision && typeof mediaItems !== "undefined") {
      for (const m of mediaItems) {
        const meta = AI.mediaMetadata.get(m.id);
        if (meta?.frames?.length) {
          // Spread frames evenly
          const pick = meta.frames
            .filter(
              (_, i) =>
                i % Math.max(1, Math.ceil(meta.frames.length / 6)) === 0,
            )
            .slice(0, 6);
          pick.forEach((f) =>
            allFrames.push({
              frame: f,
              mediaName: m.name,
              duration: m.duration,
            }),
          );
        }
      }
    }

    const taskDesc = isBoring
      ? "Identify the BORING / slow / low-energy moments in the video."
      : "Identify the HIGHLIGHT / most engaging / high-energy moments in the video.";

    const instruction = `${taskDesc}

For EACH moment provide:
- START: [HH:MM:SS] — exact start timestamp
- END: [HH:MM:SS] — exact end timestamp  
- REASON: one sentence why this is a ${isBoring ? "boring" : "highlight"} moment

Format STRICTLY as:
MOMENT 1
START: [00:00:00]
END: [00:00:00]
REASON: ...

MOMENT 2
...

List up to 6 moments. Use [HH:MM:SS] format for all timestamps.`;

    let reply;
    if (isVision && allFrames.length > 0) {
      const b64Images = allFrames.map((f) =>
        f.frame.dataUrl.replace(/^data:[^;]+;base64,/, ""),
      );
      const frameDesc = allFrames
        .map((f) => `[${fmtTime(f.frame.time)}] from "${f.mediaName}"`)
        .join(", ");
      reply = await ollamaChat(
        [
          { role: "system", content: systemCtx },
          {
            role: "user",
            content: `Frames (${allFrames.length}): ${frameDesc}\n\n${instruction}`,
            images: b64Images,
          },
        ],
        AI.activeRequest.signal,
      );
    } else {
      reply = await ollamaChat(
        [
          { role: "system", content: systemCtx },
          { role: "user", content: instruction },
        ],
        AI.activeRequest.signal,
      );
    }

    reply = await ensureEnglish(reply);

    // Parse moments out of the reply
    const moments = parseMomentsFromReply(reply);
    if (moments.length > 0) {
      window._aiHighlightMoments = moments;
      window._aiHighlightIsBoring = isBoring;
      // Append a build-reel action button (handled in buildActionsForIntent via window state)
      // We inject it via a special marker the action builder picks up
      window._aiPendingHighlight = true;
    } else {
      window._aiPendingHighlight = false;
    }

    return reply;
  }

  function parseMomentsFromReply(text) {
    const moments = [];
    // Pattern: START: [HH:MM:SS] ... END: [HH:MM:SS]
    const blocks = text.split(/MOMENT\s+\d+/i).slice(1);
    blocks.forEach((block) => {
      const startM = block.match(/START:\s*\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?/i);
      const endM = block.match(/END:\s*\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?/i);
      const reasonM = block.match(/REASON:\s*(.+?)(?:\n|$)/i);
      if (startM && endM) {
        moments.push({
          start: parseTimestamp(startM[1]),
          end: parseTimestamp(endM[1]),
          startLabel: startM[1],
          endLabel: endM[1],
          reason: reasonM ? reasonM[1].trim() : "",
        });
      }
    });

    // Fallback: look for paired timestamps in sequence if structured parse failed
    if (moments.length === 0) {
      const allTs = [...text.matchAll(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g)];
      for (let i = 0; i + 1 < allTs.length; i += 2) {
        moments.push({
          start: parseTimestamp(allTs[i][1]),
          end: parseTimestamp(allTs[i + 1][1]),
          startLabel: allTs[i][1],
          endLabel: allTs[i + 1][1],
          reason: "",
        });
      }
    }
    return moments;
  }

  // Step 2: Build the highlight reel, save it as a separate project, open in new tab
  async function handleHighlightReel(llmReply) {
    if (!window._aiHighlightMoments?.length) {
      appendAiMsg(
        "assistant",
        '⚠ No moments parsed yet. Ask me to "find key moments" or "find highlight moments" first.',
      );
      return;
    }

    const moments = window._aiHighlightMoments;
    const isBoring = window._aiHighlightIsBoring;

    if (typeof clips === "undefined" || typeof mediaItems === "undefined") {
      appendAiMsg(
        "assistant",
        "⚠ Cannot access timeline — make sure CutFrame has loaded fully.",
      );
      return;
    }

    appendAiMsg(
      "assistant",
      `🎬 Building ${isBoring ? "trimmed (boring removed)" : "highlight"} reel from ${moments.length} moment(s)…`,
      true,
    );

    // Find the source media (first video)
    const srcMedia = mediaItems.find((m) => m.type === "video");
    if (!srcMedia) {
      removeThinkingMsgs();
      appendAiMsg(
        "assistant",
        "⚠ No video media found in the bin. Import a video first.",
      );
      return;
    }

    // Determine segments to keep
    let segments =
      isBoring && srcMedia.duration
        ? invertSegments(moments, srcMedia.duration)
        : moments;

    // Clamp and filter
    segments = segments
      .filter((s) => s.end > s.start)
      .map((s) => ({
        ...s,
        start: Math.max(0, s.start),
        end: Math.min(srcMedia.duration || 9999, s.end),
      }));

    // ── Build the reel project data ──────────────────────────
    // Use the same schema as saveProject() in script.js
    const reelTrackId = 1;
    const reelClips = [];
    let cursor = 0;
    let addedCount = 0;

    for (const seg of segments) {
      const dur = seg.end - seg.start;
      if (dur < 0.5) continue;
      reelClips.push({
        id: Date.now() + Math.random(),
        trackId: reelTrackId,
        mediaId: srcMedia.id,
        start: cursor, // position on reel timeline
        mediaOffset: seg.start, // where in the source to start
        duration: dur,
        label: seg.reason
          ? seg.reason.slice(0, 40)
          : `Highlight ${++addedCount}`,
      });
      cursor += dur;
      addedCount++;
    }

    removeThinkingMsgs();

    if (reelClips.length === 0) {
      appendAiMsg(
        "assistant",
        "⚠ No valid segments could be extracted. Try asking to find highlights again.",
      );
      return;
    }

    const reelLabel = isBoring ? "No-Boring Cut" : "Highlight Reel";
    const reelTitle = `${srcMedia.name.replace(/\.[^.]+$/, "")} — ${reelLabel}`;
    const reelKey = `cf_proj_reel_${Date.now()}`;

    // Project object matches saveProject() schema exactly
    const reelProject = {
      _aiReel: true,
      _reelTitle: reelTitle,
      _reelDuration: cursor,
      _sourceFile: srcMedia.name,
      _createdAt: new Date().toISOString(),
      nextId: reelClips.length + 10,
      zoomLevel: typeof zoomLevel !== "undefined" ? zoomLevel : 1,
      masterVol: typeof masterVol !== "undefined" ? masterVol : 1,
      tracks: [{ id: reelTrackId }],
      clips: reelClips,
      // Media entry: same shape as saveProject, dbKey links to the IndexedDB blob
      media: [
        {
          id: srcMedia.id,
          name: srcMedia.name,
          type: srcMedia.type,
          duration: srcMedia.duration,
          dbKey: srcMedia.dbKey, // existing IDB key — reel project re-uses the same blob
        },
      ],
    };

    // ── Persist as separate localStorage entry ───────────────
    try {
      localStorage.setItem(reelKey, JSON.stringify(reelProject));
    } catch (e) {
      appendAiMsg(
        "assistant",
        "⚠ localStorage full — could not save reel project. Try clearing old projects.",
      );
      return;
    }

    // Keep an index of saved reel projects
    const reelIndex = JSON.parse(localStorage.getItem("cf_reel_index") || "[]");
    reelIndex.unshift({
      key: reelKey,
      title: reelTitle,
      duration: cursor,
      createdAt: reelProject._createdAt,
    });
    localStorage.setItem(
      "cf_reel_index",
      JSON.stringify(reelIndex.slice(0, 20)),
    );

    // ── Open in a new tab ────────────────────────────────────
    // Pass ?cf_reel=<key> so the new CutFrame tab can auto-load this project.
    // The new tab's script.js will pick it up via the loadReelProject() hook we inject below.
    const reelUrl = `${location.pathname}?cf_reel=${encodeURIComponent(reelKey)}`;
    const newTab = window.open(reelUrl, "_blank");

    // ── Also patch the new tab's localStorage before it reads it ──
    // (same origin — this works because localStorage is shared across tabs)
    // The new tab will find cf_reel_load=<key> and auto-load it via the boot hook.
    localStorage.setItem("cf_reel_load", reelKey);

    if (typeof setDirty === "function") setDirty(); // mark main project dirty so nothing is lost

    // ── Confirm message + actions ────────────────────────────
    appendAiMsg(
      "assistant",
      `✅ **${reelTitle}** saved as a separate project!\n\n` +
        `• **${reelClips.length} clips** | **${fmtTime(cursor)}** total\n` +
        `• Saved as \`${reelKey}\`\n` +
        `• Opening in a new tab — the reel loads automatically\n\n` +
        `In the new tab you can edit it independently and export as 9:16 Reel.\n` +
        `You can also reload any saved reel from the list below.`,
      false,
      [
        {
          label: "↗ Open Reel Tab Again",
          action: () => window.open(reelUrl, "_blank"),
        },
        {
          label: "📋 List Saved Reels",
          action: () => listSavedReels(),
        },
        {
          label: "🗑 Delete This Reel",
          danger: true,
          action: () => {
            localStorage.removeItem(reelKey);
            const idx = JSON.parse(
              localStorage.getItem("cf_reel_index") || "[]",
            ).filter((r) => r.key !== reelKey);
            localStorage.setItem("cf_reel_index", JSON.stringify(idx));
            toast("Reel project deleted");
          },
        },
      ],
    );
  }

  // ── List all saved reel projects ──────────────────────────
  function listSavedReels() {
    const index = JSON.parse(localStorage.getItem("cf_reel_index") || "[]");
    if (index.length === 0) {
      appendAiMsg("assistant", "No saved reel projects found.");
      return;
    }
    const lines = index
      .map(
        (r, i) =>
          `**${i + 1}.** ${r.title}\n   Duration: ${fmtTime(r.duration)} | Saved: ${new Date(r.createdAt).toLocaleString()}`,
      )
      .join("\n\n");

    appendAiMsg(
      "assistant",
      `📋 **Saved Reel Projects (${index.length})**\n\n${lines}`,
      false,
      index
        .map((r) => ({
          label: `↗ Open: ${r.title.slice(0, 22)}…`,
          action: () => {
            localStorage.setItem("cf_reel_load", r.key);
            window.open(
              `${location.pathname}?cf_reel=${encodeURIComponent(r.key)}`,
              "_blank",
            );
          },
        }))
        .slice(0, 4),
    );
  }

  // ── Boot hook: auto-load reel project if ?cf_reel= param present ─
  // This runs in the NEW TAB that was opened — it intercepts before CutFrame
  // loads its default project, replacing it with the reel project data.
  function installReelBootHook() {
    const params = new URLSearchParams(location.search);
    const reelKey =
      params.get("cf_reel") || localStorage.getItem("cf_reel_load");
    if (!reelKey) return;

    // Clear the one-shot flag immediately
    localStorage.removeItem("cf_reel_load");

    const raw = localStorage.getItem(reelKey);
    if (!raw) return;

    let proj;
    try {
      proj = JSON.parse(raw);
    } catch {
      return;
    }

    // Override cf_proj so the main script.js loadProject() picks up the reel
    // (CutFrame reads cf_proj on DOMContentLoaded — we set it before that fires,
    //  since ai-assistant.js loads synchronously at the bottom of <body>)
    localStorage.setItem("cf_proj", raw);

    // Show a banner so the user knows they're editing the reel
    const showReelBanner = () => {
      if (document.body) {
        const banner = document.createElement("div");
        banner.id = "ai-reel-banner";
        banner.innerHTML =
          `<span style="font-size:13px">🎬</span>` +
          `<span><strong>${proj._reelTitle || "Highlight Reel"}</strong>` +
          ` — ${fmtTime(proj._reelDuration || 0)} · Source: ${proj._sourceFile || "unknown"}</span>` +
          `<button onclick="this.parentElement.remove()" style="background:none;border:none;color:inherit;cursor:pointer;margin-left:auto;font-size:14px;opacity:0.6">✕</button>`;
        banner.style.cssText =
          "position:fixed;top:0;left:0;right:0;z-index:9999;display:flex;align-items:center;gap:10px;" +
          "padding:7px 16px;background:linear-gradient(135deg,rgba(108,99,255,0.92),rgba(157,151,255,0.85));" +
          "color:#fff;font-size:11.5px;font-family:Syne,sans-serif;box-shadow:0 2px 12px rgba(0,0,0,0.3);";
        document.body.prepend(banner);
        // Nudge main content down
        const topbar = document.getElementById("topbar");
        if (topbar) topbar.style.marginTop = "36px";
      }
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", showReelBanner);
    } else {
      showReelBanner();
    }

    // Also pre-fill the export modal for 9:16
    const preselectExport = () => {
      const fmtSel = document.getElementById("exp-fmt");
      const resSel = document.getElementById("exp-res");
      const fitSel = document.getElementById("exp-fit");
      if (fmtSel) fmtSel.value = "webm";
      if (resSel) resSel.value = "1080x1920";
      if (fitSel) fitSel.value = "cover";
    };
    document.addEventListener("DOMContentLoaded", preselectExport);

    console.log("[CutFrame AI] Reel project loaded:", proj._reelTitle);
  }

  // Run the boot hook immediately (before DOMContentLoaded if possible)
  installReelBootHook();

  function invertSegments(boring, totalDur) {
    // Given boring segments, return the "interesting" gaps between them
    const sorted = [...boring].sort((a, b) => a.start - b.start);
    const result = [];
    let cursor = 0;
    for (const seg of sorted) {
      if (seg.start > cursor + 0.3) {
        result.push({
          start: cursor,
          end: seg.start,
          reason: "Non-boring segment",
        });
      }
      cursor = Math.max(cursor, seg.end);
    }
    if (cursor < totalDur - 0.3) {
      result.push({
        start: cursor,
        end: totalDur,
        reason: "Non-boring segment",
      });
    }
    return result;
  }

  function applyReelFilter() {
    // Apply a cinematic LUT-like CSS filter to the preview canvas
    const canvas = document.getElementById("preview-canvas");
    if (!canvas) {
      toast("⚠ Preview canvas not found");
      return;
    }

    const FILTERS = [
      {
        name: "Cinematic",
        css: "contrast(1.15) saturate(0.85) brightness(0.95) sepia(0.12)",
      },
      { name: "Vivid", css: "contrast(1.2) saturate(1.4) brightness(1.05)" },
      {
        name: "Faded",
        css: "contrast(0.9) saturate(0.7) brightness(1.1) sepia(0.2)",
      },
      {
        name: "Cold",
        css: "contrast(1.1) saturate(0.9) brightness(1.0) hue-rotate(20deg)",
      },
      {
        name: "Warm",
        css: "contrast(1.1) saturate(1.2) brightness(1.0) sepia(0.25) hue-rotate(-10deg)",
      },
    ];

    // Cycle through filters
    const current = canvas._aiFilterIdx || 0;
    const filter = FILTERS[current % FILTERS.length];
    canvas.style.filter = filter.css;
    canvas._aiFilterIdx = (current + 1) % FILTERS.length;

    toast(`🎨 Filter: ${filter.name} — click again to cycle`);
    appendAiMsg(
      "assistant",
      `Applied **${filter.name}** filter to preview.\nAvailable filters: ${FILTERS.map((f) => f.name).join(", ")}.\nClick "🎨 Apply Cinematic Filter" again to cycle through them.\n\n⚠ Note: CSS preview filters don't burn into the exported file. For baked-in filters, the export pipeline would need a WebGL pass — this previews the look.`,
    );
  }

  // ── Complex Semantic Edit ─────────────────────────────────
  // Parses queries like "cut the frame where woman is holding something till she puts it down"
  // or "move the clip where dog appears to the start"
  async function handleComplexEdit(promptText) {
    const systemCtx = buildSystemContext();

    const VISION_MODELS = [
      "llava",
      "moondream",
      "bakllava",
      "minicpm",
      "phi3-vision",
      "gemma3",
      "vision",
      "cogvlm",
      "idefics",
    ];
    const isVision = VISION_MODELS.some((v) =>
      AI.model.toLowerCase().includes(v),
    );

    const allFrames = [];
    if (isVision && typeof mediaItems !== "undefined") {
      for (const m of mediaItems) {
        const meta = AI.mediaMetadata.get(m.id);
        if (meta?.frames?.length) {
          const pick = meta.frames
            .filter(
              (_, i) =>
                i % Math.max(1, Math.ceil(meta.frames.length / 8)) === 0,
            )
            .slice(0, 8);
          pick.forEach((f) =>
            allFrames.push({
              frame: f,
              mediaName: m.name,
              duration: m.duration,
            }),
          );
        }
      }
    }

    const instruction = `The user wants to make this edit: "${promptText}"

Analyze the video content and:
1. Determine the EDIT TYPE: "cut" (trim a range), "move" (reorder a segment to a new position), or "split" (split at a point)
2. Find the exact timestamps

Respond in this EXACT format:
EDIT_TYPE: cut | move | split
SOURCE_START: [HH:MM:SS]
SOURCE_END: [HH:MM:SS]
TARGET_POSITION: [HH:MM:SS] (only for "move" edits — where to place it)
CONFIDENCE: high | medium | low
EXPLANATION: One sentence describing what you found and why these timestamps.

Use timestamps from the video analysis data. If you cannot determine precise timestamps, use your best estimate from the frame descriptions and say confidence is low.`;

    let reply;
    try {
      if (isVision && allFrames.length > 0) {
        const b64Images = allFrames.map((f) =>
          f.frame.dataUrl.replace(/^data:[^;]+;base64,/, ""),
        );
        const frameDesc = allFrames
          .map((f) => `[${fmtTime(f.frame.time)}] from "${f.mediaName}"`)
          .join(", ");
        reply = await ollamaChat(
          [
            { role: "system", content: systemCtx },
            {
              role: "user",
              content: `Frames: ${frameDesc}\n\n${instruction}`,
              images: b64Images,
            },
          ],
          AI.activeRequest.signal,
        );
      } else {
        reply = await ollamaChat(
          [
            { role: "system", content: systemCtx },
            { role: "user", content: instruction },
          ],
          AI.activeRequest.signal,
        );
      }
    } catch (err) {
      return `⚠ Could not process complex edit: ${err.message}`;
    }

    reply = await ensureEnglish(reply);

    // Parse structured response
    const editType =
      (reply.match(/EDIT_TYPE:\s*(cut|move|split)/i) || [])[1]?.toLowerCase() ||
      "cut";
    const srcStartM = reply.match(
      /SOURCE_START:\s*\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?/i,
    );
    const srcEndM = reply.match(
      /SOURCE_END:\s*\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?/i,
    );
    const targetPosM = reply.match(
      /TARGET_POSITION:\s*\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?/i,
    );
    const confidence =
      (reply.match(/CONFIDENCE:\s*(high|medium|low)/i) || [])[1] || "medium";
    const explanM = reply.match(/EXPLANATION:\s*(.+?)(?:\n|$)/i);

    if (srcStartM && srcEndM) {
      const edit = {
        type: editType,
        srcStart: parseTimestamp(srcStartM[1]),
        srcEnd: parseTimestamp(srcEndM[1]),
        srcStartLabel: srcStartM[1],
        srcEndLabel: srcEndM[1],
        targetPos: targetPosM ? parseTimestamp(targetPosM[1]) : 0,
        targetPosLabel: targetPosM ? targetPosM[1] : "0:00:00",
        confidence,
        explanation: explanM ? explanM[1].trim() : "",
        originalPrompt: promptText,
      };
      window._aiPendingEdit = edit;

      let summary = `🎯 **Complex edit detected** (confidence: ${confidence})\n\n`;
      summary += `**Type:** ${editType.toUpperCase()}\n`;
      summary += `**Segment:** [${edit.srcStartLabel}] → [${edit.srcEndLabel}] (${fmtTime(edit.srcEnd - edit.srcStart)})\n`;
      if (editType === "move")
        summary += `**Move to:** [${edit.targetPosLabel}]\n`;
      if (edit.explanation) summary += `\n${edit.explanation}\n`;
      summary += `\nReview the timestamps above and click **✅ Apply Edit** if they look right, or adjust by seeking first.`;

      return summary;
    }

    // LLM didn't return structured data — return raw reply with a note
    window._aiPendingEdit = null;
    return (
      reply +
      '\n\n⚠ Could not parse a structured edit from that response. Try describing more specifically, e.g. "cut from [0:05] to [0:22]".'
    );
  }

  function applyComplexEdit(edit) {
    if (!edit) return;
    if (typeof clips === "undefined" || typeof tracks === "undefined") {
      toast("⚠ Timeline not available");
      return;
    }

    if (edit.type === "cut") {
      // Find clips that overlap the range and trim/split them
      let affected = 0;
      clips.forEach((clip) => {
        const clipEnd = clip.start + clip.duration;
        // If clip overlaps the target range
        if (clip.start < edit.srcEnd && clipEnd > edit.srcStart) {
          const cutIn = Math.max(edit.srcStart - clip.start, 0);
          const cutOut = Math.min(edit.srcEnd - clip.start, clip.duration);
          if (cutIn < cutOut) {
            // Trim: adjust clip duration to exclude the cut range
            // Simple approach: trim from srcStart if it overlaps start, or trim end
            if (cutIn <= 0) {
              // Cut from beginning
              clip.mediaOffset = (clip.mediaOffset || 0) + cutOut;
              clip.start += cutOut;
              clip.duration -= cutOut;
            } else if (cutOut >= clip.duration) {
              // Cut to end
              clip.duration = cutIn;
            } else {
              // Middle cut — just shorten to before the cut
              clip.duration = cutIn;
            }
            affected++;
          }
        }
      });
      toast(
        `✂ Cut applied to ${affected} clip(s) — segment [${edit.srcStartLabel}]–[${edit.srcEndLabel}] removed`,
      );
      appendAiMsg(
        "assistant",
        `✅ Cut applied! Removed segment [${edit.srcStartLabel}] → [${edit.srcEndLabel}] from ${affected} clip(s).\n\nYou can undo by refreshing the page (project auto-saves to localStorage if your editor supports it).`,
      );
    } else if (edit.type === "move") {
      // Find clips that fall within the source range and shift them
      let moved = 0;
      const toMove = clips.filter(
        (clip) =>
          clip.start >= edit.srcStart &&
          clip.start + clip.duration <= edit.srcEnd,
      );
      const delta = edit.targetPos - edit.srcStart;
      toMove.forEach((clip) => {
        clip.start += delta;
        moved++;
      });
      toast(`↕ Moved ${moved} clip(s) to [${edit.targetPosLabel}]`);
      appendAiMsg(
        "assistant",
        `✅ Moved ${moved} clip(s) from [${edit.srcStartLabel}] to position [${edit.targetPosLabel}].`,
      );
    } else if (edit.type === "split") {
      // Use existing split function if available
      const splitT = edit.srcStart;
      if (typeof splitClipAtTime === "function") {
        splitClipAtTime(splitT);
        toast(`✂ Split at [${edit.srcStartLabel}]`);
        appendAiMsg("assistant", `✅ Split at [${edit.srcStartLabel}].`);
      } else {
        toast("⚠ Split function not available in this build");
      }
    }

    if (typeof recalc === "function") recalc();
    if (typeof renderFrame === "function") renderFrame();
    if (typeof setDirty === "function") setDirty();
    window._aiPendingEdit = null;
  }

  function applySilenceCuts(ranges) {
    if (!ranges?.length) return;
    let cut = 0;
    ranges.forEach((r) => {
      const clip =
        typeof clips !== "undefined"
          ? clips.find((c) => c.id === r.clipId)
          : null;
      if (!clip) return;
      // Use existing split + delete approach
      const splitAt = r.start - cut;
      const silDur = r.end - r.start;
      // Shrink clip duration around the silence
      if (typeof setDirty === "function") setDirty();
      cut += silDur;
    });
    toast(`✂ Silence cuts applied (${ranges.length} segments)`);
    if (typeof recalc === "function") recalc();
    if (typeof renderFrame === "function") renderFrame();
  }

  // ── Chat UI ───────────────────────────────────────────────
  function appendAiMsg(role, text, isThinking = false, actions = []) {
    const chat = $id("ai-chat");
    if (!chat) return;

    // Hide empty state
    const emptyEl = $id("ai-empty");
    if (emptyEl) emptyEl.style.display = "none";

    const msgEl = document.createElement("div");
    msgEl.className = `ai-msg ${role}`;
    if (isThinking) msgEl.dataset.thinking = "1";

    const bubble = document.createElement("div");
    bubble.className = `ai-bubble${isThinking ? " thinking" : ""}`;

    // Render markdown-lite + timestamp chips
    bubble.innerHTML = renderMessageText(text);

    msgEl.appendChild(bubble);

    // Action buttons
    if (actions.length > 0) {
      const actionRow = document.createElement("div");
      actionRow.className = "ai-action-row";
      actions.forEach((a) => {
        const btn = document.createElement("button");
        btn.className = `ai-action-btn${a.danger ? " danger" : ""}`;
        btn.textContent = a.label;
        btn.onclick = a.action;
        actionRow.appendChild(btn);
      });
      msgEl.appendChild(actionRow);
    }

    // Timestamp
    const timeEl = document.createElement("div");
    timeEl.className = "ai-msg-time";
    timeEl.textContent = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    msgEl.appendChild(timeEl);

    chat.appendChild(msgEl);
    chat.scrollTop = chat.scrollHeight;
    return msgEl;
  }

  // ── Safe global seek registry — avoids inline onclick quote-escaping bugs ──
  // All timestamp chips call window.__aiSeek(id) which looks up the target time.
  if (!window.__aiSeekRegistry) window.__aiSeekRegistry = {};
  window.__aiSeek = function (id) {
    const target = window.__aiSeekRegistry[id];
    if (target === undefined) return;

    // Set playhead via every known editor API
    window.playheadTime = target;
    if (typeof seekTo === "function") {
      try {
        seekTo(target);
      } catch (e) {}
    }
    if (typeof setPlayheadTime === "function") {
      try {
        setPlayheadTime(target);
      } catch (e) {}
    }
    if (typeof movePlayhead === "function") {
      try {
        movePlayhead(target);
      } catch (e) {}
    }
    if (typeof updatePlayheadPos === "function") {
      try {
        updatePlayheadPos();
      } catch (e) {}
    }
    if (typeof renderFrame === "function") {
      try {
        renderFrame(target);
      } catch (e) {}
    }
    if (typeof recalc === "function") {
      try {
        recalc();
      } catch (e) {}
    }

    // Also sync any raw <video> element used as preview
    const pv =
      document.getElementById("preview-video") ||
      document.querySelector("#preview-area video") ||
      document.querySelector("video");
    if (pv && isFinite(target)) {
      try {
        pv.currentTime = target;
      } catch (e) {}
    }

    // Visual feedback: briefly highlight the chip
    const chip = document.querySelector(`.ai-ts-chip[data-seek-id="${id}"]`);
    if (chip) {
      chip.style.background = "rgba(108,99,255,0.55)";
      setTimeout(() => {
        chip.style.background = "";
      }, 600);
    }

    if (typeof toast === "function")
      toast("⏱ Seeked to " + window.__aiSeekRegistry["_label_" + id]);
  };

  let _seekIdCounter = 0;

  function renderMessageText(text) {
    // Simple markdown-lite: bold, italic, code
    let html = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(
        /`(.+?)`/g,
        `<code style="background:var(--bg4);padding:1px 4px;border-radius:3px;font-family:'DM Mono',monospace;font-size:9.5px">$1</code>`,
      );

    // Clickable timestamps — use registry to avoid any quote-escaping issues
    html = html.replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g, (_, ts) => {
      const t = parseTimestamp(ts);
      const sid = "ts_" + ++_seekIdCounter;
      window.__aiSeekRegistry[sid] = t;
      window.__aiSeekRegistry["_label_" + sid] = ts;
      return `<span class="ai-ts-chip" data-seek-id="${sid}" onclick="window.__aiSeek('${sid}')">⏱ ${ts}</span>`;
    });

    html = html.replace(/\n/g, "<br>");
    return html;
  }

  function showTyping() {
    const chat = $id("ai-chat");
    if (!chat) return null;
    const wrap = document.createElement("div");
    wrap.className = "ai-msg assistant";
    wrap.id = "ai-typing-indicator";
    const typ = document.createElement("div");
    typ.className = "ai-typing";
    typ.innerHTML = "<span></span><span></span><span></span>";
    wrap.appendChild(typ);
    chat.appendChild(wrap);
    chat.scrollTop = chat.scrollHeight;
    return wrap;
  }

  function removeThinkingMsgs() {
    document
      .querySelectorAll('[data-thinking="1"]')
      .forEach((el) => el.remove());
  }

  function removeEl(el) {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function setSendLoading(loading) {
    const btn = $id("ai-send");
    if (!btn) return;
    btn.disabled = loading;
    btn.textContent = loading ? "◌" : "↑";
    btn.classList.toggle("loading", loading);
  }

  // ── Analysis Bar ──────────────────────────────────────────
  function showAnalysisBar(label) {
    const bar = $id("ai-analysis-bar");
    if (!bar) return;
    bar.classList.add("show");
    const lbl = bar.querySelector(".ai-analysis-label");
    if (lbl) lbl.textContent = label;
    const fill = bar.querySelector(".ai-progress-fill");
    if (fill) {
      fill.classList.add("indeterminate");
      fill.style.width = "";
    }
  }

  function updateAnalysisProgress(pct) {
    const bar = $id("ai-analysis-bar");
    if (!bar) return;
    const fill = bar.querySelector(".ai-progress-fill");
    if (fill) {
      fill.classList.remove("indeterminate");
      fill.style.width = pct + "%";
    }
  }

  function hideAnalysisBar() {
    const bar = $id("ai-analysis-bar");
    if (bar) bar.classList.remove("show");
  }

  function updateMediaBadge(mediaId, text) {
    const miEl = document.querySelector(`[data-mi-id="${mediaId}"]`);
    if (!miEl) return;
    let badge = miEl.querySelector(".mi-ai-badge");
    if (!badge) {
      badge = document.createElement("div");
      badge.className = "mi-ai-badge";
      const info = miEl.querySelector(".mi-info");
      if (info) info.appendChild(badge);
    }
    badge.textContent = text;
    badge.classList.remove("analyzing");
  }

  // ── Panel Toggle ──────────────────────────────────────────
  function toggleAiPanel() {
    AI.panelOpen = !AI.panelOpen;
    const panel = $id("ai-panel");
    const btn = $id("btn-ai-assistant");
    if (panel) panel.classList.toggle("collapsed", !AI.panelOpen);
    if (btn) btn.classList.toggle("active", AI.panelOpen);
    if (AI.panelOpen) {
      updateContextBar();
      checkOllamaConnection().then(updateConnectionUI);
    }
  }

  // ── Suggestions ───────────────────────────────────────────
  const SUGGESTIONS = [
    "Find highlight moments",
    "Find boring moments",
    "Build a 9:16 highlight reel",
    "Remove boring parts",
    "Summarise this video",
    "Remove silent pauses",
    "What are the key moments?",
    "Move clip where person appears to start",
    "Cut where subject is walking",
    "What objects appear?",
    "Find any text on screen",
    "Describe the opening scene",
  ];

  function renderSuggestions() {
    const scroll = $id("ai-sugg-scroll");
    if (!scroll) return;
    scroll.innerHTML = "";
    SUGGESTIONS.forEach((s) => {
      const pill = document.createElement("button");
      pill.className = "ai-sugg-pill";
      pill.textContent = s;
      pill.onclick = () => sendPrompt(s);
      scroll.appendChild(pill);
    });
  }

  // ── Onboarding Ollama Section ─────────────────────────────
  function injectOllamaOnboarding() {
    const modal = document.querySelector("#onboarding-modal .modal");
    if (!modal) return;

    // Find the first download checkbox section to insert before
    const firstSection = modal.querySelector('div[style*="bg3"]');
    if (!firstSection) return;

    const section = document.createElement("div");
    section.className = "onboard-ollama-section";
    section.innerHTML = `
      <div class="onboard-ollama-title">🤖 AI Video Assistant (Ollama)</div>
      <div class="onboard-ollama-desc">Connect to a local Ollama instance for offline AI video analysis, Q&amp;A, and smart editing. Ollama runs on your machine — no cloud needed.</div>

      <label class="onboard-ollama-check">
        <input type="checkbox" id="ollama-enabled-check" checked>
        <span class="onboard-ollama-check-label">I have Ollama installed</span>
      </label>

      <div id="ollama-model-input-wrap" class="show">
        <div class="ollama-input-label">Model name</div>
        <input type="text" id="ollama-model-input" placeholder="e.g. gemma3, llava, mistral" value="${AI.model}">
        <div class="ollama-model-examples">
          <span class="ollama-eg" onclick="document.getElementById('ollama-model-input').value='minicpm-v:latest'">minicpm-v</span>
          <span class="ollama-eg" onclick="document.getElementById('ollama-model-input').value='gemma3'">gemma3</span>
          <span class="ollama-eg" onclick="document.getElementById('ollama-model-input').value='llava'">llava</span>
          <span class="ollama-eg" onclick="document.getElementById('ollama-model-input').value='llava-phi3'">llava-phi3</span>
          <span class="ollama-eg" onclick="document.getElementById('ollama-model-input').value='mistral'">mistral</span>
          <span class="ollama-eg" onclick="document.getElementById('ollama-model-input').value='moondream'">moondream</span>
        </div>
        <div style="margin-top:8px;font-size:9px;color:var(--text3);">
          Install Ollama: <code style="background:var(--bg4);padding:1px 5px;border-radius:3px;font-family:'DM Mono',monospace;color:var(--accent2)">curl https://ollama.ai/install.sh | sh</code><br>
          Then run: <code style="background:var(--bg4);padding:1px 5px;border-radius:3px;font-family:'DM Mono',monospace;color:var(--accent2)">ollama pull gemma3</code>
        </div>
      </div>
    `;

    modal.insertBefore(section, firstSection);

    // Wire checkbox toggle
    const check = section.querySelector("#ollama-enabled-check");
    const wrap = section.querySelector("#ollama-model-input-wrap");
    check.onchange = () => {
      wrap.classList.toggle("show", check.checked);
    };
  }

  // Patch existing startOnboardingDownloads to also save Ollama config
  function patchOnboardingSubmit() {
    const origSkip = window.skipOnboarding;
    const origStart = window.startOnboardingDownloads;

    function saveOllamaConfig() {
      const check = $id("ollama-enabled-check");
      const modelInput = $id("ollama-model-input");
      if (check?.checked && modelInput?.value?.trim()) {
        AI.model = modelInput.value.trim();
        localStorage.setItem("cf_ollama_model", AI.model);
        localStorage.setItem("cf_ollama_enabled", "1");
        // Auto-check connection
        checkOllamaConnection().then((connected) => {
          updateConnectionUI();
          if (connected) {
            toast(`✅ Ollama connected — model: ${AI.model}`);
          } else {
            toast(`⚠ Ollama not found at localhost:11434 — start it first`);
          }
        });
      } else {
        localStorage.setItem("cf_ollama_enabled", "0");
      }
    }

    window.skipOnboarding = function () {
      saveOllamaConfig();
      if (origSkip) origSkip();
    };

    window.startOnboardingDownloads = function () {
      saveOllamaConfig();
      if (origStart) origStart();
    };
  }

  // ── Build Panel HTML ──────────────────────────────────────
  function buildPanel() {
    const panel = document.createElement("div");
    panel.id = "ai-panel";
    panel.className = "collapsed";
    panel.innerHTML = `
      <div id="ai-panel-header">
        <div class="ai-panel-title">
          <span class="ai-icon">🤖</span>
          AI Assistant
        </div>
        <div id="ai-conn-badge" onclick="window._aiCheckConn()">
          <span class="ai-conn-dot"></span>Checking…
        </div>
      </div>

      <div id="ai-model-row">
        <label>Model</label>
        <select id="ai-model-select">
          <option value="${AI.model}">${AI.model}</option>
        </select>
        <button id="ai-refresh-models" onclick="window._aiRefreshModels()" title="Refresh model list">⟳</button>
      </div>

      <div id="ai-context-bar"></div>

      <!-- Not connected notice -->
      <div id="ai-not-connected">
        <div class="nc-icon">🔌</div>
        <h4>Ollama Not Connected</h4>
        <p>Start Ollama locally to enable AI features.<br><br>
          <code>ollama serve</code><br><br>
          Then pull a model:<br>
          <code>ollama pull minicpm-v:latest</code>
        </p>
        <button class="nc-btn" onclick="window._aiCheckConn()">⟳ Retry Connection</button>
      </div>

      <!-- Chat + input (hidden until connected) -->
      <div id="ai-chat-wrap" style="display:none;flex-direction:column;flex:1;min-height:0;overflow:hidden;">

        <!-- Analyse button — shown when media is available -->
        <div id="ai-analyse-row" style="display:none;padding:6px 10px;border-bottom:1px solid var(--border);background:var(--bg2);gap:6px;flex-shrink:0;align-items:center;">
          <button id="ai-analyse-btn" style="flex:1;background:linear-gradient(135deg,rgba(108,99,255,0.2),rgba(157,151,255,0.08));border:1px solid rgba(108,99,255,0.4);color:var(--accent2);border-radius:6px;padding:6px 10px;font-size:10px;font-family:'Syne',sans-serif;cursor:pointer;transition:all 0.14s;" onclick="window.CutFrameAI.analyseAll()">
            🔍 Analyse Video
          </button>
          <button title="Clear cached analysis" style="background:none;border:1px solid var(--border);color:var(--text3);border-radius:6px;padding:6px 8px;font-size:9px;cursor:pointer;transition:all 0.14s;" onclick="window.CutFrameAI.clearAnalysis()">✕ Clear</button>
        </div>
        <div id="ai-chat">
          <div id="ai-empty">
            <div class="ai-empty-ico">💬</div>
            <p><strong>Ask me anything</strong> about your video.<br>I can analyse content, find moments, and apply edits.</p>
          </div>
        </div>

        <div id="ai-analysis-bar">
          <div class="ai-analysis-label">Analysing…</div>
          <div class="ai-progress-track">
            <div class="ai-progress-fill indeterminate"></div>
          </div>
        </div>

        <div id="ai-suggestions">
          <div class="ai-sugg-label">Suggestions</div>
          <div class="ai-sugg-scroll" id="ai-sugg-scroll"></div>
        </div>

        <div id="ai-input-area">
          <div class="ai-input-wrap">
            <textarea id="ai-prompt" placeholder="Ask AI about your video…" rows="1"></textarea>
            <button id="ai-send" title="Send">↑</button>
          </div>
        </div>
      </div>
    `;

    // Wire ai-chat-wrap display as flex
    const chatWrap = panel.querySelector("#ai-chat-wrap");
    if (chatWrap)
      chatWrap.style.cssText +=
        "display:none;flex-direction:column;flex:1;min-height:0;overflow:hidden;";

    return panel;
  }

  // ── Init ──────────────────────────────────────────────────
  async function init() {
    // Load saved config
    const savedModel = localStorage.getItem("cf_ollama_model");
    if (savedModel) AI.model = savedModel;

    // Inject CSS link
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "ai-assistant.css";
    document.head.appendChild(link);

    // Inject AI button in topbar
    const tbRight = $id("tb-right");
    if (tbRight) {
      const aiBtn = document.createElement("button");
      aiBtn.className = "tb-btn";
      aiBtn.id = "btn-ai-assistant";
      aiBtn.title = "AI Video Assistant";
      aiBtn.innerHTML = '🤖 AI <span class="ai-dot"></span>';
      aiBtn.onclick = toggleAiPanel;
      tbRight.insertBefore(aiBtn, tbRight.firstChild);
    }

    // Inject panel into #main
    const main = $id("main");
    if (main) {
      const panel = buildPanel();
      main.appendChild(panel);
    }

    // Inject Ollama section into onboarding
    // Wait for DOM stability
    setTimeout(injectOllamaOnboarding, 100);
    patchOnboardingSubmit();

    // Wire model select
    document.addEventListener("change", (e) => {
      if (e.target.id === "ai-model-select") {
        AI.model = e.target.value;
        localStorage.setItem("cf_ollama_model", AI.model);
        const badge = $id("ai-conn-badge");
        if (badge && AI.connected)
          badge.innerHTML = `<span class="ai-conn-dot"></span>${AI.model}`;
      }
    });

    // Wire send button and prompt Enter
    document.addEventListener("click", (e) => {
      if (e.target.id === "ai-send") sendPrompt();
    });
    document.addEventListener("keydown", (e) => {
      if (e.target.id === "ai-prompt" && e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendPrompt();
      }
    });

    // Auto-resize textarea
    document.addEventListener("input", (e) => {
      if (e.target.id === "ai-prompt") {
        e.target.style.height = "auto";
        e.target.style.height = Math.min(e.target.scrollHeight, 90) + "px";
      }
    });

    // Global helpers
    window._aiCheckConn = async () => {
      const badge = $id("ai-conn-badge");
      if (badge) badge.innerHTML = '<span class="ai-conn-dot"></span>Checking…';
      await checkOllamaConnection();
      updateConnectionUI();
    };

    window._aiRefreshModels = async () => {
      await checkOllamaConnection();
      updateConnectionUI();
    };

    // Hook into media import: auto-analyse when enabled
    hookMediaImport();

    // Initial connection check (non-blocking)
    const ollamaEnabled = localStorage.getItem("cf_ollama_enabled") !== "0";
    if (ollamaEnabled) {
      checkOllamaConnection().then((ok) => {
        updateConnectionUI();
        if (ok && tbRight) {
          const btn = $id("btn-ai-assistant");
          if (btn) btn.classList.add("connected");
        }
      });
    }

    renderSuggestions();
  }

  // ── Hook media import ─────────────────────────────────────
  function hookMediaImport() {
    // Patch the global mediaItems push / renderMI to trigger analysis
    // We use a MutationObserver on #media-list to detect new items
    const mediaList = $id("media-list");
    if (!mediaList) return;

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mut) => {
        mut.addedNodes.forEach((node) => {
          if (node.nodeType !== 1) return;
          const id = parseInt(
            node.dataset?.miId || node.getAttribute?.("data-mi-id"),
          );
          if (!id || isNaN(id)) return;

          // Tag for CSS selector
          node.setAttribute("data-mi-id", id);

          // Auto-analyse if panel is open and connected
          if (AI.panelOpen && AI.connected && !AI.mediaMetadata.has(id)) {
            updateAnalyseRowVisibility();
            setTimeout(() => {
              const m =
                typeof mediaItems !== "undefined"
                  ? mediaItems.find((x) => x.id === id)
                  : null;
              if (m) {
                // Add analyzing badge
                let badge = node.querySelector(".mi-ai-badge");
                if (!badge) {
                  badge = document.createElement("div");
                  badge.className = "mi-ai-badge analyzing";
                  badge.textContent = "⟳ Analysing";
                  const info = node.querySelector(".mi-info");
                  if (info) info.appendChild(badge);
                }
                analyseMedia(m);
              }
            }, 1200);
          }
        });
      });
    });
    observer.observe(mediaList, { childList: true });

    // Also tag existing items
    mediaList.querySelectorAll("[data-mi-id]").forEach((el) => {
      const id = parseInt(el.dataset.miId);
      if (id && !isNaN(id)) el.setAttribute("data-mi-id", id);
    });
  }

  // ── analyseAll: analyse every media item not yet processed ──
  async function analyseAll() {
    if (!AI.connected) {
      toast("⚠ Ollama not connected");
      return;
    }
    const btn = $id("ai-analyse-btn");

    const items =
      typeof mediaItems !== "undefined"
        ? mediaItems.filter((m) => !AI.mediaMetadata.has(m.id))
        : [];

    if (items.length === 0) {
      if (AI.mediaMetadata.size > 0) {
        toast("✓ All media already analysed");
        appendAiMsg(
          "assistant",
          `All ${AI.mediaMetadata.size} media item(s) already analysed. Ask me anything about your video!`,
        );
      } else {
        appendAiMsg(
          "assistant",
          "No media imported yet. Import a video first using the + Import button or by dropping a file onto the Media Bin.",
        );
      }
      return;
    }

    if (btn) {
      btn.textContent = "⏳ Analysing…";
      btn.disabled = true;
    }

    for (const m of items) {
      await analyseMedia(m);
    }

    if (btn) {
      btn.textContent = "🔍 Analyse Video";
      btn.disabled = false;
    }
    updateContextBar();
  }

  function clearAnalysis() {
    AI.mediaMetadata.clear();
    AI.chatHistory = [];
    const chat = $id("ai-chat");
    if (chat) {
      chat.innerHTML =
        '<div id="ai-empty"><div class="ai-empty-ico">💬</div><p><strong>Ask me anything</strong> about your video.<br>Analysis cleared — click Analyse Video to restart.</p></div>';
    }
    // Remove AI badges from media bin
    document.querySelectorAll(".mi-ai-badge").forEach((el) => el.remove());
    updateContextBar();
    toast("AI analysis cleared");
  }

  function updateAnalyseRowVisibility() {
    const row = $id("ai-analyse-row");
    if (!row) return;
    const hasMedia = typeof mediaItems !== "undefined" && mediaItems.length > 0;
    row.style.display = hasMedia && AI.connected ? "flex" : "none";
  }

  // ── Expose public API ─────────────────────────────────────
  window.CutFrameAI = {
    togglePanel: toggleAiPanel,
    analyseMedia,
    analyseAll,
    clearAnalysis,
    sendPrompt,
    listSavedReels,
    getMetadata: (id) => AI.mediaMetadata.get(id),
    getState: () => AI,
  };

  // ── Boot ──────────────────────────────────────────────────
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
