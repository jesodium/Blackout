import React, { useState, useEffect, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import htm from "htm";
import { createRoverScene } from "./scene.js";

const html = htm.bind(React.createElement);

/* ---------------- sensor model ---------------- */
const fmt = (v, d) => (v == null || isNaN(v) ? "--" : Number(v).toFixed(d));

// min/max define the meter's full travel.
const SENSORS = [
  { key: "temp",  name: "Temp",       unit: "°C",  d: 1, min: 0, max: 60,   st: v => v > 45 ? ["Critical", "abort"] : v > 35 ? ["High", "warn"] : ["Normal", "go"] },
  { key: "humid", name: "Humidity",   unit: "%",   d: 1, min: 0, max: 100,  st: v => v > 75 ? ["Highly humid", "warn"] : v < 20 ? ["Too dry", "warn"] : ["Good", "go"] },
  // Distance is a navigation cue, never a hazard: only caution when right up on a
  // wall (<10cm), clear otherwise — it's something to steer around, not a danger.
  { key: "dist",  name: "Distance",   unit: "cm",  d: 0, min: 0, max: 200,  invert: true, st: v => v < 10 ? ["Too close", "warn"] : ["Clear", "go"] },
  { key: "smoke", name: "Smoke / Gas",unit: "ppm", d: 0, min: 0, max: 1000, st: v => v > 600 ? ["Hazard", "abort"] : v > 300 ? ["Warning", "warn"] : ["Normal", "go"] },
  { key: "airq",  name: "Air Qual",   unit: "ppm", d: 0, min: 0, max: 1000, st: v => v > 800 ? ["Poor", "abort"] : v > 450 ? ["Moderate", "warn"] : ["Good", "go"] },
];

const TRENDS = [
  { key: "dist", name: "Dist", color: "#9a9384" },
  { key: "airq", name: "Air",  color: "#44cf86" },
  { key: "temp", name: "Temp", color: "#ff3b2f" },
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
  u.rate = 0.9; u.lang = "en-US";
  u.voice = voices.find(v => v.lang.startsWith("en") && /samantha|alex|google|enhanced/i.test(v.name))
    || voices.find(v => v.lang.startsWith("en")) || voices[0];
  u.onstart = () => onStart?.();
  u.onend = () => onEnd?.();
  u.onerror = () => onEnd?.();
  speechSynthesis.speak(u);
}

// Mission findings: when a metric newly worsens, the Analysis panel logs a discovery.
// Bands match the server's status thresholds so the agent and the panel agree.
const FINDINGS = [
  { k: "temp",  warn: 35,  danger: 45,  msg: { 1: "Temperature climbing", 2: "High temperature detected" } },
  { k: "smoke", warn: 300, danger: 600, msg: { 1: "Smoke detected", 2: "Heavy smoke — hazard" } },
  { k: "airq",  warn: 450, danger: 800, msg: { 1: "Air quality degraded", 2: "Air quality critical" } },
  { k: "co",    warn: 300, danger: 350, msg: { 1: "Gas levels rising", 2: "High gas levels detected" } },
  { k: "dist",  close: 10,              msg: { 1: "Obstacle / wall encountered" } },
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
async function speak(text, { onStart, onEnd } = {}) {
  ttsAudio?.pause();
  window.speechSynthesis?.cancel();
  const myToken = ++ttsToken;
  if (!text) { onEnd?.(); return; }
  const parts = splitSpeech(text);
  const mk = (p) => { const a = new Audio("/api/tts?text=" + encodeURIComponent(p)); a.preload = "auto"; return a; };
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
  if (myToken === ttsToken) onEnd?.();
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
      ctx.fillText("A W A I T I N G   T E L E M E T R Y", 0, 0); ctx.restore(); return;
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
  const [label, kind] = has ? s.st(value) : ["—", ""];
  const raw = has ? Math.max(0, Math.min(100, ((value - s.min) / (s.max - s.min)) * 100)) : 0;
  const pct = s.invert ? 100 - raw : raw;
  return html`
    <div class="reading">
      <div class="reading-head">
        <span class="reading-folio">${index}</span>
        <span class="reading-name">${s.name}</span>
        <span class=${"pill " + (kind ? "is-" + kind : "")}>${label}</span>
      </div>
      <div class="reading-body">
        <span class="reading-num">${fmt(value, s.d)}</span>
        <span class="reading-unit">${s.unit}</span>
      </div>
      <div class="meter" role="meter" aria-label=${s.name}
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
      onLog("3D view failed: " + (e?.message || "init error"), "danger");
    }
  }, []);
  useEffect(() => { if (packet && apiRef.current) apiRef.current.setData(packet); }, [packet]);

  const pick = (c) => { setCam(c); apiRef.current?.setCamera(c); onLog(`Camera: ${c}`, "system"); };
  const cams = ["isometric", "front", "top", "side", "free"];

  return html`
    <section class="zone stage reveal" style=${{ animationDelay: "60ms" }} aria-labelledby="vis-h">
      <${Head} folio="01" title="Orientation" tag=${packet ? "Gyro · Locked" : "Gyro · Standby"} />
      <div class="zone-body">
        <div class="viewport">
          <span class="stage-mark" aria-hidden="true">RVR</span>
          <canvas id="vis-canvas" ref=${canvasRef}></canvas>
          ${failed && html`<div class="viewport-fallback">3D View Unavailable<br/><small>${failed} — telemetry below is live</small></div>`}
          <div class="hud">
            <div class="hud-cams" role="group" aria-label="Camera angle">
              ${cams.map(c => html`<button key=${c} type="button"
                class=${"btn btn--ghost" + (cam === c ? " is-active" : "")}
                onClick=${() => pick(c)}>${c}</button>`)}
            </div>
            <div class="compass" aria-hidden="true">
              <svg ref=${compassRef} viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(236,229,214,0.28)" stroke-width="1.5"/>
                <text x="50" y="25" fill="#ece5d6" font-size="13" font-weight="700" text-anchor="middle" font-family="Archivo, sans-serif">N</text>
                <polygon points="50,15 45,50 55,50" fill="#ff3b2f"/>
                <polygon points="50,85 45,50 55,50" fill="rgba(236,229,214,0.4)"/>
              </svg>
              <span>Heading</span>
            </div>
            <dl class="hud-tele">
              <div><dt>Dist</dt><dd>${fmt(packet?.dist, 0)} cm</dd></div>
              <div><dt>Roll</dt><dd>${fmt(packet?.roll, 1)}°</dd></div>
              <div><dt>Pitch</dt><dd>${fmt(packet?.pitch, 1)}°</dd></div>
              <div><dt>Yaw</dt><dd>${fmt(packet?.yaw, 1)}°</dd></div>
            </dl>
          </div>
        </div>
      </div>
    </section>`;
}

/* ---------------- readings panel ---------------- */
function ReadingsPanel({ packet }) {
  return html`
    <section class="zone readings reveal" style=${{ animationDelay: "120ms" }} aria-labelledby="env-h">
      <${Head} folio="03" title="Environment" tag="05 ch" />
      <div class="zone-body">
        ${SENSORS.map((s, i) => html`<${Reading} key=${s.key} s=${s}
          value=${packet?.[s.key]} index=${String(i + 1).padStart(2, "0")} />`)}
      </div>
    </section>`;
}

/* ---------------- analysis / mission memory ---------------- */
function Memory({ chat }) {
  const findings = (chat?.findings || []).slice().reverse();
  const tag = !chat ? "—" : findings.length ? findings.length + " found" : "nominal";
  return html`
    <section class="zone memory reveal" style=${{ animationDelay: "180ms" }} aria-labelledby="mem-h">
      <${Head} folio="07" title="Analysis" tag=${tag} />
      <div class="memory-body">
        ${!chat
          ? html`<p class="memory-empty">No active session.</p>`
          : findings.length === 0
          ? html`<p class="memory-empty">No findings yet — conditions nominal.</p>`
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
      <${Head} folio="04" title="Trends">
        <div class="legend" aria-label="Series">
          ${TRENDS.map(s => html`<span key=${s.key}><i style=${{ background: s.color }}></i>${s.name}</span>`)}
        </div>
      <//>
      <div class="trend-body"><${Trends} packet=${packet} /></div>
    </section>`;
}

/* ---------------- agent (AI) ----------------
   The agent has a "mood" derived from what it's saying + live sensor state.
   That mood drives an animated glyph so the analysis reads as intent, not just text. */
const INTENTS = {
  idle:     { key: "idle",     label: "Standby",   color: "var(--ink-3)", face: "-_-" },
  scanning: { key: "scanning", label: "Scanning",  color: "var(--ink-2)", face: "o_o" },
  thinking: { key: "thinking", label: "Analyzing", color: "var(--ink)",   face: "o_O" },
  clear:    { key: "clear",    label: "All Clear", color: "var(--go)",     face: "^_^" },
  caution:  { key: "caution",  label: "Caution",   color: "var(--warn)",   face: ":o"  },
  alert:    { key: "alert",    label: "Alert",     color: "var(--accent)", face: "x_x" },
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
  if (rank == null) return { kind: "idle", label: "Awaiting Data", cause: "No telemetry yet" };
  let cause = "All readings nominal";
  if (rank > 0) {
    for (const s of SENSORS) {
      const v = packet[s.key];
      if (v == null || isNaN(v)) continue;
      const [lbl, k] = s.st(v);
      if ((k === "abort" ? 2 : k === "warn" ? 1 : 0) === rank) { cause = `${s.name} · ${lbl}`; break; }
    }
  }
  if (rank === 2) return { kind: "abort", label: "Danger", cause };
  if (rank === 1) return { kind: "warn",  label: "Caution", cause };
  return { kind: "go", label: "Safe", cause };
}

// Intent: analysis-in-flight wins, then keywords in what the agent said, then sensors.
function deriveIntent(ai, packet, connected) {
  if (ai.analyzing) return INTENTS.thinking;
  const t = (ai.text || "").toLowerCase();
  if (/\b(danger|abort|critical|hazard|emergency|evacuat|fire|toxic)\b/.test(t)) return INTENTS.alert;
  if (/\b(caution|warning|careful|slow|obstacle|collision|bump|approach|elevated|moderate|watch|steer)\b/.test(t)) return INTENTS.caution;
  if (/\b(clear|safe|normal|nominal|stable|good|proceed|no threat|all systems)\b/.test(t)) return INTENTS.clear;
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
  if (ai.phase === "thinking") return html`<div class="agent-timing is-live">Thinking… <b><${Stopwatch} since=${ai.since} /></b></div>`;
  if (ai.phase === "speaking") return html`<div class="agent-timing is-live">Synthesizing voice… <b><${Stopwatch} since=${ai.since} /></b></div>`;
  if (ai.llm != null) return html`<div class="agent-timing">LLM <b>${(ai.llm / 1000).toFixed(1)}s</b> · TTS <b>${ai.tts != null ? (ai.tts / 1000).toFixed(1) + "s" : "—"}</b></div>`;
  return null;
}

function Agent({ ai, tts, packet, connected, speaking, chats, activeChat, onNewChat, onSelectChat, onDeleteChat, onBrief, onAnalyze, onToggleTts, onPick, onMock, onAsk }) {
  const intent = deriveIntent(ai, packet, connected);
  const v = assess(packet);
  const briefed = activeChat && activeChat.mission;
  return html`
    <section class=${"zone agent reveal is-" + intent.key + (ai.analyzing ? " is-analyzing" : "") + (speaking ? " is-speaking" : "")}
      style=${{ animationDelay: "120ms", "--agent-c": intent.color }} aria-labelledby="agent-h">
      <${Head} folio="02" title="Agent" tag=${ai.badge} />
      <div class="agent-body">
        <div class="agent-topbar">
          ${briefed
            ? html`<button type="button" class="brief-back agent-back" onClick=${() => onSelectChat("")}>← Sessions · ${activeChat.title}</button>`
            : html`<span class="agent-topbar-spacer"></span>`}
          <label class="switch agent-voice" title="Toggle Blackout's voice">
            <input type="checkbox" checked=${tts} onChange=${onToggleTts} />
            <span class="switch-track" aria-hidden="true"><span class="switch-knob"></span></span>
            Voice
          </label>
        </div>
        ${!activeChat
          ? html`<${ChatSelect} chats=${chats} onNew=${onNewChat} onSelect=${onSelectChat} onDelete=${onDeleteChat} />`
          : !briefed
          ? html`<${Briefing} onBrief=${onBrief} onBack=${() => onSelectChat("")} busy=${ai.analyzing} />`
          : html`<${React.Fragment}>
        <div class="agent-stage">
          <span class="agent-grid" aria-hidden="true"></span>
          <span class="agent-mark" aria-hidden="true">AGT</span>
          <div class="agent-orb"><${AgentIcon} intent=${intent} /></div>
          ${speaking
            ? html`<div class="agent-eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>`
            : html`<span class="agent-state-label"><span class="agent-face">${intent.face}</span> ${intent.label}</span>`}
        </div>
        <div class="agent-speech">
          <p class="agent-text" key=${ai.text} role="status" aria-live="polite">${ai.text}</p>
          <${AgentTiming} ai=${ai} />
        </div>
        <div class=${"verdict is-" + v.kind} role="status" aria-live="polite">
          <span class="verdict-k">Entry Status</span>
          <strong class="verdict-label">${v.label}</strong>
          <span class="verdict-cause">${v.cause}</span>
        </div>
        <div class="agent-foot">
          <button class="btn btn--primary" type="button" onClick=${onAnalyze} disabled=${ai.analyzing}>
            ${ai.analyzing ? "Analyzing…" : "Run Analysis"}
          </button>
          <button class="btn" type="button" onClick=${onMock} disabled=${ai.analyzing} title="Inject random sensor data — no Arduino needed">
            Mock Data
          </button>
        </div>
        <${Ask} onAsk=${onAsk} busy=${ai.analyzing} />
        <details class="ai-hist agent-hist">
          <summary>History · ${ai.history.length}</summary>
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
      <div class="mission-head"><span class="mission-k">Sessions</span></div>
      ${chats.length === 0
        ? html`<p class="chat-empty">No chats created.</p>`
        : html`<div class="chat-list">
            ${chats.slice().reverse().map((c, i) => html`
              <div key=${c.id} class="chat-item" style=${{ animationDelay: (i * 45) + "ms" }}>
                <button type="button" class="chat-item-main" onClick=${() => onSelect(c.id)}>
                  <span class="chat-item-title">${c.title || "Untitled"}</span>
                  <span class="chat-item-sub">${c.mission ? "Briefed" : "Not briefed"}</span>
                </button>
                <button type="button" class="chat-del" onClick=${() => onDelete(c.id)} title="Delete chat" aria-label="Delete chat">×</button>
              </div>`)}
          </div>`}
      <button type="button" class="btn btn--primary chat-new" onClick=${onNew}>+ New Chat</button>
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
    const rec = new SpeechRec();
    rec.lang = "en-US"; rec.interimResults = false; rec.maxAlternatives = 1;
    rec.onresult = (e) => onText(e.results[0][0].transcript);
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec; setListening(true); rec.start();
  }, [listening, onText]);
  return { listening, toggle, supported: !!SpeechRec };
}

const INTRO = "Hey — I'm Blackout, the recon unit you're sending into the dark. Walk me through the job, one thing at a time.";
const BRIEF_STEPS = [
  { key: "objective",   label: "Objective",   q: "What's the job down there — what am I going in to do?",   ph: "e.g. find a route through the collapsed section, check for survivors" },
  { key: "environment", label: "Environment", q: "What kind of place am I dropping into?",                   ph: "e.g. flooded mine shaft, tight passages, unstable ceiling" },
  { key: "watch",       label: "Watch for",   q: "What should I be watching for down there?",                ph: "e.g. gas pockets, sudden drop-offs, rising water" },
];

function Briefing({ onBrief, onBack, busy }) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState({});
  const review = step >= BRIEF_STEPS.length;
  const cur = BRIEF_STEPS[step];
  const setCur = (val) => setAnswers(a => ({ ...a, [cur.key]: val }));
  const mic = useMic((t) => setAnswers(a => {
    const k = BRIEF_STEPS[step]?.key; if (!k) return a;
    return { ...a, [k]: (a[k] ? a[k] + " " : "") + t };
  }));
  const curVal = (answers[cur?.key] || "");
  const next = () => { if (curVal.trim()) setStep(s => s + 1); };
  const start = () => onBrief(BRIEF_STEPS.map(s => `${s.label}: ${answers[s.key] || "—"}`).join("\n"));

  const dots = html`<div class="brief-dots" aria-hidden="true">
    ${BRIEF_STEPS.map((s, i) => html`<span key=${s.key}
      class=${"brief-dot" + (i === step ? " is-active" : "") + (i < step || review ? " is-done" : "")}></span>`)}
    <span class=${"brief-dot" + (review ? " is-active" : "")}></span>
  </div>`;

  if (review) {
    return html`
      <div class="briefing">
        <button type="button" class="brief-back" onClick=${() => setStep(BRIEF_STEPS.length - 1)}>← Back</button>
        ${dots}
        <div class="brief-orb is-happy"><span class="agent-face">^_^</span></div>
        <div class="brief-step" key="review">
          <p class="brief-greeting">Got it — here's the rundown. Good to go?</p>
          <div class="brief-summary">
            ${BRIEF_STEPS.map((s, i) => html`<div key=${s.key} class="brief-sum-row" style=${{ animationDelay: (i * 70) + "ms" }}>
              <span class="brief-sum-k">${s.label}</span>
              <span class="brief-sum-v">${answers[s.key] || "—"}</span>
            </div>`)}
          </div>
          <button type="button" class="btn btn--primary btn--go" onClick=${start} disabled=${busy}>
            ${busy ? "Heading in…" : "Start Recon"}
          </button>
        </div>
      </div>`;
  }

  return html`
    <div class="briefing">
      <button type="button" class="brief-back" onClick=${step === 0 ? onBack : () => setStep(s => s - 1)}>
        ${step === 0 ? "← Sessions" : "← Back"}
      </button>
      ${dots}
      <div class="brief-orb"><span class="agent-face">o_o</span></div>
      ${step === 0 ? html`<p class="brief-greeting">${INTRO}</p>` : null}
      <div class="brief-step" key=${step}>
        <div class="brief-step-k">Step ${step + 1} of ${BRIEF_STEPS.length} · ${cur.label}</div>
        <p class="brief-q">${cur.q}</p>
        <div class="brief-field">
          <textarea class="mission-input" rows="3" placeholder=${cur.ph}
            value=${curVal} onInput=${e => setCur(e.target.value)} disabled=${busy} autoFocus
            onKeyDown=${e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) next(); }}></textarea>
          ${mic.supported ? html`<button type="button" class=${"ask-mic brief-mic" + (mic.listening ? " is-live" : "")}
            onClick=${mic.toggle} disabled=${busy} aria-pressed=${mic.listening}>
            ${mic.listening ? "● Listening…" : "🎤 Speak"}</button>` : null}
        </div>
        <button type="button" class="btn btn--primary" onClick=${next} disabled=${busy || !curVal.trim()}>
          ${step === BRIEF_STEPS.length - 1 ? "Review" : "Next"}
        </button>
      </div>
    </div>`;
}

/* ---------------- ask blackout (voice, in agent box) ---------------- */
// Predetermined prompts — give the operator ideas and keep questions on-telemetry.
const ASK_SUGGESTIONS = ["What's ahead?", "Is the air breathable?", "Any gas danger?", "Are we level?", "Push on or back out?"];
function Ask({ onAsk, busy }) {
  const mic = useMic(onAsk);
  return html`
    <div class="agent-ask">
      ${mic.supported ? html`<button type="button" class=${"ask-mic" + (mic.listening ? " is-live" : "")} onClick=${mic.toggle}
        disabled=${busy} aria-pressed=${mic.listening}>${mic.listening ? "● Listening…" : "🎤 Ask Blackout"}</button>` : null}
      <div class="ask-chips">
        ${ASK_SUGGESTIONS.map(q => html`<button key=${q} type="button" class="ask-chip"
          onClick=${() => onAsk(q)} disabled=${busy}>${q}</button>`)}
      </div>
    </div>`;
}

/* ---------------- logs ---------------- */
function Logs({ logs }) {
  const [f, setF] = useState("all");
  const tabs = [["all", "All"], ["system", "System"], ["alerts", "Alerts"], ["ai", "AI"]];
  const view = logs.filter(l => f === "all" ? true : f === "alerts" ? (l.type === "warn" || l.type === "danger") : l.type === f);
  return html`
    <section class="zone logs reveal" style=${{ animationDelay: "320ms" }} aria-labelledby="log-h">
      <${Head} folio="05" title="Activity Log" tag=${logs.length + " ev"} />
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
      <${Head} folio="06" title="Serial Monitor">
        <div class="serial-tools">
          <span class="tag">${lines.length}</span>
          ${!hidden && html`<button type="button" class="serial-btn" onClick=${() => setPaused(p => !p)}
            aria-pressed=${paused}>${paused ? "Resume" : "Pause"}</button>`}
          ${!hidden && html`<button type="button" class="serial-btn" onClick=${onClear}>Clear</button>`}
          <button type="button" class="serial-btn" onClick=${onToggle} aria-expanded=${!hidden}
            title="Toggle (backtick \`)">${hidden ? "Show" : "Hide"}</button>
        </div>
      <//>
      ${!hidden && html`
        <div class="serial-stream" role="log" aria-live="off" ref=${streamRef}>
          ${lines.length === 0
            ? html`<div class="serial-empty">No serial traffic yet…</div>`
            : lines.map(l => html`<div key=${l.id} class=${"serial-line" + (l.s ? " is-data" : "")}>
                <span class="t">${l.time}</span><span class="m">${l.text}</span></div>`)}
        </div>`}
    </section>`;
}

/* ---------------- masthead ---------------- */
function Masthead({ connected, ports, currentPort, ping, packets, uptime, onPort }) {
  return html`
    <header class="masthead reveal">
      <div class="mast-top">
        <div class="mast-id">
          <span class="folio-sm">BLK-01</span>
          <span class="label">Flight Console · WRO 2026</span>
        </div>
        <div class="mast-strip">
          <p class="lamp" role="status" aria-live="polite">
            <span class=${"lamp-dot " + (connected ? "is-go" : "is-abort")}></span>
            <span class="lamp-label">${connected ? "Link Live" : "No Signal"}</span>
          </p>
          <label class="port-field">
            <span class="label">Port</span>
            <select class="port-select" value=${currentPort || ""} onChange=${e => onPort(e.target.value)}>
              ${ports.length === 0 && html`<option value="">no ports</option>`}
              ${ports.map(p => html`<option key=${p} value=${p}>${p}</option>`)}
            </select>
          </label>
          <dl class="stat"><dt>Ping</dt><dd>${ping}</dd></dl>
          <dl class="stat"><dt>Packets</dt><dd>${packets}</dd></dl>
          <dl class="stat"><dt>Uptime</dt><dd>${uptime}</dd></dl>
        </div>
      </div>
      <div class="mast-title">
        <h1>Blackout<span class="ver">V1</span></h1>
        <div class="mast-sub">
          <span>Sensor-Hub Telemetry</span>
          <span class="dim">Mega 2560 · Uno R3</span>
        </div>
      </div>
    </header>`;
}

/* ---------------- ticker ---------------- */
function Ticker({ packet, connected }) {
  const items = [
    ["Temp", fmt(packet?.temp, 1) + "°C"],
    ["Humid", fmt(packet?.humid, 0) + "%"],
    ["Dist", fmt(packet?.dist, 0) + "cm"],
    ["Smoke", fmt(packet?.smoke, 0) + "ppm"],
    ["Air", fmt(packet?.airq, 0) + "ppm"],
    ["Roll", fmt(packet?.roll, 0) + "°"],
    ["Pitch", fmt(packet?.pitch, 0) + "°"],
    ["Yaw", fmt(packet?.yaw, 0) + "°"],
    ["Link", connected ? "Live" : "Down"],
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
  const [ai, setAi] = useState({ text: "Awaiting telemetry…", badge: "Standby", analyzing: false, history: [], phase: null, since: 0, llm: null, tts: null });
  const [tts, setTts] = useState(() => localStorage.getItem("tts") !== "false");
  const [ports, setPorts] = useState([]);
  const [currentPort, setCurrentPort] = useState(null);
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
          added.push({ id: Date.now() + Math.random(), text: f.msg[b], kind: b === 2 ? "danger" : "warn", time: new Date().toLocaleTimeString() });
        }
        lastBands.current[f.k] = b;
      }
      if (added.length) setChats(cs => cs.map(c => c.id === chat.id ? { ...c, findings: [...(c.findings || []), ...added].slice(-40) } : c));
    }

    socket.on("connect", () => {
      setConnected(true); addLog("Link established. Awaiting telemetry…", "system");
      socket.emit("set-mission", activeRef.current?.mission || ""); // sync server to active session
    });
    socket.on("disconnect", () => { setConnected(false); setPing("—"); addLog("Link lost. Reconnecting…", "danger"); });
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
          addLog(`Obstacle at ${d.dist.toFixed(0)} cm`, d.dist < 20 ? "danger" : d.dist < 55 ? "warn" : "system");
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
        text, badge: "Online", analyzing: false,
        phase: null, since: 0, llm: p.since ? Date.now() - p.since : null, tts: null,
        history: [...p.history, { text, time: new Date(ts || Date.now()).toLocaleTimeString(), id: Date.now() + Math.random() }].slice(-20),
      }));
      if (ttsRef.current) speakTimed(text);
    };
    // Auto analysis + instant reactions only fire when a briefed session is open —
    // otherwise the dashboard talks to itself on boot with no chat active.
    socket.on("ai-analysis", d => { if (d?.analysis && activeRef.current?.mission) sayAgent(d.analysis, d.timestamp, "AI analysis received.", "ai"); });
    socket.on("agent-blurt", d => { if (d?.text && activeRef.current?.mission) sayAgent(d.text, d.timestamp, "Blackout: " + d.text, "warn"); });
    socket.on("mission-ack", d => { if (d?.text) sayAgent(d.text, d.timestamp, "Mission acknowledged.", "ai"); });
    addLog("Console booted. Standing by.", "system");
    return () => socket.close();
  }, [addLog, speakTimed]);

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

  const switchPort = useCallback(async (path) => {
    if (!path) return;
    addLog(`Switching to ${path}…`, "system");
    try {
      const r = await fetch("/api/ports/switch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
      const data = await r.json();
      if (data.ok) { addLog(`Switched to ${path}`, "system"); toast(`Connected · ${path}`, "ok"); setCurrentPort(path); }
      else { addLog(`Failed: ${data.error}`, "danger"); toast(`Failed · ${data.error}`, "danger"); loadPorts(); }
    } catch (e) { addLog(`Error: ${e.message}`, "danger"); toast(`Error · ${e.message}`, "danger"); }
  }, [addLog, toast, loadPorts]);

  const analyze = useCallback(() => {
    setAi(p => ({ ...p, analyzing: true, badge: "Analyzing…", phase: "thinking", since: Date.now(), llm: null, tts: null }));
    socketRef.current?.emit("request-analysis");
  }, []);
  const mockData = useCallback(() => {
    setAi(p => ({ ...p, analyzing: true, badge: "Analyzing…", phase: "thinking", since: Date.now(), llm: null, tts: null }));
    socketRef.current?.emit("mock-data");
  }, []);
  // Ask Blackout: reply lands in the agent's speech bubble + is spoken. Each chat
  // keeps its own rolling message history so follow-ups have context.
  const ask = useCallback(async (text) => {
    text = (text || "").trim();
    const chat = activeRef.current;
    if (!text || !chat) return;
    addLog(`Operator: ${text}`, "system");
    const t0 = Date.now();
    setAi(p => ({ ...p, analyzing: true, badge: "Thinking…", phase: "thinking", since: t0, llm: null, tts: null }));
    const next = [...(chat.messages || []), { role: "user", content: text }].slice(-12);
    setChats(cs => cs.map(c => c.id === chat.id ? { ...c, messages: next } : c));
    try {
      const r = await fetch("/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });
      const data = await r.json();
      const reply = data.reply || data.error || "No response.";
      if (data.reply) setChats(cs => cs.map(c => c.id === chat.id ? { ...c, messages: [...next, { role: "assistant", content: reply }].slice(-12) } : c));
      addLog("Blackout replied.", "ai");
      setAi(p => ({
        text: reply, badge: "Online", analyzing: false, phase: null, since: 0, llm: Date.now() - t0, tts: null,
        history: [...p.history, { text: reply, time: new Date().toLocaleTimeString(), id: Date.now() + Math.random() }].slice(-20),
      }));
      if (ttsRef.current && data.reply) speakTimed(reply);
    } catch (e) {
      setAi(p => ({ ...p, text: "Comms error: " + e.message, badge: "Online", analyzing: false, phase: null }));
    }
  }, [addLog, speakTimed]);
  const toggleTts = useCallback(() => setTts(p => {
    const n = !p; ttsRef.current = n; localStorage.setItem("tts", n);
    if (!n) { ttsAudio?.pause(); window.speechSynthesis?.cancel(); setSpeaking(false); }
    return n;
  }), []);
  const newChat = useCallback(() => {
    const id = "c" + Date.now();
    setChats(cs => [...cs, { id, title: "New Recon", mission: "", messages: [], created: Date.now() }]);
    setActiveId(id);
    socketRef.current?.emit("set-mission", ""); // no mission until briefed
    if (ttsRef.current) speakTimed(INTRO); // Blackout greets you out loud (user-gesture, so audio is allowed)
  }, [speakTimed]);
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
    addLog(`Mission briefing sent: ${text}`, "system");
    setChats(cs => cs.map(c => c.id === chat.id ? { ...c, mission: text, title: text.length > 30 ? text.slice(0, 30) + "…" : text } : c));
    setAi(p => ({ ...p, analyzing: true, badge: "Copying…", phase: "thinking", since: Date.now() }));
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
          ping=${ping} packets=${packets} uptime=${uptime} onPort=${switchPort} />
        <${Ticker} packet=${view} connected=${connected} />

        <main class="deck" id="sensors">
          <div class="row row--stage">
            <div class="stage-col">
              <${Orientation} packet=${packet} onLog=${addLog} />
              <${ReadingsPanel} packet=${view} />
            </div>
            <${Agent} ai=${ai} tts=${tts} packet=${packet} connected=${connected} speaking=${speaking}
              chats=${chats} activeChat=${activeChat} onNewChat=${newChat} onSelectChat=${selectChat}
              onDeleteChat=${deleteChat} onBrief=${briefMission}
              onAnalyze=${analyze} onToggleTts=${toggleTts} onPick=${pickHistory} onMock=${mockData} onAsk=${ask} />
            <${Memory} chat=${activeChat} />
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
          <span>Sensor Hub <b>Mega 2560</b></span><span class="dot">/</span>
          <span>Motor <b>Uno R3</b></span><span class="dot">/</span>
          <span>Field Console</span>
        </footer>
      </div>

      <${Toasts} items=${toasts} />
    <//>`;
}

createRoot(document.getElementById("root")).render(html`<${App} />`);
