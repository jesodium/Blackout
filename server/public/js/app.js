import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { createPortal, flushSync } from "react-dom";
import htm from "htm";
import { createRoverScene } from "./scene.js";
import { t, getLang, setLang, LANGS, ttsVoice, speechLang, ONBOARDING } from "./i18n.js";
import { parse as blkParse, run as blkRun, lint as blkLint, estimate as blkEstimate, fmtMs } from "./blk.mjs";
import { SageFace } from "./sageface.js";
import { packXbm, coverRect, VID_W, VID_H, VID_BYTES, VID_CHUNK, VID_MAX_FRAMES } from "./oledvid.mjs";
import { initPadNav, cursorOn } from "./padnav.mjs";

const html = htm.bind(React.createElement);

// icons are files masked with currentColor — see icons.mjs / public/icons/
const Icon = ({ n }) => html`<i class=${"icn icn-" + n} aria-hidden="true" />`;

// mirror mode: the judges' tablet reaches this dashboard over the lan, the operator's
// laptop over localhost. anything not local is a read-only copy — same telemetry, no
// link/firmware/drive controls (stop still works, an e-stop should never be gated).
// ?operator on the url unlocks a second machine for good.
const VIEWER = (() => {
  if (new URLSearchParams(location.search).has("operator")) localStorage.setItem("operator", "1");
  return !localStorage.getItem("operator") &&
    !["localhost", "127.0.0.1", "[::1]", "::1"].includes(location.hostname);
})();

// cam mjpeg stream. known homes: tp-link, iphone hotspot, school
// camera walks this list on failure until one loads. offline panel field overrides (localStorage).
const CAM_HOSTS = ["172.20.10.10", "192.168.1.111", "blackout-cam.local"];
const CAM_HOST_DEFAULT = CAM_HOSTS[0];
const camHost = () => localStorage.getItem("camHost") || CAM_HOST_DEFAULT;
const camUrl = (host) => `http://${host}:81/stream`;

/* sensor model */
const fmt = (v, d) => (v == null || isNaN(v) ? "--" : Number(v).toFixed(d));

// min/max define the meter's travel. st() returns [labelkey, kind] — label is i18n key resolved at render.
const SENSORS = [
  { key: "temp",  unit: "°C",  d: 1, min: 0, max: 60,   st: v => v > 45 ? ["st.critical", "abort"] : v > 35 ? ["st.high", "warn"] : ["st.normal", "go"] },
  { key: "humid", unit: "%",   d: 1, min: 0, max: 100,  st: v => v > 75 ? ["st.humid", "warn"] : v < 20 ? ["st.dry", "warn"] : ["st.good", "go"] },
  // distance is navigation cue, never hazard: caution when close to wall (<10cm), clear otherwise
  { key: "dist",  unit: "cm",  d: 0, min: 0, max: 200,  invert: true, st: v => v < 10 ? ["st.tooClose", "warn"] : ["st.clear", "go"] },
  { key: "smoke", unit: "ppm", d: 0, min: 0, max: 1000, st: v => v > 600 ? ["st.hazard", "abort"] : v > 300 ? ["st.warning", "warn"] : ["st.normal", "go"] },
  { key: "airq",  unit: "ppm", d: 0, min: 0, max: 1000, st: v => v > 800 ? ["st.poor", "abort"] : v > 450 ? ["st.moderate", "warn"] : ["st.good", "go"] },
  // height above sea level, derived server-side from the bme280's pressure (see
  // SEA_LEVEL_HPA). never a hazard, so it always reads "go" — worstSensor() walks this
  // same list to pick the go/no-go verdict and altitude must never sway it.
  { key: "alt",   unit: "m",   d: 0, min: 0, max: 3000, st: () => ["st.normal", "go"] },
];

// voice/chat command triggers: saying one of these fires ble directly instead of going to llm
// routines are fixed on-board scripts and drive is live joystick. accents stripped, dots/commas survive.
const norm = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/[\u00a1\u00bf!?]/g, "").replace(/\s+/g, " ").trim();
const DRIVE_PWM = 140, DRIVE_MS = 501;

// two match paths:
// 1. order — explicit "i order you" marker, whatever direction word appears wins
// 2. lead — bare imperatives with no marker, anchored and verb-gated
const ORDER = /^(?:sage[\s,]*)?(?:te (?:lo )?ordeno|te pido|orden|i order you|order)(?:\s+que)?\b\s*(.+)/;
const LEAD = "^(?:sage[\\s,]*)?(?:please\\s+|por favor\\s+)?(?:(?:can|could) you\\s+)?" +
  "(?:(?:go|move|drive|turn|head|ir|ve|vaya|vayas|gira|gires|anda|muevete|camina|sigue)\\s+)*" +
  "(?:(?:a la|al|hacia|para|to the)\\s+)*";
const drv = (words) => new RegExp(LEAD + `(?:${words})\\b`);

// "for 2 seconds" -> 2000, "500ms" -> 500, unsaid -> 501. capped at 5s (no encoder feedback).
function driveMs(txt) {
  const m = txt.match(/(\d+(?:[.,]\d+)?)\s*(ms|milliseconds?|milisegundos?|s|secs?|seconds?|segundos?)\b/);
  if (!m) return DRIVE_MS;
  const n = parseFloat(m[1].replace(",", "."));
  return Math.min(5000, Math.max(50, Math.round(m[2][0] === "m" ? n : n * 1000)));
}

// one direction-word list for both paths. stemmed covers conjugations. "stop" tested first so "para de avanzar" halts.
const DIRS = [
  { w: "stop|halt|freeze|alto|frena\\w*|deten\\w*|pare\\w*|parat\\w*|para(?!\\s+(?:atras|adelante|delante|la|el|de))",
    cmd: () => "stop", ackKey: "sage.stopAck" },
  { w: "back|backwards?|reverse|atras|reversa|retroced\\w*|retroces\\w*",
    cmd: (ms) => `drv,back,${DRIVE_PWM},${ms}`,  ackKey: "sage.backAck" },
  { w: "forward|ahead|straight|adelante|delante|avanz\\w*|avanc\\w*",
    cmd: (ms) => `drv,fwd,${DRIVE_PWM},${ms}`,   ackKey: "sage.fwdAck" },
  { w: "left|izquierda",  cmd: (ms) => `drv,left,${DRIVE_PWM},${ms}`,  ackKey: "sage.leftAck" },
  { w: "right|derecha",   cmd: (ms) => `drv,right,${DRIVE_PWM},${ms}`, ackKey: "sage.rightAck" },
].map(d => ({ ...d, bare: new RegExp(`\\b(?:${d.w})\\b`), re: drv(d.w) }));

const CMD_TRIGGERS = [
  { re: /present yourself|presentate/,        cmd: () => "go,presentation", ackKey: "sage.presentAck" },
  { re: /time to explore|hora de explorar/,   cmd: () => "go,run",          ackKey: "sage.exploreAck" },
  { re: /start the mission|inicia la mision/, cmd: () => "go,mission",      ackKey: "sage.missionAck" },
  ...DIRS,
];

// marked order -> direction word anywhere in rest; otherwise anchored imperative. returns null if no match, goes to sage.
function matchCmd(txt) {
  const ord = txt.match(ORDER);
  if (ord) return DIRS.find(d => d.bare.test(ord[1])) || null;
  return CMD_TRIGGERS.find(c => c.re.test(txt)) || null;
}

const TRENDS = [
  { key: "dist", tkey: "trend.dist", color: "#9a9384" },
  { key: "airq", tkey: "trend.air",  color: "#44cf86" },
  { key: "temp", tkey: "trend.temp", color: "#3b82f6" },
];

/* tts */
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
  // null when no same-language voice -> engine picks by u.lang. never fall back to voices[0] for spanish.
  u.voice = voices.find(v => v.lang.startsWith(pre) && /samantha|alex|google|enhanced|jorge|alvaro|helena/i.test(v.name))
    || voices.find(v => v.lang.startsWith(pre)) || null;
  u.onstart = () => onStart?.();
  u.onend = () => onEnd?.();
  u.onerror = () => onEnd?.();
  speechSynthesis.speak(u);
}

// mission findings: when a metric newly worsens, the analysis panel logs a discovery.
// bands match the server's status thresholds so agent and panel agree.
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

// split into sentences so we speak first one immediately instead of waiting for whole reply
const splitSpeech = (t) => (t.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) || [t]).map(s => s.trim()).filter(Boolean);

// ms edge / deepgram neural tts via server proxy; falls back to browser tts on failure.
// plays sentence-by-sentence, prefetching next clip while current one plays (max 2 concurrent requests).
let ttsAudio = null;
let ttsToken = 0;
let ttsOnEnd = null; // active speak()'s onEnd, so stopSpeech() can settle ui
let ttsProviderRef = "edge"; // "edge" | "deepgram", updated by app toggle
// cut off whatever's playing: supersede loop, stop audio, settle ui.
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

// onboarding lines are pre-rendered to /audio/onboard-<lang>-<key>.mp3 (no 5-7s synth wait).
// play the static clip; fall back to live tts if file is missing.
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

/* zone header (title · tag/tools) */
function Head({ title, tag, children }) {
  return html`
    <div class="zone-head">
      <h2 class="zone-title">${title}</h2>
      ${tag ? html`<span class="tag">${tag}</span>` : children}
    </div>`;
}

/* canvas: trends */
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

/* reading tile (sensor strip) */
function Reading({ s, value }) {
  const has = value != null && !isNaN(value);
  const [labelKey, kind] = has ? s.st(value) : [null, ""];
  const label = has ? t(labelKey) : "—";
  const name = t("sensor." + s.key);
  const raw = has ? Math.max(0, Math.min(100, ((value - s.min) / (s.max - s.min)) * 100)) : 0;
  const pct = s.invert ? 100 - raw : raw;
  return html`
    <div class="reading">
      <div class="reading-head">
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

/* cam box — standalone camera feed */
function CamBox({ packet, onFpv }) {
  return html`
    <section class="zone stage-cam reveal" aria-labelledby="cam-h">
      <div class="zone-head">
        <h2 class="zone-title" id="cam-h">${t("zone.camera")}</h2>
        <button type="button" class="tag fpv-enter" onClick=${onFpv}>△ FPV</button>
      </div>
      <div class="stage-body">
        <${CamView} />
        <dl class="hud-tele">
          <div><dt>${t("hud.dist")}</dt><dd>${fmt(packet?.dist, 0)} cm</dd></div>
        </dl>
      </div>
    </section>`;
}

/* 3d box — standalone 3d orientation viewport */
function ThreeDeeBox({ packet, onLog }) {
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
    <section class="zone stage-3d reveal" aria-labelledby="stage3d-h">
      <div class="zone-head">
        <h2 class="zone-title" id="stage3d-h">${t("stage.title")}</h2>
      </div>
      <div class="stage-body">
        <div class="stage-view stage-view--3d">
          <canvas id="vis-canvas" ref=${canvasRef}></canvas>
          ${failed && html`<div class="viewport-fallback">${t("view.unavailable")}<br/><small>${failed} — ${t("view.liveBelow")}</small></div>`}
          <span class="stage-chip">${t(packet ? "tag.gyroLocked" : "tag.gyroStandby")}</span>
          <div class="hud-cams" role="group" aria-label=${t("cam.group")}>
            ${cams.map(c => html`<button key=${c} type="button"
              class=${"hud-btn" + (cam === c ? " is-active" : "")}
              onClick=${() => pick(c)}>${t("cam." + c)}</button>`)}
          </div>
          <div class="compass" aria-hidden="true">
            <svg ref=${compassRef} viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(236,229,214,0.28)" stroke-width="1.5"/>
              <text x="50" y="25" fill="#ece5d6" font-size="13" font-weight="700" text-anchor="middle" font-family="Archivo, sans-serif">N</text>
              <polygon points="50,15 45,50 55,50" fill="#3b82f6"/>
              <polygon points="50,85 45,50 55,50" fill="rgba(236,229,214,0.4)"/>
            </svg>
            <span>${t("hud.heading")}</span>
          </div>
        </div>
        <dl class="hud-tele">
          <div><dt>${t("hud.dist")}</dt><dd>${fmt(packet?.dist, 0)} cm</dd></div>
          <div><dt>${t("hud.roll")}</dt><dd>${fmt(packet?.roll, 1)}°</dd></div>
          <div><dt>${t("hud.pitch")}</dt><dd>${fmt(packet?.pitch, 1)}°</dd></div>
          <div><dt>${t("hud.yaw")}</dt><dd>${fmt(packet?.yaw, 1)}°</dd></div>
        </dl>
      </div>
    </section>`;
}

/* motor debug: direct-drive bench panel */
// bench tool — labels stay english, not worth 6-language i18n keys.
// every button sends "drv,<verb>,<pwm>,<ms>": firmware auto-halts when <ms> runs out, so dropped ble link never leaves wheels spinning.
// 360s are timed spins (no IMU feedback) — "360 ms" knob is calibration. knobs persist in localStorage.
function MotorDebug({ onCmd, enabled }) {
  const knob = (key, def) => {
    const [v, setV] = useState(+localStorage.getItem(key) || def);
    return [v, (x) => { setV(x); localStorage.setItem(key, x); }];
  };
  const [pwm, setPwm]       = knob("dbgPwm", 180);     // 60 floor: below ~60 the L298N stalls
  const [ms, setMs]         = knob("dbgMs", 800);
  const [spinMs, setSpinMs] = knob("dbgSpinMs", 1200);
  const drv = (verb, dur) => onCmd(`drv,${verb},${pwm},${dur}`);
  const btn = (label, fn, extra = "") => html`
    <button type="button" class=${"btn btn--ghost " + extra} disabled=${!enabled} onClick=${fn}>${label}</button>`;
  const num = (label, v, set, min, max) => html`
    <label class="dbg-knob"><span class="label">${label}</span>
      <input type="number" min=${min} max=${max} value=${v}
        onChange=${e => set(Math.min(max, Math.max(min, +e.target.value || min)))} /></label>`;
  return html`
    <div class="dbg">
      ${!enabled && html`<small class="drive-hint">BT bridge off — buttons dead.</small>`}
      <div class="dbg-body">
        <div class="dbg-grid">
          ${btn("▲ Forward",  () => drv("fwd", ms))}
          ${btn("▼ Backward", () => drv("back", ms))}
          ${btn("◀ Pivot L",  () => drv("left", ms))}
          ${btn("▶ Pivot R",  () => drv("right", ms))}
          ${btn("↺ 360 CCW",  () => drv("left", spinMs))}
          ${btn("↻ 360 CW",   () => drv("right", spinMs))}
          ${btn("▶▶ Fwd 3s",  () => drv("fwd", 3000))}
          ${btn("◀◀ Back 3s", () => drv("back", 3000))}
          <button type="button" class="btn dbg-stop" onClick=${() => onCmd("stop")}>■ STOP</button>
        </div>
        <div class="dbg-knobs">
          <label class="dbg-knob dbg-knob--wide"><span class="label">Speed ${pwm}</span>
            <input type="range" min="60" max="255" value=${pwm} onInput=${e => setPwm(+e.target.value)} /></label>
          ${num("Burst ms", ms, setMs, 50, 9999)}
          ${num("360 ms", spinMs, setSpinMs, 50, 9999)}
        </div>
      </div>
    </div>`;
}

/* oled video: pick a clip, it plays on the robot's panel and the panel goes back to
   the hud on its own when the clip ends. the slider is the per-clip knob — a 1-bit
   panel has no grey, so a dark source needs a lower threshold to show up at all, and
   it stays live while the clip plays so it can be dialled in by eye. */
function OledVideo({ enabled, video, onPlay, onStop }) {
  const [thresh, setThresh] = useState(() => +localStorage.getItem("oledVidThresh") || 128);
  const threshRef = useRef(thresh);
  threshRef.current = thresh;
  const pick = (e) => {
    const f = e.target.files?.[0];
    e.target.value = ""; // picking the same clip twice in a row must still fire change
    if (f) onPlay(f, threshRef);
  };
  const off = !enabled || !!video;
  return html`
    <div class="routines">
      <span class="label">${t("drive.oledVid")}</span>
      ${/* not .routine-row: that selector means "on-board routine buttons", and
           test-mirror asserts every chip in one is a real disabled-able button */""}
      <div class="vid-row">
        <label class=${"chip" + (off ? " is-off" : "")}>
          ${video
            ? (video.phase === "play"
                ? `▶ ${video.fps} FPS`
                : `${t(video.phase === "capture" ? "drive.vidCapture" : "drive.vidUpload")} ${video.pct}%`)
            : t("drive.pickClip")}
          <input type="file" accept="video/*" hidden disabled=${off} onChange=${pick} />
        </label>
        ${video && html`
          <button type="button" class="chip" onClick=${onStop}>■ ${t("drive.stop")}</button>`}
        <input type="range" class="vid-thresh" min="40" max="220" value=${thresh}
          aria-label=${t("drive.vidThresh")} title=${t("drive.vidThresh")}
          onInput=${(e) => { setThresh(+e.target.value); localStorage.setItem("oledVidThresh", e.target.value); }} />
      </div>
    </div>`;
}

/* blk workflow control: pick a saved .blk program, run/stop it from here */
// programs are authored in the popup editor (blk.html) and saved server-side;
// the runner lives here because the browser holds the ble link. each drive step
// is one timed "drv," burst, so a mid-run stop or ble drop auto-halts on firmware.
function BlkCtl({ onCmd, onAnalyze, enabled, busyRef, packetRef }) {
  const [files, setFiles] = useState([]);
  const [sel, setSel] = useState(() => localStorage.getItem("blkSel") || "");
  const [run, setRun] = useState(null); // {n, label, vars} while executing
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null); // last log/ask/find line from the program
  const [preview, setPreview] = useState(null); // what the picked workflow does, before it runs
  const [editorOpen, setEditorOpen] = useState(false); // false | "open" | "closing"
  const token = useRef(0);
  const runRef = useRef(false); // mirrors run for unmount cleanup
  runRef.current = !!run;

  // play the exit animation, then unmount
  const closeEditor = useCallback(() => {
    setEditorOpen(o => o === "open" ? "closing" : o);
    setTimeout(() => setEditorOpen(false), 240);
  }, []);

  // editor iframe talks back: esc asks to close, "save & run" hands us a workflow
  useEffect(() => {
    const fn = (e) => {
      if (e.data === "blk:close") return closeEditor();
      if (e.data?.type === "blk:run" && e.data.name) {
        pick(e.data.name);
        closeEditor();
        setTimeout(() => startRef.current(e.data.name), 320); // let the editor finish closing
      }
    };
    window.addEventListener("message", fn);
    return () => window.removeEventListener("message", fn);
  }, [closeEditor]);

  const loadFiles = useCallback(() => {
    fetch("/api/blk").then(r => r.json()).then(d => setFiles(d.files || [])).catch(() => {});
  }, []);
  // refresh on mount, on editor saves (broadcastchannel), and on tab refocus
  useEffect(() => {
    loadFiles();
    const bc = new BroadcastChannel("blk");
    bc.onmessage = loadFiles;
    window.addEventListener("focus", loadFiles);
    return () => { bc.close(); window.removeEventListener("focus", loadFiles); };
  }, [loadFiles]);
  // read the picked workflow ahead of time: the operator gets its text, its
  // rough runtime and any lint warnings before anything moves.
  useEffect(() => {
    if (!sel) { setPreview(null); return; }
    let live = true;
    fetch("/api/blk/" + encodeURIComponent(sel))
      .then(r => r.ok ? r.text() : Promise.reject())
      .then(text => {
        if (!live) return;
        const { program, errors } = blkParse(text);
        setPreview({ text, warns: errors.length ? errors : blkLint(program), ms: fmtMs(blkEstimate(program)) });
      })
      .catch(() => live && setPreview(null));
    return () => { live = false; };
  }, [sel]);

  // leaving blk mode unmounts this panel — kill a live run and the motors with it
  useEffect(() => () => { token.current++; if (runRef.current) onCmd("stop"); }, [onCmd]);

  const start = async (name = sel) => {
    if (!name || run) return;
    setErr(null);
    setNote(null);
    let text;
    try {
      const r = await fetch("/api/blk/" + encodeURIComponent(name));
      if (!r.ok) throw new Error("not found");
      text = await r.text();
    } catch { setErr("couldn't load workflow"); return; }
    const { program, errors } = blkParse(text);
    if (errors.length) { setErr(errors[0]); return; }
    if (!program.length) { setErr("workflow is empty"); return; }
    const my = ++token.current;
    const stopped = () => token.current !== my;
    const sleep = async (ms) => {
      const t0 = Date.now();
      while (!stopped() && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 50));
    };
    setRun({ n: 0, label: "start" });
    // a yes/no call the program can branch on. the server does the thinking;
    // a failed request reads as "no" so a dead link can't send the rover on.
    const decide = async (path, body) => {
      try {
        const r = await fetch(path, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        const d = await r.json();
        setNote(`${d.yes ? "yes" : "no"}${d.text ? " — " + d.text : ""}`);
        return !!d.yes;
      } catch { setNote("AI didn't answer — treating as no"); return false; }
    };
    // interpreter walks the tree live: conditions read the latest telemetry packet,
    // forever/until loops run until STOP (or their condition trips)
    await blkRun(program, {
      stopped, sleep,
      drive: async (verb, pwm, ms) => { onCmd(`drv,${verb},${pwm},${ms}`); await sleep(ms + 150); },
      analyze: async (focus) => { // fire the agent, wait until it's done (30s cap)
        onAnalyze(null, focus);
        await sleep(500);
        const t0 = Date.now();
        while (!stopped() && busyRef.current && Date.now() - t0 < 30000) await sleep(300);
      },
      ask: (q) => decide("/api/blk-ask", { question: q }),
      find: (thing) => decide("/api/blk-find", { thing }),
      led: (v) => { fetch("/api/led", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: v }) }).catch(() => {}); },
      log: (txt) => setNote(txt),
      say: (txt) => speak(txt),
      sensors: () => packetRef?.current,
      halt: () => onCmd("stop"),
      onStep: (node, n, st) => setRun({ n, label: node.op.replace("_", " "), vars: { ...st.vars } }),
    });
    if (!stopped()) setRun(null);
  };

  // the editor's "save & run" fires through a ref so the message listener above
  // always calls the current start(), not the one from its first render
  const startRef = useRef(start);
  startRef.current = start;

  const stop = () => { token.current++; setRun(null); onCmd("stop"); };
  const pick = (v) => { setSel(v); localStorage.setItem("blkSel", v); };

  return html`
    <div class="blk-ctl">
      <div class="blk-ctl-row">
        <select class="port-select blk-ctl-sel" value=${sel} onChange=${e => pick(e.target.value)} disabled=${!!run}>
          <option value="">${files.length ? "— pick workflow —" : "no workflows yet"}</option>
          ${files.map(f => html`<option key=${f} value=${f}>${f}</option>`)}
        </select>
        <button type="button" class="btn btn--ghost" title="reload list" onClick=${loadFiles}>⟳</button>
        <button type="button" class="btn btn--ghost" onClick=${() => setEditorOpen("open")}>EDITOR</button>
      </div>
      ${run
        ? html`<button type="button" class="btn blk-stop" onClick=${stop}>■ STOP — step ${run.n} · ${run.label.toUpperCase()}</button>`
        : html`<button type="button" class="btn btn--primary" disabled=${!enabled || !sel} onClick=${() => start()}>▶ RUN WORKFLOW</button>`}
      ${preview && !run && html`
        <details class="blk-prev">
          <summary>${preview.text.split("\n").filter(l => l.trim()).length} lines · ~${preview.ms} per pass${preview.warns.length ? ` · ${preview.warns.length} warning${preview.warns.length === 1 ? "" : "s"}` : ""}</summary>
          <pre>${preview.text}</pre>
          ${preview.warns.map(w => html`<div class="blk-warn" key=${w}><${Icon} n="warn" /> ${w}</div>`)}
        </details>`}
      ${run && Object.keys(run.vars || {}).length > 0 && html`
        <small style=${{ opacity: 0.75, fontFamily: "var(--mono)" }}>
          ${Object.entries(run.vars).map(([k, v]) => `${k}=${Math.round(v * 100) / 100}`).join("  ·  ")}
        </small>`}
      <small style=${{ opacity: 0.7 }}>
        ${err ? html`<span style=${{ color: "var(--accent)" }}>${err}</span>`
          : note ? html`<span style=${{ color: "var(--ink-2)" }}>${note}</span>`
          : !enabled ? "BT bridge off — connect to run."
          : run ? "Running — STOP or switching mode halts the rover. Forever loops run until stopped."
          : "Author programs in the EDITOR (blocks or text), save, run here."}
      </small>
      ${editorOpen && createPortal(html`
        <div class=${"blk-modal" + (editorOpen === "closing" ? " is-closing" : "")}
          onClick=${(e) => { if (e.target === e.currentTarget) closeEditor(); }}>
          <div class="blk-modal-frame">
            <div class="blk-modal-head">
              <span class="label">BLK · Workflow Editor</span>
              <button type="button" class="blk-modal-x" onClick=${closeEditor} aria-label="Close editor">✕</button>
            </div>
            <iframe src="blk.html" title="BLK workflow editor"></iframe>
          </div>
        </div>`, document.body)}
    </div>`;
}

/* true while the first-run tour owns the screen. `inert` + the tour's own key capture
   cover pointer and keyboard; the gamepad is polled, not evented, so it checks this. */
let tourOpen = false;

/* drive — manual control hub: on-screen pad (hold-to-drive), wasd/arrows, gamepad, routines, stop.
   drive is sent as short timed bursts re-sent every 150ms while held: firmware auto-halts 300ms
   after the last burst, so a dropped link or stuck ui never leaves wheels spinning.
   autopilot on = all manual input ignored. control mode: remote + blk live; autonomous placeholder. */
const MODES = [["remote", "REMOTE"], ["blk", "BLK"], ["auto", "AUTO"]];
const KEYMAP = {
  w: "fwd", arrowup: "fwd", s: "back", arrowdown: "back",
  a: "left", arrowleft: "left", d: "right", arrowright: "right",
};
// each discrete verb as its per-side mix, so keys and the on-screen pad go down the
// same tank path as the sticks. matches left()/right() in main.ino — pivots, not arcs.
const VERB_MIX = { fwd: [1, 1], back: [-1, -1], left: [1, -1], right: [-1, 1] };
function Drive({ onCmd, onAnalyze, enabled, leaving, busyRef, packetRef, video, onVideo, onVideoStop }) {
  const [mode, setMode] = useState("remote");
  const [padName, setPadName] = useState(null);
  const bodyRef = useRef(null);   // .drive-body — the box that gets height-animated
  const innerRef = useRef(null);  // .drive-inner — its natural height, read by the observer
  const [verb, setVerb] = useState(null); // live verb for ui readout + pad highlight
  const armed = mode === "remote" && enabled;
  const armedRef = useRef(armed);
  armedRef.current = armed;
  const heldRef = useRef(null);   // verb held via on-screen pad or keyboard
  const keysRef = useRef(new Set());
  const moving = useRef(false);
  const sqWas = useRef(false);
  const analyzeRef = useRef(onAnalyze);
  analyzeRef.current = onAnalyze;

  useEffect(() => {
    const seen = () => setPadName([...navigator.getGamepads()].find(Boolean)?.id || null);
    window.addEventListener("gamepadconnected", seen);
    window.addEventListener("gamepaddisconnected", seen);
    seen();
    return () => { window.removeEventListener("gamepadconnected", seen); window.removeEventListener("gamepaddisconnected", seen); };
  }, []);

  // wasd / arrows — same held-verb path as the on-screen pad. space = stop.
  useEffect(() => {
    const typing = (e) => { const t = e.target; return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable); };
    const down = (e) => {
      if (!armedRef.current || typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === " ") { e.preventDefault(); keysRef.current.clear(); heldRef.current = null; onCmd("stop"); return; }
      if (!KEYMAP[k]) return;
      e.preventDefault();
      keysRef.current.add(k);
      heldRef.current = KEYMAP[k]; // last key pressed wins
    };
    const up = (e) => {
      const k = e.key.toLowerCase();
      if (!KEYMAP[k]) return;
      keysRef.current.delete(k);
      const left = [...keysRef.current].pop();
      heldRef.current = left ? KEYMAP[left] : null;
    };
    const blur = () => { keysRef.current.clear(); heldRef.current = null; };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", blur); };
  }, [onCmd]);

  /* one drive loop for every input source, and every source ends up as the same thing:
     a signed pwm per side ("drv,tank,l,r"). that's what lets the left stick throttle and
     steer at once — the four verbs can only do one or the other.
       left stick   — arcade: y throttles, x steers, mixed, so it arcs while driving
       right stick x — pivot on the spot at a fraction of the band, for lining up
       R2            — turbo (pad-only, no key binding)
       □/X           — analyze
     the d-pad is *not* drive any more: it roams the ui (padnav.mjs). on-screen pad and
     wasd still send discrete verbs, and only when the sticks are idle. */
  const MANUAL_PWM = 110; // manual is precision, not speed
  const TURBO_PWM = 200;
  const SPIN_SCALE = 0.45; // right stick uses under half the band — that's the "slow" in slow spin
  // IMPORTANT NOTE: bench knobs, both. DEADZONE covers a worn stick's drift at rest;
  // MIN_PWM is where this l298n + these motors stop buzzing and start turning. stick
  // travel is mapped into [MIN_PWM, cap] so the first millimetre of throw already moves.
  const DEADZONE = 0.15;
  const MIN_PWM = 55;
  useEffect(() => {
    const dz = (v) => (Math.abs(v) < DEADZONE ? 0 : (v - Math.sign(v) * DEADZONE) / (1 - DEADZONE));
    const duty = (v, cap) => (Math.abs(v) < 0.02 ? 0
      : Math.round(Math.sign(v) * (MIN_PWM + (cap - MIN_PWM) * Math.min(1, Math.abs(v)))));
    const verbOf = (l, r) => (!l && !r ? null
      : Math.abs(l - r) > Math.abs(l + r) ? (l > r ? "left" : "right") : l + r > 0 ? "fwd" : "back");
    const id = setInterval(() => {
      // cursor mode has the sticks aiming a pointer — they must not also be wheels.
      if (!armedRef.current || tourOpen || cursorOn()) { if (moving.current) { moving.current = false; setVerb(null); onCmd("stop"); } return; }
      const pad = [...navigator.getGamepads()].find(Boolean);
      // R2 = button 7. analog on ds4/xbox, so read .value too — .pressed only trips past the deadzone.
      const turbo = !!pad && (pad.buttons[7]?.pressed || (pad.buttons[7]?.value ?? 0) > 0.35);
      const cap = turbo ? TURBO_PWM : MANUAL_PWM;
      let l = 0, r = 0; // normalised -1..1 per side until the duty map at the end
      if (pad) {
        // square (x on xbox) = button 2. press edge only, so holding doesn't queue analyses.
        const sq = !!pad.buttons[2]?.pressed;
        if (sq && !sqWas.current) analyzeRef.current?.();
        sqWas.current = sq;
        const y = -dz(pad.axes[1] ?? 0), x = dz(pad.axes[0] ?? 0); // axis 1 is +down
        l = y - x; r = y + x;
        const rx = dz(pad.axes[2] ?? 0);
        l -= rx * SPIN_SCALE; r += rx * SPIN_SCALE;
      }
      if (!l && !r && heldRef.current) [l, r] = VERB_MIX[heldRef.current];
      // full throttle plus full steering overshoots — scale both back together, or the
      // clip would eat the steering and turn an arc into a straight line.
      const peak = Math.max(Math.abs(l), Math.abs(r));
      if (peak > 1) { l /= peak; r /= peak; }
      l = duty(l, cap); r = duty(r, cap);
      if (!l && !r) {
        if (moving.current) { moving.current = false; setVerb(null); onCmd("stop"); }
        return;
      }
      moving.current = true; setVerb(verbOf(l, r));
      onCmd(`drv,tank,${l},${r},300`);
    }, 150);
    return () => clearInterval(id);
  }, [onCmd]);

  // switching away from remote parks everything: stop any live drive, no burst leaks through.
  const pick = (m) => {
    if (m === mode) return;
    if (mode === "remote") { heldRef.current = null; moving.current = false; setVerb(null); onCmd("stop"); }
    setMode(m);
  };

  /* the body is a different height per mode (pad / blk panel / bare) and sage takes the
     slack, so a raw swap jump-cuts both boxes. animate the real height — not a view
     transition: that snapshots the whole page and freezes the cam feed and 3d view.
     the observer watches .drive-inner (natural height) and animates .drive-body, so a
     late arrival — blk's workflow list and preview each land a fetch after the switch —
     retargets the running tween from wherever it is instead of queueing a second resize. */
  useLayoutEffect(() => {
    const el = bodyRef.current, inner = innerRef.current;
    if (!el || !inner || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let prev = inner.offsetHeight, anim = null;
    const ro = new ResizeObserver(() => {
      const h = inner.offsetHeight;
      if (h === prev) return;
      // start from the last natural height, not el's — by the time the observer runs, layout
      // already moved. only mid-tween is el's own height the honest starting point.
      const from = anim?.playState === "running" ? el.offsetHeight : prev;
      prev = h;
      anim?.cancel();
      el.style.overflow = "hidden"; // only while it moves, or the stop bar's hover glow gets clipped
      anim = el.animate([{ height: from + "px" }, { height: h + "px" }],
        { duration: 340, easing: "cubic-bezier(0.32, 0.72, 0, 1)" });
      anim.finished.then(() => { el.style.overflow = ""; }, () => {}); // cancel rejects — ignore
    });
    ro.observe(inner);
    return () => { ro.disconnect(); anim?.cancel(); };
  }, []);

  const stopAll = () => { heldRef.current = null; keysRef.current.clear(); moving.current = false; setVerb(null); onCmd("stop"); };

  const hold = (v) => (e) => { e.preventDefault(); if (armedRef.current) heldRef.current = v; };
  const release = () => { heldRef.current = null; };
  const padBtn = (v, glyph, key) => html`
    <button type="button" class=${"pad-btn" + (verb === v ? " is-live" : "")} disabled=${!armed}
      aria-label=${v} onPointerDown=${hold(v)} onPointerUp=${release} onPointerLeave=${release}
      onPointerCancel=${release} onContextMenu=${(e) => e.preventDefault()}>
      <span class="pad-glyph" aria-hidden="true">${glyph}</span>
      <kbd aria-hidden="true">${key}</kbd>
    </button>`;

  const hint = mode !== "remote" ? null
    : !enabled ? t("toast.cmdNoLink")
    : verb ? "▶ " + verb.toUpperCase()
    : padName ? t("drive.pad")
    : t("drive.hold");

  return html`
    <section class=${"zone drive " + (leaving ? "is-leaving" : "reveal")} aria-labelledby="drive-h">
      <div class="zone-head">
        <h2 class="zone-title" id="drive-h">${t("zone.drive")}</h2>
        <span class=${"pill " + (padName ? "is-go" : "")}>${padName ? "PAD OK" : "NO PAD"}</span>
      </div>
      <div class="drive-body" ref=${bodyRef}>
       <div class="drive-inner" ref=${innerRef}>
        <div class="conn-seg mode-seg" data-mode=${mode} role="tablist">
          <span class="conn-seg-thumb"></span>
          ${MODES.map(([m, label]) => html`
            <button type="button" key=${m} role="tab" aria-selected=${mode === m}
              class=${mode === m ? "is-active" : ""} onClick=${() => pick(m)}>${label}</button>`)}
        </div>
        ${mode === "remote" ? html`
          <div class=${"pad" + (armed ? "" : " is-off")}>
            <span></span>${padBtn("fwd", "▲", "W")}<span></span>
            ${padBtn("left", "◀", "A")}${padBtn("back", "▼", "S")}${padBtn("right", "▶", "D")}
          </div>
          <small class="drive-hint">${hint}</small>`
        : mode === "blk" ? html`
          <${BlkCtl} onCmd=${onCmd} onAnalyze=${onAnalyze} enabled=${enabled} busyRef=${busyRef} packetRef=${packetRef} />`
        : html`
          <small class="drive-hint">${t("drive.auto")}</small>`}
        ${mode !== "remote" && html`
        <div class="routines">
          <span class="label">${t("drive.routines")}</span>
          <div class="routine-row">
            ${[["presentation", "PRES", "mast.routinePresTitle"], ["run", "RUN", "mast.routineRunTitle"],
               ["mission", "MISSION", "mast.routineMissionTitle"], ["test", "TEST", "mast.routineTestTitle"],
               ["test2", "TEST2", "mast.routineTest2Title"]].map(([r, label, titleKey]) => html`
              <button type="button" key=${r} class="chip" title=${t(titleKey)}
                disabled=${!enabled} onClick=${() => onCmd("go," + r)}>${label}</button>`)}
          </div>
        </div>`}
        ${mode === "auto" && html`
          <button type="button" class=${"stop-bar" + (enabled ? "" : " is-off")} onClick=${stopAll} title=${t("mast.routineStopTitle")}>
            ■ ${t("drive.stop")}
          </button>`}
        <${OledVideo} enabled=${enabled} video=${video} onPlay=${onVideo} onStop=${onVideoStop} />
       </div>
      </div>
    </section>`;
}

/* enum camera settings, [var, [[value, label], ...]]. values are the ov2640's own,
   not ours — see the /control handler in esp32-cam/main/main.ino.
   wb_mode is the pink-cast knob: auto first, the fixed presets compensate when a
   module with no ir-cut filter makes auto give up. framesize caps at SVGA(8)
   because that's what sized the psram buffer at init; lower = less latency. */
const CAM_PICKS = [
  ["wb_mode", [[0, "auto"], [1, "sunny"], [2, "cloudy"], [3, "office"], [4, "home"]]],
  ["framesize", [[8, "SVGA 800×600"], [6, "VGA 640×480"], [5, "CIF 400×296"], [4, "QVGA 320×240"]]],
];

/* camera view (esp32-cam mjpeg) — lives inside the stage */
function CamView() {
  const [state, setState] = useState("loading");
  const [nonce, setNonce] = useState(0);
  const [yielded, setYielded] = useState(false);
  const [host, setHost] = useState(camHost());
  const [settingsOpen, setSettingsOpen] = useState(false);
  // defaults mirror what the firmware sets at boot — the panel opens showing the
  // real state, not zeroes. change one here only if you change it in main.ino too.
  const [sliders, setSliders] = useState({ brightness: -1, contrast: -1, saturation: 0, ae_level: 0, led: 15 });
  const [picks, setPicks] = useState({ wb_mode: 0, framesize: 8 });
  const imgRef = useRef(null);

  useEffect(() => {
    // hang up before unmounting. removeattribute aborts the fetch now — unlike src="", it doesn't re-request page url.
    const y = () => { imgRef.current?.removeAttribute("src"); setYielded(true); };
    // back to "loading", not old state. a remounted <img> whose stream never starts fires neither onLoad nor onError.
    const r = () => { setYielded(false); setState("loading"); setNonce(n => n + 1); };
    window.addEventListener("cam:yield", y);
    window.addEventListener("cam:resume", r);
    return () => { window.removeEventListener("cam:yield", y); window.removeEventListener("cam:resume", r); };
  }, []);

  const fail = useCallback(() => setState("offline"), []);

  useEffect(() => {
    if (yielded || state !== "loading") return;
    const id = setTimeout(fail, 12000);
    return () => clearTimeout(id);
  }, [state, yielded, nonce, host, fail]);

  // dropped feed (cam-yield, wifi hiccup) shouldn't strand operator behind manual retry — keep trying.
  useEffect(() => {
    if (yielded || state !== "offline") return;
    const id = setTimeout(() => { setState("loading"); setNonce(n => n + 1); }, 5000);
    return () => clearTimeout(id);
  }, [state, yielded]);

  const base = camUrl(host);
  const src = base + "?n=" + nonce;

  const applyHost = (v) => {
    const h = v.trim() || CAM_HOST_DEFAULT;
    localStorage.setItem("camHost", h);
    setHost(h); setState("loading"); setNonce(n => n + 1);
  };

  const ctrl = (varName, val) => {
    setSliders(p => ({ ...p, [varName]: val }));
    fetch(`http://${host}/control?var=${varName}&val=${val}`).catch(() => {});
  };
  // the pink wash is white balance, and it comes back two ways: a board still on
  // pre-awb firmware boots with frozen gains, and set_framesize re-runs the sensor
  // init on *any* firmware, dropping the awb chain with it. so re-assert it whenever
  // the stream goes live or the resolution changes, rather than trusting it to stick.
  // all three matter — whitebal alone leaves the gains where the sensor left them.
  const forceAwb = () => {
    for (const [k, v] of [["whitebal", 1], ["awb_gain", 1], ["wb_mode", picks.wb_mode]])
      fetch(`http://${host}/control?var=${k}&val=${v}`).catch(() => {});
  };
  // enum settings — same endpoint, but a slider can't label "cloudy" vs "office".
  // framesize reallocates the frame buffer, so the stream stutters for a frame on
  // change; it can't exceed the init size (SVGA=8) — see the control handler.
  const pick = (varName, val) => {
    setPicks(p => ({ ...p, [varName]: val }));
    fetch(`http://${host}/control?var=${varName}&val=${val}`)
      .then(() => { if (varName === "framesize") forceAwb(); }) // reinit dropped it
      .catch(() => {});
  };

  return html`
    <div class="stage-view stage-view--cam">
      ${yielded
        ? html`<div class="viewport-fallback">${t("cam.scanning")}</div>`
        : state !== "offline"
        ? html`<img ref=${imgRef} src=${src} alt=${t("zone.camera")} class="cam-feed"
            onLoad=${() => { setState("live"); localStorage.setItem("camHost", host); forceAwb(); }}
            onError=${fail} />`
        : html`<div class="viewport-fallback">${t("cam.offline")}<br/>
            <small>${base}</small><br/>
            <input type="text" class="cam-host" defaultValue=${host} aria-label=${t("zone.camera")}
              placeholder=${CAM_HOST_DEFAULT}
              onKeyDown=${(e) => { if (e.key === "Enter") applyHost(e.target.value); }}
              onBlur=${(e) => applyHost(e.target.value)} /><br/>
            <button type="button" class="btn" onClick=${() => { setState("loading"); setNonce(n => n + 1); }}>${t("cam.retry")}</button>
          </div>`}
      <span class="stage-chip">${t(yielded ? "cam.tag.scanning" : "cam.tag." + state)}</span>
      ${state === "live" && !yielded ? html`
        <div class="cam-tools">
          <button type="button" class="hud-btn" aria-expanded=${settingsOpen}
            onClick=${() => setSettingsOpen(o => !o)}>${t("cam.settings")}</button>
          ${settingsOpen ? html`
            <div class="cam-pop">
              ${CAM_PICKS.map(([k, opts]) => html`
                <label key=${k} class="cam-pick">
                  <span>${k}</span>
                  <select value=${picks[k]} onChange=${(e) => pick(k, parseInt(e.target.value))}>
                    ${opts.map(([v, label]) => html`<option key=${v} value=${v}>${label}</option>`)}
                  </select>
                </label>`)}
              ${[["brightness", -2, 2], ["contrast", -2, 2], ["saturation", -2, 2], ["ae_level", -2, 2], ["led", 0, 255]].map(([k, min, max]) => html`
                <label key=${k} class="cam-slider">
                  <span class="cam-slider-row"><span>${k}</span><b>${sliders[k]}</b></span>
                  <input type="range" min=${min} max=${max} step="1" value=${sliders[k]}
                    onInput=${(e) => ctrl(k, parseInt(e.target.value))} />
                </label>`)}
            </div>` : null}
        </div>` : null}
    </div>`;
}

/* fpv frame sizes, cycled by OPTIONS (or the hud button). "fill" crops the rotated frame to
   the viewport — see .fpv-fill in the css — the rest scale the whole frame, letterboxed.
   fill stays first so fpv still opens the way it always has. */
const FPV_ZOOMS = [
  { id: "fill", label: "FILL" },
  { id: "fit", label: "FIT", z: 1 },
  { id: "z125", label: "125%", z: 1.25 },
  { id: "z160", label: "160%", z: 1.6 },
];

/* ---- fpv hud ----
   glass drawn over the fullscreen feed: corner brackets, reticle, an attitude
   line driven by roll/pitch and a heading tape driven by yaw. all of it is
   pointer-events:none so it never eats a click meant for the feed underneath.
   with no packet the numbers read 0 and the horizon sits level — a dead link
   should look obviously dead, not frozen at the last good attitude. */
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const wrap360 = (d) => ((d % 360) + 360) % 360;
const headingLabel = (d) => (d % 45 === 0 ? COMPASS[(d / 45) % 8] : String(d).padStart(3, "0"));

// ±50° of heading either side of centre, one tick per 10°. off is -0.5..0.5 of the tape width.
function headingTicks(yaw) {
  const out = [];
  for (let a = Math.ceil((yaw - 50) / 10) * 10; a <= yaw + 50; a += 10) {
    out.push({ deg: wrap360(a), off: (a - yaw) / 100 });
  }
  return out;
}

function FpvOverlay({ packet }) {
  const roll = packet?.roll ?? 0;
  const pitch = packet?.pitch ?? 0;
  const yaw = wrap360(packet?.yaw ?? 0);
  const dist = packet?.dist;
  // close obstacle turns the reticle red — the one number that matters while driving blind
  const near = dist != null && !isNaN(dist) && dist > 0 && dist < 30;

  return html`
    <div class="fpv-glass" aria-hidden="true">
      <div class="fpv-brackets"><i></i><i></i><i></i><i></i></div>

      <div class="fpv-tape">
        ${headingTicks(yaw).map(k => html`
          <span key=${k.deg} class=${"fpv-tick" + (k.deg % 45 === 0 ? " is-major" : "")}
            style=${{ left: (50 + k.off * 100) + "%" }}>${headingLabel(k.deg)}</span>`)}
        <span class="fpv-tape-now">${Math.round(yaw).toString().padStart(3, "0")}°</span>
      </div>

      <div class="fpv-attitude" style=${{ transform: `translateY(${Math.max(-28, Math.min(28, pitch)) * 4}px) rotate(${-roll}deg)` }}>
        <span class="fpv-horizon"></span>
      </div>

      <div class=${"fpv-reticle" + (near ? " is-near" : "")}>
        <svg viewBox="0 0 120 120">
          <path d="M60 42V54 M60 66V78 M42 60H54 M66 60H78" />
          <circle cx="60" cy="60" r="1.6" class="fpv-pip" />
        </svg>
        <span class="fpv-reticle-num">${fmt(dist, 0)}<i>cm</i></span>
      </div>

      <div class="fpv-scan"></div>
      <div class="fpv-vignette"></div>
    </div>`;
}

/* fpv sage — the agent as one glass card over the feed: who is talking, what it
   just said, and the four numbers that matter while driving blind. deliberately
   the same panel as the marketing frame (docs/marketing/template.html #03-telemetry),
   so what people are shown and what they get are the same object — stats down the
   right instead of across, because it carries every sensor, not the headline four.
   the rail agent (voice picker, verdict, history) stays behind in the cockpit —
   fpv keeps the readout, the hud keeps the buttons. */
const FPV_STATS = [
  { k: "sensor.dist",  u: "cm",  v: p => fmt(p?.dist, 0) },
  { k: "sensor.temp",  u: "°C",  v: p => fmt(p?.temp, 0) },
  { k: "sensor.humid", u: "%",   v: p => fmt(p?.humid, 0) },
  { k: "sensor.smoke", u: "ppm", v: p => fmt(p?.smoke, 0) },
  { k: "sensor.airq",  u: "ppm", v: p => fmt(p?.airq, 0) },
  { k: "sensor.alt",   u: "m",   v: p => fmt(p?.alt, 0) },
];

function FpvSage({ ai, packet, speaking, connected }) {
  const state = ai.analyzing ? t("intent.thinking")
    : speaking ? t("intent.speaking")
    : t(deriveIntent(ai, packet, connected).label);
  return html`
    <section class=${"fpv-sage" + (speaking ? " is-speaking" : "")} aria-label="Sage">
      <p class="fpv-sage-bar">
        <i class="fpv-sage-dot" aria-hidden="true"></i><b>Sage</b><span>${t("zone.agent")}</span>
        <span class="fpv-sage-state">${state} · ${getLang()}</span>
      </p>
      <p class=${"fpv-sage-said" + (ai.status ? " sage-" + ai.status : "")} key=${ai.text}
        role="status" aria-live="polite">${ai.text}</p>
      <div class="fpv-sage-row">
        ${FPV_STATS.map(s => html`
          <div key=${s.k}><small>${t(s.k)}</small><strong>${s.v(packet)}<i>${s.u}</i></strong></div>`)}
      </div>
    </section>`;
}

/* ---- mission replay ----
   a recorded run is telemetry stamped against cam stills (server-side grabs —
   the cam is a different origin, so a canvas drawn from the mjpeg <img> is
   tainted). playback is the FPV overlay over the recorded frame, so a replay
   reads exactly like the live feed did. */
const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String((s / 60) | 0).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
// last sample at or before t. IMPORTANT NOTE: linear scan each tick — a 15 min run
// at 20 Hz is 18k samples, still microseconds. index it only if that stops being true.
function at(list, t) {
  let hit = list[0];
  for (const x of list) { if (x.t > t) break; hit = x; }
  return hit;
}
// same, but nothing before the first one — an event hasn't happened yet at t=0.
function before(list, t) {
  let hit = null;
  for (const x of list) { if (x.t > t) break; hit = x; }
  return hit;
}

// what the recorder marks, and how the timeline says it. a kind with no entry
// here draws nothing — keep this in step with recorder.js's mark() callers.
const EVENT_META = {
  finding:  { label: "FINDING DETECTED", glyph: "◆", cls: "k-find" },
  analysis: { label: "ANALYSIS",         glyph: "◎", cls: "k-analysis" },
  sage:     { label: "SAGE",             glyph: "◈", cls: "k-sage" },
  blk:      { label: "BLK DECISION",     glyph: "▣", cls: "k-blk" },
  camlost:  { label: "CAMERA DEAD",      glyph: "◉", cls: "k-dead" },
  camback:  { label: "CAMERA BACK",      glyph: "◉", cls: "k-back" },
};
const SAID = ["sage", "analysis", "finding"]; // kinds that count as sage talking
const BANNER_MS = 4000;                       // how long an event stays called out

function Replay({ run, onClose }) {
  const [t, setT] = useState(0);
  const [play, setPlay] = useState(true);
  const events = (run.events || []).filter(e => EVENT_META[e.kind]);
  const ended = t >= run.dur;
  useEffect(() => {
    if (!play) return;
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const dt = now - last; last = now;
      setT(v => {
        if (v + dt >= run.dur) { setPlay(false); return run.dur; }
        return v + dt;
      });
    }, 60);
    return () => clearInterval(id);
  }, [play, run]);
  const seek = useCallback((ms) => { setPlay(false); setT(Math.max(0, Math.min(run.dur, ms))); }, [run.dur]);
  // esc out, space to hold, arrows to jog. the scrubber keeps its own native
  // arrow handling when it has focus, so don't fight it there.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") return onClose();
      if (e.target?.classList?.contains("rep-scrub")) return;
      if (e.key === " ") { e.preventDefault(); setPlay(p => !p); }
      if (e.key === "ArrowRight") setT(v => Math.min(run.dur, v + 5000));
      if (e.key === "ArrowLeft") setT(v => Math.max(0, v - 5000));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, run.dur]);

  const frame = at(run.frames, t);
  const packet = at(run.packets, t);
  const now = before(events, t);                               // last thing that happened
  const banner = now && t - now.t < BANNER_MS ? now : null;    // ...if it just happened
  const said = before(events.filter(e => SAID.includes(e.kind)), t);
  const dead = before(events.filter(e => e.kind === "camlost" || e.kind === "camback"), t)?.kind === "camlost";
  // sage's card is the live one, fed the line she was on at this point in the run
  const ai = { text: said?.text || "—", status: null, analyzing: false };

  return html`
    <div class="rep">
      ${frame
        ? html`<img class=${"rep-img" + (dead ? " is-stale" : "")} src=${`/recordings/${run.id}/${frame.f}`} alt="" />`
        : html`<p class="rep-blind">no video — cam was down for this run</p>`}
      <${FpvOverlay} packet=${packet} />
      <${FpvSage} ai=${ai} packet=${packet} speaking=${false} connected=${true} />

      <p class="rep-badge">REPLAY · ${run.name}</p>
      ${dead && html`<p class="rep-dead">◉ CAMERA DEAD — no video from here</p>`}
      ${banner && html`
        <p class=${"rep-event " + EVENT_META[banner.kind].cls} key=${banner.t}>
          <b>${EVENT_META[banner.kind].glyph} ${EVENT_META[banner.kind].label}</b>
          <span>${banner.text}</span>
        </p>`}

      <div class="rep-bar">
        <button type="button" class="hud-btn" onClick=${() => { if (ended) setT(0); setPlay(p => ended || !p); }}
          aria-label=${ended ? "restart" : play ? "pause" : "play"}>${ended ? "↻" : play ? "❚❚" : "▶"}</button>
        <div class="rep-track">
          <input class="rep-scrub" type="range" min="0" max=${run.dur} step="100" value=${Math.round(t)}
            aria-label="scrub" onInput=${(e) => seek(+e.target.value)} />
          <div class="rep-ticks">
            ${events.map(e => html`
              <button type="button" key=${e.t + e.kind} class=${"rep-tick " + EVENT_META[e.kind].cls}
                style=${{ left: (e.t / run.dur) * 100 + "%" }} onClick=${() => seek(e.t)}
                title=${`${clock(e.t)} · ${EVENT_META[e.kind].label} — ${e.text}`}
                aria-label=${`${EVENT_META[e.kind].label} at ${clock(e.t)}`}></button>`)}
          </div>
        </div>
        <span class="rep-t">${clock(t)} / ${clock(run.dur)}</span>
        <button type="button" class="hud-btn" onClick=${onClose}>✕ ESC</button>
      </div>
    </div>`;
}

function ReplayList({ runs, onPick, onDelete, onClose }) {
  return html`
    <div class="blk-modal" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="blk-modal-frame rep-list-frame">
        <div class="blk-modal-head">
          <span class="label">MISSION REPLAYS</span>
          <button type="button" class="blk-modal-x" onClick=${onClose}>✕</button>
        </div>
        <div class="rep-list">
          ${!runs.length && html`<p class="report-empty">no recordings yet — hit ● REC on the camera</p>`}
          ${runs.map(r => html`
            <div class="rep-row" key=${r.id}>
              <button type="button" class="rep-open" onClick=${() => onPick(r.id)}>
                <b>${r.name}</b>
                <small>${new Date(r.at).toLocaleString()} · ${clock(r.dur)} · ${r.frames} frames · ${r.packets} pkt${r.events ? ` · ${r.events} events` : ""}</small>
              </button>
              <button type="button" class="serial-btn" onClick=${() => onDelete(r.id)}>DELETE</button>
            </div>`)}
        </div>
      </div>
    </div>`;
}

/* sensor strip — 5 live tiles + trend sparkline, one row under the stage */
function SensorStrip({ packet }) {
  return html`
    <${React.Fragment}>
      <section class="strip reveal" aria-label=${t("zone.environment")}>
        ${SENSORS.map(s => html`<${Reading} key=${s.key} s=${s} value=${packet?.[s.key]} />`)}
      </section>
      <div class="reading trend-cell reveal" aria-label=${t("zone.trends")}>
        <div class="reading-head">
          <span class="reading-name">${t("zone.trends")}</span>
          <span class="legend">
            ${TRENDS.map(s => html`<span key=${s.key} class="legend-item"><i style=${{ background: s.color }}></i>${t(s.tkey)}</span>`)}
          </span>
        </div>
        <div class="trend-body"><${Trends} packet=${packet} /></div>
      </div>
    <//>`;
}

/* analysis / mission memory (drawer tab) */
function Memory({ chat }) {
  const findings = (chat?.findings || []).slice().reverse();
  const tag = !chat ? "—" : findings.length ? t("tag.found", { n: findings.length }) : t("tag.nominal");
  return html`
    <section class="zone memory" aria-labelledby="mem-h">
      <${Head} title=${t("zone.analysis")} tag=${tag} />
      <div class="memory-body">
        ${!chat
          ? html`<p class="memory-empty">${t("mem.noSession")}</p>`
          : findings.length === 0
          ? html`<p class="memory-empty">${t("mem.noFindings")}</p>`
          : findings.map(f => html`<div key=${f.id} class=${"memory-item is-" + f.kind}>
              <span class="memory-dot" aria-hidden="true"></span>
              <span class="memory-text">${f.text}</span>
              <span class="memory-time">${f.time}</span>
              ${f.img && html`<img class="memory-shot" src=${f.img} alt=${f.text} loading="lazy" />`}
            </div>`)}
      </div>
    </section>`;
}

/* agent (ai)
   mood derived from what it says + live sensor state. drives animated glyph so analysis reads as intent, not just text. */
// label is i18n key, resolved at render via t(). key doubles as the SageFace mood.
const INTENTS = {
  idle:     { key: "idle",     label: "intent.idle",     color: "var(--ink-3)" },
  scanning: { key: "scanning", label: "intent.scanning", color: "var(--ink-2)" },
  thinking: { key: "thinking", label: "intent.thinking", color: "var(--ink)"   },
  clear:    { key: "clear",    label: "intent.clear",    color: "var(--go)"     },
  caution:  { key: "caution",  label: "intent.caution",  color: "var(--warn)"   },
  alert:    { key: "alert",    label: "intent.alert",    color: "var(--accent)" },
};

// worst pill across all live readings: 0 go · 1 warn · 2 abort · null no data.
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

// go/no-go verdict for operator: worst sensor decides, named so reason is visible.
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

// intent: analysis-in-flight wins, then keywords in agent text, then sensors.
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

/* animated glyph — one svg per intent, parts animated via css (see .ai-glyph) */
function AgentIcon({ intent }) {
  const k = intent.key;
  if (k === "thinking") return html`<svg class="ai-glyph" viewBox="0 0 120 120" aria-hidden="true">
    <circle class="g-faint" cx="60" cy="60" r="40"/>
    <circle class="g-track" cx="60" cy="60" r="40"/>
    <g class="g-spin g-orbit">
      <circle class="g-fill g-dot g-dot1" cx="60" cy="20" r="6"/>
      <circle class="g-fill g-dot g-dot2" cx="60" cy="20" r="6" transform="rotate(120 60 60)"/>
      <circle class="g-fill g-dot g-dot3" cx="60" cy="20" r="6" transform="rotate(240 60 60)"/>
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

// live ticking elapsed counter (since a timestamp), ~10fps.
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

function Agent({ ai, tts, ttsProv, hasDeepgram, packet, connected, speaking, chats, activeChat, onNewChat, onSelectChat, onDeleteChat, onBrief, onSpeak, onAnalyze, onToggleTts, onToggleTtsProvider, onPick, onMock, onAsk, onReport }) {
  const intent = deriveIntent(ai, packet, connected);
  const v = assess(packet);
  const briefed = activeChat && activeChat.mission;
  return html`
    <section class=${"zone agent reveal is-" + intent.key + (ai.analyzing ? " is-analyzing" : "") + (speaking ? " is-speaking" : "")}
      style=${{ "--agent-c": intent.color }} aria-labelledby="agent-h">
      <${Head} title=${t("zone.agent")} tag=${t(ai.badge)} />
      <div class="agent-body">
        <div class="agent-topbar">
          ${briefed
            ? html`<button type="button" class="brief-back agent-back" onClick=${() => onSelectChat("")}>${t("brief.sessions")} · ${activeChat.title}</button>`
            : html`<span class="agent-topbar-spacer"></span>`}
          <select class="agent-voice-sel" title=${t("agent.voiceTitle")} aria-label=${t("agent.voiceTitle")}
            value=${!tts ? "off" : (hasDeepgram && ttsProv === "deepgram" ? "deepgram" : "edge")}
            onChange=${e => {
              const v = e.target.value;
              if (v === "off") { if (tts) onToggleTts(); return; }
              if (!tts) onToggleTts();
              if (hasDeepgram && v !== ttsProv) onToggleTtsProvider();
            }}>
            <option value="off">${t("agent.voiceOff")}</option>
            <option value="edge">${t("agent.voiceEdge")}</option>
            ${hasDeepgram ? html`<option value="deepgram">${t("agent.voiceDg")}</option>` : null}
          </select>
        </div>
        ${!activeChat
          ? html`<${ChatSelect} chats=${chats} onNew=${onNewChat} onSelect=${onSelectChat} onDelete=${onDeleteChat} />`
          : !briefed
          ? html`<${Briefing} onBrief=${onBrief} onBack=${() => onSelectChat("")} onSpeak=${onSpeak} busy=${ai.analyzing} />`
          : html`<${React.Fragment}>
        <div class="agent-stage">
          <span class="agent-grid" aria-hidden="true"></span>
          ${ai.analyzing
            ? html`<span class="agent-analyzing-label">${t("intent.thinking")}</span>`
            : html`<div class="agent-orb"><${AgentIcon} intent=${intent} /></div>
          ${speaking
            ? html`<div class="agent-eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>`
            : html`<span class="agent-state-label"><${SageFace} mood=${intent.key} /> ${t(intent.label)}</span>`}`}
        </div>
        <div class="agent-speech">
          <p class=${"agent-text" + (ai.status ? " sage-" + ai.status : "")} key=${ai.text} role="status" aria-live="polite">${ai.text}</p>
          <${AgentTiming} ai=${ai} />
        </div>
        <div class=${"verdict is-" + v.kind} role="status" aria-live="polite">
          <span class="verdict-k">${t("verdict.entryStatus")}</span>
          <strong class="verdict-label">${v.label}</strong>
          <span class="verdict-cause">${v.cause}</span>
        </div>
        <div class="agent-foot">
          <${Ask} onAsk=${onAsk} busy=${ai.analyzing} />
          <button class="btn btn--primary" type="button" onClick=${() => onAnalyze()} disabled=${ai.analyzing}>
            ${ai.analyzing ? t("agent.analyzing") : t("agent.runAnalysis")}
          </button>
          <details class="foot-menu" onBlur=${e => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.open = false; }}>
            <summary class="btn foot-icon" title=${t("agent.more")} aria-label=${t("agent.more")}>⋯</summary>
            <div class="foot-menu-pop" onClick=${e => { e.currentTarget.closest("details").open = false; }}>
              <span class="menu-label">${t("ask.pick")}</span>
              ${ASK_SUGGESTIONS.map(q => html`<button key=${q} class="menu-item" type="button"
                onClick=${() => onAsk(t(q))} disabled=${ai.analyzing}>${t(q)}</button>`)}
              <hr class="menu-sep" />
              <button class="menu-item" type="button" onClick=${onMock} disabled=${ai.analyzing} title=${t("agent.mockTitle")}>
                ${t("agent.mock")}
              </button>
              <button class="menu-item" type="button" onClick=${onReport} title=${t("agent.reportTitle")}>
                ${t("agent.report")}
              </button>
            </div>
          </details>
        </div>
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

/* ---- session report ----
   one object holding everything the session knows: mission, link, verdict,
   telemetry, findings, conversation, analysis, events. the modal renders it and
   the same object is what downloads as .json — the document and the export can
   never disagree because there is only one of them. */
function buildReport({ chat, packet, logs, ai, connected, ping, packets, uptime }) {
  const v = assess(packet);
  return {
    kind: "blackout.session-report",
    version: 1,
    generated: new Date().toISOString(),
    session: {
      id: chat?.id || null,
      title: chat?.title || null,
      mission: chat?.mission || null,
      started: chat?.created ? new Date(chat.created).toISOString() : null,
    },
    link: { connected, ping, packets, uptime },
    verdict: { kind: v.kind, label: v.label, cause: v.cause },
    environment: SENSORS.map(s => {
      const value = packet?.[s.key];
      const ok = value != null && !isNaN(value);
      const [lblKey, kind] = ok ? s.st(value) : [null, null];
      return { key: s.key, label: t("sensor." + s.key), value: ok ? Number(value) : null, unit: s.unit, status: lblKey ? t(lblKey) : null, kind };
    }),
    // raw packet too: attitude, co, bumps and anything the csv grows later that
    // has no tile yet still lands in the export.
    telemetry: packet || null,
    findings: (chat?.findings || []).map(f => ({ time: f.time, kind: f.kind, text: f.text, hasImage: !!f.img })),
    conversation: (chat?.messages || []).map(m => ({ role: m.role, content: m.content })),
    analysis: (ai?.history || []).map(h => ({ time: h.time, text: h.text })),
    events: logs.map(l => ({ time: l.time, type: l.type, text: l.text })),
  };
}

function downloadReport(rep) {
  const stamp = rep.generated.slice(0, 19).replace(/[:T]/g, "-");
  const slug = (rep.session.title || "session").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "session";
  // desktop shell: native save sheet instead of a silent drop into ~/Downloads
  if (window.blackout) {
    window.blackout.saveFile({
      defaultName: `blackout-${slug}-${stamp}.json`,
      data: JSON.stringify(rep, null, 2),
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    return;
  }
  const url = URL.createObjectURL(new Blob([JSON.stringify(rep, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `blackout-${slug}-${stamp}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000); // revoking in the same tick cancels the download
}

function ReportRow({ k, v, kind, img }) {
  return html`<div class=${"report-row" + (kind ? " is-" + kind : "")}>
    <span class="report-k">${k}</span><span class="report-v">${v}${img ? html` <${Icon} n="camera" />` : null}</span></div>`;
}

function ReportModal({ report, closing, onClose }) {
  const s = report.session;
  const empty = html`<p class="report-empty">${t("report.none")}</p>`;
  return html`
    <div class=${"blk-modal" + (closing ? " is-closing" : "")} onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="blk-modal-frame report-frame" role="dialog" aria-label=${t("report.title")}>
        <div class="blk-modal-head">
          <span class="label">${t("report.title")}</span>
          <div class="report-actions">
            <button type="button" class="blk-modal-x" onClick=${() => downloadReport(report)}>${t("report.export")}</button>
            <button type="button" class="blk-modal-x" onClick=${onClose}>${t("report.close")}</button>
          </div>
        </div>
        <div class="report-body">
          <h2 class="report-title">${s.title || t("chat.untitled")}</h2>
          <p class="report-sub">${new Date(report.generated).toLocaleString()}</p>

          <h3 class="report-h">${t("report.mission")}</h3>
          ${s.mission ? html`<p class="report-p">${s.mission}</p>` : empty}

          <h3 class="report-h">${t("report.status")}</h3>
          <${ReportRow} k=${t("verdict.entryStatus")} v=${report.verdict.label + " · " + report.verdict.cause} kind=${report.verdict.kind} />
          <${ReportRow} k=${t("report.link")} v=${(report.link.connected ? t("report.online") : t("report.offline"))
            + ` · ${report.link.packets} pkt · ${report.link.ping} · ${report.link.uptime}`} />

          <h3 class="report-h">${t("report.environment")}</h3>
          ${report.environment.map(e => html`<${ReportRow} key=${e.key} k=${e.label}
            v=${e.value == null ? "—" : `${e.value} ${e.unit}${e.status ? " · " + e.status : ""}`} kind=${e.kind} />`)}

          <h3 class="report-h">${t("report.findings")} · ${report.findings.length}</h3>
          ${report.findings.length ? report.findings.map((f, i) => html`
            <${ReportRow} key=${i} k=${f.time} v=${f.text} img=${f.hasImage} kind=${f.kind === "danger" ? "abort" : f.kind === "warn" ? "warn" : null} />`) : empty}

          <h3 class="report-h">${t("report.analysis")} · ${report.analysis.length}</h3>
          ${report.analysis.length ? report.analysis.map((h, i) => html`
            <div key=${i} class="report-note"><span class="report-k">${h.time}</span><p class="report-p">${h.text}</p></div>`) : empty}

          <h3 class="report-h">${t("report.conversation")} · ${report.conversation.length}</h3>
          ${report.conversation.length ? report.conversation.map((m, i) => html`
            <div key=${i} class=${"report-msg is-" + m.role}><span class="report-k">${m.role}</span><p class="report-p">${m.content}</p></div>`) : empty}

          <h3 class="report-h">${t("report.events")} · ${report.events.length}</h3>
          ${report.events.length ? report.events.slice(-40).map((l, i) => html`
            <${ReportRow} key=${i} k=${l.time} v=${l.text} kind=${l.type === "danger" ? "abort" : l.type === "warn" ? "warn" : null} />`) : empty}
        </div>
      </div>
    </div>`;
}

/* chat sessions (in agent box) */
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

// shared speech-to-text. onText gets the recognized transcript.
function useMic(onText) {
  const [listening, setListening] = useState(false);
  const recRef = useRef(null);
  const toggle = useCallback(() => {
    if (!SpeechRec) return;
    if (listening) { recRef.current?.stop(); return; }
    stopSpeech(); // operator is talking — cut agent off so it doesn't talk over them
    const rec = new SpeechRec();
    rec.lang = speechLang(); rec.interimResults = false; rec.maxAlternatives = 1;
    rec.onresult = (e) => onText(e.results[0][0].transcript);
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec; setListening(true); rec.start();
  }, [listening, onText]);
  return { listening, toggle, supported: !!SpeechRec };
}

// briefing step copy resolved through i18n at render. `clip` maps each step to its pre-generated onboarding audio key.
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

  // speak each onboarding step out loud (pre-rendered clips, no synth wait).
  // step 0 plays the intro greeting first, then its question.
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
        <div class="brief-orb is-happy"><${SageFace} mood="clear" /></div>
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
      <div class="brief-orb"><${SageFace} mood="scanning" /></div>
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
            <${Icon} n="mic" /> ${mic.listening ? t("brief.listening") : t("brief.speak")}</button>` : null}
        </div>
        <button type="button" class="btn btn--primary" onClick=${next} disabled=${busy || !curVal.trim()}>
          ${step === BRIEF_STEPS.length - 1 ? t("brief.review") : t("brief.next")}
        </button>
      </div>
    </div>`;
}

/* ask sage (voice, in agent box) */
// predetermined prompts — give operator ideas and keep questions on-telemetry.
// they live in the ⋯ menu; only the mic gets a permanent button.
const ASK_SUGGESTIONS = ["ask.s0", "ask.s1", "ask.s2", "ask.s3", "ask.s4"];
function Ask({ onAsk, busy }) {
  const mic = useMic(onAsk);
  if (!mic.supported) return null;
  return html`<button type="button" class=${"btn foot-icon ask-mic" + (mic.listening ? " is-live" : "")} onClick=${mic.toggle}
    disabled=${busy} aria-pressed=${mic.listening} title=${t("ask.mic")} aria-label=${t("ask.mic")}>
    ${mic.listening ? "●" : html`<${Icon} n="mic" />`}</button>`;
}

/* logs */
function Logs({ logs }) {
  const [f, setF] = useState("all");
  const tabs = [["all", t("log.tabAll")], ["system", t("log.tabSystem")], ["alerts", t("log.tabAlerts")], ["ai", t("log.tabAi")]];
  const view = logs.filter(l => f === "all" ? true : f === "alerts" ? (l.type === "warn" || l.type === "danger") : l.type === f);
  return html`
    <section class="zone logs" aria-labelledby="log-h">
      <${Head} title=${t("zone.logs")} tag=${t("log.ev", { n: logs.length })} />
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

/* serial monitor (drawer tab) */
function SerialMonitor({ lines, onClear }) {
  const [paused, setPaused] = useState(false);
  const streamRef = useRef(null);
  // stick to bottom on new lines unless user paused to read.
  useEffect(() => {
    if (paused) return;
    const el = streamRef.current; if (el) el.scrollTop = el.scrollHeight;
  }, [lines, paused]);
  return html`
    <section class="zone serial" aria-labelledby="ser-h">
      <${Head} title=${t("zone.serial")}>
        <div class="serial-tools">
          <span class="tag">${lines.length}</span>
          <button type="button" class="serial-btn" onClick=${() => setPaused(p => !p)}
            aria-pressed=${paused}>${paused ? t("serial.resume") : t("serial.pause")}</button>
          <button type="button" class="serial-btn" onClick=${onClear}>${t("serial.clear")}</button>
        </div>
      <//>
      <div class="serial-stream" role="log" aria-live="off" ref=${streamRef}>
        ${lines.length === 0
          ? html`<div class="serial-empty">${t("serial.empty")}</div>`
          : lines.map(l => html`<div key=${l.id} class=${"serial-line" + (l.s ? " is-data" : "")}>
              <span class="t">${l.time}</span><span class="m">${l.text}</span></div>`)}
      </div>
    </section>`;
}

/* topbar — slim command strip: identity, link, connection, vitals, lang, console */
function Topbar({ connected, bridge, onBridge, ping, packets, uptime, lanUrl, lang, onLang, onConsole, consoleOpen, clients, onDevices, granted, onSettings }) {
  return html`
    <header class="topbar">
      <div class="brand">
        ${/* htm has no void-element rule — an unclosed <img> swallows the rest of the header */""}
        <img src="brand.svg" alt="" width="24" height="24" />
      </div>
      <p class="lamp visually-hidden" role="status" aria-live="polite">
        ${connected ? t("mast.linkLive") : t("mast.noSignal")}
      </p>
      ${VIEWER ? html`<span class=${"pill top-mirror" + (granted ? " is-go" : "")}>
        ◉ ${t(granted ? "mast.control" : "mast.mirror")}</span>` : html`
      <div class="top-conn">
        <div class="bridge-ctl">
          <button type="button" class=${"bridge-btn " + (bridge.running ? "is-on" : "")}
            disabled=${bridge.busy} onClick=${() => onBridge("toggle")}>
            <span class=${"lamp-dot " + (bridge.running ? "is-go" : "is-abort")}></span>
            ${bridge.busy ? t("mast.bridgeBusy") : bridge.running ? t("mast.linked") : t("mast.connect")}
          </button>
          <button type="button" class="bridge-repair" title=${t("mast.bridgeRepairTitle")}
            disabled=${bridge.busy} onClick=${() => onBridge("reconnect")}>⟳</button>
        </div>
      </div>`}
      <div class="top-stats">
        <dl class="stat"><dt>${t("mast.ping")}</dt><dd>${ping}</dd></dl>
        <dl class="stat"><dt>${t("mast.packets")}</dt><dd>${packets}</dd></dl>
        <dl class="stat"><dt>${t("mast.uptime")}</dt><dd>${uptime}</dd></dl>
        ${lanUrl && html`
          <dl class="stat stat-lan"><dt>${t("mast.tablet")}</dt>
            <dd><button type="button" class="lan-btn" title=${t("mast.tabletTitle")}
              onClick=${() => navigator.clipboard?.writeText(lanUrl)}>${lanUrl.replace("http://", "")}</button></dd>
          </dl>`}
      </div>
      <select class="port-select top-lang" value=${lang} onChange=${e => onLang(e.target.value)} aria-label=${t("mast.lang")}>
        ${LANGS.map(l => html`<option key=${l.code} value=${l.code}>${l.label}</option>`)}
      </select>
      ${!VIEWER && window.blackout && html`
        <button type="button" class="console-btn" onClick=${onSettings} title=${t("settings.title")} aria-label=${t("settings.title")}><${Icon} n="gear" /></button>`}
      ${!VIEWER && html`
        <button type="button" class="console-btn" onClick=${onDevices} title=${t("devices.title")}>
          ◈ ${t("devices.button")} ${clients.length}
        </button>`}
      <button type="button" class=${"console-btn" + (consoleOpen ? " is-active" : "")}
        onClick=${onConsole} aria-pressed=${consoleOpen} title=${t("serial.toggleTitle")}>
        ▤ ${t("drawer.console")}
      </button>
    </header>`;
}

/* console drawer — logs, findings, serial, motor bench. slides over the cockpit */
function Drawer({ open, tab, onTab, onClose, logs, serialLines, onClearSerial, chat, onCmd, enabled, onTutorial }) {
  if (!open) return null;
  const tabs = [["logs", t("zone.logs")], ["findings", t("zone.analysis")], ["serial", t("zone.serial")], ["motor", t("colo.motor")]];
  return html`
    <div class=${"drawer" + (open === "closing" ? " is-closing" : "")} role="region" aria-label=${t("drawer.console")}>
      <div class="drawer-bar">
        <div class="drawer-tabs" role="tablist">
          ${tabs.map(([k, lbl]) => html`<button key=${k} type="button" role="tab" aria-selected=${tab === k}
            class=${"drawer-tab" + (tab === k ? " is-active" : "")} onClick=${() => onTab(k)}>${lbl}</button>`)}
        </div>
        <button type="button" class="serial-btn drawer-tour" onClick=${onTutorial}>${t("tour.restart")}</button>
        <button type="button" class="drawer-x" onClick=${onClose} aria-label="Close">✕</button>
      </div>
      <div class="drawer-body">
        ${tab === "logs" ? html`<${Logs} logs=${logs} />`
        : tab === "findings" ? html`<${Memory} chat=${chat} />`
        : tab === "serial" ? html`<${SerialMonitor} lines=${serialLines} onClear=${onClearSerial} />`
        : html`<${MotorDebug} onCmd=${onCmd} enabled=${enabled} />`}
      </div>
    </div>`;
}

/* flash.sh draws a braille spinner with \r — treat CR as "rewind to start of
   line" so the log pane shows one live line instead of thousands of frames. */
function appendLog(log, chunk) {
  return chunk.split(/(\r\n|\n|\r)/).reduce((acc, tok) => {
    if (tok === "\r") return acc.slice(0, acc.lastIndexOf("\n") + 1);
    if (tok === "\r\n") return acc + "\n";
    return acc + tok;
  }, log);
}

// which rover is on the wire. the giga is V3, the uno r4 is V2 — flash.sh builds
// V2 straight out of git history, so both are flashable from here.
const roverModel = (b) => b.giga ? "Blackout V3" : b.unor4 ? "Blackout V2" : "Blackout";
const anyBoard = (b) => !!(b.giga || b.unor4 || b.esp32cam);

/* usb board plugged in = someone is setting the rover up. that's the only thing
   that surfaces the updater — there's no permanent button for it. */
function UpdateBar({ boards, onUpdate }) {
  const stale = boards.status !== "current";
  return html`
    <div class=${"update-bar" + (stale ? " is-stale" : "")} role="status">
      <span class="lamp-dot ${stale ? "is-abort" : "is-go"}" aria-hidden="true"></span>
      <span class="update-bar-msg">
        ${t("update.connected", { model: roverModel(boards) })} · ${t("update.st." + boards.status)}
      </span>
      <button type="button" class="serial-btn" onClick=${onUpdate}>${t("update.button")}</button>
    </div>`;
}

// flash.sh's stdout is the only progress signal there is — arduino-cli's own
// percentages go to its temp log, not the stream. what does come through is one
// "▸" per board and one "✔" per finished compile/upload: two ticks per board.
const FLASH_TICKS_PER_BOARD = 2;
function flashProgress(log, boards, phase) {
  const heads = [...log.matchAll(/^▸ (.+?) @ /gm)].map(m => m[1]);
  const ticks = (log.match(/✔/g) || []).length;
  const planned = ["giga", "unor4", "esp32cam"].filter(k => boards[k]).length;
  const total = Math.max(planned, heads.length, 1) * FLASH_TICKS_PER_BOARD;
  const board = heads[heads.length - 1] || null;
  const step = !board ? "prep" : ticks % 2 === 0 ? "compile" : "upload";
  // never show a full bar until the script actually exits — 99 is "nearly", not "done"
  return { pct: phase === "done" ? 100 : Math.min(99, Math.round((ticks / total) * 100)), board, step };
}

/* sage's face + bar. the eyes scan while work is happening and settle into
   ^_^ / x_x the moment the script exits — the bar is the actual read-out. */
const FLASH_MOOD = { work: "work", ok: "clear", error: "alert" };
function FlashProgress({ log, boards, phase, code }) {
  const { pct, board, step } = flashProgress(log, boards, phase);
  const state = phase !== "done" ? "work" : code === 0 ? "ok" : "error";
  const label = step === "prep" ? t("update.prep")
    : t(step === "compile" ? "update.compiling" : "update.uploading", { board });
  return html`
    <div class=${"flash-prog is-" + state}>
      <${SageFace} mood=${FLASH_MOOD[state]} />
      <div class="flash-bar" role="progressbar" aria-valuenow=${pct} aria-valuemin="0" aria-valuemax="100"
        aria-label=${t("update.title")}>
        <div class="flash-bar-fill" style=${{ width: pct + "%" }}></div>
      </div>
      <div class="flash-prog-line">
        <span>${phase === "done" ? (code === 0 ? t("update.done") : t("update.error")) : label}</span>
        <span class="flash-pct">${pct}%</span>
      </div>
    </div>`;
}

/* update blackout — self-serve firmware flash over usb. detect → flashing → done */
function UpdateModal({ open, phase, boards, log, code, onFlash, onClose }) {
  const logRef = useRef(null);
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [log]);
  const locked = phase === "flashing"; // no way out mid-flash — pulling the rug corrupts the board
  const board = (label, ok, note) => html`
    <div class=${"flash-board " + (ok ? "is-ok" : "is-missing")}>
      ${label}<small>${ok ? (note || t("update.detected")) : t("update.notDetected")}</small>
    </div>`;
  return html`
    <div class=${"blk-modal" + (open === "closing" ? " is-closing" : "")}
      onClick=${(e) => { if (e.target === e.currentTarget && !locked) onClose(); }}>
      <div class="blk-modal-frame update-frame" role="dialog" aria-label=${t("update.title")}>
        <span class="update-title">${t("update.title")}</span>
        ${phase === "detect" && html`
          <p>${anyBoard(boards) ? t("update.st." + boards.status) : t("update.plugin")}</p>
          <div class="flash-boards">
            ${board(t("update.esp32cam"), boards.esp32cam)}
            ${board(t("update.mainboard"), boards.giga || boards.unor4,
              boards.giga ? "Giga R1 · V3" : boards.unor4 ? "Uno R4 · V2" : null)}
          </div>`}
        ${(phase === "flashing" || phase === "done") && html`
          <${FlashProgress} log=${log} boards=${boards} phase=${phase} code=${code} />
          <div class="flash-log" role="log" ref=${logRef}>${log || "…"}</div>`}
        ${phase === "flashing" && html`<p>${t("update.flashing")}</p>`}
        ${phase === "done" && html`
          <p class=${"flash-status " + (code === 0 ? "is-ok" : "is-error")}>
            ${code === 0 ? t("update.done") : t("update.error")}
          </p>`}
        ${!locked && html`
          <div class="update-actions">
            ${phase === "detect" && html`
              <button type="button" class="serial-btn" disabled=${!anyBoard(boards)}
                onClick=${onFlash}>${t("update.flashNow")}</button>`}
            <button type="button" class="serial-btn" onClick=${onClose}>${t("update.close")}</button>
          </div>`}
      </div>
    </div>`;
}

/* toasts */
function Toasts({ items }) {
  return html`<div class="toasts">${items.map(t => html`<div key=${t.id} class=${"toast k-" + t.kind + (t.leaving ? " is-leaving" : "")}>${t.msg}</div>`)}</div>`;
}

/* connected devices — the host's roster of every dashboard on the lan, with the
   control switch for each. the server decides who's host (loopback) and enforces it. */
function DevicesModal({ open, clients, selfId, onGrant, onClose }) {
  // granting is one-way dangerous, so it goes through a confirm with a 3s arm timer.
  // revoking never asks. { c, closing } — `closing` keeps it mounted for the exit animation.
  const [ask, setAsk] = useState(null);
  const [count, setCount] = useState(3);
  useEffect(() => {
    if (!ask || ask.closing) return;
    setCount(3);
    const iv = setInterval(() => setCount(n => Math.max(0, n - 1)), 1000);
    return () => clearInterval(iv);
  }, [ask?.c.id, ask?.closing]);
  const closeAsk = () => { setAsk(a => a && { ...a, closing: true }); setTimeout(() => setAsk(null), 220); };
  return html`
    <div class=${"blk-modal" + (open === "closing" ? " is-closing" : "")}
      onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="blk-modal-frame devices-frame">
        <div class="blk-modal-head">
          <span class="label">${t("devices.title")}</span>
          <button type="button" class="blk-modal-x" onClick=${onClose} aria-label=${t("update.close")}>✕</button>
        </div>
        <ul class="device-list">
          ${clients.length === 0 && html`<li class="device-empty">${t("devices.none")}</li>`}
          ${clients.map(c => html`
            <li key=${c.id} class="device-row">
              <span class="device-name">
                ${c.kind} · ${c.ip}
                ${c.id === selfId ? html`<span class="pill">${t("devices.this")}</span>` : null}
              </span>
              ${c.host
                ? html`<span class="pill is-go">${t("devices.host")}</span>`
                : html`<button type="button" class=${"serial-btn" + (c.granted ? " is-on" : "")}
                    onClick=${() => (c.granted ? onGrant(c.id, false) : setAsk({ c }))}>
                    ${c.granted ? t("devices.full") : t("devices.view")}
                  </button>`}
            </li>`)}
        </ul>
      </div>
      ${ask && html`
        <div class=${"blk-modal" + (ask.closing ? " is-closing" : "")}
          onClick=${(e) => { if (e.target === e.currentTarget) closeAsk(); }}>
          <div class="blk-modal-frame warn-frame" role="alertdialog" aria-label=${t("devices.confirmTitle")}>
            <span class="warn-title"><${Icon} n="warn" /> ${t("devices.confirmTitle")}</span>
            <p>${t("devices.confirmBody", { name: `${ask.c.kind} · ${ask.c.ip}` })}</p>
            <div class="warn-actions">
              <button type="button" class="serial-btn" onClick=${closeAsk}>${t("devices.confirmCancel")}</button>
              <button type="button" class="serial-btn warn-go" disabled=${count > 0}
                onClick=${() => { onGrant(ask.c.id, true); closeAsk(); }}>
                ${t("devices.confirmGo")}<span class=${"warn-count" + (count > 0 ? "" : " is-done")}> (${count || 1})</span>
              </button>
            </div>
          </div>
        </div>`}
    </div>`;
}

/* operator settings — desktop shell only. Reads/writes <userData>/blackout.env
   through main.js; the server only picks up changes on relaunch since it's
   forked once at launch. */
function SettingsModal({ open, onClose }) {
  const [values, setValues] = useState({ CEREBRAS_API_KEY: "", DEEPGRAM_API_KEY: "", CEREBRAS_MODEL: "", TTS_VOICE: "" });
  const [saved, setSaved] = useState(false);
  useEffect(() => { window.blackout.getSettings().then(setValues); }, []);
  const set = (k) => (e) => { setSaved(false); setValues(v => ({ ...v, [k]: e.target.value })); };
  const save = async () => { await window.blackout.saveSettings(values); setSaved(true); };
  const field = (key, label, placeholder, type = "text") => html`
    <label class="settings-field">
      <span>${label}</span>
      <input type=${type} value=${values[key]} placeholder=${placeholder} onInput=${set(key)} />
    </label>`;
  return html`
    <div class=${"blk-modal" + (open === "closing" ? " is-closing" : "")}
      onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="blk-modal-frame devices-frame settings-frame" role="dialog" aria-label=${t("settings.title")}>
        <div class="blk-modal-head">
          <span class="label">${t("settings.title")}</span>
          <button type="button" class="blk-modal-x" onClick=${onClose} aria-label=${t("update.close")}>✕</button>
        </div>
        <div class="settings-body">
          ${field("CEREBRAS_API_KEY", t("settings.cerebrasKey"), t("settings.unset"), "password")}
          ${field("DEEPGRAM_API_KEY", t("settings.deepgramKey"), t("settings.optional"), "password")}
          ${field("CEREBRAS_MODEL", t("settings.cerebrasModel"), "gemma-4-31b")}
          ${field("TTS_VOICE", t("settings.ttsVoice"), "en-US-AndrewNeural")}
        </div>
        <div class="settings-actions">
          <span class="settings-hint">${saved ? t("settings.saved") : t("settings.hint")}</span>
          ${saved
            ? html`<button type="button" class="serial-btn warn-go" onClick=${() => window.blackout.relaunch()}>${t("settings.relaunch")}</button>`
            : html`<button type="button" class="serial-btn warn-go" onClick=${save}>${t("settings.save")}</button>`}
        </div>
      </div>
    </div>`;
}

/* in-app BLE pairing — desktop shell only. Chrome's native chooser can't be
   styled, so in Electron the main process holds the requestDevice() callback and
   streams discovered devices here; a tap routes the pick back. Browser tabs
   never render this — they keep the native chooser. */
function BlePickerModal({ open, devices, onPick, onCancel }) {
  // IMPORTANT NOTE: electron gives deviceId + deviceName only (no RSSI), and the
  // giga may advertise every robot as "arduino" (untested — see toggleBridge).
  // A name renders bare only when non-empty and unique; otherwise it's tagged
  // with the id tail so three robots never show as three identical rows.
  const names = devices.map((d) => d.deviceName);
  const label = (d) => {
    const name = d.deviceName || t("ble.unnamed");
    const dup = !d.deviceName || names.filter((n) => n === d.deviceName).length > 1;
    return dup ? `${name} · ${d.deviceId.replace(/[^a-zA-Z0-9]/g, "").slice(-4).toUpperCase()}` : name;
  };
  // IMPORTANT NOTE: guess only — the advertised name is all we get. Widen the map
  // if a board ever advertises something more specific than "arduino".
  const assumed = (d) => {
    const n = (d.deviceName || "").toLowerCase();
    if (n.includes("blackout")) return "Blackout V3";
    if (n.includes("arduino") || n.includes("giga")) return "Blackout · Giga R1";
    return t("ble.assumedUnknown");
  };
  return html`
    <div class=${"blk-modal" + (open === "closing" ? " is-closing" : "")}
      onClick=${(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div class="blk-modal-frame devices-frame ble-picker" role="dialog" aria-label=${t("ble.title")}>
        <div class="blk-modal-head">
          <span class="label">BLACKOUT</span>
          <button type="button" class="blk-modal-x" onClick=${onCancel} aria-label=${t("ble.cancel")}>✕</button>
        </div>
        <div class="ble-progress" aria-hidden="true"><span></span></div>
        <ul class="device-list">
          ${devices.length === 0 && html`<li class="device-empty">${t("ble.none")}</li>`}
          ${devices.map((d) => html`
            <li key=${d.deviceId} class="device-row ble-row">
              <button type="button" class="ble-pick" onClick=${() => onPick(d.deviceId)}>
                <span class="ble-pick-main">
                  <span class="device-name">${label(d)}</span>
                  <span class="device-model">${t("ble.assumed")}: ${assumed(d)}</span>
                </span>
                <span class="pill is-go">${t("ble.inRange")}</span>
              </button>
            </li>`)}
        </ul>
        <div class="ble-actions">
          <span class="ble-scanning-label">${t("ble.scanning")}</span>
          <button type="button" class="serial-btn" onClick=${onCancel}>${t("ble.cancel")}</button>
        </div>
      </div>
    </div>`;
}

/* first-run onboard flow — hero → choose model → pair, so first launch reads as
   a real app opening rather than a webpage that starts poking at itself.
   full-screen (not a modal over the dashboard): the dashboard hasn't earned its
   look yet on a first run. viewers (mirror tablets) never see model/pair —
   pairing is the host's bridge, not theirs — App skips them straight through.
   each step is its own component keyed by id in ONBOARD_VIEWS below — adding a
   step means writing a component and adding one line there, nothing else. */
const ONBOARD_CURRENT = { key: "v3", label: "Blackout V3", descKey: "onboard.v3Desc", photo: "onboard/rover-cave.jpg" };
const ONBOARD_LEGACY = [{ key: "v2", label: "Blackout V2", descKey: "onboard.v2Desc" }];
const ONBOARD_MODELS = [ONBOARD_CURRENT, ...ONBOARD_LEGACY];

function OnboardHero({ onStart }) {
  return html`
    <div class="onboard-view onboard-hero">
      <h1 class="onboard-title">${t("onboard.title")}</h1>
      <p class="onboard-desc">${t("onboard.desc")}</p>
      <div class="onboard-feats">
        <span class="onboard-feat">${t("onboard.featDrive")}</span>
        <span class="onboard-feat">${t("onboard.featSensors")}</span>
        <span class="onboard-feat">${t("onboard.featSage")}</span>
      </div>
      <div class="onboard-photos">
        <img src="onboard/rover-cave.jpg" alt="" />
        <img src="onboard/rover.jpg" alt="" />
        <img src="onboard/shot-console.jpg" alt="" />
      </div>
      <button type="button" class="serial-btn warn-go onboard-cta" autoFocus onClick=${onStart}>${t("onboard.startBtn")}</button>
    </div>`;
}

/* legacy pick is gated behind its own confirm popup (reuses the debug-warning's
   3s countdown pattern) since V2 is a retired board, not a peer option to V3. */
function OnboardModel({ onBack, onPickModel }) {
  const [legacyOpen, setLegacyOpen] = useState(false);
  const [confirm, setConfirm] = useState(false); // false | "open" | "closing"
  const [count, setCount] = useState(3);
  useEffect(() => {
    if (confirm !== "open") return;
    setCount(3);
    const id = setInterval(() => setCount((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(id);
  }, [confirm]);
  const closeConfirm = useCallback(() => {
    setConfirm((c) => (c === "open" ? "closing" : c));
    setTimeout(() => setConfirm(false), 220);
  }, []);
  const confirmLegacy = useCallback((key) => { closeConfirm(); onPickModel(key); }, [closeConfirm, onPickModel]);

  return html`
    <${React.Fragment}>
      <div class="onboard-view">
        <button type="button" class="onboard-back" onClick=${onBack}>${t("onboard.back")}</button>
        <h2 class="onboard-h2">${t("onboard.chooseModel")}</h2>
        <button type="button" class="onboard-model-card onboard-model-featured"
          style=${{ backgroundImage: `linear-gradient(180deg, rgba(6,6,7,0.1), rgba(6,6,7,0.88)), url(${ONBOARD_CURRENT.photo})` }}
          onClick=${() => onPickModel(ONBOARD_CURRENT.key)}>
          <span class="onboard-model-label">${ONBOARD_CURRENT.label}</span>
          <span class="onboard-model-desc">${t(ONBOARD_CURRENT.descKey)}</span>
        </button>

        <button type="button" class="onboard-legacy-toggle" aria-expanded=${legacyOpen} onClick=${() => setLegacyOpen((o) => !o)}>
          ${t("onboard.legacyToggle")}
          <span class=${"onboard-legacy-caret" + (legacyOpen ? " is-open" : "")} aria-hidden="true">⌄</span>
        </button>
        <div class=${"onboard-legacy" + (legacyOpen ? " is-open" : "")}>
          <div class="onboard-legacy-inner">
            ${ONBOARD_LEGACY.map((m) => html`
              <button key=${m.key} type="button" class="onboard-model-card onboard-model-legacy" onClick=${() => setConfirm("open")}>
                <span class="onboard-legacy-badge">${t("onboard.legacyBadge")}</span>
                <span class="onboard-model-label">${m.label}</span>
                <span class="onboard-model-desc">${t(m.descKey)}</span>
              </button>`)}
          </div>
        </div>
      </div>
      ${confirm && createPortal(html`
        <div class=${"blk-modal" + (confirm === "closing" ? " is-closing" : "")}
          onClick=${(e) => { if (e.target === e.currentTarget) closeConfirm(); }}>
          <div class="blk-modal-frame warn-frame" role="alertdialog" aria-label=${t("onboard.legacyWarnTitle")}>
            <span class="warn-title"><${Icon} n="warn" /> ${t("onboard.legacyWarnTitle")}</span>
            <p>${t("onboard.legacyWarnBody")}</p>
            <div class="warn-actions">
              <button type="button" class="serial-btn" onClick=${closeConfirm}>${t("onboard.legacyCancel")}</button>
              <button type="button" class="serial-btn warn-go" disabled=${count > 0} onClick=${() => confirmLegacy(ONBOARD_LEGACY[0].key)}>
                ${t("onboard.legacyContinue")}<span class=${"warn-count" + (count > 0 ? "" : " is-done")}> (${count || 1})</span>
              </button>
            </div>
          </div>
        </div>`, document.body)}
    </${React.Fragment}>`;
}

function OnboardPair({ model, bridge, onBack, onConnect, onSkipConnect }) {
  const modelLabel = ONBOARD_MODELS.find((m) => m.key === model)?.label || "Blackout";
  return html`
    <div class="onboard-view">
      <button type="button" class="onboard-back" disabled=${bridge.busy} onClick=${onBack}>${t("onboard.back")}</button>
      <h2 class="onboard-h2">${t("onboard.pairTitle", { model: modelLabel })}</h2>
      <svg class="onboard-sweep" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.5" />
        <circle cx="12" cy="12" r="5.5" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.5" />
        <path class="g-sweep" d="M12 12 L12 2 A10 10 0 0 1 20.6 7 Z" fill="currentColor" fill-opacity="0.55" />
      </svg>
      <p class="onboard-desc">${t("onboard.pairBody")}</p>
      <button type="button" class="serial-btn warn-go onboard-cta" disabled=${bridge.busy || bridge.running} onClick=${onConnect}>
        ${bridge.running ? t("onboard.connected") : bridge.busy ? t("onboard.connecting") : t("onboard.connect")}
      </button>
      <button type="button" class="onboard-later" onClick=${onSkipConnect}>${t("onboard.later")}</button>
    </div>`;
}

const ONBOARD_VIEWS = { hero: OnboardHero, model: OnboardModel, pair: OnboardPair };

function Onboard({ step, closing, model, bridge, onStart, onPickModel, onBack, onConnect, onSkipConnect, onDone }) {
  const View = ONBOARD_VIEWS[step];
  if (!View) return null;
  return html`
    <div class=${"onboard" + (closing ? " is-closing" : "")} role="dialog" aria-modal="true" aria-label=${t("onboard.title")}>
      <button type="button" class="onboard-skip" onClick=${onDone}>${t("onboard.skip")}</button>
      <${View} model=${model} bridge=${bridge} onStart=${onStart} onPickModel=${onPickModel}
        onBack=${onBack} onConnect=${onConnect} onSkipConnect=${onSkipConnect} />
    </div>`;
}

/* first-run tour — one spotlight box + a card, walked with Next. anchors that
   aren't on the page (mirror mode has no link/drive zone) drop out of the walk. */
const TOUR = [
  [".brand", "brand"],
  [".bridge-ctl, .top-mirror", "link"],
  [".bridge-ctl", "pair", () => !!window.blackout], // desktop shell only — in-app robot picker
  [".stage-3d", "stage"],
  [".stage-cam", "cam"],
  [".strip", "strip"],
  [".agent", "agent"],
  [".drive", "drive"],
  [".console-btn:last-of-type", "console"],
  [".topbar .console-btn", "mirrorShare"], // hand the judges' tablet the mirror view
];

function Tour({ closing, onDone }) {
  const steps = useRef(TOUR.filter(([sel, , when]) => (!when || when()) && document.querySelector(sel))).current;
  const [i, setI] = useState(0);
  const [box, setBox] = useState(null);
  const step = steps[i];
  const last = i >= steps.length - 1;

  useLayoutEffect(() => {
    if (!step) { onDone(); return; }
    // IMPORTANT NOTE: re-measure on a timer — panels animate in, telemetry resizes
    // them, and the spotlight has to stay glued. cheap enough for a 30s walkthrough.
    const measure = () => {
      const el = document.querySelector(step[0]);
      if (!el) return setBox(null);
      const r = el.getBoundingClientRect();
      setBox(b => (b && b.x === r.left - 6 && b.y === r.top - 6 && b.w === r.width + 12 && b.h === r.height + 12)
        ? b : { x: r.left - 6, y: r.top - 6, w: r.width + 12, h: r.height + 12 });
    };
    measure();
    const id = setInterval(measure, 250);
    window.addEventListener("resize", measure);
    return () => { clearInterval(id); window.removeEventListener("resize", measure); };
  }, [i, step, onDone]);

  // lock the app behind the walkthrough. `inert` takes clicks and tab-focus away from
  // everything under #root (the tour is portaled outside it), and a capture-phase key
  // listener swallows the window-level shortcuts inert can't touch — wasd drive, ` for
  // the console, esc out of fpv. buttons still activate on Enter: that's a native click.
  useEffect(() => {
    const root = document.getElementById("root");
    root.inert = true;
    tourOpen = true;
    const onKey = (e) => {
      e.stopPropagation();
      if (e.type === "keydown" && e.key === "Escape") onDone();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    return () => {
      root.inert = false;
      tourOpen = false;
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
    };
  }, [onDone]);

  if (!step || !box) return null;
  const below = box.y + box.h + 190 < window.innerHeight;
  const card = {
    left: Math.max(8, Math.min(box.x, window.innerWidth - 340)) + "px",
    top: (below ? box.y + box.h + 12 : Math.max(8, box.y - 12)) + "px",
    transform: below ? "none" : "translateY(-100%)",
  };
  return html`
    <div class=${"tour" + (closing ? " is-closing" : "")} role="dialog" aria-modal="true" aria-label=${t("tour." + step[1] + ".t")}>
      <div class="tour-hole" style=${{ left: box.x + "px", top: box.y + "px", width: box.w + "px", height: box.h + "px" }}></div>
      <div class="tour-card" style=${card}>
        <span class="tour-count">${i + 1} / ${steps.length}</span>
        <h3 class="tour-title">${t("tour." + step[1] + ".t")}</h3>
        <p class="tour-text">${t("tour." + step[1] + ".b")}</p>
        <div class="tour-actions">
          <button type="button" class="serial-btn" onClick=${onDone}>${t("tour.skip")}</button>
          <button type="button" class="serial-btn warn-go" autoFocus
            onClick=${() => last ? onDone() : setI(n => n + 1)}>${last ? t("tour.done") : t("tour.next")}</button>
        </div>
      </div>
    </div>`;
}

/* root */
function App() {
  const [connected, setConnected] = useState(false);
  const [packet, setPacket] = useState(null);
  const [ping, setPing] = useState("—");
  const [packets, setPackets] = useState(0);
  const [logs, setLogs] = useState([]);
  const [ai, setAi] = useState({ text: t("ai.awaiting"), badge: "badge.standby", analyzing: false, history: [], phase: null, since: 0, llm: null, tts: null, status: null });
  // mirrors ai.analyzing for callers with no render to gate on (gamepad poll, routine e:analyze). re-synced every render.
  const analyzingRef = useRef(false);
  analyzingRef.current = ai.analyzing;
  const presentingRef = useRef(false); // last routine started was presentation
  const [tts, setTts] = useState(() => localStorage.getItem("tts") !== "false");
  const [ttsProv, setTtsProv] = useState(() => localStorage.getItem("ttsProvider") || "edge");
  const [hasDeepgram, setHasDeepgram] = useState(false);
  const [lang, setLangState] = useState(getLang());
  const [bridge, setBridge] = useState({ running: false, busy: false });
  const [toasts, setToasts] = useState([]);
  const [uptime, setUptime] = useState("00:00:00");
  const [lanUrl, setLanUrl] = useState(null); // this laptop's lan address, for pointing the judges' tablet at it
  const [serialLines, setSerialLines] = useState([]);
  const [tour, setTour] = useState(false);     // false | "open" | "closing" — first-run walkthrough (once per browser)
  const [drawer, setDrawer] = useState(false); // false | "open" | "closing"
  const [drawerTab, setDrawerTab] = useState("logs");
  const [warn, setWarn] = useState(false);     // false | "open" | "closing" — first-open debug warning gate
  const [warnCount, setWarnCount] = useState(3);
  const [updateOpen, setUpdateOpen] = useState(false); // false | "open" | "closing"
  const [flashPhase, setFlashPhase] = useState("choose");
  const [flashBoards, setFlashBoards] = useState({ giga: false, esp32cam: false, unor4: false, status: "none" });
  const [flashLog, setFlashLog] = useState("");
  const [flashCode, setFlashCode] = useState(null);
  const [speaking, setSpeaking] = useState(false);
  const [fpv, setFpv] = useState(false);      // △/Y — fullscreen camera + hud overlay
  const [fpvZoom, setFpvZoom] = useState(0);  // index into FPV_ZOOMS — OPTIONS cycles it
  const [rec, setRec] = useState(null);       // run being recorded server-side, or null
  const [runs, setRuns] = useState(null);     // saved runs while the picker is open, else null
  const [replay, setReplay] = useState(null); // loaded run being played back
  const [recErr, setRecErr] = useState(null); // why the last record attempt was refused
  const [report, setReport] = useState(null); // frozen session report, or null when closed
  const [reportClosing, setReportClosing] = useState(false); // true while the exit transition plays
  const [clients, setClients] = useState([]); // every dashboard on the lan (host's roster)
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false); // false | "open" | "closing"
  const [onboardStep, setOnboardStep] = useState(false); // false | "hero" | "model" | "pair" — first-run, ahead of the spotlight tour
  const [onboardModel, setOnboardModel] = useState(null); // "v2" | "v3" | null — cosmetic, picked in the onboard flow
  const [onboardClosing, setOnboardClosing] = useState(false); // true while the exit transition plays
  // a mirror drives only while the host has granted it; the host is always granted.
  const [granted, setGranted] = useState(!VIEWER);
  const grantedRef = useRef(!VIEWER);
  grantedRef.current = granted;
  const canDrive = granted && !!bridge.running;
  // outlives `granted` by one animation so a revoke can play out instead of vanishing
  const [driveMounted, setDriveMounted] = useState(!VIEWER);
  useEffect(() => {
    if (granted) { setDriveMounted(true); return; }
    const id = setTimeout(() => setDriveMounted(false), 260);
    return () => clearTimeout(id);
  }, [granted]);
  // chats = briefed recon sessions. each holds its own mission + conversation.
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

  // smoke/air gas readings are noisy mq sensors — sample them every 5s so display doesn't flicker. everything else stays live.
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
    setTimeout(() => setToasts(p => p.map(t => t.id === id ? { ...t, leaving: true } : t)), 3600);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 3820);
  }, []);

  // speak with timing: clock starts now, stops when first audio plays (tts ms).
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
    // same origin: this page is served by that server. hardcoding localhost:3000 pointed
    // a tablet at its own machine, and broke every test that runs the server off 3000.
    const socket = window.io();
    socketRef.current = socket;

    // log a discovery to active session whenever a metric newly worsens.
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
      socket.emit("set-language", getLang());                          // sync ai language
      socket.emit("set-mission", activeRef.current?.mission || ""); // sync server to active session
    });
    socket.on("disconnect", () => { setConnected(false); setPing("—"); addLog(t("log.linkLost"), "danger"); });
    socket.on("clients", list => {
      // the host logs every control change on the roster, not just its own: who was
      // driving when is the first thing asked after a bad run, and log.events is what
      // the session report exports.
      setClients(prev => {
        if (!VIEWER) for (const c of list || []) {
          if (c.host) continue;
          const was = prev.find(p => p.id === c.id)?.granted ?? false;
          if (was !== c.granted)
            addLog(t(c.granted ? "log.grantGiven" : "log.grantTaken", { device: `${c.kind} ${c.ip}` }), c.granted ? "warn" : "system");
        }
        return list || [];
      });
      const me = (list || []).find(c => c.id === socket.id);
      if (me) setGranted(g => {
        if (me.granted !== g) addLog(t(me.granted ? "log.controlGranted" : "log.controlRevoked"), me.granted ? "system" : "warn");
        return me.granted;
      });
    });
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
    // sage spotted something herself (relic fragments, a drawing) and logged it with the still she saw. same shape as sensor finding, plus img.
    socket.on("sage-finding", d => {
      if (!d?.text) return;
      const chat = activeRef.current;
      if (!chat || !chat.mission) return;
      const entry = { id: d.id || Date.now() + Math.random(), text: d.text, kind: "find", img: d.img || null,
        time: new Date(d.timestamp || Date.now()).toLocaleTimeString() };
      setChats(cs => cs.map(c => c.id === chat.id
        ? { ...c, findings: [...(c.findings || []), entry].slice(-40) } : c));
    });
    // a running blk workflow asked sage a yes/no (ask/find) — log the call so the
    // operator can see why the program branched the way it did.
    socket.on("blk-decision", d => {
      if (!d?.question) return;
      addLog(`${d.kind === "find" ? "find" : "ask"} "${d.question}" → ${d.yes ? "YES" : "no"}${d.text ? " · " + d.text : ""}`, d.yes ? "ai" : "system");
    });
    socket.on("flash-log", d => setFlashLog(l => appendLog(l, d?.chunk || "")));
    socket.on("flash-done", d => { setFlashCode(d?.code ?? -1); setFlashPhase("done"); });
    socket.on("serial-line", d => {
      if (!d?.line) return;
      setSerialLines(p => [...p, {
        text: d.line, s: d.line.startsWith("S:"),
        time: new Date(d.timestamp || Date.now()).toLocaleTimeString(),
        id: Date.now() + Math.random(),
      }].slice(-300));
    });
    // agent says something on its own (analysis, instant reaction, or mission ack).
    const sayAgent = (text, ts, logMsg, logKind, status = null) => {
      addLog(logMsg, logKind);
      setAi(p => ({
        text, badge: "badge.online", analyzing: false, status,
        phase: null, since: 0, llm: p.since ? Date.now() - p.since : null, tts: null,
        history: [...p.history, { text, time: new Date(ts || Date.now()).toLocaleTimeString(), id: Date.now() + Math.random() }].slice(-20),
      }));
      if (ttsRef.current) speakTimed(text);
    };
    // auto analysis + instant reactions only fire when a briefed session is open — otherwise dashboard talks to itself on boot with no chat active.
    socket.on("ai-analysis", d => {
      if (!d) return;
      // no briefed session: don't display/voice result, but always release spinner — routine's e:analyze at bench sets analyzing, and a swallowed reply here locked briefing ui behind "busy" forever.
      if (!activeRef.current?.mission) {
        setAi(p => ({ ...p, analyzing: false, phase: null, badge: "badge.standby" }));
        return;
      }
      if (d.analysis) sayAgent(d.analysis, d.timestamp, t("log.aiReceived"), "ai", d.status);
      else if (d.error) sayAgent(d.error, d.timestamp, t("log.aiReceived"), "warn", null);
    });
    socket.on("agent-blurt", d => { if (d?.text && activeRef.current?.mission) sayAgent(d.text, d.timestamp, t("log.blurt", { text: d.text }), "warn"); });
    // server-driven camera yield: runaianalysis grabs a still from /capture, which fights the live /stream for cam's starved ram.
    socket.on("cam-yield", () => window.dispatchEvent(new Event("cam:yield")));
    socket.on("cam-resume", () => window.dispatchEvent(new Event("cam:resume")));
    socket.on("mission-ack", d => { if (d?.text) sayAgent(d.text, d.timestamp, t("log.missionAck"), "ai", d.status); });
    // drive command relayed from a client with no ble. only the link holder acts, so it can't bounce.
    socket.on("cmd", w => { if (bleRef.current.device?.gatt?.connected) sendCmdRef.current?.(w); });
    addLog(t("log.booted"), "system");
    return () => socket.close();
  }, [addLog, speakTimed]);

  // keep document language + skip-link (static html outside react) in sync.
  useEffect(() => {
    document.documentElement.lang = lang;
    const sk = document.querySelector(".skip-link");
    if (sk) sk.textContent = t("skip");
  }, [lang]);

  useEffect(() => { fetch("/api/lan").then(r => r.json()).then(d => setLanUrl(d.url)).catch(() => {}); }, []);

  // uptime
  useEffect(() => {
    const t0 = Date.now();
    const id = setInterval(() => {
      const e = Date.now() - t0, p = n => String(n).padStart(2, "0");
      setUptime(`${p(Math.floor(e / 3600000))}:${p(Math.floor(e / 60000) % 60)}:${p(Math.floor(e / 1000) % 60)}`);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // bluetooth bridge: r4 advertises ble (no classic spp), so browser's web bluetooth talks to it directly — no server-side native bt library needed.
  const BLE_SERVICE = "19b10000-e8f2-537e-4f6c-d104768a1214";
  const BLE_CHAR = "19b10001-e8f2-537e-4f6c-d104768a1214";
  const BLE_CMD = "19b10002-e8f2-537e-4f6c-d104768a1214"; // write = motion routine verbs
  const BLE_VID = "19b10003-e8f2-537e-4f6c-d104768a1214"; // write = raw oled video frames
  const bleRef = useRef({ device: null, char: null, cmd: null, vid: null });
  const bleWriteRef = useRef(Promise.resolve()); // serializes every gatt write, see bleWrite
  // web bluetooth runs one gatt op at a time — a hud push landing mid-write throws
  // "GATT operation already in progress" and that command is just lost. every write on
  // the link goes through this one chain, video frames included.
  const bleWrite = useCallback((fn) => {
    const w = bleWriteRef.current.then(fn);
    bleWriteRef.current = w.catch(() => {}); // a failed write must not poison the chain
    return w;
  }, []);

  // defined above onblenotify because that handler calls it — deps are evaluated during render, so later `const` would be in temporal dead zone.
  // `focus` comes from a workflow's `analyze <what to look at>` step — it steers
  // this one read only.
  const analyze = useCallback((mode, focus) => {
    if (analyzingRef.current) return;
    analyzingRef.current = true; // set now, not on re-render — two calls in one tick must not both emit
    setAi(p => ({ ...p, analyzing: true, badge: "badge.analyzing", phase: "thinking", since: Date.now(), llm: null, tts: null }));
    socketRef.current?.emit("request-analysis", { mode: mode || null, prompt: focus || null });
  }, []);

  // board notifies two kinds of line: "s:" telemetry, and "e:" events a routine raises as it runs (an analyze step asking for an ai read).
  // events are ours to act on and aren't telemetry, so they don't go to /api/mega/sensor.
  const onBleNotify = useCallback((e) => {
    const line = new TextDecoder().decode(e.target.value);
    console.log("BLE notify:", line);
    // presentation's single closing analyze is a greeting to judges, not a cave read.
    // the board can't say which routine raised the event, so we go by the last "go," we sent.
    if (line.startsWith("E:analyze")) {
      addLog(t("log.routineAnalyze"), "ai");
      analyze(presentingRef.current ? "present" : null);
      presentingRef.current = false;
      return;
    }
    fetch("/api/mega/sensor", { method: "POST", headers: { "Content-Type": "text/plain" }, body: line })
      .then((r) => { if (!r.ok) console.error("BLE forward failed:", r.status); })
      .catch((err) => console.error("BLE forward error:", err.message));
  }, [analyze, addLog]);

  const disconnectBle = useCallback(() => {
    const { device, char } = bleRef.current;
    if (char) char.removeEventListener("characteristicvaluechanged", onBleNotify);
    if (device?.gatt?.connected) device.gatt.disconnect();
    bleRef.current = { device: null, char: null, cmd: null, vid: null };
  }, [onBleNotify]);

  // one verb to firmware over ble cmd char: "go,<name>" starts a motion routine, "stop" cuts motors.
  // routines run standalone on board — this only fires starting gun, so dropped link mid-run doesn't strand robot.
  const sendCmd = useCallback(async (word) => {
    if (!grantedRef.current && word !== "stop") { toast(t("toast.mirrorOnly"), "warn"); return false; }
    if (word.startsWith("go,")) presentingRef.current = word === "go,presentation";
    const { device, cmd } = bleRef.current;
    // no local ble (judges' tablet, second browser): hand off over the socket to the client that holds the link.
    if (!device?.gatt?.connected) {
      if (socketRef.current?.connected) { socketRef.current.emit("cmd", word); return true; }
      toast(t("toast.cmdNoLink"), "danger"); return false;
    }
    if (!cmd) { toast(t("toast.cmdNoChar"), "danger"); return false; } // linked but firmware lacks cmd char
    try {
      await bleWrite(() => cmd.writeValue(new TextEncoder().encode(word)));
      addLog(t("log.cmdSent", { cmd: word }), "system");
      return true;
    } catch (e) { addLog(t("log.error", { msg: e.message }), "danger"); return false; }
  }, [addLog, toast, bleWrite]);
  // the socket effect above relays commands through this — sendCmd is defined below it, so it can't reference it directly
  const sendCmdRef = useRef(sendCmd);
  sendCmdRef.current = sendCmd;

  /* oled video: play an operator's clip on the robot's panel, then hand the screen back.
     two phases, and the whole point is that only the first one touches the link.
       1. capture — a detached <video> plays the picked file, every decoded frame is
          cropped + dithered to the panel's 64x128 1-bit bitmap (oledvid.mjs) and kept in
          an array. runs at the clip's real speed, so a 10s clip takes 10s.
       2. upload — the frames go out back-to-back as one flat byte stream, and the board
          plays them from its own sdram at the clip's own frame rate.
     it used to dither-and-write frame by frame while the clip played, which meant the
     panel only ever ran as fast as ble could carry 1KB frames — single digits. the link
     can't do video rates (60fps is ~61KB/s, and a with-response write costs a round trip
     at the ~15ms connection interval), so the fix is to stop asking it to: pay the
     transfer once up front and let the board's own clock drive playback.
     IMPORTANT NOTE: the threshold slider applies at *capture*. once a clip is uploaded
     it's a fixed bitmap — re-pick the file to try a different threshold. */
  const [video, setVideo] = useState(null); // { name, phase, pct, fps } while a clip runs
  const videoStopRef = useRef(null);
  const stopVideo = useCallback(() => { videoStopRef.current?.(); }, []);

  const playVideo = useCallback(async (file, threshRef) => {
    if (!grantedRef.current) { toast(t("toast.mirrorOnly"), "warn"); return; }
    if (videoStopRef.current) return;                       // one clip at a time
    const vid = bleRef.current.vid;
    if (!vid) { toast(t("toast.vidNoChar"), "danger"); return; }
    const el = document.createElement("video"); // detached: it never has to be on screen to decode
    el.src = URL.createObjectURL(file);
    el.playsInline = true;
    const canvas = document.createElement("canvas");
    canvas.width = VID_W; canvas.height = VID_H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    let stop = false;
    videoStopRef.current = () => { stop = true; };
    addLog(t("log.vidStart", { name: file.name }), "system");
    try {
      await new Promise((res, rej) => {
        el.onloadeddata = res;
        el.onerror = () => rej(new Error(t("toast.vidDecode")));
      });
      // rVFC is how we get *every* decoded frame at its real presentation time. without
      // it we'd be sampling a <video> on rAF and guessing, so refuse rather than upload
      // a clip that judders for a reason nobody can see.
      if (!el.requestVideoFrameCallback) throw new Error(t("toast.vidNoRvfc"));
      const { sx, sy, sw, sh } = coverRect(el.videoWidth, el.videoHeight);

      // 1. capture. muted: this pass is just a decode, the audible play is phase 3.
      el.muted = true;
      const frames = [];
      let lastUi = 0;
      setVideo({ name: file.name, phase: "capture", pct: 0, fps: "—" });
      await el.play();
      await new Promise((res, rej) => {
        const onFrame = () => {
          if (stop || el.ended || frames.length >= VID_MAX_FRAMES) return res();
          ctx.drawImage(el, sx, sy, sw, sh, 0, 0, VID_W, VID_H);
          frames.push(packXbm(ctx.getImageData(0, 0, VID_W, VID_H).data, VID_W, VID_H, threshRef.current));
          const now = Date.now();
          if (now - lastUi > 250) { // a setState per frame re-renders the whole drive panel
            lastUi = now;
            setVideo({ name: file.name, phase: "capture", fps: "—",
              pct: Math.min(100, Math.round((el.currentTime / (el.duration || 1)) * 100)) });
          }
          el.requestVideoFrameCallback(onFrame);
        };
        el.onended = res;
        el.onerror = () => rej(new Error(t("toast.vidDecode")));
        el.requestVideoFrameCallback(onFrame);
      });
      el.pause();
      if (stop) return;
      if (!frames.length) throw new Error(t("toast.vidDecode"));
      // the clip's real rate, from what actually decoded — not a guess and not forced to
      // 60. a 24 or 30fps source padded up to 60 is duplicate frames: same motion, twice
      // the upload. clamped to what the board accepts.
      const fps = Math.max(1, Math.min(60, Math.round(frames.length / (el.currentTime || el.duration || 1))));

      // 2. upload, as one flat byte stream. chunk boundaries are free to ignore frame
      // boundaries — the board just appends in arrival order until it has the byte count
      // "vid,load" declared, then plays.
      if (!(await sendCmd(`vid,load,${frames.length},${fps}`))) throw new Error(t("toast.cmdNoLink"));
      let sent = 0;
      for (const buf of frames) {
        for (let o = 0; o < VID_BYTES; o += VID_CHUNK) {
          if (stop || bleRef.current.vid !== vid) return;
          // with response, and VID_CHUNK stays under the att mtu so each one is a single
          // write rather than a multi-round-trip long write. see VID_CHUNK in main.ino.
          await bleWrite(() => vid.writeValueWithResponse(buf.subarray(o, o + VID_CHUNK)));
        }
        sent++;
        const now = Date.now();
        if (now - lastUi > 250) {
          lastUi = now;
          setVideo({ name: file.name, phase: "upload", fps: String(fps),
            pct: Math.round((sent / frames.length) * 100) });
        }
      }

      // 3. the board is now playing it from ram on its own clock. play the audio here to
      // match — sound is half the joke, and the two clocks only have to agree to about a
      // frame for that to land.
      setVideo({ name: file.name, phase: "play", pct: 100, fps: String(fps) });
      el.currentTime = 0;
      el.muted = false;
      await el.play().catch(() => {}); // autoplay policy said no — the panel still plays
      const playMs = (frames.length / fps) * 1000;
      await new Promise((res) => {
        const id = setTimeout(res, playMs);
        videoStopRef.current = () => { stop = true; clearTimeout(id); res(); };
      });
    } catch (e) {
      addLog(t("log.error", { msg: e.message }), "danger");
      toast(e.message, "danger");
    } finally {
      el.pause();
      URL.revokeObjectURL(el.src);
      videoStopRef.current = null;
      setVideo(null);
      await sendCmd("vid,off"); // the board also times out on its own if this never lands
    }
  }, [addLog, toast, sendCmd, bleWrite]);

  const loadBridge = useCallback(async () => {
    try { const r = await fetch("/api/bridge"); const d = await r.json();
      setBridge(b => ({ ...b, running: d.running })); } catch { /* offline */ }
  }, []);
  useEffect(() => { loadBridge(); const id = setInterval(loadBridge, 5000); return () => clearInterval(id); }, [loadBridge]);

  // in-app ble picker (desktop shell only) — electron's main process holds the
  // pending requestDevice() callback and streams discovered devices over ipc;
  // picking a row (or cancelling) resolves it. browsers keep the native chooser.
  const [blePicker, setBlePicker] = useState(false);
  const [bleDevs, setBleDevs] = useState([]);
  const closeBlePicker = useCallback(() => {
    setBlePicker(o => o === "open" ? "closing" : o);
    setTimeout(() => { setBlePicker(false); setBleDevs([]); }, 240);
  }, []);
  useEffect(() => {
    if (!window.blackout) return;
    const offDevs = window.blackout.onBleDevices((list) => {
      setBleDevs(list);
      setBlePicker(o => o || "open"); // a scan can start without us (chooser re-fired) — surface it
    });
    const offClosed = window.blackout.onBleClosed(closeBlePicker);
    return () => { offDevs(); offClosed(); };
  }, [closeBlePicker]);

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
        if (window.blackout) setBlePicker("open"); // desktop shell: our picker instead of chrome's chooser
        // filter by service uuid, not name — arduinoble on r4 wifi always advertises name as "arduino" (known upstream bug), so name filter never matches.
        const device = await navigator.bluetooth.requestDevice({
          filters: [{ services: [BLE_SERVICE] }],
          optionalServices: [BLE_SERVICE],
        });
        const server = await device.gatt.connect();
        const service = await server.getPrimaryService(BLE_SERVICE);
        const char = await service.getCharacteristic(BLE_CHAR);
        const cmd = await service.getCharacteristic(BLE_CMD).catch(() => null); // older firmware lacks it
        const vid = await service.getCharacteristic(BLE_VID).catch(() => null); // ditto, oled video
        await char.startNotifications();
        char.addEventListener("characteristicvaluechanged", onBleNotify);
        device.addEventListener("gattserverdisconnected", () => {
          bleRef.current = { device: null, char: null, cmd: null, vid: null };
          setBridge(b => ({ ...b, running: false }));
          fetch("/api/bridge/stop", { method: "POST" }).catch(() => {});
        });
        bleRef.current = { device, char, cmd, vid };
        const r = await fetch("/api/bridge/start", { method: "POST" });
        const d = await r.json();
        if (d.ok) { setBridge({ running: true, busy: false }); toast(t("toast.bridgeOn"), "ok"); }
        else { disconnectBle(); setBridge(b => ({ ...b, busy: false })); addLog(t("log.failed", { error: d.error }), "danger"); toast(d.error, "danger"); }
      }
    } catch (e) { setBridge(b => ({ ...b, busy: false })); addLog(t("log.error", { msg: e.message }), "danger"); if (window.blackout) closeBlePicker(); }
    loadBridge();
  }, [bridge.running, addLog, toast, loadBridge, disconnectBle, onBleNotify, closeBlePicker]);

  const mockData = useCallback(() => {
    setAi(p => ({ ...p, analyzing: true, badge: "badge.analyzing", phase: "thinking", since: Date.now(), llm: null, tts: null }));
    socketRef.current?.emit("mock-data");
  }, []);
  // ask sage: reply lands in agent's speech bubble + spoken. each chat keeps its own rolling message history so follow-ups have context.
  // render a sage json reply {text,status,action}: bubble + status tint + history + tts. only text field is shown or voiced — never raw json.
  const showSage = useCallback((sage, t0, speak = true) => {
    const textv = (sage && sage.text) || "No response.";
    setAi(p => ({
      text: textv, status: (sage && sage.status) || null,
      badge: "badge.online", analyzing: false, phase: null, since: 0,
      llm: t0 ? Date.now() - t0 : p.llm, tts: null,
      history: [...p.history, { text: textv, time: new Date().toLocaleTimeString(), id: Date.now() + Math.random() }].slice(-20),
    }));
    if (speak && ttsRef.current) speakTimed(textv);
  }, [speakTimed]);

  // sage asked for a fresh look (action:"analyze"): let server grab a still and hand back sage's description. no ble write — camera is fixed forward, purely a camera read.
  const runScan = useCallback(async () => {
    // hand the camera to server: drop our live feed so its single worker is free to grab the frame, then reconnect once done.
    window.dispatchEvent(new Event("cam:yield"));
    const t0 = Date.now();
    setAi(p => ({ ...p, analyzing: true, badge: "badge.thinking", phase: "thinking", since: t0, llm: null, tts: null }));
    try {
      await new Promise(r => setTimeout(r, 400)); // let esp32 free its worker first
      const r = await fetch("/api/scan", { method: "POST" });
      const data = await r.json();
      const sage = data.reply, ok = !!(sage && sage.text);
      addLog(t("log.replied"), "ai");
      showSage(ok ? sage : { text: data.error || "No response.", status: null }, t0, ok);
      const chat = activeRef.current;
      if (ok && chat) setChats(cs => cs.map(c => c.id === chat.id ? { ...c, messages: [...(c.messages || []), { role: "assistant", content: sage.text }].slice(-12) } : c));
    } catch (e) {
      setAi(p => ({ ...p, text: t("ai.comms", { msg: e.message }), badge: "badge.online", analyzing: false, phase: null }));
    } finally {
      window.dispatchEvent(new Event("cam:resume")); // give live feed back
    }
  }, [showSage, addLog]);

  const ask = useCallback(async (text) => {
    text = (text || "").trim();
    const chat = activeRef.current;
    if (!text || !chat) return;
    addLog(t("log.operator", { text }), "system");
    // routine or drive phrase ("present yourself", "go forward for 2 seconds") — fire straight over ble, no llm round trip.
    const trigger = matchCmd(norm(text));
    if (trigger) {
      const ms = driveMs(norm(text));
      const sent = await sendCmd(trigger.cmd(ms));
      const ack = { text: t(sent ? trigger.ackKey : "toast.cmdNoLink", { s: (ms / 1000).toFixed(1) }), status: null };
      setChats(cs => cs.map(c => c.id === chat.id ? { ...c, messages: [...(c.messages || []), { role: "user", content: text }, { role: "assistant", content: ack.text }].slice(-12) } : c));
      showSage(ack, null, sent);
      return;
    }
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
      const sage = data.reply, ok = !!(sage && sage.text);
      if (ok) setChats(cs => cs.map(c => c.id === chat.id ? { ...c, messages: [...next, { role: "assistant", content: sage.text }].slice(-12) } : c));
      addLog(t("log.replied"), "ai");
      showSage(ok ? sage : { text: data.error || "No response.", status: null }, t0, ok);
      if (ok && sage.action === "analyze") runScan(); // sage wants a fresh look
    } catch (e) {
      setAi(p => ({ ...p, text: t("ai.comms", { msg: e.message }), badge: "badge.online", analyzing: false, phase: null }));
    }
  }, [addLog, showSage, runScan, sendCmd]);

  /* fpv — camera fullscreen, stats + agent become edge huds. △/Y toggles, ○/B talks to sage.
     own poll (not drive's) because drive's loop bails unless remote mode is armed, and fpv
     has to work from any mode. edge-detected so holding a button fires once. */
  const fpvMic = useMic(ask);
  const fpvMicRef = useRef(fpvMic);
  fpvMicRef.current = fpvMic;
  const fpvRef = useRef(fpv);
  fpvRef.current = fpv;
  /* the transition is the browser's, not ours: view transitions snapshot the cam tile
     before and its fullscreen self after, then morph between them — no keyframes to keep
     in sync with the layout. flushSync so react has committed before the "after" snapshot.
     no support (safari < 18) = the old instant swap, which is still a working fpv mode. */
  const toggleFpv = useCallback((on) => {
    const go = () => flushSync(() => setFpv(p => (typeof on === "boolean" ? on : !p)));
    if (document.startViewTransition) document.startViewTransition(go); else go();
  }, []);
  const toggleFpvRef = useRef(toggleFpv);
  toggleFpvRef.current = toggleFpv;
  const cycleZoomRef = useRef(null);
  cycleZoomRef.current = () => setFpvZoom(i => (i + 1) % FPV_ZOOMS.length);
  // recorder controls live on the pad too, but only while fpv is up — the hud is
  // where they're labelled, and a stray ✕ on the cockpit shouldn't start a run.
  const recActRef = useRef(null);
  useEffect(() => {
    let was = [false, false, false, false, false];
    const id = setInterval(() => {
      const pad = [...navigator.getGamepads()].find(Boolean);
      if (!pad || tourOpen) return;
      // △ = 3, ○ = 1, OPTIONS/start = 9, ✕ = 0, SHARE/select = 8.
      // everything but △ is fpv-only: off the hud those four are padnav's (press,
      // back, menu), and one button can't mean both without a mode nobody can see.
      const now = [!!pad.buttons[3]?.pressed, !!pad.buttons[1]?.pressed, !!pad.buttons[9]?.pressed,
        !!pad.buttons[0]?.pressed, !!pad.buttons[8]?.pressed];
      if (now[0] && !was[0]) toggleFpvRef.current();
      if (now[1] && !was[1] && fpvRef.current) fpvMicRef.current.toggle();
      if (now[2] && !was[2] && fpvRef.current) cycleZoomRef.current?.();
      if (now[3] && !was[3] && fpvRef.current && !VIEWER) recActRef.current?.rec();
      if (now[4] && !was[4] && fpvRef.current) recActRef.current?.replays();
      was = now;
    }, 80);
    return () => clearInterval(id);
  }, []);
  // esc is the way out without a controller — never trap the operator in fpv.
  // with a replay up, esc belongs to the player: one press per layer, not both.
  useEffect(() => {
    if (!fpv || replay) return;
    const onKey = (e) => { if (e.key === "Escape") toggleFpv(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fpv, replay, toggleFpv]);

  const toggleTts = useCallback(() => setTts(p => {
    const n = !p; ttsRef.current = n; localStorage.setItem("tts", n);
    if (!n) { stopSpeech(); setSpeaking(false); }
    return n;
  }), []);
  const toggleTtsProvider = useCallback(() => setTtsProv(p => p === "edge" ? "deepgram" : "edge"), []);
  // play a sequence of pre-rendered onboarding clips (intro + step questions).
  const speakBrief = useCallback((items) => {
    if (!ttsRef.current) return;
    const play = (i) => { if (i < items.length) playOnboard(items[i].clip, items[i].text, { onEnd: () => play(i + 1) }); };
    play(0);
  }, []);
  const changeLang = useCallback((code) => {
    setLang(code); setLangState(code);
    socketRef.current?.emit("set-language", code); // ai replies in new language
  }, []);
  const newChat = useCallback(() => {
    const id = "c" + Date.now();
    setChats(cs => [...cs, { id, title: t("chat.newTitle"), mission: "", messages: [], created: Date.now() }]);
    setActiveId(id);
    socketRef.current?.emit("set-mission", ""); // no mission until briefed
    // briefing's step-0 effect speaks the intro + first question out loud.
  }, []);
  const selectChat = useCallback((id) => {
    setActiveId(id);
    socketRef.current?.emit("set-mission", (chats.find(c => c.id === id)?.mission) || "");
  }, [chats]);
  const deleteChat = useCallback((id) => {
    setChats(cs => cs.filter(c => c.id !== id));
    setActiveId(a => {
      if (a !== id) return a;
      // deleting the active session: clear server's mission too, or it keeps firing auto-analysis llm calls nobody will ever see.
      socketRef.current?.emit("set-mission", "");
      return "";
    });
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
  const clearSerial = useCallback(() => setSerialLines([]), []);
  // play the exit animation, then unmount
  const closeDrawer = useCallback(() => {
    setDrawer(o => o === "open" ? "closing" : o);
    setTimeout(() => setDrawer(false), 240);
  }, []);
  // first open ever shows the debug warning instead; ack is remembered
  const openDrawer = useCallback(() => {
    if (localStorage.getItem("debugAck")) setDrawer("open");
    else setWarn("open");
  }, []);
  const closeWarn = useCallback(() => {
    setWarn(w => w === "open" ? "closing" : w);
    setTimeout(() => setWarn(false), 220);
  }, []);
  const closeReport = useCallback(() => {
    setReportClosing(true);
    setTimeout(() => { setReport(null); setReportClosing(false); }, 220);
  }, []);
  const toggleDrawer = useCallback(() => {
    if (drawerRef.current === "open") closeDrawer(); else openDrawer();
  }, [closeDrawer, openDrawer]);

  /* the pad owns the ui too, not just the wheels: d-pad roams focus, ✕ presses,
     ○/SHARE backs out of whatever is on top, OPTIONS is the menu (the console).
     fpv and the tour take the pad back while they're up — both have their own
     bindings for the same buttons. mounted once; the refs keep it current. */
  const toggleDrawerRef = useRef(toggleDrawer);
  toggleDrawerRef.current = toggleDrawer;
  useEffect(() => {
    const id = initPadNav({
      blocked: () => fpvRef.current || tourOpen,
      onMenu: () => toggleDrawerRef.current(),
    });
    return () => clearInterval(id);
  }, []);

  // tutorial runs once per browser; the console's restart button clears the flag.
  // first run leads with the onboard flow (hero → model → pair), then the spotlight tour.
  useEffect(() => {
    if (localStorage.getItem("tourDone")) return;
    const id = setTimeout(() => setOnboardStep("hero"), 900); // let the zones finish revealing
    return () => clearTimeout(id);
  }, []);
  const endTour = useCallback(() => {
    localStorage.setItem("tourDone", "1");
    setTour(s => s === "open" ? "closing" : s);
    setTimeout(() => setTour(false), 240);
  }, []);
  // fades/pops the onboard overlay out, then swaps it for whatever comes next —
  // the dashboard is already mounted underneath, so this reads as a crossfade.
  const closeOnboard = useCallback((next) => {
    if (window.blackout && blePicker) window.blackout.selectBleDevice(""); // don't leave a scan running behind us
    setOnboardClosing(true);
    setTimeout(() => { setOnboardStep(false); setOnboardClosing(false); next?.(); }, 300);
  }, [blePicker]);
  const finishOnboard = useCallback(() => closeOnboard(() => setTour("open")), [closeOnboard]);
  const skipOnboard = useCallback(() => { localStorage.setItem("tourDone", "1"); closeOnboard(); }, [closeOnboard]);
  // pairing is host-only (viewers never own the bridge) — start walks straight into the tour for them.
  const onboardStart = useCallback(() => { if (VIEWER) finishOnboard(); else setOnboardStep("model"); }, [finishOnboard]);
  const onboardPickModel = useCallback((m) => { setOnboardModel(m); setOnboardStep("pair"); }, []);
  const restartTour = useCallback(() => {
    localStorage.removeItem("tourDone");
    setOnboardModel(null);
    closeDrawer();
    setTimeout(() => setOnboardStep("hero"), 260); // after the drawer slides out — full replay, hero first
  }, [closeDrawer]);
  // a successful pair mid-flow walks straight into the dashboard + tutorial
  useEffect(() => {
    if (onboardStep !== "pair" || !bridge.running) return;
    const id = setTimeout(finishOnboard, 700); // a beat to read "connected"
    return () => clearTimeout(id);
  }, [onboardStep, bridge.running, finishOnboard]);

  const closeSettings = useCallback(() => {
    setSettingsOpen(o => o === "open" ? "closing" : o);
    setTimeout(() => setSettingsOpen(false), 240);
  }, []);
  useEffect(() => {
    if (!window.blackout) return;
    return window.blackout.onSettingsOpen(() => setSettingsOpen("open"));
  }, []);

  // warning's 3s cooldown before PROCEED unlocks
  useEffect(() => {
    if (warn !== "open") return;
    setWarnCount(3);
    const id = setInterval(() => setWarnCount(c => Math.max(0, c - 1)), 1000);
    return () => clearInterval(id);
  }, [warn]);

  const openUpdate = useCallback(() => {
    setFlashPhase("detect"); // model is already known from the poll — nothing to pick
    setFlashLog(""); setFlashCode(null);
    setUpdateOpen("open");
  }, []);
  const closeUpdate = useCallback(() => {
    setUpdateOpen(o => o === "open" ? "closing" : o);
    setTimeout(() => setUpdateOpen(false), 240);
  }, []);
  const closeDevices = useCallback(() => {
    setDevicesOpen(o => o === "open" ? "closing" : o);
    setTimeout(() => setDevicesOpen(false), 240);
  }, []);
  const startFlash = useCallback(() => {
    setFlashLog(""); setFlashCode(null); setFlashPhase("flashing");
    fetch("/api/flash/start", { method: "POST" }).then(r => {
      if (!r.ok) throw new Error(r.status === 409 ? "a flash is already running" : `server said ${r.status}`);
    }).catch(err => {
      setFlashLog(err.message); setFlashCode(-1); setFlashPhase("done");
    });
  }, []);

  // watch usb for a board the whole time the dashboard is up — plugging one in is
  // what reveals the updater. tightens up while the modal is open, and backs off
  // entirely mid-flash so board list doesn't poke the port arduino-cli is using.
  useEffect(() => {
    if (VIEWER || flashPhase === "flashing") return;
    const poll = () => fetch("/api/flash/boards").then(r => r.json()).then(setFlashBoards).catch(() => {});
    poll();
    const id = setInterval(poll, updateOpen === "open" ? 1200 : 5000);
    return () => clearInterval(id);
  }, [updateOpen, flashPhase]);

  // backtick jumps to the serial tab of the console drawer (ignored while typing in a field).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "`" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      e.preventDefault();
      if (drawerRef.current === "open" && drawerTabRef.current === "serial") { closeDrawer(); return; }
      setDrawerTab("serial");
      openDrawer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeDrawer, openDrawer]);
  // recording lives on the server (it grabs the cam stills), so the button only
  // reflects it — a reload mid-run picks the state back up.
  useEffect(() => { fetch("/api/rec").then(r => r.json()).then(d => setRec(d.now)).catch(() => {}); }, []);
  const recRef = useRef(rec); recRef.current = rec;
  const toggleRec = useCallback(() => {
    const on = !!recRef.current;
    fetch(on ? "/api/rec/stop" : "/api/rec/start", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: activeRef.current?.title || "" }), // title, not the whole brief
    }).then(async r => {
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "server said " + r.status); // cam offline => 503
      setRec(on ? null : d.now);
      setRecErr(null);
      addLog(on ? "recording saved" : "recording started", "system");
    }).catch(err => {
      addLog("recorder: " + err.message, "danger");
      toast(err.message, "danger");
      setRecErr(err.message); // sticks on the hud until the next attempt works
    });
  }, [addLog, toast]);
  const openReplays = useCallback(() => {
    fetch("/api/rec").then(r => r.json()).then(d => { setRec(d.now); setRuns(d.runs); }).catch(() => setRuns([]));
  }, []);
  const pickReplay = useCallback((id) => {
    fetch("/api/rec/" + id).then(r => r.json()).then(run => { setRuns(null); setReplay(run); }).catch(() => {});
  }, []);
  recActRef.current = { rec: toggleRec, replays: openReplays }; // what ✕ / SHARE hit while fpv is up
  const deleteReplay = useCallback((id) => {
    fetch("/api/rec/" + id, { method: "DELETE" })
      .then(() => setRuns(rs => (rs || []).filter(r => r.id !== id))).catch(() => {});
  }, []);

  // snapshot on open, so the document you read is exactly the json you export —
  // telemetry keeps arriving behind it either way.
  const openReport = useCallback(() => {
    setReport(buildReport({ chat: activeRef.current, packet: packetRef.current, logs, ai, connected, ping, packets, uptime }));
  }, [logs, ai, connected, ping, packets, uptime]);

  const drawerTabRef = useRef(drawerTab);
  drawerTabRef.current = drawerTab;
  const drawerRef = useRef(drawer);
  drawerRef.current = drawer;

  return html`
    <${React.Fragment}>
      <div class=${"shell" + (fpv ? " is-fpv" : "") + (FPV_ZOOMS[fpvZoom].z ? "" : " fpv-fill")}
        style=${{ "--fpv-zoom": FPV_ZOOMS[fpvZoom].z || 1 }}>
        ${fpv && html`
          <${React.Fragment}>
            <${FpvOverlay} packet=${packet} />
            <${FpvSage} ai=${ai} packet=${packet} speaking=${speaking} connected=${connected} />
            <div class="fpv-hud">
              <button type="button" class=${"hud-btn" + (fpvMic.listening ? " is-active" : "")}
                disabled=${!fpvMic.supported} onClick=${fpvMic.toggle} aria-pressed=${fpvMic.listening}>
                ○ ${fpvMic.listening ? t("ask.listening") : t("ask.mic")}
              </button>
              <button type="button" class="hud-btn" onClick=${() => analyze()} disabled=${ai.analyzing}>
                ◎ ${ai.analyzing ? t("agent.analyzing") : t("agent.runAnalysis")}
              </button>
              <button type="button" class="hud-btn" onClick=${() => cycleZoomRef.current()}>
                <${Icon} n="gear" /> ${FPV_ZOOMS[fpvZoom].label}
              </button>
              ${!VIEWER && html`
                <button type="button" class=${"hud-btn is-rec" + (rec ? " is-on" : "") + (recErr ? " is-err" : "")}
                  onClick=${toggleRec} aria-pressed=${!!rec}>
                  ✕ ${rec ? "STOP REC" : recErr ? "CAN'T RECORD" : "REC"}
                </button>`}
              <button type="button" class="hud-btn" onClick=${openReplays}>⧉ REPLAYS</button>
              <button type="button" class="hud-btn" onClick=${() => toggleFpv(false)}>△ / ESC</button>
            </div>
            ${recErr && !rec && html`<p class="rec-err" role="alert">✕ ${recErr}</p>`}
          <//>`}
        ${window.blackout?.platform === "darwin" && html`<div class="mac-titlebar"></div>`}
        <${Topbar} connected=${connected} bridge=${bridge} onBridge=${toggleBridge}
          ping=${ping} packets=${packets} uptime=${uptime} lanUrl=${lanUrl}
          lang=${lang} onLang=${changeLang} onConsole=${toggleDrawer} consoleOpen=${drawer === "open"}
          clients=${clients} onDevices=${() => setDevicesOpen("open")} granted=${granted}
          onSettings=${() => setSettingsOpen("open")} />

        ${!VIEWER && flashBoards.status !== "none" && html`<${UpdateBar} boards=${flashBoards} onUpdate=${openUpdate} />`}

        <main class="cockpit" id="sensors">
          <div class="col-main">
            <div class="stage-row">
              <${ThreeDeeBox} packet=${packet} onLog=${addLog} />
              <${CamBox} packet=${packet} onFpv=${() => toggleFpv(true)} />
            </div>
            <${SensorStrip} packet=${view} />
          </div>
          <aside class="col-rail">
            <${Agent} ai=${ai} tts=${tts} ttsProv=${ttsProv} hasDeepgram=${hasDeepgram} packet=${packet} connected=${connected} speaking=${speaking}
              chats=${chats} activeChat=${activeChat} onNewChat=${newChat} onSelectChat=${selectChat}
              onDeleteChat=${deleteChat} onBrief=${briefMission} onSpeak=${speakBrief}
              onAnalyze=${analyze} onToggleTts=${toggleTts} onToggleTtsProvider=${toggleTtsProvider} onPick=${pickHistory} onMock=${mockData} onAsk=${ask}
              onReport=${openReport} />
            ${/* mirror sees no drive zone at all until the host grants it — .reveal animates the
                 mount, and driveMounted holds it one beat past a revoke so it can animate out */
              driveMounted && html`
              <${Drive} onCmd=${sendCmd} onAnalyze=${analyze} enabled=${canDrive} leaving=${!granted}
                busyRef=${analyzingRef} packetRef=${packetRef}
                video=${video} onVideo=${playVideo} onVideoStop=${stopVideo} />`}
          </aside>
        </main>

        <${Drawer} open=${drawer} tab=${drawerTab} onTab=${setDrawerTab} onClose=${closeDrawer}
          logs=${logs} serialLines=${serialLines} onClearSerial=${clearSerial}
          chat=${activeChat} onCmd=${sendCmd} enabled=${canDrive} onTutorial=${restartTour} />
      </div>

      <${Toasts} items=${toasts} />

      ${updateOpen && createPortal(html`
        <${UpdateModal} open=${updateOpen} phase=${flashPhase} boards=${flashBoards}
          log=${flashLog} code=${flashCode}
          onFlash=${startFlash} onClose=${closeUpdate} />`, document.body)}

      ${devicesOpen && createPortal(html`
        <${DevicesModal} open=${devicesOpen} clients=${clients} selfId=${socketRef.current?.id}
          onGrant=${(id, on) => socketRef.current?.emit("grant", { id, on })}
          onClose=${closeDevices} />`, document.body)}

      ${settingsOpen && createPortal(html`
        <${SettingsModal} open=${settingsOpen} onClose=${closeSettings} />`, document.body)}

      ${blePicker && createPortal(html`
        <${BlePickerModal} open=${blePicker} devices=${bleDevs}
          onPick=${(id) => window.blackout.selectBleDevice(id)}
          onCancel=${() => window.blackout.selectBleDevice("")} />`, document.body)}

      ${runs && createPortal(html`
        <${ReplayList} runs=${runs} onPick=${pickReplay} onDelete=${deleteReplay}
          onClose=${() => setRuns(null)} />`, document.body)}

      ${replay && createPortal(html`
        <${Replay} run=${replay} onClose=${() => setReplay(null)} />`, document.body)}

      ${report && createPortal(html`
        <${ReportModal} report=${report} closing=${reportClosing} onClose=${closeReport} />`, document.body)}

      ${onboardStep && createPortal(html`
        <${Onboard} step=${onboardStep} closing=${onboardClosing} model=${onboardModel} bridge=${bridge}
          onStart=${onboardStart} onPickModel=${onboardPickModel}
          onBack=${() => setOnboardStep(s => s === "pair" ? "model" : "hero")}
          onConnect=${() => toggleBridge("toggle")} onSkipConnect=${finishOnboard} onDone=${skipOnboard} />`, document.body)}

      ${tour && createPortal(html`<${Tour} closing=${tour === "closing"} onDone=${endTour} />`, document.body)}

      ${warn && createPortal(html`
        <div class=${"blk-modal" + (warn === "closing" ? " is-closing" : "")}
          onClick=${(e) => { if (e.target === e.currentTarget) closeWarn(); }}>
          <div class="blk-modal-frame warn-frame">
            <span class="warn-title"><${Icon} n="warn" /> DEBUG MENU</span>
            <p>This is a debug menu. If you don't know what you are doing, turn back!</p>
            <div class="warn-actions">
              <button type="button" class="serial-btn" onClick=${closeWarn}>Turn back</button>
              <button type="button" class="serial-btn warn-go" disabled=${warnCount > 0}
                onClick=${() => { localStorage.setItem("debugAck", "1"); closeWarn(); setDrawer("open"); }}>
                Proceed<span class=${"warn-count" + (warnCount > 0 ? "" : " is-done")}> (${warnCount || 1})</span>
              </button>
            </div>
          </div>
        </div>`, document.body)}
    <//>`;
}

createRoot(document.getElementById("root")).render(html`<${App} />`);
