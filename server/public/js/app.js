import React, { useState, useEffect, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import htm from "htm";
import { createRoverScene } from "./scene.js";
import { t, getLang, setLang, LANGS, ttsVoice, speechLang, ONBOARDING } from "./i18n.js";

const html = htm.bind(React.createElement);

// ESP32-CAM MJPEG stream. Matches MDNS_NAME in esp32-cam/main/main.ino.
// IMPORTANT NOTE: mDNS (.local) can fail on some networks/Androids — swap for
// the cam's raw IP (printed on its serial) if the feed never loads.
const CAM_URL = "http://blackout-cam.local/stream";

/* ---------------- sensor model ---------------- */
const fmt = (v, d) => (v == null || isNaN(v) ? "--" : Number(v).toFixed(d));

// min/max define the meter's full travel. st() returns [labelKey, kind] — the
// label is an i18n key resolved at render time so it follows the language.
const SENSORS = [
  { key: "temp",  unit: "°C",  d: 1, min: 0, max: 60,   st: v => v > 45 ? ["st.critical", "abort"] : v > 35 ? ["st.high", "warn"] : ["st.normal", "go"] },
  { key: "humid", unit: "%",   d: 1, min: 0, max: 100,  st: v => v > 75 ? ["st.humid", "warn"] : v < 20 ? ["st.dry", "warn"] : ["st.good", "go"] },
  // Distance is a navigation cue, never a hazard: only caution when right up on a
  // wall (<10cm), clear otherwise — it's something to steer around, not a danger.
  { key: "dist",  unit: "cm",  d: 0, min: 0, max: 200,  invert: true, st: v => v < 10 ? ["st.tooClose", "warn"] : ["st.clear", "go"] },
  { key: "smoke", unit: "ppm", d: 0, min: 0, max: 1000, st: v => v > 600 ? ["st.hazard", "abort"] : v > 300 ? ["st.warning", "warn"] : ["st.normal", "go"] },
  { key: "airq",  unit: "ppm", d: 0, min: 0, max: 1000, st: v => v > 800 ? ["st.poor", "abort"] : v > 450 ? ["st.moderate", "warn"] : ["st.good", "go"] },
];

const TRENDS = [
  { key: "dist", tkey: "trend.dist", color: "#9a9384" },
  { key: "airq", tkey: "trend.air",  color: "#44cf86" },
  { key: "temp", tkey: "trend.temp", color: "#ff3b2f" },
];

/* ---------------- TTS ---------------- */
let voices = [];
const loadVoices = () => { voices = window.speechSynthesis?.getVoices() || []; };
loadVoices();
if (window.speechSynthesis) speechSynthesis.onvoiceschanged = loadVoices;
function browserSpeak(text, { onStart, onEnd } = {}) {
  if (!text || !window.speechSynthesis || !voices.length) { onEnd?.(); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const sl = speechLang();          // e.g. "en-US" / "es-ES"
  const pre = sl.slice(0, 2);       // "en" / "es"
  u.rate = 0.9; u.lang = sl;
  // ponytail: null when no same-language voice → engine picks by u.lang. Never
  // fall back to voices[0] (usually English) for Spanish text.
  u.voice = voices.find(v => v.lang.startsWith(pre) && /samantha|alex|google|enhanced|jorge|alvaro|helena/i.test(v.name))
    || voices.find(v => v.lang.startsWith(pre)) || null;
  u.onstart = () => onStart?.();
  u.onend = () => onEnd?.();
  u.onerror = () => onEnd?.();
  speechSynthesis.speak(u);
}

// Mission findings: when a metric newly worsens, the Analysis panel logs a discovery.
// Bands match the server's status thresholds so the agent and the panel agree.
const FINDINGS = [
  { k: "temp",  warn: 35,  danger: 45,  msg: { 1: "find.tempUp", 2: "find.tempHigh" } },
  { k: "smoke", warn: 300, danger: 600, msg: { 1: "find.smoke", 2: "find.smokeHeavy" } },
  { k: "airq",  warn: 450, danger: 800, msg: { 1: "find.airDeg", 2: "find.airCrit" } },
  { k: "co",    warn: 300, danger: 350, msg: { 1: "find.gasUp", 2: "find.gasHigh" } },
  { k: "dist",  close: 10,              msg: { 1: "find.obstacle" } },
];
const bandOf = (f, v) => {
  if (v == null || isNaN(v)) return 0;
  if (f.k === "dist") return v < f.close ? 1 : 0;
  return v >= f.danger ? 2 : v >= f.warn ? 1 : 0;
};

// Split into sentences so we can start speaking the FIRST one immediately instead
// of waiting for the whole reply's audio — big cut to time-to-first-sound.
const splitSpeech = (t) => (t.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) || [t]).map(s => s.trim()).filter(Boolean);

// MS Edge / Deepgram neural TTS via server proxy; falls back to browser TTS on failure.
// Plays sentence-by-sentence, prefetching the next clip while the current one plays
// (max 2 concurrent requests, so we don't trip Deepgram's rate limit).
let ttsAudio = null;
let ttsToken = 0;
let ttsOnEnd = null; // active speak()'s onEnd, so stopSpeech() can settle the UI
let ttsProviderRef = "edge"; // "edge" | "deepgram", updated by App toggle
// Cut off whatever's playing: supersede the loop, stop audio, settle the UI.
function stopSpeech() {
  ttsToken++;
  ttsAudio?.pause();
  window.speechSynthesis?.cancel();
  const cb = ttsOnEnd; ttsOnEnd = null; cb?.();
}
async function speak(text, { onStart, onEnd } = {}) {
  stopSpeech();
  const myToken = ttsToken;
  ttsOnEnd = onEnd;
  if (!text) { ttsOnEnd = null; onEnd?.(); return; }
  const parts = splitSpeech(text);
  const mk = (p) => { const a = new Audio("/api/tts?text=" + encodeURIComponent(p) + "&voice=" + encodeURIComponent(ttsVoice()) + "&provider=" + ttsProviderRef); a.preload = "auto"; return a; };
  let started = false;
  const firstStart = () => { if (!started) { started = true; onStart?.(); } };
  let cur = mk(parts[0]);
  for (let i = 0; i < parts.length; i++) {
    if (myToken !== ttsToken) { cur?.pause(); return; } // newer speak() superseded us
    const a = cur;
    const next = i + 1 < parts.length ? mk(parts[i + 1]) : null; // prefetch next clip
    ttsAudio = a;
    try {
      await new Promise((resolve, reject) => {
        a.onended = resolve; a.onerror = reject;
        a.onplay = firstStart;
        a.play().catch(reject);
      });
    } catch {
      if (myToken !== ttsToken) return;
      browserSpeak(parts.slice(i).join(" "), { onStart: firstStart, onEnd }); // proxy/offline fallback
      return;
    }
    cur = next;
  }
  if (myToken === ttsToken) { ttsOnEnd = null; onEnd?.(); }
}

// Onboarding lines are pre-rendered to /audio/onboard-<lang>-<key>.mp3 on the
// server (no 5-7s synth wait). Play the static clip; fall back to live TTS if
// the file is missing (e.g. pregen hasn't run yet).
function playOnboard(key, fallbackText, { onStart, onEnd } = {}) {
  ttsAudio?.pause();
  window.speechSynthesis?.cancel();
  const myToken = ++ttsToken;
  const a = new Audio(`/audio/onboard-${getLang()}-${key}.mp3`);
  ttsAudio = a;
  const fall = () => { if (myToken === ttsToken) speak(fallbackText, { onStart, onEnd }); };
  a.onplay = () => { if (myToken === ttsToken) onStart?.(); };
  a.onended = () => { if (myToken === ttsToken) onEnd?.(); };
  a.onerror = fall;
  a.play().catch(fall);
}

/* ---------------- zone header (folio · title · tag) ---------------- */
function Head({ folio, title, tag, children }) {
  return html`
    <div class="zone-head">
      <div class="zone-head-l">
        <span class="folio">${folio}</span>
        <h2 class="zone-title">${title}</h2>
      </div>
      ${tag ? html`<span class="tag">${tag}</span>` : children}
    </div>`;
}

/* ---------------- canvas: trends ---------------- */
function Trends({ packet }) {
  const ref = useRef(null);
  const hist = useRef([]);
  useEffect(() => {
    if (packet) { hist.current.push(packet); if (hist.current.length > 60) hist.current.shift(); }
    const cv = ref.current; if (!cv) return;
    const r = cv.getBoundingClientRect();
    cv.width = r.width * devicePixelRatio; cv.height = r.height * devicePixelRatio;
    const ctx = cv.getContext("2d"), w = cv.width, h = cv.height, H = hist.current;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(236,229,214,0.06)"; ctx.lineWidth = 1;
    for (let i = 1; i < 12; i++) { ctx.beginPath(); ctx.moveTo((i / 12) * w, 0); ctx.lineTo((i / 12) * w, h); ctx.stroke(); }
    for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(0, (i / 4) * h); ctx.lineTo(w, (i / 4) * h); ctx.stroke(); }
    if (H.length < 2) {
      ctx.fillStyle = "rgba(99,93,81,0.9)"; ctx.font = `600 ${10 * devicePixelRatio}px 'Archivo', sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.save(); ctx.translate(w / 2, h / 2);
      ctx.fillText(t("trend.awaiting"), 0, 0); ctx.restore(); return;
    }
    TRENDS.forEach(s => {
      const vals = H.map(d => d[s.key]).filter(v => v != null && !isNaN(v));
      if (vals.length < 2) return;
      const min = Math.min(...vals), max = Math.max(...vals), rng = (max - min) || 1;
      ctx.beginPath(); let n = 0;
      H.forEach((d, i) => {
        const v = d[s.key]; if (v == null || isNaN(v)) return;
        const x = (i / (H.length - 1)) * w, y = h - ((v - min) / rng) * (h - 16) - 8;
        n++ ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.strokeStyle = s.color; ctx.lineWidth = 1.6 * devicePixelRatio;
      ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.stroke();
    });
  }, [packet]);
  return html`<canvas ref=${ref}></canvas>`;
}

/* ---------------- reading row (sensor index) ---------------- */
function Reading({ s, value, index }) {
  const has = value != null && !isNaN(value);
  const [labelKey, kind] = has ? s.st(value) : [null, ""];
  const label = has ? t(labelKey) : "—";
  const name = t("sensor." + s.key);
  const raw = has ? Math.max(0, Math.min(100, ((value - s.min) / (s.max - s.min)) * 100)) : 0;
  const pct = s.invert ? 100 - raw : raw;
  return html`
    <div class="reading">
      <div class="reading-head">
        <span class="reading-folio">${index}</span>
        <span class="reading-name">${name}</span>
        <span class=${"pill " + (kind ? "is-" + kind : "")}>${label}</span>
      </div>
      <div class="reading-body">
        <span class="reading-num">${fmt(value, s.d)}</span>
        <span class="reading-unit">${s.unit}</span>
      </div>
      <div class="meter" role="meter" aria-label=${name}
        aria-valuenow=${has ? Number(value) : undefined} aria-valuemin=${s.min} aria-valuemax=${s.max}>
        <div class=${"meter-fill " + (kind ? "is-" + kind : "")} style=${{ width: pct + "%" }}></div>
      </div>
    </div>`;
}

/* ---------------- orientation (stage) ---------------- */
function Orientation({ packet, onLog }) {
  const canvasRef = useRef(null);
  const compassRef = useRef(null);
  const apiRef = useRef(null);
  const [cam, setCam] = useState("isometric");
  const [failed, setFailed] = useState(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    try {
      const api = createRoverScene(canvasRef.current, { onLog });
      api.bindCompass(compassRef.current);
      apiRef.current = api;
      return () => api.dispose();
    } catch (e) {
      console.error("Scene init failed:", e);
      setFailed(e?.message || "init error");
      onLog(t("log.viewFailed", { msg: e?.message || "init error" }), "danger");
    }
  }, []);
  useEffect(() => { if (packet && apiRef.current) apiRef.current.setData(packet); }, [packet]);

  const pick = (c) => { setCam(c); apiRef.current?.setCamera(c); onLog(t("log.camera", { c: t("cam." + c) }), "system"); };
  const cams = ["isometric", "front", "top", "side", "free"];

  return html`
    <section class="zone stage reveal" style=${{ animationDelay: "60ms" }} aria-labelledby="vis-h">
      <${Head} folio="01" title=${t("zone.orientation")} tag=${packet ? t("tag.gyroLocked") : t("tag.gyroStandby")} />
      <div class="zone-body">
        <div class="viewport">
          <span class="stage-mark" aria-hidden="true">RVR</span>
          <canvas id="vis-canvas" ref=${canvasRef}></canvas>
          ${failed && html`<div class="viewport-fallback">${t("view.unavailable")}<br/><small>${failed} — ${t("view.liveBelow")}</small></div>`}
          <div class="hud">
            <div class="hud-cams" role="group" aria-label=${t("cam.group")}>
              ${cams.map(c => html`<button key=${c} type="button"
                class=${"btn btn--ghost" + (cam === c ? " is-active" : "")}
                onClick=${() => pick(c)}>${t("cam." + c)}</button>`)}
            </div>
            <div class="compass" aria-hidden="true">
              <svg ref=${compassRef} viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(236,229,214,0.28)" stroke-width="1.5"/>
                <text x="50" y="25" fill="#ece5d6" font-size="13" font-weight="700" text-anchor="middle" font-family="Archivo, sans-serif">N</text>
                <polygon points="50,15 45,50 55,50" fill="#ff3b2f"/>
                <polygon points="50,85 45,50 55,50" fill="rgba(236,229,214,0.4)"/>
              </svg>
              <span>${t("hud.heading")}</span>
            </div>
            <dl class="hud-tele">
              <div><dt>${t("hud.dist")}</dt><dd>${fmt(packet?.dist, 0)} cm</dd></div>
              <div><dt>${t("hud.roll")}</dt><dd>${fmt(packet?.roll, 1)}°</dd></div>
              <div><dt>${t("hud.pitch")}</dt><dd>${fmt(packet?.pitch, 1)}°</dd></div>
              <div><dt>${t("hud.yaw")}</dt><dd>${fmt(packet?.yaw, 1)}°</dd></div>
            </dl>
          </div>
        </div>
      </div>
    </section>`;
}

/* ---------------- camera: ESP32-CAM live feed ---------------- */
function Camera() {
  const [state, setState] = useState("loading"); // loading | live | offline
  const [nonce, setNonce] = useState(0);          // bump to force <img> reload
  const src = CAM_URL + (CAM_URL.includes("?") ? "&" : "?") + "n=" + nonce;
  return html`
    <section class="zone stage reveal" style=${{ animationDelay: "60ms" }} aria-labelledby="cam-h">
      <${Head} folio="02" title=${t("zone.camera")} tag=${t("cam.tag." + state)} />
      <div class="zone-body">
        <div class="viewport">
          <span class="stage-mark" aria-hidden="true">CAM</span>
          ${state !== "offline"
            ? html`<img src=${src} alt=${t("zone.camera")}
                style=${{ width: "100%", height: "100%", objectFit: "contain" }}
                onLoad=${() => setState("live")} onError=${() => setState("offline")} />`
            : html`<div class="viewport-fallback">${t("cam.offline")}<br/>
                <small>${CAM_URL}</small><br/>
                <button type="button" class="btn btn--ghost" style=${{ marginTop: "12px" }}
                  onClick=${() => { setState("loading"); setNonce(n => n + 1); }}>${t("cam.retry")}</button>
              </div>`}
        </div>
      </div>
    </section>`;
}

/* ---------------- readings panel ---------------- */
function ReadingsPanel({ packet }) {
  return html`
    <section class="zone readings reveal" style=${{ animationDelay: "120ms" }} aria-labelledby="env-h">
      <${Head} folio="03" title=${t("zone.environment")} tag=${t("tag.channels")} />
      <div class="zone-body">
        ${SENSORS.map((s, i) => html`<${Reading} key=${s.key} s=${s}
          value=${packet?.[s.key]} index=${String(i + 1).padStart(2, "0")} />`)}
      </div>
    </section>`;
}

/* ---------------- analysis / mission memory ---------------- */
function Memory({ chat }) {
  const findings = (chat?.findings || []).slice().reverse();
  const tag = !chat ? "—" : findings.length ? t("tag.found", { n: findings.length }) : t("tag.nominal");
  return html`
    <section class="zone memory reveal" style=${{ animationDelay: "180ms" }} aria-labelledby="mem-h">
      <${Head} folio="07" title=${t("zone.analysis")} tag=${tag} />
      <div class="memory-body">
        ${!chat
          ? html`<p class="memory-empty">${t("mem.noSession")}</p>`
          : findings.length === 0
          ? html`<p class="memory-empty">${t("mem.noFindings")}</p>`
          : findings.map(f => html`<div key=${f.id} class=${"memory-item is-" + f.kind}>
              <span class="memory-dot" aria-hidden="true"></span>
              <span class="memory-text">${f.text}</span>
              <span class="memory-time">${f.time}</span>
            </div>`)}
      </div>
    </section>`;
}

/* ---------------- trends panel ---------------- */
function TrendsPanel({ packet }) {
  return html`
    <section class="zone reveal" style=${{ animationDelay: "200ms" }} aria-labelledby="tr-h">
      <${Head} folio="04" title=${t("zone.trends")}>
        <div class="legend" aria-label="Series">
          ${TRENDS.map(s => html`<span key=${s.key}><i style=${{ background: s.color }}></i>${t(s.tkey)}</span>`)}
        </div>
      <//>
      <div class="trend-body"><${Trends} packet=${packet} /></div>
    </section>`;
}

/* ---------------- agent (AI) ----------------
   The agent has a "mood" derived from what it's saying + live sensor state.
   That mood drives an animated glyph so the analysis reads as intent, not just text. */
// label is an i18n key, resolved at render via t().
// Split face string into animated parts for Telegram-style blink.
function animFace(face) {
  if (face === ":o") return html`<span class="a-eye">:</span><span class="a-mouth">o</span>`;
  const [l, m, r] = face;
  return html`<span class="a-eye">${l}</span><span class="a-mouth">${m}</span><span class="a-eye">${r}</span>`;
}

const INTENTS = {
  idle:     { key: "idle",     label: "intent.idle",     color: "var(--ink-3)", face: "-_-" },
  scanning: { key: "scanning", label: "intent.scanning", color: "var(--ink-2)", face: "o_o" },
  thinking: { key: "thinking", label: "intent.thinking", color: "var(--ink)",   face: "o_O" },
  clear:    { key: "clear",    label: "intent.clear",    color: "var(--go)",     face: "^_^" },
  caution:  { key: "caution",  label: "intent.caution",  color: "var(--warn)",   face: ":o"  },
  alert:    { key: "alert",    label: "intent.alert",    color: "var(--accent)", face: "x_x" },
};

// Worst pill across all live readings: 0 go · 1 warn · 2 abort · null no data.
function worstSensor(packet) {
  if (!packet) return null;
  let rank = -1;
  for (const s of SENSORS) {
    const v = packet[s.key];
    if (v == null || isNaN(v)) continue;
    const k = s.st(v)[1];
    rank = Math.max(rank, k === "abort" ? 2 : k === "warn" ? 1 : 0);
  }
  return rank < 0 ? null : rank;
}

// Go/no-go verdict for the operator: worst sensor decides, named so the reason
// is visible. Mirrors the project pitch — "can a human safely enter?"
function assess(packet) {
  const rank = worstSensor(packet);
  if (rank == null) return { kind: "idle", label: t("verdict.awaiting"), cause: t("verdict.noTelemetry") };
  let cause = t("verdict.nominal");
  if (rank > 0) {
    for (const s of SENSORS) {
      const v = packet[s.key];
      if (v == null || isNaN(v)) continue;
      const [lblKey, k] = s.st(v);
      if ((k === "abort" ? 2 : k === "warn" ? 1 : 0) === rank) { cause = `${t("sensor." + s.key)} · ${t(lblKey)}`; break; }
    }
  }
  if (rank === 2) return { kind: "abort", label: t("verdict.danger"), cause };
  if (rank === 1) return { kind: "warn",  label: t("verdict.caution"), cause };
  return { kind: "go", label: t("verdict.safe"), cause };
}

// Intent: analysis-in-flight wins, then keywords in what the agent said, then sensors.
function deriveIntent(ai, packet, connected) {
  if (ai.analyzing) return INTENTS.thinking;
  const txt = (ai.text || "").toLowerCase();
  if (/\b(danger|abort|critical|hazard|emergency|evacuat|fire|toxic|peligro|abortar|crítico|critico|emergencia|evacua|fuego|tóxico|toxico)\b/.test(txt)) return INTENTS.alert;
  if (/\b(caution|warning|careful|slow|obstacle|collision|bump|approach|elevated|moderate|watch|steer|precaución|precaucion|advertencia|cuidado|lento|obstácul|obstacul|colisión|colision|acerca|moderad|vigila)\b/.test(txt)) return INTENTS.caution;
  if (/\b(clear|safe|normal|nominal|stable|good|proceed|no threat|all systems|despejado|seguro|estable|bien|procede|sin amenaza)\b/.test(txt)) return INTENTS.clear;
  const w = worstSensor(packet);
  if (w === 2) return INTENTS.alert;
  if (w === 1) return INTENTS.caution;
  if (w === 0) return INTENTS.clear;
  return connected ? INTENTS.scanning : INTENTS.idle;
}

/* animated glyph — one SVG per intent, parts animated via CSS (see .ai-glyph) */
function AgentIcon({ intent }) {
  const k = intent.key;
  if (k === "thinking") return html`<svg class="ai-glyph" viewBox="0 0 120 120" aria-hidden="true">
    <circle class="g-faint" cx="60" cy="60" r="40"/>
    <g class="g-spin g-orbit">
      <circle class="g-fill" cx="60" cy="20" r="6"/>
      <circle class="g-fill" cx="60" cy="20" r="4.5" transform="rotate(120 60 60)"/>
      <circle class="g-fill" cx="60" cy="20" r="4.5" transform="rotate(240 60 60)"/>
    </g>
    <circle class="g-fill g-core" cx="60" cy="60" r="8"/>
  </svg>`;
  if (k === "scanning") return html`<svg class="ai-glyph" viewBox="0 0 120 120" aria-hidden="true">
    <circle class="g-faint" cx="60" cy="60" r="40"/>
    <circle class="g-faint" cx="60" cy="60" r="24"/>
    <g class="g-spin g-sweep"><path class="g-fill g-wedge" d="M60 60 L60 22 A38 38 0 0 1 92 41 Z"/></g>
    <circle class="g-fill g-core" cx="60" cy="60" r="4"/>
    <circle class="g-fill g-blip" cx="84" cy="42" r="3.6"/>
  </svg>`;
  if (k === "clear") return html`<svg class="ai-glyph" viewBox="0 0 120 120" aria-hidden="true">
    <circle class="g-ring2" cx="60" cy="60" r="34"/>
    <path class="g-check" d="M44 61 L55 72 L78 47"/>
  </svg>`;
  if (k === "caution" || k === "alert") return html`<svg class="ai-glyph" viewBox="0 0 120 120" aria-hidden="true">
    <path class="g-tri" d="M60 22 L94 84 L26 84 Z"/>
    <line class="g-bang" x1="60" y1="46" x2="60" y2="66"/>
    <circle class="g-fill g-dot2" cx="60" cy="75" r="3.2"/>
  </svg>`;
  return html`<svg class="ai-glyph" viewBox="0 0 120 120" aria-hidden="true">
    <circle class="g-ring g-faint" cx="60" cy="60" r="34"/>
    <circle class="g-fill g-core" cx="60" cy="60" r="7"/>
  </svg>`;
}

// Live ticking elapsed counter (since a timestamp), ~10fps.
function Stopwatch({ since }) {
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick(n => n + 1), 90); return () => clearInterval(id); }, [since]);
  return html`${((Date.now() - since) / 1000).toFixed(1)}s`;
}

function AgentTiming({ ai }) {
  if (ai.phase === "thinking") return html`<div class="agent-timing is-live">${t("timing.thinking")} <b><${Stopwatch} since=${ai.since} /></b></div>`;
  if (ai.phase === "speaking") return html`<div class="agent-timing is-live">${t("timing.synth")} <b><${Stopwatch} since=${ai.since} /></b></div>`;
  if (ai.llm != null) return html`<div class="agent-timing">LLM <b>${(ai.llm / 1000).toFixed(1)}s</b> · TTS <b>${ai.tts != null ? (ai.tts / 1000).toFixed(1) + "s" : "—"}</b></div>`;
  return null;
}

function Agent({ ai, tts, ttsProv, hasDeepgram, packet, connected, speaking, chats, activeChat, onNewChat, onSelectChat, onDeleteChat, onBrief, onSpeak, onAnalyze, onToggleTts, onToggleTtsProvider, onPick, onMock, onAsk }) {
  const intent = deriveIntent(ai, packet, connected);
  const v = assess(packet);
  const briefed = activeChat && activeChat.mission;
  return html`
    <section class=${"zone agent reveal is-" + intent.key + (ai.analyzing ? " is-analyzing" : "") + (speaking ? " is-speaking" : "")}
      style=${{ animationDelay: "120ms", "--agent-c": intent.color }} aria-labelledby="agent-h">
      <${Head} folio="02" title=${t("zone.agent")} tag=${t(ai.badge)} />
      <div class="agent-body">
        <div class="agent-topbar">
          ${briefed
            ? html`<button type="button" class="brief-back agent-back" onClick=${() => onSelectChat("")}>${t("brief.sessions")} · ${activeChat.title}</button>`
            : html`<span class="agent-topbar-spacer"></span>`}
          <label class="switch agent-voice" title=${t("agent.voiceTitle")}>
            <input type="checkbox" checked=${tts} onChange=${onToggleTts} />
            <span class="switch-track" aria-hidden="true"><span class="switch-knob"></span></span>
            ${t("agent.voice")}
          </label>
          ${hasDeepgram ? html`
            <div class="tts-provider-toggle" role="radiogroup" aria-label=${t("agent.ttsProvider")}>
              <button type="button" role="radio" aria-checked=${ttsProv === "edge"}
                class=${"tts-prov-btn" + (ttsProv === "edge" ? " is-active" : "")}
                onClick=${() => ttsProv !== "edge" && onToggleTtsProvider()}>
                Edge
              </button>
              <button type="button" role="radio" aria-checked=${ttsProv === "deepgram"}
                class=${"tts-prov-btn" + (ttsProv === "deepgram" ? " is-active" : "")}
                onClick=${() => ttsProv !== "deepgram" && onToggleTtsProvider()}>
                DG
              </button>
            </div>` : null}
        </div>
        ${!activeChat
          ? html`<${ChatSelect} chats=${chats} onNew=${onNewChat} onSelect=${onSelectChat} onDelete=${onDeleteChat} />`
          : !briefed
          ? html`<${Briefing} onBrief=${onBrief} onBack=${() => onSelectChat("")} onSpeak=${onSpeak} busy=${ai.analyzing} />`
          : html`<${React.Fragment}>
        <div class="agent-stage">
          <span class="agent-grid" aria-hidden="true"></span>
          <span class="agent-mark" aria-hidden="true">AGT</span>
          <div class="agent-orb"><${AgentIcon} intent=${intent} /></div>
          ${speaking
            ? html`<div class="agent-eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>`
            : html`<span class="agent-state-label"><span class="agent-face">${animFace(intent.face)}</span> ${t(intent.label)}</span>`}
        </div>
        <div class="agent-speech">
          <p class="agent-text" key=${ai.text} role="status" aria-live="polite">${ai.text}</p>
          <${AgentTiming} ai=${ai} />
        </div>
        <div class=${"verdict is-" + v.kind} role="status" aria-live="polite">
          <span class="verdict-k">${t("verdict.entryStatus")}</span>
          <strong class="verdict-label">${v.label}</strong>
          <span class="verdict-cause">${v.cause}</span>
        </div>
        <div class="agent-foot">
          <button class="btn btn--primary" type="button" onClick=${onAnalyze} disabled=${ai.analyzing}>
            ${ai.analyzing ? t("agent.analyzing") : t("agent.runAnalysis")}
          </button>
          <button class="btn" type="button" onClick=${onMock} disabled=${ai.analyzing} title=${t("agent.mockTitle")}>
            ${t("agent.mock")}
          </button>
        </div>
        <${Ask} onAsk=${onAsk} busy=${ai.analyzing} />
        <details class="ai-hist agent-hist">
          <summary>${t("agent.history", { n: ai.history.length })}</summary>
          <div class="ai-hist-list">
            ${ai.history.map(h => html`
              <div key=${h.id} class="ai-hist-item" onClick=${() => onPick(h.text)}>
                <span class="ai-hist-time">${h.time}</span>
                <span>${h.text.length > 90 ? h.text.slice(0, 90) + "…" : h.text}</span>
              </div>`)}
          </div>
        </details>
          </${React.Fragment}>`}
      </div>
    </section>`;
}

/* ---------------- chat sessions (in agent box) ---------------- */
function ChatSelect({ chats, onNew, onSelect, onDelete }) {
  return html`
    <div class="chat-select">
      <div class="mission-head"><span class="mission-k">${t("chat.sessions")}</span></div>
      ${chats.length === 0
        ? html`<p class="chat-empty">${t("chat.empty")}</p>`
        : html`<div class="chat-list">
            ${chats.slice().reverse().map((c, i) => html`
              <div key=${c.id} class="chat-item">
                <button type="button" class="chat-item-main" onClick=${() => onSelect(c.id)}>
                  <span class="chat-item-title">${c.title || t("chat.untitled")}</span>
                  <span class="chat-item-sub">${c.mission ? t("chat.briefed") : t("chat.notBriefed")}</span>
                </button>
                <button type="button" class="chat-del" onClick=${() => onDelete(c.id)} title=${t("chat.delete")} aria-label=${t("chat.delete")}>×</button>
              </div>`)}
          </div>`}
      <button type="button" class="btn btn--primary chat-new" onClick=${onNew}>${t("chat.new")}</button>
    </div>`;
}

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

// Shared speech-to-text. onText gets the recognized transcript.
function useMic(onText) {
  const [listening, setListening] = useState(false);
  const recRef = useRef(null);
  const toggle = useCallback(() => {
    if (!SpeechRec) return;
    if (listening) { recRef.current?.stop(); return; }
    stopSpeech(); // operator is talking — cut the agent off so it doesn't talk over them
    const rec = new SpeechRec();
    rec.lang = speechLang(); rec.interimResults = false; rec.maxAlternatives = 1;
    rec.onresult = (e) => onText(e.results[0][0].transcript);
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec; setListening(true); rec.start();
  }, [listening, onText]);
  return { listening, toggle, supported: !!SpeechRec };
}

// Briefing step copy is resolved through i18n at render time. `clip` maps each
// step to its pre-generated onboarding audio key (see playOnboard / ONBOARDING).
const BRIEF_STEPS = [
  { key: "objective",   clip: "q0", label: "brief.objLabel",   q: "brief.objQ",   ph: "brief.objPh" },
  { key: "environment", clip: "q1", label: "brief.envLabel",   q: "brief.envQ",   ph: "brief.envPh" },
  { key: "watch",       clip: "q2", label: "brief.watchLabel", q: "brief.watchQ", ph: "brief.watchPh" },
];

function Briefing({ onBrief, onBack, onSpeak, busy }) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState({});
  const review = step >= BRIEF_STEPS.length;
  const cur = BRIEF_STEPS[step];
  const setCur = (val) => setAnswers(a => ({ ...a, [cur.key]: val }));
  const mic = useMic((txt) => setAnswers(a => {
    const k = BRIEF_STEPS[step]?.key; if (!k) return a;
    return { ...a, [k]: (a[k] ? a[k] + " " : "") + txt };
  }));
  const curVal = (answers[cur?.key] || "");
  const next = () => { if (curVal.trim()) setStep(s => s + 1); };
  const start = () => onBrief(BRIEF_STEPS.map(s => `${t(s.label)}: ${answers[s.key] || "—"}`).join("\n"));

  // Speak each onboarding step out loud (pre-rendered clips, no synth wait).
  // Step 0 plays the intro greeting first, then its question.
  useEffect(() => {
    if (review) {
      onSpeak?.([{ clip: "rundown", text: ONBOARDING[getLang()].rundown }]);
      return;
    }
    const s = BRIEF_STEPS[step];
    const q = { clip: s.clip, text: t(s.q) };
    onSpeak?.(step === 0 ? [{ clip: "intro", text: ONBOARDING[getLang()].intro }, q] : [q]);
  }, [step]); // eslint-disable-line — re-speak only on step change, not keystrokes

  const dots = html`<div class="brief-dots" aria-hidden="true">
    ${BRIEF_STEPS.map((s, i) => html`<span key=${s.key}
      class=${"brief-dot" + (i === step ? " is-active" : "") + (i < step || review ? " is-done" : "")}></span>`)}
    <span class=${"brief-dot" + (review ? " is-active" : "")}></span>
  </div>`;

  if (review) {
    return html`
      <div class="briefing">
        <button type="button" class="brief-back" onClick=${() => setStep(BRIEF_STEPS.length - 1)}>${t("brief.back")}</button>
        ${dots}
        <div class="brief-orb is-happy"><span class="agent-face">${animFace("^_^")}</span></div>
        <div class="brief-step" key="review">
          <p class="brief-greeting">${t("brief.rundown")}</p>
          <div class="brief-summary">
            ${BRIEF_STEPS.map((s, i) => html`<div key=${s.key} class="brief-sum-row" style=${{ animationDelay: (i * 70) + "ms" }}>
              <span class="brief-sum-k">${t(s.label)}</span>
              <span class="brief-sum-v">${answers[s.key] || "—"}</span>
            </div>`)}
          </div>
          <button type="button" class="btn btn--primary btn--go" onClick=${start} disabled=${busy}>
            ${busy ? t("brief.heading") : t("brief.start")}
          </button>
        </div>
      </div>`;
  }

  return html`
    <div class="briefing">
      <button type="button" class="brief-back" onClick=${step === 0 ? onBack : () => setStep(s => s - 1)}>
        ${step === 0 ? t("brief.sessions") : t("brief.back")}
      </button>
      ${dots}
      <div class="brief-orb"><span class="agent-face">${animFace("o_o")}</span></div>
      ${step === 0 ? html`<p class="brief-greeting">${ONBOARDING[getLang()].intro}</p>` : null}
      <div class="brief-step" key=${step}>
        <div class="brief-step-k">${t("brief.stepOf", { n: step + 1, total: BRIEF_STEPS.length, label: t(cur.label) })}</div>
        <p class="brief-q">${t(cur.q)}</p>
        <div class="brief-field">
          <textarea class="mission-input" rows="3" placeholder=${t(cur.ph)}
            value=${curVal} onInput=${e => setCur(e.target.value)} disabled=${busy} autoFocus
            onKeyDown=${e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) next(); }}></textarea>
          ${mic.supported ? html`<button type="button" class=${"ask-mic brief-mic" + (mic.listening ? " is-live" : "")}
            onClick=${mic.toggle} disabled=${busy} aria-pressed=${mic.listening}>
            ${mic.listening ? t("brief.listening") : t("brief.speak")}</button>` : null}
        </div>
        <button type="button" class="btn btn--primary" onClick=${next} disabled=${busy || !curVal.trim()}>
          ${step === BRIEF_STEPS.length - 1 ? t("brief.review") : t("brief.next")}
        </button>
      </div>
    </div>`;
}

/* ---------------- ask Sage (voice, in agent box) ---------------- */
// Predetermined prompts — give the operator ideas and keep questions on-telemetry.
const ASK_SUGGESTIONS = ["ask.s0", "ask.s1", "ask.s2", "ask.s3", "ask.s4"];
function Ask({ onAsk, busy }) {
  const mic = useMic(onAsk);
  return html`
    <div class="agent-ask">
      ${mic.supported ? html`<button type="button" class=${"ask-mic" + (mic.listening ? " is-live" : "")} onClick=${mic.toggle}
        disabled=${busy} aria-pressed=${mic.listening}>${mic.listening ? t("ask.listening") : t("ask.mic")}</button>` : null}
      <div class="ask-chips">
        ${ASK_SUGGESTIONS.map(q => html`<button key=${q} type="button" class="ask-chip"
          onClick=${() => onAsk(t(q))} disabled=${busy}>${t(q)}</button>`)}
      </div>
    </div>`;
}

/* ---------------- logs ---------------- */
function Logs({ logs }) {
  const [f, setF] = useState("all");
  const tabs = [["all", t("log.tabAll")], ["system", t("log.tabSystem")], ["alerts", t("log.tabAlerts")], ["ai", t("log.tabAi")]];
  const view = logs.filter(l => f === "all" ? true : f === "alerts" ? (l.type === "warn" || l.type === "danger") : l.type === f);
  return html`
    <section class="zone logs reveal" style=${{ animationDelay: "320ms" }} aria-labelledby="log-h">
      <${Head} folio="05" title=${t("zone.logs")} tag=${t("log.ev", { n: logs.length })} />
      <div class="zone-body">
        <div class="log-tabs" role="tablist">
          ${tabs.map(([k, lbl]) => html`<button key=${k} type="button" role="tab" aria-selected=${f === k}
            class=${"log-tab" + (f === k ? " is-active" : "")} onClick=${() => setF(k)}>${lbl}</button>`)}
        </div>
        <div class="log-stream" role="log" aria-live="polite">
          ${view.map(l => html`<div key=${l.id} class=${"log-line k-" + l.type}>
            <span class="t">${l.time}</span><span class="m">${l.text}</span></div>`)}
        </div>
      </div>
    </section>`;
}

/* ---------------- serial monitor ---------------- */
function SerialMonitor({ lines, hidden, onToggle, onClear }) {
  const [paused, setPaused] = useState(false);
  const streamRef = useRef(null);
  // Stick to the bottom on new lines unless the user paused to read.
  useEffect(() => {
    if (hidden || paused) return;
    const el = streamRef.current; if (el) el.scrollTop = el.scrollHeight;
  }, [lines, hidden, paused]);
  return html`
    <section class=${"zone serial reveal" + (hidden ? " is-collapsed" : "")} style=${{ animationDelay: "380ms" }} aria-labelledby="ser-h">
      <${Head} folio="06" title=${t("zone.serial")}>
        <div class="serial-tools">
          <span class="tag">${lines.length}</span>
          ${!hidden && html`<button type="button" class="serial-btn" onClick=${() => setPaused(p => !p)}
            aria-pressed=${paused}>${paused ? t("serial.resume") : t("serial.pause")}</button>`}
          ${!hidden && html`<button type="button" class="serial-btn" onClick=${onClear}>${t("serial.clear")}</button>`}
          <button type="button" class="serial-btn" onClick=${onToggle} aria-expanded=${!hidden}
            title=${t("serial.toggleTitle")}>${hidden ? t("serial.show") : t("serial.hide")}</button>
        </div>
      <//>
      ${!hidden && html`
        <div class="serial-stream" role="log" aria-live="off" ref=${streamRef}>
          ${lines.length === 0
            ? html`<div class="serial-empty">${t("serial.empty")}</div>`
            : lines.map(l => html`<div key=${l.id} class=${"serial-line" + (l.s ? " is-data" : "")}>
                <span class="t">${l.time}</span><span class="m">${l.text}</span></div>`)}
        </div>`}
    </section>`;
}

/* ---------------- masthead ---------------- */
function Masthead({ connected, ports, currentPort, bridge, onBridge, onServo, connMode, onConnMode, ping, packets, uptime, onPort, lang, onLang }) {
  return html`
    <header class="masthead reveal">
      <div class="mast-top">
        <div class="mast-id">
          <span class="folio-sm">BLK-01</span>
          <span class="label">${t("mast.console")}</span>
        </div>
        <div class="mast-strip">
          <p class="lamp" role="status" aria-live="polite">
            <span class=${"lamp-dot " + (connected ? "is-go" : "is-abort")}></span>
            <span class="lamp-label">${connected ? t("mast.linkLive") : t("mast.noSignal")}</span>
          </p>
          <div class="conn-field">
            <span class="label">${t("mast.link")}</span>
            <div class="conn-seg" data-mode=${connMode} role="tablist" aria-label=${t("mast.link")}>
              <button type="button" role="tab" aria-selected=${connMode === "usb"}
                class=${connMode === "usb" ? "is-active" : ""} onClick=${() => onConnMode("usb")}>${t("mast.usb")}</button>
              <button type="button" role="tab" aria-selected=${connMode === "bt"}
                class=${connMode === "bt" ? "is-active" : ""} onClick=${() => onConnMode("bt")}>${t("mast.bt")}</button>
              <span class="conn-seg-thumb" aria-hidden="true"></span>
            </div>
            <div class="conn-panel" key=${connMode}>
              ${connMode === "usb" ? html`
                <select class="port-select" value=${currentPort || ""} onChange=${e => onPort(e.target.value)}>
                  ${ports.length === 0 && html`<option value="">${t("mast.noPorts")}</option>`}
                  ${ports.map(p => html`<option key=${p} value=${p}>${p}</option>`)}
                </select>
              ` : html`
                <div class="bridge-ctl">
                  <button type="button" class=${"bridge-btn " + (bridge.running ? "is-on" : "")}
                    disabled=${bridge.busy} onClick=${() => onBridge("toggle")}>
                    <span class=${"lamp-dot " + (bridge.running ? "is-go" : "is-abort")}></span>
                    ${bridge.busy ? t("mast.bridgeBusy") : bridge.running ? t("mast.bridgeOn") : t("mast.bridgeOff")}
                  </button>
                  <button type="button" class="bridge-repair" title=${t("mast.bridgeRepairTitle")}
                    disabled=${bridge.busy} onClick=${() => onBridge("reconnect")}>⟳</button>
                  <button type="button" class="bridge-repair" title=${t("mast.servoTitle")}
                    disabled=${bridge.busy || !bridge.running} onClick=${onServo}>⟲cam</button>
                </div>
              `}
            </div>
          </div>
          <label class="port-field">
            <span class="label">${t("mast.lang")}</span>
            <select class="port-select" value=${lang} onChange=${e => onLang(e.target.value)}>
              ${LANGS.map(l => html`<option key=${l.code} value=${l.code}>${l.label}</option>`)}
            </select>
          </label>
          <dl class="stat"><dt>${t("mast.ping")}</dt><dd>${ping}</dd></dl>
          <dl class="stat"><dt>${t("mast.packets")}</dt><dd>${packets}</dd></dl>
          <dl class="stat"><dt>${t("mast.uptime")}</dt><dd>${uptime}</dd></dl>
        </div>
      </div>
      <div class="mast-title">
        <h1>Blackout<span class="ver">V1</span></h1>
        <div class="mast-sub">
          <span>${t("mast.subTele")}</span>
          <span class="dim">Mega 2560 · Uno R3</span>
        </div>
      </div>
    </header>`;
}

/* ---------------- ticker ---------------- */
function Ticker({ packet, connected }) {
  const items = [
    [t("tick.temp"), fmt(packet?.temp, 1) + "°C"],
    [t("tick.humid"), fmt(packet?.humid, 0) + "%"],
    [t("tick.dist"), fmt(packet?.dist, 0) + "cm"],
    [t("tick.smoke"), fmt(packet?.smoke, 0) + "ppm"],
    [t("tick.air"), fmt(packet?.airq, 0) + "ppm"],
    [t("tick.roll"), fmt(packet?.roll, 0) + "°"],
    [t("tick.pitch"), fmt(packet?.pitch, 0) + "°"],
    [t("tick.yaw"), fmt(packet?.yaw, 0) + "°"],
    [t("tick.link"), connected ? t("link.live") : t("link.down")],
  ];
  const seq = [...items, ...items];
  return html`
    <div class="ticker" aria-hidden="true">
      <div class="ticker-track">
        ${seq.map((it, i) => html`<span key=${i} class="ticker-item">
          <i class="ticker-sep">/</i><span class="ticker-k">${it[0]}</span> <b>${it[1]}</b></span>`)}
      </div>
    </div>`;
}

/* ---------------- toasts ---------------- */
function Toasts({ items }) {
  return html`<div class="toasts">${items.map(t => html`<div key=${t.id} class=${"toast k-" + t.kind}>${t.msg}</div>`)}</div>`;
}

/* ---------------- root ---------------- */
function App() {
  const [connected, setConnected] = useState(false);
  const [packet, setPacket] = useState(null);
  const [ping, setPing] = useState("—");
  const [packets, setPackets] = useState(0);
  const [logs, setLogs] = useState([]);
  const [ai, setAi] = useState({ text: t("ai.awaiting"), badge: "badge.standby", analyzing: false, history: [], phase: null, since: 0, llm: null, tts: null });
  const [tts, setTts] = useState(() => localStorage.getItem("tts") !== "false");
  const [ttsProv, setTtsProv] = useState(() => localStorage.getItem("ttsProvider") || "edge");
  const [hasDeepgram, setHasDeepgram] = useState(false);
  const [lang, setLangState] = useState(getLang());
  const [ports, setPorts] = useState([]);
  const [currentPort, setCurrentPort] = useState(null);
  const [bridge, setBridge] = useState({ running: false, busy: false });
  const [connMode, setConnModeState] = useState(() => localStorage.getItem("connMode") || "usb");
  const [toasts, setToasts] = useState([]);
  const [uptime, setUptime] = useState("00:00:00");
  const [serialLines, setSerialLines] = useState([]);
  const [serialHidden, setSerialHidden] = useState(() => localStorage.getItem("serialHidden") === "true");
  const [speaking, setSpeaking] = useState(false);
  // Chats = briefed recon sessions. Each holds its own mission + conversation.
  const [chats, setChats] = useState(() => { try { return JSON.parse(localStorage.getItem("chats") || "[]"); } catch { return []; } });
  const [activeId, setActiveId] = useState(() => localStorage.getItem("activeChat") || "");
  const activeChat = chats.find(c => c.id === activeId) || null;
  const activeRef = useRef(null);
  useEffect(() => { activeRef.current = activeChat; }, [activeChat]);
  useEffect(() => { localStorage.setItem("chats", JSON.stringify(chats)); }, [chats]);
  useEffect(() => { localStorage.setItem("activeChat", activeId); }, [activeId]);
  useEffect(() => { localStorage.setItem("ttsProvider", ttsProv); ttsProviderRef = ttsProv; }, [ttsProv]);
  useEffect(() => {
    fetch("/api/tts/providers").then(r => r.json()).then(d => {
      setHasDeepgram(d.deepgram);
      if (!d.deepgram) setTtsProv("edge");
    }).catch(() => {});
  }, []);

  const socketRef = useRef(null);
  const ttsRef = useRef(localStorage.getItem("tts") !== "false");
  const lastObstacle = useRef(0);
  const lastDist = useRef(0);
  const lastBands = useRef({}); // per-metric severity, to detect when something newly worsens
  useEffect(() => { lastBands.current = {}; }, [activeId]); // fresh findings per session

  // Smoke/air gas readings are noisy MQ sensors — sample them every 5s so the
  // display doesn't flicker. Everything else stays live.
  const packetRef = useRef(null);
  useEffect(() => { packetRef.current = packet; }, [packet]);
  const [slowGas, setSlowGas] = useState({});
  useEffect(() => {
    const id = setInterval(() => {
      const p = packetRef.current;
      if (p) setSlowGas({ smoke: p.smoke, airq: p.airq });
    }, 5000);
    return () => clearInterval(id);
  }, []);
  const view = packet ? { ...packet, ...slowGas } : packet;

  const addLog = useCallback((text, type = "system") => {
    setLogs(p => [...p, { text, type, time: new Date().toLocaleTimeString(), id: Date.now() + Math.random() }].slice(-80));
  }, []);
  const toast = useCallback((msg, kind = "system") => {
    const id = Date.now() + Math.random();
    setToasts(p => [...p, { msg, kind, id }]);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 3600);
  }, []);

  // Speak with timing: clock starts now, stops when first audio plays (tts ms).
  const speakTimed = useCallback((text) => {
    const t = Date.now();
    setAi(p => ({ ...p, phase: "speaking", since: t, tts: null }));
    speak(text, {
      onStart: () => { setSpeaking(true); setAi(p => ({ ...p, phase: null, tts: Date.now() - t })); },
      onEnd: () => setSpeaking(false),
    });
  }, []);

  // socket
  useEffect(() => {
    const url = window.location.port !== "3000" ? "http://localhost:3000" : undefined;
    const socket = window.io(url);
    socketRef.current = socket;

    // Log a discovery to the active session whenever a metric newly worsens.
    function recordFindings(d) {
      const chat = activeRef.current;
      if (!chat || !chat.mission) return;
      const added = [];
      for (const f of FINDINGS) {
        const b = bandOf(f, d[f.k]);
        const prev = lastBands.current[f.k] ?? 0;
        if (b > prev && f.msg[b]) {
          added.push({ id: Date.now() + Math.random(), text: t(f.msg[b]), kind: b === 2 ? "danger" : "warn", time: new Date().toLocaleTimeString() });
        }
        lastBands.current[f.k] = b;
      }
      if (added.length) setChats(cs => cs.map(c => c.id === chat.id ? { ...c, findings: [...(c.findings || []), ...added].slice(-40) } : c));
    }

    socket.on("connect", () => {
      setConnected(true); addLog(t("log.linkEstablished"), "system");
      socket.emit("set-language", getLang());                          // sync AI language
      socket.emit("set-mission", activeRef.current?.mission || ""); // sync server to active session
    });
    socket.on("disconnect", () => { setConnected(false); setPing("—"); addLog(t("log.linkLost"), "danger"); });
    socket.on("sensor-data", d => {
      if (!d) return;
      const lat = d.timestamp ? Math.max(0, Date.now() - d.timestamp) : NaN;
      setPing(isNaN(lat) ? "—" : lat + " ms");
      setPackets(p => p + 1);
      setPacket(d);
      if (d.dist != null && !isNaN(d.dist) && Math.abs(d.dist - lastDist.current) > 3) {
        lastDist.current = d.dist;
        const now = Date.now();
        if (now - lastObstacle.current > 2400) {
          lastObstacle.current = now;
          addLog(t("log.obstacle", { d: d.dist.toFixed(0) }), d.dist < 20 ? "danger" : d.dist < 55 ? "warn" : "system");
        }
      }
      recordFindings(d);
    });
    socket.on("serial-line", d => {
      if (!d?.line) return;
      setSerialLines(p => [...p, {
        text: d.line, s: d.line.startsWith("S:"),
        time: new Date(d.timestamp || Date.now()).toLocaleTimeString(),
        id: Date.now() + Math.random(),
      }].slice(-300));
    });
    // The agent says something on its own (analysis, instant reaction, or mission ack).
    const sayAgent = (text, ts, logMsg, logKind) => {
      addLog(logMsg, logKind);
      setAi(p => ({
        text, badge: "badge.online", analyzing: false,
        phase: null, since: 0, llm: p.since ? Date.now() - p.since : null, tts: null,
        history: [...p.history, { text, time: new Date(ts || Date.now()).toLocaleTimeString(), id: Date.now() + Math.random() }].slice(-20),
      }));
      if (ttsRef.current) speakTimed(text);
    };
    // Auto analysis + instant reactions only fire when a briefed session is open —
    // otherwise the dashboard talks to itself on boot with no chat active.
    socket.on("ai-analysis", d => { if (d?.analysis && activeRef.current?.mission) sayAgent(d.analysis, d.timestamp, t("log.aiReceived"), "ai"); });
    socket.on("agent-blurt", d => { if (d?.text && activeRef.current?.mission) sayAgent(d.text, d.timestamp, t("log.blurt", { text: d.text }), "warn"); });
    socket.on("mission-ack", d => { if (d?.text) sayAgent(d.text, d.timestamp, t("log.missionAck"), "ai"); });
    addLog(t("log.booted"), "system");
    return () => socket.close();
  }, [addLog, speakTimed]);

  // Keep the document language + skip-link (static HTML outside React) in sync.
  useEffect(() => {
    document.documentElement.lang = lang;
    const sk = document.querySelector(".skip-link");
    if (sk) sk.textContent = t("skip");
  }, [lang]);

  // uptime
  useEffect(() => {
    const t0 = Date.now();
    const id = setInterval(() => {
      const e = Date.now() - t0, p = n => String(n).padStart(2, "0");
      setUptime(`${p(Math.floor(e / 3600000))}:${p(Math.floor(e / 60000) % 60)}:${p(Math.floor(e / 1000) % 60)}`);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // ports
  const loadPorts = useCallback(async () => {
    try {
      const r = await fetch("/api/ports"); const { ports, current } = await r.json();
      setPorts(ports); setCurrentPort(current);
    } catch { /* offline */ }
  }, []);
  useEffect(() => { loadPorts(); const id = setInterval(loadPorts, 10000); return () => clearInterval(id); }, [loadPorts]);

  const setConnMode = useCallback(async (m) => {
    setConnModeState(m);
    localStorage.setItem("connMode", m);
    addLog(t("log.connMode", { mode: m.toUpperCase() }), "system");
    try {
      const r = await fetch("/api/connMode", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: m }),
      });
      const d = await r.json();
      if (d.ok) {
        toast(t("toast.connMode", { mode: m.toUpperCase() }), "ok");
        const br = await fetch("/api/bridge");
        const bd = await br.json();
        setBridge(b => ({ ...b, running: bd.running }));
        if (m === "usb") loadPorts();
      } else {
        addLog(t("log.failed", { error: d.error }), "danger");
        toast(d.error, "danger");
      }
    } catch (e) {
      addLog(t("log.error", { msg: e.message }), "danger");
      toast(t("toast.error", { msg: e.message }), "danger");
    }
  }, [addLog, toast, loadPorts]);

  const switchPort = useCallback(async (path) => {
    if (!path) return;
    addLog(t("log.switching", { path }), "system");
    try {
      const r = await fetch("/api/ports/switch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
      const data = await r.json();
      if (data.ok) { addLog(t("log.switched", { path }), "system"); toast(t("toast.connected", { path }), "ok"); setCurrentPort(path); }
      else { addLog(t("log.failed", { error: data.error }), "danger"); toast(t("toast.failed", { error: data.error }), "danger"); loadPorts(); }
    } catch (e) { addLog(t("log.error", { msg: e.message }), "danger"); toast(t("toast.error", { msg: e.message }), "danger"); }
  }, [addLog, toast, loadPorts]);

  // Bluetooth bridge: the R4 advertises BLE (no classic SPP), so the browser's
  // own Web Bluetooth talks to it directly — no server-side native BT lib needed.
  // /api/bridge/* just tracks the intent flag server-side (mutual excl. w/ USB).
  const BLE_SERVICE = "19b10000-e8f2-537e-4f6c-d104768a1214";
  const BLE_CHAR = "19b10001-e8f2-537e-4f6c-d104768a1214";
  const BLE_CMD = "19b10002-e8f2-537e-4f6c-d104768a1214"; // write = sweep servo (camera pan)
  const bleRef = useRef({ device: null, char: null, cmd: null });

  const onBleNotify = useCallback((e) => {
    const line = new TextDecoder().decode(e.target.value);
    console.log("BLE notify:", line);
    fetch("/api/mega/sensor", { method: "POST", headers: { "Content-Type": "text/plain" }, body: line })
      .then((r) => { if (!r.ok) console.error("BLE forward failed:", r.status); })
      .catch((err) => console.error("BLE forward error:", err.message));
  }, []);

  const disconnectBle = useCallback(() => {
    const { device, char } = bleRef.current;
    if (char) char.removeEventListener("characteristicvaluechanged", onBleNotify);
    if (device?.gatt?.connected) device.gatt.disconnect();
    bleRef.current = { device: null, char: null, cmd: null };
  }, [onBleNotify]);

  // Servo check: any write to the cmd char makes the R4 sweep the servo once
  // (0→180→0) so we can eyeball the camera pan. Payload is ignored by firmware.
  const sweepServo = useCallback(async () => {
    const { device, cmd } = bleRef.current;
    if (!device?.gatt?.connected) { toast(t("toast.servoNoLink"), "danger"); return; }
    if (!cmd) { toast(t("toast.servoNoChar"), "danger"); return; } // linked but firmware lacks cmd char
    try {
      await cmd.writeValue(new TextEncoder().encode("sweep"));
      addLog(t("log.servoSweep"), "system");
    } catch (e) { addLog(t("log.error", { msg: e.message }), "danger"); }
  }, [addLog, toast]);

  const loadBridge = useCallback(async () => {
    try { const r = await fetch("/api/bridge"); const d = await r.json();
      setBridge(b => ({ ...b, running: d.running })); } catch { /* offline */ }
  }, []);
  useEffect(() => { loadBridge(); const id = setInterval(loadBridge, 5000); return () => clearInterval(id); }, [loadBridge]);

  // mode: "toggle" (connect↔disconnect) or "reconnect" (re-pick device while running).
  const toggleBridge = useCallback(async (mode = "toggle") => {
    const stopping = mode === "toggle" && bridge.running;
    setBridge(b => ({ ...b, busy: true }));
    addLog(stopping ? t("log.bridge", { action: "stop" }) : mode === "reconnect" ? t("log.bridgeRepair") : t("log.bridge", { action: "start" }), "system");
    try {
      if (stopping) {
        disconnectBle();
        await fetch("/api/bridge/stop", { method: "POST" });
        setBridge({ running: false, busy: false }); toast(t("toast.bridgeOff"), "ok");
      } else {
        if (mode === "reconnect") disconnectBle();
        if (!navigator.bluetooth) throw new Error("Web Bluetooth unsupported — use Chrome/Edge");
        // Filter by service UUID, not name — ArduinoBLE on the R4 WiFi always
        // advertises the name as "Arduino" (known upstream bug), so a name
        // filter never matches.
        const device = await navigator.bluetooth.requestDevice({
          filters: [{ services: [BLE_SERVICE] }],
          optionalServices: [BLE_SERVICE],
        });
        const server = await device.gatt.connect();
        const service = await server.getPrimaryService(BLE_SERVICE);
        const char = await service.getCharacteristic(BLE_CHAR);
        const cmd = await service.getCharacteristic(BLE_CMD).catch(() => null); // older firmware lacks it
        await char.startNotifications();
        char.addEventListener("characteristicvaluechanged", onBleNotify);
        device.addEventListener("gattserverdisconnected", () => {
          bleRef.current = { device: null, char: null, cmd: null };
          setBridge(b => ({ ...b, running: false }));
          fetch("/api/bridge/stop", { method: "POST" }).catch(() => {});
        });
        bleRef.current = { device, char, cmd };
        const r = await fetch("/api/bridge/start", { method: "POST" });
        const d = await r.json();
        if (d.ok) { setBridge({ running: true, busy: false }); toast(t("toast.bridgeOn"), "ok"); }
        else { disconnectBle(); setBridge(b => ({ ...b, busy: false })); addLog(t("log.failed", { error: d.error }), "danger"); toast(d.error, "danger"); }
      }
    } catch (e) { setBridge(b => ({ ...b, busy: false })); addLog(t("log.error", { msg: e.message }), "danger"); }
    loadBridge();
  }, [bridge.running, addLog, toast, loadBridge, disconnectBle, onBleNotify]);

  const analyze = useCallback(() => {
    setAi(p => ({ ...p, analyzing: true, badge: "badge.analyzing", phase: "thinking", since: Date.now(), llm: null, tts: null }));
    socketRef.current?.emit("request-analysis");
  }, []);
  const mockData = useCallback(() => {
    setAi(p => ({ ...p, analyzing: true, badge: "badge.analyzing", phase: "thinking", since: Date.now(), llm: null, tts: null }));
    socketRef.current?.emit("mock-data");
  }, []);
  // Ask Sage: reply lands in the agent's speech bubble + is spoken. Each chat
  // keeps its own rolling message history so follow-ups have context.
  const ask = useCallback(async (text) => {
    text = (text || "").trim();
    const chat = activeRef.current;
    if (!text || !chat) return;
    addLog(t("log.operator", { text }), "system");
    const t0 = Date.now();
    setAi(p => ({ ...p, analyzing: true, badge: "badge.thinking", phase: "thinking", since: t0, llm: null, tts: null }));
    const next = [...(chat.messages || []), { role: "user", content: text }].slice(-12);
    setChats(cs => cs.map(c => c.id === chat.id ? { ...c, messages: next } : c));
    try {
      const r = await fetch("/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next, lang: getLang() }),
      });
      const data = await r.json();
      const reply = data.reply || data.error || "No response.";
      if (data.reply) setChats(cs => cs.map(c => c.id === chat.id ? { ...c, messages: [...next, { role: "assistant", content: reply }].slice(-12) } : c));
      addLog(t("log.replied"), "ai");
      setAi(p => ({
        text: reply, badge: "badge.online", analyzing: false, phase: null, since: 0, llm: Date.now() - t0, tts: null,
        history: [...p.history, { text: reply, time: new Date().toLocaleTimeString(), id: Date.now() + Math.random() }].slice(-20),
      }));
      if (ttsRef.current && data.reply) speakTimed(reply);
    } catch (e) {
      setAi(p => ({ ...p, text: t("ai.comms", { msg: e.message }), badge: "badge.online", analyzing: false, phase: null }));
    }
  }, [addLog, speakTimed]);
  const toggleTts = useCallback(() => setTts(p => {
    const n = !p; ttsRef.current = n; localStorage.setItem("tts", n);
    if (!n) { stopSpeech(); setSpeaking(false); }
    return n;
  }), []);
  const toggleTtsProvider = useCallback(() => setTtsProv(p => p === "edge" ? "deepgram" : "edge"), []);
  // Play a sequence of pre-rendered onboarding clips (intro + step questions).
  const speakBrief = useCallback((items) => {
    if (!ttsRef.current) return;
    const play = (i) => { if (i < items.length) playOnboard(items[i].clip, items[i].text, { onEnd: () => play(i + 1) }); };
    play(0);
  }, []);
  const changeLang = useCallback((code) => {
    setLang(code); setLangState(code);
    socketRef.current?.emit("set-language", code); // AI replies in the new language
  }, []);
  const newChat = useCallback(() => {
    const id = "c" + Date.now();
    setChats(cs => [...cs, { id, title: t("chat.newTitle"), mission: "", messages: [], created: Date.now() }]);
    setActiveId(id);
    socketRef.current?.emit("set-mission", ""); // no mission until briefed
    // Briefing's step-0 effect speaks the intro + first question out loud.
  }, []);
  const selectChat = useCallback((id) => {
    setActiveId(id);
    socketRef.current?.emit("set-mission", (chats.find(c => c.id === id)?.mission) || "");
  }, [chats]);
  const deleteChat = useCallback((id) => {
    setChats(cs => cs.filter(c => c.id !== id));
    setActiveId(a => (a === id ? "" : a));
  }, []);
  const briefMission = useCallback((text) => {
    text = (text || "").trim();
    const chat = activeRef.current;
    if (!text || !chat) return;
    addLog(t("log.missionSent", { text }), "system");
    setChats(cs => cs.map(c => c.id === chat.id ? { ...c, mission: text, title: text.length > 30 ? text.slice(0, 30) + "…" : text } : c));
    setAi(p => ({ ...p, analyzing: true, badge: "badge.copying", phase: "thinking", since: Date.now() }));
    socketRef.current?.emit("set-mission", text);
  }, [addLog]);
  const pickHistory = useCallback((text) => setAi(p => ({ ...p, text })), []);
  const toggleSerial = useCallback(() => setSerialHidden(p => { const n = !p; localStorage.setItem("serialHidden", n); return n; }), []);
  const clearSerial = useCallback(() => setSerialLines([]), []);

  // Backtick toggles the serial monitor (ignored while typing in a field).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "`" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      e.preventDefault(); toggleSerial();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSerial]);

  return html`
    <${React.Fragment}>
      <div class="console">
        <${Masthead} connected=${connected} ports=${ports} currentPort=${currentPort}
          bridge=${bridge} onBridge=${toggleBridge} onServo=${sweepServo} connMode=${connMode} onConnMode=${setConnMode}
          ping=${ping} packets=${packets} uptime=${uptime} onPort=${switchPort}
          lang=${lang} onLang=${changeLang} />
        <${Ticker} packet=${view} connected=${connected} />

        <main class="deck" id="sensors">
          <div class="row row--stage">
            <div class="stage-col">
              <${Orientation} packet=${packet} onLog=${addLog} />
              <${ReadingsPanel} packet=${view} />
            </div>
            <${Agent} ai=${ai} tts=${tts} ttsProv=${ttsProv} hasDeepgram=${hasDeepgram} packet=${packet} connected=${connected} speaking=${speaking}
              chats=${chats} activeChat=${activeChat} onNewChat=${newChat} onSelectChat=${selectChat}
              onDeleteChat=${deleteChat} onBrief=${briefMission} onSpeak=${speakBrief}
              onAnalyze=${analyze} onToggleTts=${toggleTts} onToggleTtsProvider=${toggleTtsProvider} onPick=${pickHistory} onMock=${mockData} onAsk=${ask} />
            <div class="side-col">
              <${Camera} />
              <${Memory} chat=${activeChat} />
            </div>
          </div>

          <div class="row">
            <${TrendsPanel} packet=${packet} />
          </div>

          <div class="row">
            <${Logs} logs=${logs} />
          </div>

          <div class="row">
            <${SerialMonitor} lines=${serialLines} hidden=${serialHidden} onToggle=${toggleSerial} onClear=${clearSerial} />
          </div>
        </main>

        <footer class="colophon">
          <span><b>Blackout V1</b></span><span class="dot">/</span>
          <span>WRO 2026</span><span class="dot">/</span>
          <span>${t("colo.sensorHub")} <b>Mega 2560</b></span><span class="dot">/</span>
          <span>${t("colo.motor")} <b>Uno R3</b></span><span class="dot">/</span>
          <span>${t("colo.field")}</span>
        </footer>
      </div>

      <${Toasts} items=${toasts} />
    <//>`;
}

createRoot(document.getElementById("root")).render(html`<${App} />`);
