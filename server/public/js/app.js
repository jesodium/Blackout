import React, { useState, useEffect, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import htm from "htm";
import { createRoverScene } from "./scene.js";
import { t, getLang, setLang, LANGS, ttsVoice, speechLang, ONBOARDING } from "./i18n.js";
import { parse as blkParse, run as blkRun } from "./blk.js";

const html = htm.bind(React.createElement);

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
function CamBox({ packet }) {
  return html`
    <section class="zone stage-cam reveal" aria-labelledby="cam-h">
      <div class="zone-head">
        <h2 class="zone-title" id="cam-h">${t("zone.camera")}</h2>
      </div>
      <div class="stage-body">
        <${CamView} />
        <dl class="hud-tele">
          <div><dt>${t("hud.dist")}</dt><dd>${fmt(packet?.dist, 0)} cm</dd></div>
          <div><dt>${t("hud.roll")}</dt><dd>${fmt(packet?.roll, 1)}°</dd></div>
          <div><dt>${t("hud.pitch")}</dt><dd>${fmt(packet?.pitch, 1)}°</dd></div>
          <div><dt>${t("hud.yaw")}</dt><dd>${fmt(packet?.yaw, 1)}°</dd></div>
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

/* blk workflow control: pick a saved .blk program, run/stop it from here */
// programs are authored in the popup editor (blk.html) and saved server-side;
// the runner lives here because the browser holds the ble link. each drive step
// is one timed "drv," burst, so a mid-run stop or ble drop auto-halts on firmware.
function BlkCtl({ onCmd, onAnalyze, enabled, busyRef, packetRef }) {
  const [files, setFiles] = useState([]);
  const [sel, setSel] = useState(() => localStorage.getItem("blkSel") || "");
  const [run, setRun] = useState(null); // {n, label} while executing
  const [err, setErr] = useState(null);
  const [editorOpen, setEditorOpen] = useState(false); // false | "open" | "closing"
  const token = useRef(0);
  const runRef = useRef(false); // mirrors run for unmount cleanup
  runRef.current = !!run;

  // play the exit animation, then unmount
  const closeEditor = useCallback(() => {
    setEditorOpen(o => o === "open" ? "closing" : o);
    setTimeout(() => setEditorOpen(false), 240);
  }, []);

  // editor iframe asks to close (esc key inside it)
  useEffect(() => {
    const fn = (e) => { if (e.data === "blk:close") closeEditor(); };
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
  // leaving blk mode unmounts this panel — kill a live run and the motors with it
  useEffect(() => () => { token.current++; if (runRef.current) onCmd("stop"); }, [onCmd]);

  const start = async () => {
    if (!sel || run) return;
    setErr(null);
    let text;
    try {
      const r = await fetch("/api/blk/" + encodeURIComponent(sel));
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
    // interpreter walks the tree live: conditions read the latest telemetry packet,
    // forever/until loops run until STOP (or their condition trips)
    await blkRun(program, {
      stopped, sleep,
      drive: async (verb, pwm, ms) => { onCmd(`drv,${verb},${pwm},${ms}`); await sleep(ms + 150); },
      analyze: async () => { // fire the agent, wait until it's done (30s cap)
        onAnalyze();
        await sleep(500);
        const t0 = Date.now();
        while (!stopped() && busyRef.current && Date.now() - t0 < 30000) await sleep(300);
      },
      say: (txt) => speak(txt),
      sensors: () => packetRef?.current,
      halt: () => onCmd("stop"),
      onStep: (node, n) => setRun({ n, label: node.op.replace("_", " ") }),
    });
    if (!stopped()) setRun(null);
  };

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
        : html`<button type="button" class="btn btn--primary" disabled=${!enabled || !sel} onClick=${start}>▶ RUN WORKFLOW</button>`}
      <small style=${{ opacity: 0.7 }}>
        ${err ? html`<span style=${{ color: "var(--accent)" }}>${err}</span>`
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

/* drive — manual control hub: on-screen pad (hold-to-drive), wasd/arrows, gamepad, routines, stop.
   drive is sent as short timed bursts re-sent every 150ms while held: firmware auto-halts 300ms
   after the last burst, so a dropped link or stuck ui never leaves wheels spinning.
   autopilot on = all manual input ignored. control mode: remote + blk live; autonomous placeholder. */
const MODES = [["remote", "REMOTE"], ["blk", "BLK"], ["auto", "AUTO"]];
const KEYMAP = {
  w: "fwd", arrowup: "fwd", s: "back", arrowdown: "back",
  a: "left", arrowleft: "left", d: "right", arrowright: "right",
};

function Drive({ onCmd, onAnalyze, enabled, busyRef, packetRef }) {
  const [mode, setMode] = useState("remote");
  const [padName, setPadName] = useState(null);
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

  // one drive loop for every input source. gamepad wins over held pad/keys.
  // dpad up/down drives, right stick x rotates, □/X analyzes. fixed slow pwm — manual is precision, not speed.
  const MANUAL_PWM = 110;
  useEffect(() => {
    const id = setInterval(() => {
      if (!armedRef.current) { if (moving.current) { moving.current = false; setVerb(null); onCmd("stop"); } return; }
      const pad = [...navigator.getGamepads()].find(Boolean);
      let v = null;
      if (pad) {
        // square (x on xbox) = button 2. press edge only, so holding doesn't queue analyses.
        const sq = !!pad.buttons[2]?.pressed;
        if (sq && !sqWas.current) analyzeRef.current?.();
        sqWas.current = sq;
        const rx = pad.axes[2] ?? 0;
        v = pad.buttons[12]?.pressed ? "fwd"
          : pad.buttons[13]?.pressed ? "back"
          : Math.abs(rx) > 0.35 ? (rx < 0 ? "left" : "right")
          : null;
      }
      v = v || heldRef.current;
      if (!v) {
        if (moving.current) { moving.current = false; setVerb(null); onCmd("stop"); }
        return;
      }
      moving.current = true; setVerb(v);
      onCmd(`drv,${v},${MANUAL_PWM},300`);
    }, 150);
    return () => clearInterval(id);
  }, [onCmd]);

  // switching away from remote parks everything: stop any live drive, no burst leaks through.
  const pick = (m) => {
    if (m === mode) return;
    if (mode === "remote") { heldRef.current = null; moving.current = false; setVerb(null); onCmd("stop"); }
    setMode(m);
  };

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
    : t("drive.hold");

  return html`
    <section class="zone drive reveal" aria-labelledby="drive-h">
      <div class="zone-head">
        <h2 class="zone-title" id="drive-h">${t("zone.drive")}</h2>
        <span class=${"pill " + (padName ? "is-go" : "")}>${padName ? "PAD OK" : "NO PAD"}</span>
      </div>
      <div class="drive-body">
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
        <div class="routines">
          <span class="label">${t("drive.routines")}</span>
          <div class="routine-row">
            ${[["presentation", "PRES", "mast.routinePresTitle"], ["run", "RUN", "mast.routineRunTitle"],
               ["mission", "MISSION", "mast.routineMissionTitle"], ["test", "TEST", "mast.routineTestTitle"],
               ["test2", "TEST2", "mast.routineTest2Title"]].map(([r, label, titleKey]) => html`
              <button type="button" key=${r} class="chip" title=${t(titleKey)}
                disabled=${!enabled} onClick=${() => onCmd("go," + r)}>${label}</button>`)}
          </div>
        </div>
        ${mode !== "blk" && html`
          <button type="button" class="stop-bar" onClick=${stopAll} title=${t("mast.routineStopTitle")}>
            ■ ${t("drive.stop")}
          </button>`}
      </div>
    </section>`;
}

/* camera view (esp32-cam mjpeg) — lives inside the stage */
function CamView() {
  const [state, setState] = useState("loading");
  const [nonce, setNonce] = useState(0);
  const [yielded, setYielded] = useState(false);
  const [host, setHost] = useState(camHost());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sliders, setSliders] = useState({ brightness: -1, contrast: -1, ae_level: 0, led: 15 });
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

  return html`
    <div class="stage-view stage-view--cam">
      ${yielded
        ? html`<div class="viewport-fallback">${t("cam.scanning")}</div>`
        : state !== "offline"
        ? html`<img ref=${imgRef} src=${src} alt=${t("zone.camera")} class="cam-feed"
            onLoad=${() => { setState("live"); localStorage.setItem("camHost", host); }}
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
              ${[["brightness", -2, 2], ["contrast", -2, 2], ["ae_level", -2, 2], ["led", 0, 255]].map(([k, min, max]) => html`
                <label key=${k} class="cam-slider">
                  <span class="cam-slider-row"><span>${k}</span><b>${sliders[k]}</b></span>
                  <input type="range" min=${min} max=${max} step="1" value=${sliders[k]}
                    onInput=${(e) => ctrl(k, parseInt(e.target.value))} />
                </label>`)}
            </div>` : null}
        </div>` : null}
    </div>`;
}

/* sensor strip — 5 live tiles + trend sparkline, one row under the stage */
function SensorStrip({ packet }) {
  return html`
    <section class="strip reveal" aria-label=${t("zone.environment")}>
      ${SENSORS.map(s => html`<${Reading} key=${s.key} s=${s} value=${packet?.[s.key]} />`)}
      <div class="reading trend-cell" aria-label=${t("zone.trends")}>
        <div class="reading-head">
          <span class="reading-name">${t("zone.trends")}</span>
          <span class="legend">
            ${TRENDS.map(s => html`<span key=${s.key} class="legend-item"><i style=${{ background: s.color }}></i>${t(s.tkey)}</span>`)}
          </span>
        </div>
        <div class="trend-body"><${Trends} packet=${packet} /></div>
      </div>
    </section>`;
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
// label is i18n key, resolved at render via t().
// split face string into animated parts for telegram-style blink.
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

function Agent({ ai, tts, ttsProv, hasDeepgram, packet, connected, speaking, chats, activeChat, onNewChat, onSelectChat, onDeleteChat, onBrief, onSpeak, onAnalyze, onToggleTts, onToggleTtsProvider, onPick, onMock, onAsk }) {
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
          ${ai.analyzing
            ? html`<span class="agent-analyzing-label">${t("intent.thinking")}</span>`
            : html`<div class="agent-orb"><${AgentIcon} intent=${intent} /></div>
          ${speaking
            ? html`<div class="agent-eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>`
            : html`<span class="agent-state-label"><span class="agent-face">${animFace(intent.face)}</span> ${t(intent.label)}</span>`}`}
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
          <button class="btn btn--primary" type="button" onClick=${() => onAnalyze()} disabled=${ai.analyzing}>
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

/* ask sage (voice, in agent box) */
// predetermined prompts — give operator ideas and keep questions on-telemetry.
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
function Topbar({ connected, ports, currentPort, bridge, onBridge, connMode, onConnMode, ping, packets, uptime, onPort, lang, onLang, onConsole, consoleOpen }) {
  return html`
    <header class="topbar">
      <div class="brand">
        <span class="brand-tick" aria-hidden="true"></span>
        <span class="brand-name">Blackout</span>
        <span class="brand-ver">V3</span>
      </div>
      <p class="lamp visually-hidden" role="status" aria-live="polite">
        ${connected ? t("mast.linkLive") : t("mast.noSignal")}
      </p>
      <div class="top-conn">
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
                ${bridge.busy ? t("mast.bridgeBusy") : bridge.running ? t("mast.linked") : t("mast.connect")}
              </button>
              <button type="button" class="bridge-repair" title=${t("mast.bridgeRepairTitle")}
                disabled=${bridge.busy} onClick=${() => onBridge("reconnect")}>⟳</button>
            </div>
          `}
        </div>
      </div>
      <div class="top-stats">
        <dl class="stat"><dt>${t("mast.ping")}</dt><dd>${ping}</dd></dl>
        <dl class="stat"><dt>${t("mast.packets")}</dt><dd>${packets}</dd></dl>
        <dl class="stat"><dt>${t("mast.uptime")}</dt><dd>${uptime}</dd></dl>
      </div>
      <select class="port-select top-lang" value=${lang} onChange=${e => onLang(e.target.value)} aria-label=${t("mast.lang")}>
        ${LANGS.map(l => html`<option key=${l.code} value=${l.code}>${l.label}</option>`)}
      </select>
      <button type="button" class=${"console-btn" + (consoleOpen ? " is-active" : "")}
        onClick=${onConsole} aria-pressed=${consoleOpen} title=${t("serial.toggleTitle")}>
        ▤ ${t("drawer.console")}
      </button>
    </header>`;
}

/* console drawer — logs, findings, serial, motor bench. slides over the cockpit */
function Drawer({ open, tab, onTab, onClose, logs, serialLines, onClearSerial, chat, onCmd, enabled }) {
  if (!open) return null;
  const tabs = [["logs", t("zone.logs")], ["findings", t("zone.analysis")], ["serial", t("zone.serial")], ["motor", t("colo.motor")]];
  return html`
    <div class=${"drawer" + (open === "closing" ? " is-closing" : "")} role="region" aria-label=${t("drawer.console")}>
      <div class="drawer-bar">
        <div class="drawer-tabs" role="tablist">
          ${tabs.map(([k, lbl]) => html`<button key=${k} type="button" role="tab" aria-selected=${tab === k}
            class=${"drawer-tab" + (tab === k ? " is-active" : "")} onClick=${() => onTab(k)}>${lbl}</button>`)}
        </div>
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

/* toasts */
function Toasts({ items }) {
  return html`<div class="toasts">${items.map(t => html`<div key=${t.id} class=${"toast k-" + t.kind}>${t.msg}</div>`)}</div>`;
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
  const [ports, setPorts] = useState([]);
  const [currentPort, setCurrentPort] = useState(null);
  const [bridge, setBridge] = useState({ running: false, busy: false });
  const [connMode, setConnModeState] = useState(() => localStorage.getItem("connMode") || "usb");
  const [toasts, setToasts] = useState([]);
  const [uptime, setUptime] = useState("00:00:00");
  const [serialLines, setSerialLines] = useState([]);
  const [drawer, setDrawer] = useState(false); // false | "open" | "closing"
  const [drawerTab, setDrawerTab] = useState("logs");
  const [warn, setWarn] = useState(false);     // first-open debug warning gate
  const [warnCount, setWarnCount] = useState(3);
  const [speaking, setSpeaking] = useState(false);
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
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 3600);
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
    const url = window.location.port !== "3000" ? "http://localhost:3000" : undefined;
    const socket = window.io(url);
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
    addLog(t("log.booted"), "system");
    return () => socket.close();
  }, [addLog, speakTimed]);

  // keep document language + skip-link (static html outside react) in sync.
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

  // bluetooth bridge: r4 advertises ble (no classic spp), so browser's web bluetooth talks to it directly — no server-side native bt library needed.
  const BLE_SERVICE = "19b10000-e8f2-537e-4f6c-d104768a1214";
  const BLE_CHAR = "19b10001-e8f2-537e-4f6c-d104768a1214";
  const BLE_CMD = "19b10002-e8f2-537e-4f6c-d104768a1214"; // write = motion routine verbs
  const bleRef = useRef({ device: null, char: null, cmd: null });

  // defined above onblenotify because that handler calls it — deps are evaluated during render, so later `const` would be in temporal dead zone.
  const analyze = useCallback((mode) => {
    if (analyzingRef.current) return;
    analyzingRef.current = true; // set now, not on re-render — two calls in one tick must not both emit
    setAi(p => ({ ...p, analyzing: true, badge: "badge.analyzing", phase: "thinking", since: Date.now(), llm: null, tts: null }));
    socketRef.current?.emit("request-analysis", { mode: mode || null });
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
    bleRef.current = { device: null, char: null, cmd: null };
  }, [onBleNotify]);

  // one verb to firmware over ble cmd char: "go,<name>" starts a motion routine, "stop" cuts motors.
  // routines run standalone on board — this only fires starting gun, so dropped link mid-run doesn't strand robot.
  const sendCmd = useCallback(async (word) => {
    if (word.startsWith("go,")) presentingRef.current = word === "go,presentation";
    const { device, cmd } = bleRef.current;
    if (!device?.gatt?.connected) { toast(t("toast.cmdNoLink"), "danger"); return false; }
    if (!cmd) { toast(t("toast.cmdNoChar"), "danger"); return false; } // linked but firmware lacks cmd char
    try {
      await cmd.writeValue(new TextEncoder().encode(word));
      addLog(t("log.cmdSent", { cmd: word }), "system");
      return true;
    } catch (e) { addLog(t("log.error", { msg: e.message }), "danger"); return false; }
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
        // filter by service uuid, not name — arduinoble on r4 wifi always advertises name as "arduino" (known upstream bug), so name filter never matches.
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
    else setWarn(true);
  }, []);
  const toggleDrawer = useCallback(() => {
    if (drawerRef.current === "open") closeDrawer(); else openDrawer();
  }, [closeDrawer, openDrawer]);

  // warning's 3s cooldown before PROCEED unlocks
  useEffect(() => {
    if (!warn) return;
    setWarnCount(3);
    const id = setInterval(() => setWarnCount(c => Math.max(0, c - 1)), 1000);
    return () => clearInterval(id);
  }, [warn]);

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
  const drawerTabRef = useRef(drawerTab);
  drawerTabRef.current = drawerTab;
  const drawerRef = useRef(drawer);
  drawerRef.current = drawer;

  return html`
    <${React.Fragment}>
      <div class="shell">
        <${Topbar} connected=${connected} ports=${ports} currentPort=${currentPort}
          bridge=${bridge} onBridge=${toggleBridge} connMode=${connMode} onConnMode=${setConnMode}
          ping=${ping} packets=${packets} uptime=${uptime} onPort=${switchPort}
          lang=${lang} onLang=${changeLang} onConsole=${toggleDrawer} consoleOpen=${drawer === "open"} />

        <main class="cockpit" id="sensors">
          <div class="col-main">
            <div class="stage-row">
              <${ThreeDeeBox} packet=${packet} onLog=${addLog} />
              <${CamBox} packet=${packet} />
            </div>
            <${SensorStrip} packet=${view} />
          </div>
          <aside class="col-rail">
            <${Agent} ai=${ai} tts=${tts} ttsProv=${ttsProv} hasDeepgram=${hasDeepgram} packet=${packet} connected=${connected} speaking=${speaking}
              chats=${chats} activeChat=${activeChat} onNewChat=${newChat} onSelectChat=${selectChat}
              onDeleteChat=${deleteChat} onBrief=${briefMission} onSpeak=${speakBrief}
              onAnalyze=${analyze} onToggleTts=${toggleTts} onToggleTtsProvider=${toggleTtsProvider} onPick=${pickHistory} onMock=${mockData} onAsk=${ask} />
            <${Drive} onCmd=${sendCmd} onAnalyze=${analyze} enabled=${bridge.running} busyRef=${analyzingRef} packetRef=${packetRef} />
          </aside>
        </main>

        <${Drawer} open=${drawer} tab=${drawerTab} onTab=${setDrawerTab} onClose=${closeDrawer}
          logs=${logs} serialLines=${serialLines} onClearSerial=${clearSerial}
          chat=${activeChat} onCmd=${sendCmd} enabled=${bridge.running} />
      </div>

      <${Toasts} items=${toasts} />

      ${warn && createPortal(html`
        <div class="blk-modal" onClick=${(e) => { if (e.target === e.currentTarget) setWarn(false); }}>
          <div class="blk-modal-frame warn-frame">
            <span class="warn-title">⚠ DEBUG MENU</span>
            <p>This is a debug menu. If you don't know what you are doing, turn back!</p>
            <div class="warn-actions">
              <button type="button" class="serial-btn" onClick=${() => setWarn(false)}>Turn back</button>
              <button type="button" class="serial-btn warn-go" disabled=${warnCount > 0}
                onClick=${() => { localStorage.setItem("debugAck", "1"); setWarn(false); setDrawer("open"); }}>
                ${warnCount > 0 ? `Proceed (${warnCount})` : "Proceed"}
              </button>
            </div>
          </div>
        </div>`, document.body)}
    <//>`;
}

createRoot(document.getElementById("root")).render(html`<${App} />`);
