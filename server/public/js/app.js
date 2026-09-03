import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { createPortal, flushSync } from "react-dom";
import htm from "htm";
import { createRoverScene } from "./scene.js";
import { t, getLang, setLang, LANGS, ttsVoice, speechLang, ONBOARDING } from "./i18n.js";
import { parse as blkParse, run as blkRun, lint as blkLint, estimate as blkEstimate, fmtMs,
         compile as blkCompile, insLine as blkInsLine, interp as blkInterp, evalExpr as blkEval, clampArg as blkClamp,
         guard as blkGuard, serialize as blkSerialize, GUARD_CM } from "./blk.mjs";
import { SageFace } from "./sageface.js";
import { initPadNav, cursorOn } from "./padnav.mjs";
import { mjpegSplit } from "./mjpeg.mjs";
import { loadDetector, detectUpright, drawBoxes } from "./detect.mjs";

const html = htm.bind(React.createElement);

const NO_FEED = [];
const Icon = ({ n }) => html`<i class=${"icn icn-" + n} aria-hidden="true" />`;

// ---- viewer / cam host ----
// anything not on localhost is a read-only copy. ?operator unlocks a second machine for good.
const VIEWER = (() => {
  if (new URLSearchParams(location.search).has("operator")) localStorage.setItem("operator", "1");
  return !localStorage.getItem("operator") &&
    !["localhost", "127.0.0.1", "[::1]", "::1"].includes(location.hostname);
})();

const CAM_HOSTS = ["172.20.10.10", "192.168.1.111", "blackout-cam.local"];
const CAM_HOST_DEFAULT = CAM_HOSTS[0];
const camHost = () => localStorage.getItem("camHost") || CAM_HOST_DEFAULT;
const camUrl = (host) => `http://${host}:81/stream`;

const fmt = (v, d) => (v == null || isNaN(v) ? "--" : Number(v).toFixed(d));

// ---- sensor model ----
// min/max is the meter's travel, st() picks the label and the colour band.
// zeroOk marks the three sensors that can really read 0 — everything else sends 0 because nothing is wired yet.
const SENSORS = [
  { key: "temp",  unit: "°C",  d: 1, min: 0, max: 60,   st: v => v > 45 ? ["st.critical", "abort"] : v > 35 ? ["st.high", "warn"] : ["st.normal", "go"] },
  { key: "humid", unit: "%",   d: 1, min: 0, max: 100,  st: v => v > 75 ? ["st.humid", "warn"] : v < 20 ? ["st.dry", "warn"] : ["st.good", "go"] },
  { key: "dist",  unit: "cm",  d: 0, min: 0, max: 200,  invert: true, zeroOk: true, st: v => v < 10 ? ["st.tooClose", "warn"] : ["st.clear", "go"] },
  { key: "alt",   unit: "m",   d: 0, min: -25, max: 25, cm: true, zeroOk: true, st: () => ["st.normal", "go"] },
  { key: "pressure", unit: "hPa", d: 1, min: 950, max: 1050, st: () => ["st.normal", "go"] },
  { key: "lux", unit: "lx", d: 0, min: 0, max: 1000, zeroOk: true,
    st: v => v < 1 ? ["st.dark", "go"] : v > 500 ? ["st.bright", "go"] : ["st.normal", "go"] },
];

const reads = (s, v) => v != null && !isNaN(v) && (v !== 0 || s.zeroOk);

const PKT_STALE_MS = 3000;

// ---- voice commands ----
const norm = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/[\u00a1\u00bf!?]/g, "").replace(/\s+/g, " ").trim();
const DRIVE_PWM = 140, DRIVE_MS = 501;

const ORDER = /^(?:sage[\s,]*)?(?:te (?:lo )?ordeno|te pido|orden|i order you|order)(?:\s+que)?\b\s*(.+)/;
const LEAD = "^(?:sage[\\s,]*)?(?:please\\s+|por favor\\s+)?(?:(?:can|could) you\\s+)?" +
  "(?:(?:go|move|drive|turn|head|ir|ve|vaya|vayas|gira|gires|anda|muevete|camina|sigue)\\s+)*" +
  "(?:(?:a la|al|hacia|para|to the)\\s+)*";
const drv = (words) => new RegExp(LEAD + `(?:${words})\\b`);

function driveMs(txt) {
  const m = txt.match(/(\d+(?:[.,]\d+)?)\s*(ms|milliseconds?|milisegundos?|s|secs?|seconds?|segundos?)\b/);
  if (!m) return DRIVE_MS;
  const n = parseFloat(m[1].replace(",", "."));
  return Math.min(5000, Math.max(50, Math.round(m[2][0] === "m" ? n : n * 1000)));
}

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

function matchCmd(txt) {
  const ord = txt.match(ORDER);
  if (ord) return DIRS.find(d => d.bare.test(ord[1])) || null;
  return CMD_TRIGGERS.find(c => c.re.test(txt)) || null;
}

const TRENDS = [
  { key: "dist", tkey: "trend.dist", color: "#9a9384" },
  { key: "humid", tkey: "trend.humid", color: "#44cf86" },
  { key: "temp", tkey: "trend.temp", color: "#3b82f6" },
];

// ---- speech ----
let voices = [];
const loadVoices = () => { voices = window.speechSynthesis?.getVoices() || []; };
loadVoices();
if (window.speechSynthesis) speechSynthesis.onvoiceschanged = loadVoices;
function browserSpeak(text, { onStart, onEnd } = {}) {
  if (!text || !window.speechSynthesis || !voices.length) { onEnd?.(); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const sl = speechLang();
  const pre = sl.slice(0, 2);
  u.rate = 0.9; u.lang = sl;

  u.voice = voices.find(v => v.lang.startsWith(pre) && /samantha|alex|google|enhanced|jorge|alvaro|helena/i.test(v.name))
    || voices.find(v => v.lang.startsWith(pre)) || null;
  u.onstart = () => onStart?.();
  u.onend = () => onEnd?.();
  u.onerror = () => onEnd?.();
  speechSynthesis.speak(u);
}

const FINDINGS = [
  { k: "temp",  warn: 35,  danger: 45,  msg: { 1: "find.tempUp", 2: "find.tempHigh" } },
  { k: "dist",  close: 10,              msg: { 1: "find.obstacle" } },
];
const bandOf = (f, v) => {
  if (v == null || isNaN(v)) return 0;
  if (f.k === "dist") return v < f.close ? 1 : 0;
  return v >= f.danger ? 2 : v >= f.warn ? 1 : 0;
};

const splitSpeech = (t) => (t.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) || [t]).map(s => s.trim()).filter(Boolean);

let ttsAudio = null;
let ttsToken = 0;
let ttsOnEnd = null;
let ttsProviderRef = "edge";

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
    if (myToken !== ttsToken) { cur?.pause(); return; }
    const a = cur;
    const next = i + 1 < parts.length ? mk(parts[i + 1]) : null;
    ttsAudio = a;
    try {
      await new Promise((resolve, reject) => {
        a.onended = resolve; a.onerror = reject;
        a.onplay = firstStart;
        a.play().catch(reject);
      });
    } catch {
      if (myToken !== ttsToken) return;
      browserSpeak(parts.slice(i).join(" "), { onStart: firstStart, onEnd });
      return;
    }
    cur = next;
  }
  if (myToken === ttsToken) { ttsOnEnd = null; onEnd?.(); }
}

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

// ---- panels ----
function Head({ title, tag, children }) {
  return html`
    <div class="zone-head">
      <h2 class="zone-title">${title}</h2>
      ${tag ? html`<span class="tag">${tag}</span>` : children}
    </div>`;
}

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
      const spec = SENSORS.find(x => x.key === s.key) || {};
      const vals = H.map(d => d[s.key]).filter(v => reads(spec, v));
      if (vals.length < 2) return;
      const min = Math.min(...vals), max = Math.max(...vals), rng = max - min;
      const pad = 8 * devicePixelRatio;   // flat series draws mid-canvas, not on the floor
      ctx.beginPath(); let n = 0;
      H.forEach((d, i) => {
        const v = d[s.key]; if (!reads(spec, v)) return;
        const x = (i / (H.length - 1)) * w;
        const y = rng ? h - ((v - min) / rng) * (h - 2 * pad) - pad : h / 2;
        n++ ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.strokeStyle = s.color; ctx.lineWidth = 1.6 * devicePixelRatio;
      ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.stroke();
    });
  }, [packet]);
  return html`<canvas ref=${ref}></canvas>`;
}

function Reading({ s, value }) {
  const [inCm, setInCm] = useState(false);
  const cm = s.cm && inCm;
  const has = reads(s, value);
  const [labelKey, kind] = has ? s.st(value) : [null, ""];

  const label = has ? t(labelKey) : value === 0 ? t("st.noRead") : "—";
  const name = t("sensor." + s.key);
  const raw = has ? Math.max(0, Math.min(100, ((value - s.min) / (s.max - s.min)) * 100)) : 0;
  const pct = s.invert ? 100 - raw : raw;
  const toggle = s.cm ? () => setInCm(v => !v) : undefined;
  return html`
    <div class=${"reading" + (has ? "" : " is-dead")} onClick=${toggle}
      role=${s.cm ? "button" : undefined} tabIndex=${s.cm ? 0 : undefined}
      onKeyDown=${s.cm ? e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } } : undefined}>
      <div class="reading-head">
        <span class="reading-name">${name}</span>
        <span class=${"pill " + (kind ? "is-" + kind : "")}>${label}</span>
      </div>
      <div class="reading-body">
        <span class="reading-num">${has ? fmt(cm ? value * 100 : value, cm ? 0 : s.d) : "--"}</span>
        <span class="reading-unit">${cm ? "cm" : s.unit}</span>
      </div>
      <div class="meter" role="meter" aria-label=${name}
        aria-valuenow=${has ? Number(value) : undefined} aria-valuemin=${s.min} aria-valuemax=${s.max}>
        <div class=${"meter-fill " + (kind ? "is-" + kind : "")} style=${{ width: pct + "%" }}></div>
      </div>
    </div>`;
}

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

function MotorDebug({ onCmd, enabled }) {
  const knob = (key, def) => {
    const [v, setV] = useState(+localStorage.getItem(key) || def);
    return [v, (x) => { setV(x); localStorage.setItem(key, x); }];
  };
  const [pwm, setPwm]       = knob("dbgPwm", 180);
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
          ${btn("A ▲ only", () => onCmd(`drv,tank,${pwm},0,${ms}`))}
          ${btn("A ▼ only", () => onCmd(`drv,tank,${-pwm},0,${ms}`))}
          ${btn("B ▲ only", () => onCmd(`drv,tank,0,${pwm},${ms}`))}
          ${btn("B ▼ only", () => onCmd(`drv,tank,0,${-pwm},${ms}`))}
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

// ---- blk runner ----
// the board plays the program; the browser only services the say/log/ask events it sends back.
let blkEvt = null;
window.addEventListener("blk:evt", (e) => blkEvt?.(e.detail));

let blkToken = 0;
const blkCancel = () => { blkToken++; };

const blkWaitFor = (pred, ms, kick) => new Promise((res) => {
  const to = setTimeout(() => { blkEvt = null; res(null); }, ms);
  blkEvt = (line) => { if (!pred(line)) return; clearTimeout(to); blkEvt = null; res(line); };
  kick?.();
});

function blkIo(deps, stopped, sleep) {
  const { onCmd, onAnalyze, busyRef, packetRef, onNote, onProgress } = deps;

  const decide = async (path, body) => {
    try {
      const r = await fetch(path, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const d = await r.json();
      onNote?.(`${d.yes ? "yes" : "no"}${d.text ? " — " + d.text : ""}`);
      return !!d.yes;
    } catch { onNote?.("AI didn't answer — treating as no"); return false; }
  };
  return {
    stopped, sleep,
    drive: async (verb, pwm, ms) => { onCmd(`drv,${verb},${pwm},${ms}`); await sleep(ms + 150); },
    analyze: async (focus) => {
      onAnalyze(null, focus);
      await sleep(500);
      const t0 = Date.now();
      while (!stopped() && busyRef.current && Date.now() - t0 < 30000) await sleep(300);
    },
    ask: (q) => decide("/api/blk-ask", { question: q }),
    find: (thing) => decide("/api/blk-find", { thing }),
    led: (v) => { fetch("/api/led", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: v }) }).catch(() => {}); },
    log: (txt) => onNote?.(txt),
    say: (txt) => speak(txt),
    sensors: () => packetRef?.current,
    halt: () => onCmd("stop"),
    onStep: (node, n, st) => onProgress?.({ n, label: node.op.replace("_", " "), vars: { ...st.vars } }),
  };
}

async function blkOnBoard({ code, nodes, slots }, io, deps, stopped) {
  const { onCmd, onProgress } = deps;
  if (!await blkWaitFor(l => l.startsWith("E:blkrdy"), 2000, () => onCmd(`blk,n,${code.length}`))) return false;

  for (let i = 0; i < code.length; i++) {
    if (stopped()) return true;
    await onCmd(blkInsLine(i, code[i]));
  }
  let n = 0;
  return new Promise((res) => {
    const finish = (v) => { clearInterval(poll); blkEvt = null; res(v); };
    const poll = setInterval(() => { if (stopped()) finish(true); }, 200);
    blkEvt = async (line) => {
      if (line.startsWith("E:blkend")) return finish(true);
      if (line.startsWith("E:blkerr")) return finish(false);
      if (!line.startsWith("E:blk,")) return;
      const f = line.slice(6).split(",");
      const node = nodes[+f[0]];
      const kind = +f[1];
      if (!node) return void onCmd("blk,res,0");

      const vars = {};
      for (const [name, i] of Object.entries(slots)) vars[name] = +f[2 + i] || 0;
      onProgress?.({ n: ++n, label: node.op.replace("_", " "), vars, board: true });
      const ctx = { st: { vars }, sensors: io.sensors };
      const txt = () => blkInterp(node.text, ctx);
      let val = 0;
      switch (node.op) {
        case "say": io.say(txt()); break;
        case "log": io.log(txt()); break;
        case "led": io.led(blkClamp("led", blkEval(node.arg, ctx) || 0)); break;
        case "analyze": await io.analyze(txt()); break;
        case "ask": val = (await io.ask(txt())) ? 1 : 0; break;
        case "find": val = (await io.find(txt())) ? 1 : 0; break;
      }
      if (kind) await onCmd(`blk,res,${val}`);
    };
    onCmd("blk,go");
  });
}

async function playBlk(program, deps) {
  const my = ++blkToken;
  const stopped = () => blkToken !== my;
  const sleep = async (ms) => {
    const t0 = Date.now();
    while (!stopped() && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 50));
  };
  const io = blkIo(deps, stopped, sleep);
  let built = null;
  try { built = blkCompile(program); } catch (e) { deps.onNote?.(`running in browser — ${e.message}`); }
  if (built && await blkOnBoard(built, io, deps, stopped)) return { where: "board", cancelled: stopped() };
  await blkRun(program, io);
  return { where: "browser", cancelled: stopped() };
}

function BlkCtl({ onCmd, onAnalyze, enabled, busyRef, packetRef }) {
  const [files, setFiles] = useState([]);
  const [sel, setSel] = useState(() => localStorage.getItem("blkSel") || "");
  const [run, setRun] = useState(null);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);
  const [preview, setPreview] = useState(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const runRef = useRef(false);
  runRef.current = !!run;

  const closeEditor = useCallback(() => {
    setEditorOpen(o => o === "open" ? "closing" : o);
    setTimeout(() => setEditorOpen(false), 240);
  }, []);

  useEffect(() => {
    const fn = (e) => {
      if (e.data === "blk:close") return closeEditor();
      if (e.data?.type === "blk:run" && e.data.name) {
        pick(e.data.name);
        closeEditor();
        setTimeout(() => startRef.current(e.data.name), 320);
      }
    };
    window.addEventListener("message", fn);
    return () => window.removeEventListener("message", fn);
  }, [closeEditor]);

  const loadFiles = useCallback(() => {
    fetch("/api/blk").then(r => r.json()).then(d => setFiles(d.files || [])).catch(() => {});
  }, []);

  useEffect(() => {
    loadFiles();
    const bc = new BroadcastChannel("blk");
    bc.onmessage = loadFiles;
    window.addEventListener("focus", loadFiles);
    return () => { bc.close(); window.removeEventListener("focus", loadFiles); };
  }, [loadFiles]);

  useEffect(() => {
    if (!sel) { setPreview(null); return; }
    let live = true;
    fetch("/api/blk/" + encodeURIComponent(sel))
      .then(r => r.ok ? r.text() : Promise.reject())
      .then(text => {
        if (!live) return;
        const { program, errors } = blkParse(text);

        let board;
        try { board = blkCompile(program).code.length; } catch (e) { board = e.message; }
        setPreview({ text, warns: errors.length ? errors : blkLint(program), ms: fmtMs(blkEstimate(program)), board });
      })
      .catch(() => live && setPreview(null));
    return () => { live = false; };
  }, [sel]);

  useEffect(() => () => { blkCancel(); if (runRef.current) onCmd("stop"); }, [onCmd]);

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
    setRun({ n: 0, label: "start" });
    const { cancelled } = await playBlk(program, {
      onCmd, onAnalyze, busyRef, packetRef, onNote: setNote,
      onProgress: (p) => setRun(p),
    });
    if (!cancelled) setRun(null);
  };

  const startRef = useRef(start);
  startRef.current = start;

  const stop = () => { blkCancel(); setRun(null); onCmd("stop"); };
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
        ? html`<button type="button" class="btn blk-stop" onClick=${stop}>■ STOP — ${run.board ? "on board · " : ""}step ${run.n} · ${run.label.toUpperCase()}</button>`
        : html`<button type="button" class="btn btn--primary" disabled=${!enabled || !sel} onClick=${() => start()}>▶ RUN WORKFLOW</button>`}
      ${preview && !run && html`
        <details class="blk-prev">
          <summary>${preview.text.split("\n").filter(l => l.trim()).length} lines · ~${preview.ms} per pass${preview.warns.length ? ` · ${preview.warns.length} warning${preview.warns.length === 1 ? "" : "s"}` : ""}</summary>
          <div class="blk-where">${typeof preview.board === "number"
            ? `runs on the board — ${preview.board} instructions uploaded first`
            : `runs in the browser — ${preview.board}`}</div>
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

// ---- drive ----
let tourOpen = false;

const MODES = [["remote", "REMOTE"], ["blk", "BLK"], ["auto", "AUTO"]];
const KEYMAP = {
  w: "fwd", arrowup: "fwd", s: "back", arrowdown: "back",
  a: "left", arrowleft: "left", d: "right", arrowright: "right",
};

const VERB_MIX = { fwd: [1, 1], back: [-1, -1], left: [1, -1], right: [-1, 1] };
// ---- arm ----
// Every joint is a 360 with no encoder or end stop, so there is no "go to 45deg":
// a button held sends the same jog over and over and the board's deadman
// (ARM_JOG_MS, 800ms) kills the pulse the moment the repeats stop — a closed tab
// or a dropped link must not outlive the hand on the button.
const ARM_REPEAT_MS = 300;
const ARM_JOINTS = ["base", "shoulder", "elbow", "wrist", "gripwrist", "gripper"];
// A released 360 free-wheels, so a loaded joint sags. HOLD is the bias it is left
// driving at: turn it until the sag stops, then copy the number into armSv[] in
// arm.h — the board keeps it in RAM only. ARM_HOLD_MAX matches the firmware clamp.
const ARM_HOLD_MAX = 35;
// Starting hold per joint — the same numbers armSv[] in arm.h boots with, and
// test-arm.mjs fails if the two drift. Only gravity-loaded joints have one.
const ARM_HOLD_INIT = {};
// A 360 has no encoder, so "do not overdrive this joint" can only ever be a
// RUN-TIME budget: milliseconds at full speed, counted either way from the last
// re-home, which makes a joint's range 2x this wide. The board keeps the same
// count (armTravel[] in arm.h) and it is the authority — this copy exists so the
// operator watches the stop coming and the arrow greys out, instead of a joint
// silently refusing to move. Both are dead reckoning and both DRIFT (a stall, a
// sag, a hand moving the arm), which is why RE-HOME is a button and not a
// maintenance task. ?armlimits=off turns off this copy AND the board's — bench
// only, and it is the whole reason arml, exists.
const ARM_TRAVEL_MS = 2500;
const ARM_LIMIT = { gripper: 1200 };   // joints whose budget is not the default
const armLimit = (name) => ARM_LIMIT[name] ?? ARM_TRAVEL_MS;
const ARM_LIMITS_ON = !/[?&]armlimits=off/i.test(location.search);

function Arm({ onCmd, enabled }) {
  const heldRef = useRef(null);
  const [hold, setHold] = useState(() => ARM_JOINTS.map((n) => ARM_HOLD_INIT[n] ?? 0));
  const [moves, setMoves] = useState({});
  const [travel, setTravel] = useState(() => ARM_JOINTS.map(() => 0));
  const travelRef = useRef(travel);
  const speedRef = useRef(ARM_JOINTS.map(() => 0));
  const clockRef = useRef(0);
  const playRef = useRef([]);

  // The one choke point every arm command goes through, so a tapped move counts
  // against the same budget a held button does — integrate first at the OLD
  // speed, then adopt the new one. Sends are never more than ARM_REPEAT_MS
  // apart while a joint is moving, so the integral has nothing to miss.
  const send = (cmd) => {
    const now = performance.now();
    const dt = clockRef.current ? now - clockRef.current : 0;
    clockRef.current = now;
    const t = travelRef.current.map((v, k) => v + (speedRef.current[k] * dt) / 100);
    const m = /^arm,(\d+),(-?\d+)$/.exec(cmd);
    if (m) speedRef.current[+m[1]] = +m[2];
    else speedRef.current = ARM_JOINTS.map(() => 0);   // "arm," / "stop" / anything else
    travelRef.current = t;
    setTravel(t);
    onCmd(cmd);
  };
  const atLimit = (i, dir) => ARM_LIMITS_ON &&
    (dir > 0 ? travelRef.current[i] >= armLimit(ARM_JOINTS[i])
             : travelRef.current[i] <= -armLimit(ARM_JOINTS[i]));

  const stopPlay = () => { playRef.current.forEach(clearTimeout); playRef.current = []; };
  useEffect(() => {
    fetch("/api/arm-moves").then((r) => r.json()).then(setMoves).catch(() => {});
    // A queued step firing after the panic key restarts the arm the instant it
    // was stopped, so the tape has to die with it. The root binding already
    // sends the stop itself.
    const panic = (e) => { if (e.code === "Space" || e.key === "Escape") stopPlay(); };
    addEventListener("keydown", panic);
    return () => { removeEventListener("keydown", panic); stopPlay(); };
  }, []);

  useEffect(() => {
    if (!enabled) { stopPlay(); return; }
    // The board boots with its stops ON, so the debug flag is re-pushed on every
    // connect — same as the buzzer mute. A reset brings the stops back.
    if (!ARM_LIMITS_ON) onCmd("arml,0");
    const id = setInterval(() => {
      const h = heldRef.current;
      if (!h) return;
      if (atLimit(h[0], h[1])) { heldRef.current = null; send(`arm,${h[0]},0`); return; }
      send(`arm,${h[0]},${h[1]}`);
    }, ARM_REPEAT_MS);
    return () => { clearInterval(id); heldRef.current = null; };
  }, [onCmd, enabled]);

  const press = (i, dir) => (e) => {
    e.preventDefault();
    if (!enabled || atLimit(i, dir)) return;
    heldRef.current = [i, dir];
    send(`arm,${i},${dir}`);            // first one now, the interval only repeats it
  };
  // release stops the joint outright rather than waiting out the deadman
  const release = (i) => () => {
    if (heldRef.current?.[0] !== i) return;
    heldRef.current = null;
    send(`arm,${i},0`);
  };

  // Recorded on the bench by armrec.py: a flat list of {ms, cmd} replayed with
  // its original gaps. The gaps are the take — the board's deadman lives on
  // them — so this is timeouts off one clock, never a loop with waits.
  const playMove = (name) => {
    stopPlay();
    const steps = moves[name] || [];
    playRef.current = steps.map((st) => setTimeout(() => send(st.cmd), st.ms));
    playRef.current.push(setTimeout(() => send("arm,"),
      (steps.length ? steps[steps.length - 1].ms : 0) + ARM_REPEAT_MS));
  };

  const rehome = () => {
    travelRef.current = ARM_JOINTS.map(() => 0);
    setTravel(travelRef.current);
    send("armz,");
  };

  return html`
    <div class=${"arm-pad" + (enabled ? "" : " is-off")}>
      ${ARM_JOINTS.map((name, i) => html`
        <div class="arm-row" key=${name}>
          <span class="arm-name">${name}</span>
          ${[["◀", -100], ["▶", 100]].map(([glyph, dir]) => html`
            <button type="button" key=${dir} class="pad-btn arm-btn"
              disabled=${!enabled || atLimit(i, dir)}
              aria-label=${`${name} ${dir < 0 ? "reverse" : "forward"}`}
              onPointerDown=${press(i, dir)} onPointerUp=${release(i)}
              onPointerLeave=${release(i)} onPointerCancel=${release(i)}
              onContextMenu=${(e) => e.preventDefault()}>
              <span class="pad-glyph" aria-hidden="true">${glyph}</span>
            </button>`)}
          <meter class="arm-travel" min="0" max="100" high="80" optimum="0"
            value=${Math.min(100, Math.round((Math.abs(travel[i]) / armLimit(name)) * 100))}
            title=${`${name}: travel used since the last re-home`}
            aria-label=${`${name} travel used`}></meter>
          <input type="range" class="arm-hold" disabled=${!enabled}
            min=${-ARM_HOLD_MAX} max=${ARM_HOLD_MAX} step="1" value=${hold[i]}
            aria-label=${`${name} hold bias`} title="hold bias — stops the joint sagging"
            onInput=${(e) => {
              if (!enabled) return;
              const v = +e.target.value;
              setHold((h) => h.map((x, k) => (k === i ? v : x)));
              onCmd(`armh,${i},${v}`);
            }} />
          <span class="arm-hold-v" aria-hidden="true">${hold[i]}</span>
        </div>`)}
      <div class="arm-moves">
        ${Object.keys(moves).map((name) => html`
          <button type="button" key=${name} class="pad-btn arm-move" disabled=${!enabled}
            onClick=${() => enabled && playMove(name)}>${name}</button>`)}
        <button type="button" class="pad-btn arm-move" disabled=${!enabled}
          title="the travel count is dead reckoning — tell it the arm is home"
          onClick=${() => enabled && rehome()}>RE-HOME</button>
      </div>
    </div>`;
}

function Drive({ onCmd, onAnalyze, enabled, leaving, busyRef, packetRef }) {
  const [mode, setMode] = useState("remote");
  const [sub, setSub] = useState("motors");   // remote splits in two screens: drive pad / arm
  const [padName, setPadName] = useState(null);
  const bodyRef = useRef(null);
  const innerRef = useRef(null);
  const [verb, setVerb] = useState(null);
  const armed = mode === "remote" && enabled;
  const armedRef = useRef(armed);
  armedRef.current = armed;
  const heldRef = useRef(null);
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

  useEffect(() => {
    const typing = (e) => { const t = e.target; return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable); };
    const down = (e) => {
      if (!armedRef.current || typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === " ") { e.preventDefault(); keysRef.current.clear(); heldRef.current = null; onCmd("stop"); return; }
      if (!KEYMAP[k]) return;
      e.preventDefault();
      keysRef.current.add(k);
      heldRef.current = KEYMAP[k];
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

  const MANUAL_PWM = 110;
  const TURBO_PWM = 200;
  const SPIN_SCALE = 0.45;

  const DEADZONE = 0.15;
  const MIN_PWM = 55;
  useEffect(() => {
    const dz = (v) => (Math.abs(v) < DEADZONE ? 0 : (v - Math.sign(v) * DEADZONE) / (1 - DEADZONE));
    const duty = (v, cap) => (Math.abs(v) < 0.02 ? 0
      : Math.round(Math.sign(v) * (MIN_PWM + (cap - MIN_PWM) * Math.min(1, Math.abs(v)))));
    const verbOf = (l, r) => (!l && !r ? null
      : Math.abs(l - r) > Math.abs(l + r) ? (l > r ? "left" : "right") : l + r > 0 ? "fwd" : "back");
    const id = setInterval(() => {
      if (!armedRef.current || tourOpen || cursorOn()) { if (moving.current) { moving.current = false; setVerb(null); onCmd("stop"); } return; }
      const pad = [...navigator.getGamepads()].find(Boolean);

      const turbo = !!pad && (pad.buttons[7]?.pressed || (pad.buttons[7]?.value ?? 0) > 0.35);
      const cap = turbo ? TURBO_PWM : MANUAL_PWM;
      let l = 0, r = 0;
      if (pad) {
        const sq = !!pad.buttons[2]?.pressed;
        if (sq && !sqWas.current) analyzeRef.current?.();
        sqWas.current = sq;
        const y = -dz(pad.axes[1] ?? 0), x = dz(pad.axes[0] ?? 0);
        l = y - x; r = y + x;
        const rx = dz(pad.axes[2] ?? 0);
        l -= rx * SPIN_SCALE; r += rx * SPIN_SCALE;
      }
      if (!l && !r && heldRef.current) [l, r] = VERB_MIX[heldRef.current];

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

  const pick = (m) => {
    if (m === mode) return;
    if (mode === "remote") { heldRef.current = null; moving.current = false; setVerb(null); onCmd("stop"); }
    setMode(m);
  };

  useLayoutEffect(() => {
    const el = bodyRef.current, inner = innerRef.current;
    if (!el || !inner || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let prev = inner.offsetHeight, anim = null;
    const ro = new ResizeObserver(() => {
      const h = inner.offsetHeight;
      if (h === prev) return;

      const from = anim?.playState === "running" ? el.offsetHeight : prev;
      prev = h;
      anim?.cancel();
      el.style.overflow = "hidden";
      anim = el.animate([{ height: from + "px" }, { height: h + "px" }],
        { duration: 340, easing: "cubic-bezier(0.32, 0.72, 0, 1)" });
      anim.finished.then(() => { el.style.overflow = ""; }, () => {});
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
          ${sub === "motors" ? html`
            <div class=${"pad" + (armed ? "" : " is-off")}>
              <span></span>${padBtn("fwd", "▲", "W")}<span></span>
              ${padBtn("left", "◀", "A")}${padBtn("back", "▼", "S")}${padBtn("right", "▶", "D")}
            </div>
            <small class="drive-hint">${hint}</small>`
          : html`<${Arm} onCmd=${onCmd} enabled=${armed} />`}
          <div class="conn-seg sub-seg" data-sub=${sub} role="tablist">
            <span class="conn-seg-thumb"></span>
            ${[["motors", "MOTORS"], ["arm", "ARM"]].map(([m, label]) => html`
              <button type="button" key=${m} role="tab" aria-selected=${sub === m}
                class=${sub === m ? "is-active" : ""}
                onClick=${() => { if (m !== sub) { if (sub === "arm") onCmd("arm,"); setSub(m); } }}>${label}</button>`)}
          </div>`
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
       </div>
      </div>
    </section>`;
}

// ---- camera ----
const CAM_PICKS = [
  ["wb_mode", [[0, "auto"], [1, "sunny"], [2, "cloudy"], [3, "office"], [4, "home"]]],
  ["framesize", [[8, "SVGA 800×600"], [6, "VGA 640×480"], [5, "CIF 400×296"], [4, "QVGA 320×240"]]],
];

const STALL_MS = 5000;

const DET_MS = 100;
const DET_MIN_SCORE = 0.5;

function CamView() {
  const [state, setState] = useState("loading");
  const [nonce, setNonce] = useState(0);
  const [yielded, setYielded] = useState(false);
  const [host, setHost] = useState(camHost());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [detect, setDetect] = useState(() => localStorage.getItem("camDetect") === "1");
  const [detState, setDetState] = useState("off");

  const [sliders, setSliders] = useState({ brightness: -1, contrast: -1, saturation: 0, ae_level: 0, led: 15 });
  const [picks, setPicks] = useState({ wb_mode: 0, framesize: 8 });
  const imgRef = useRef(null);
  const boxRef = useRef(null);

  useEffect(() => {
    const y = () => { imgRef.current?.removeAttribute("src"); setYielded(true); };

    const r = () => { setYielded(false); setState("loading"); setNonce(n => n + 1); };
    window.addEventListener("cam:yield", y);
    window.addEventListener("cam:resume", r);
    return () => { window.removeEventListener("cam:yield", y); window.removeEventListener("cam:resume", r); };
  }, []);

  const fail = useCallback(() => setState("offline"), []);
  const lastFrame = useRef(0);

  useEffect(() => {
    if (yielded) return;
    const img = imgRef.current;
    if (!img) return;
    const ctl = new AbortController();

    lastFrame.current = Date.now();
    let alive = true, shown = null, first = true;
    const paint = (bytes) => {
      const url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
      img.src = url;
      if (shown) URL.revokeObjectURL(shown);
      shown = url;
      lastFrame.current = Date.now();
      if (first) {
        first = false;
        setState("live");
        localStorage.setItem("camHost", host);
        forceAwbRef.current();
      }
    };
    (async () => {
      try {
        const res = await fetch(camUrl(host), { signal: ctl.signal, cache: "no-store" });
        if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
        const reader = res.body.getReader();
        let buf = new Uint8Array(0);
        while (alive) {
          const { done, value } = await reader.read();
          if (done) break;
          const next = new Uint8Array(buf.length + value.length);
          next.set(buf); next.set(value, buf.length);
          buf = next;
          const cut = mjpegSplit(buf);
          for (const f of cut.frames) paint(f);
          buf = cut.rest;
        }
        if (alive) throw new Error("stream ended");
      } catch (err) {
        if (alive && err.name !== "AbortError") setState("offline");
      }
    })();
    return () => { alive = false; ctl.abort(); if (shown) URL.revokeObjectURL(shown); };
  }, [yielded, nonce, host]);

  useEffect(() => {
    if (!detect || yielded || state !== "live") { setDetState("off"); return; }
    let alive = true, model = null, busy = false;
    setDetState("loading");
    loadDetector().then((m) => { if (alive) { model = m; setDetState("on"); } })
      .catch(() => { if (alive) setDetState("failed"); });
    const id = setInterval(async () => {
      const img = imgRef.current, cv = boxRef.current;
      if (!model || busy || !img || !cv || !img.naturalWidth) return;
      busy = true;
      try {
        const boxes = await detectUpright(model, img, 20, DET_MIN_SCORE);
        if (!alive) return;
        if (cv.width !== img.naturalWidth) { cv.width = img.naturalWidth; cv.height = img.naturalHeight; }
        drawBoxes(cv.getContext("2d"), boxes, cv.width, cv.height);
      } catch {  }
      finally { busy = false; }
    }, DET_MS);
    return () => { alive = false; clearInterval(id); };
  }, [detect, yielded, state]);

  useEffect(() => {
    if (yielded || state !== "live") return;
    const id = setInterval(() => {
      if (Date.now() - lastFrame.current > STALL_MS) setNonce(n => n + 1);
    }, 1000);
    return () => clearInterval(id);
  }, [state, yielded]);

  useEffect(() => {
    if (yielded || state !== "loading") return;
    const id = setTimeout(fail, 12000);
    return () => clearTimeout(id);
  }, [state, yielded, nonce, host, fail]);

  useEffect(() => {
    if (yielded || state !== "offline") return;
    const id = setTimeout(() => { setState("loading"); setNonce(n => n + 1); }, 5000);
    return () => clearTimeout(id);
  }, [state, yielded]);

  const base = camUrl(host);

  const applyHost = (v) => {
    const h = v.trim() || CAM_HOST_DEFAULT;
    localStorage.setItem("camHost", h);
    setHost(h); setState("loading"); setNonce(n => n + 1);
  };

  const ctrl = (varName, val) => {
    setSliders(p => ({ ...p, [varName]: val }));
    fetch(`http://${host}/control?var=${varName}&val=${val}`).catch(() => {});

    if (varName === "led") fetch("/api/led", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: val }) }).catch(() => {});
  };

  const forceAwb = () => {
    for (const [k, v] of [["whitebal", 1], ["awb_gain", 1], ["wb_mode", picks.wb_mode]])
      fetch(`http://${host}/control?var=${k}&val=${v}`).catch(() => {});
  };

  const forceAwbRef = useRef(forceAwb);
  forceAwbRef.current = forceAwb;

  const pick = (varName, val) => {
    setPicks(p => ({ ...p, [varName]: val }));
    fetch(`http://${host}/control?var=${varName}&val=${val}`)
      .then(() => { if (varName === "framesize") forceAwb(); })
      .catch(() => {});
  };

  return html`
    <div class="stage-view stage-view--cam">
      ${yielded
        ? html`<div class="viewport-fallback">${t("cam.scanning")}</div>`
        : state !== "offline"

        ? html`<${React.Fragment}>
            <img ref=${imgRef} alt="" class="cam-feed" />
            ${detect ? html`<canvas ref=${boxRef} class="cam-feed cam-boxes" aria-hidden="true" />` : null}
          <//>`
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
          <button type="button" class=${"hud-btn" + (detect ? " is-active" : "")} aria-pressed=${detect}
            onClick=${() => { const v = !detect; setDetect(v); localStorage.setItem("camDetect", v ? "1" : "0"); }}>
            ${t("cam.detect")}${detect && detState !== "on" ? " · " + t("cam.detect." + detState) : ""}</button>
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

// ---- fpv ----
const FPV_ZOOMS = [
  { id: "fill", label: "FILL" },
  { id: "fit", label: "FIT", z: 1 },
  { id: "z125", label: "125%", z: 1.25 },
  { id: "z160", label: "160%", z: 1.6 },
];

function FpvOverlay({ packet }) {
  const roll = packet?.roll ?? 0;
  const pitch = packet?.pitch ?? 0;
  const dist = packet?.dist;

  const near = dist != null && !isNaN(dist) && dist > 0 && dist < 30;

  return html`
    <div class="fpv-glass" aria-hidden="true">
      <div class="fpv-brackets"><i></i><i></i><i></i><i></i></div>

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

const FPV_STATS = [
  { k: "sensor.dist",  u: "cm",  v: p => fmt(p?.dist, 0) },
  { k: "sensor.temp",  u: "°C",  v: p => fmt(p?.temp, 0) },
  { k: "sensor.humid", u: "%",   v: p => fmt(p?.humid, 0) },
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

// ---- replay ----
const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String((s / 60) | 0).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

function at(list, t) {
  let hit = list[0];
  for (const x of list) { if (x.t > t) break; hit = x; }
  return hit;
}

function before(list, t) {
  let hit = null;
  for (const x of list) { if (x.t > t) break; hit = x; }
  return hit;
}

const EVENT_META = {
  finding:  { label: "FINDING DETECTED", glyph: "◆", cls: "k-find" },
  analysis: { label: "ANALYSIS",         glyph: "◎", cls: "k-analysis" },
  sage:     { label: "SAGE",             glyph: "◈", cls: "k-sage" },
  blk:      { label: "BLK DECISION",     glyph: "▣", cls: "k-blk" },
  camlost:  { label: "CAMERA DEAD",      glyph: "◉", cls: "k-dead" },
  camback:  { label: "CAMERA BACK",      glyph: "◉", cls: "k-back" },
};
const SAID = ["sage", "analysis", "finding"];
const BANNER_MS = 4000;

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
  const now = before(events, t);
  const banner = now && t - now.t < BANNER_MS ? now : null;
  const said = before(events.filter(e => SAID.includes(e.kind)), t);
  const dead = before(events.filter(e => e.kind === "camlost" || e.kind === "camback"), t)?.kind === "camlost";

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

// ---- judge view ----
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

function JudgeView({ packet, connected, ai }) {
  const v = assess(packet);
  return html`
    <main class="judge" id="sensors">
      <div class="judge-head">
        <span class=${"judge-verdict is-" + v.kind}>${v.label}</span>
        <span class="judge-cause">${v.cause}</span>
        <span class=${"pill " + (connected ? "is-go" : "is-abort")}>
          ${connected ? t("mast.linkLive") : t("mast.noSignal")}</span>
      </div>
      <div class="judge-body">
        <div class="judge-cam"><${CamView} /></div>
        <div class="judge-grid">
          ${SENSORS.map(s => {
            const val = packet?.[s.key], on = reads(s, val);
            return html`
              <div key=${s.key} class=${"judge-cell" + (on ? "" : " is-dead")}>
                <span class="judge-key">${t("sensor." + s.key)}</span>
                <span class="judge-val">${on ? fmt(val, s.d) : t("st.noRead")}
                  ${on && html`<i>${s.unit}</i>`}</span>
              </div>`;
          })}
        </div>
      </div>
      ${""}
      ${ai.text && ai.text !== t("ai.awaiting") && html`<p class="judge-say">${ai.text}</p>`}
    </main>`;
}

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

// ---- verdict + mood ----
const INTENTS = {
  idle:     { key: "idle",     label: "intent.idle",     color: "var(--ink-3)" },
  scanning: { key: "scanning", label: "intent.scanning", color: "var(--ink-2)" },
  thinking: { key: "thinking", label: "intent.thinking", color: "var(--ink)"   },
  clear:    { key: "clear",    label: "intent.clear",    color: "var(--go)"     },
  caution:  { key: "caution",  label: "intent.caution",  color: "var(--warn)"   },
  alert:    { key: "alert",    label: "intent.alert",    color: "var(--accent)" },
};

function worstSensor(packet) {
  if (!packet) return null;
  let rank = -1;
  for (const s of SENSORS) {
    const v = packet[s.key];
    if (!reads(s, v)) continue;
    const k = s.st(v)[1];
    rank = Math.max(rank, k === "abort" ? 2 : k === "warn" ? 1 : 0);
  }
  return rank < 0 ? null : rank;
}

function assess(packet) {
  const rank = worstSensor(packet);
  if (rank == null) return { kind: "idle", label: t("verdict.awaiting"), cause: t("verdict.noTelemetry") };
  let cause = t("verdict.nominal");
  if (rank > 0) {
    for (const s of SENSORS) {
      const v = packet[s.key];
      if (!reads(s, v)) continue;
      const [lblKey, k] = s.st(v);
      if ((k === "abort" ? 2 : k === "warn" ? 1 : 0) === rank) { cause = `${t("sensor." + s.key)} · ${t(lblKey)}`; break; }
    }
  }
  if (rank === 2) return { kind: "abort", label: t("verdict.danger"), cause };
  if (rank === 1) return { kind: "warn",  label: t("verdict.caution"), cause };
  return { kind: "go", label: t("verdict.safe"), cause };
}

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

function Stopwatch({ since }) {
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick(n => n + 1), 90); return () => clearInterval(id); }, [since]);
  return html`${((Date.now() - since) / 1000).toFixed(1)}s`;
}

// ---- agent feed ----
const TOOLS = {
  camera:   { icon: "camera", label: "tool.camera",  of: "tool.lookAt" },
  sensors:  { icon: "timer",  label: "tool.sensors",  of: "tool.readingsOf" },
  snapshot: { icon: "step",   label: "tool.snapshot" },
  finding:  { icon: "warn",   label: "tool.finding" },
  lamp:     { icon: "gear",   label: "tool.lamp" },
  ask:      { icon: "mic",    label: "tool.ask" },
  analysis: { icon: "camera", label: "tool.analysis" },
};

function MoveCard({ e, onMove }) {
  const st = e.state || "pending";
  return html`<div class=${"fl fl-move is-" + st}>
    <span class="fl-mark">◆</span>
    <div class="fl-body">
      <p class="fl-t">${t("move.asks")}</p>
      <pre class="fl-code">${e.text}</pre>
      <p class="fl-detail">└ ${typeof e.board === "number" ? t("move.onBoard", { n: e.board }) : t("move.inBrowser", { why: e.board || "?" })}</p>
      ${e.guarded ? html`<p class="fl-detail fl-guard"><${Icon} n="warn" /> ${t("move.guarded", { n: e.guarded, cm: GUARD_CM })}</p>` : null}
      ${st === "pending" ? html`<div class="fl-btns">
        <button type="button" class="term-chip is-go" onClick=${() => onMove(e, true)}>▶ ${t("move.yes")}</button>
        <button type="button" class="term-chip" onClick=${() => onMove(e, false)}>${t("move.no")}</button>
      </div>` : html`<p class=${"fl-detail fl-st is-" + st}>└ ${t("move.st." + st)}${e.note ? ` · ${e.note}` : ""}</p>`}
    </div></div>`;
}

function FeedLine({ e, onMove }) {
  if (e.kind === "move") return html`<${MoveCard} e=${e} onMove=${onMove} />`;
  if (e.kind === "tool") {
    const spec = TOOLS[e.name] || { icon: "gear", label: "tool.unknown" };

    const what = e.arg ? t(spec.of || "tool.of", { what: e.arg }) : t(spec.label);
    return html`<div class="fl fl-tool">
      <span class="fl-mark">◆</span>
      <div class="fl-body">
        <p class="fl-t">${t("tool.used")} <b><${Icon} n=${spec.icon} /> ${what}</b></p>
        ${e.detail ? html`<p class="fl-detail">└ ${e.detail}</p>` : null}
        ${e.img ? html`<img class="fl-shot" src=${e.img} alt=${what} loading="lazy" />` : null}
      </div></div>`;
  }
  if (e.kind === "user") return html`<div class="fl fl-user">
    <span class="fl-mark">›</span>
    <div class="fl-body"><p class="fl-t">${e.text}</p></div></div>`;
  if (e.kind === "note") return html`<div class="fl fl-note">
    <span class="fl-mark">·</span>
    <div class="fl-body"><p class="fl-t">${e.text}</p></div></div>`;
  return html`<div class=${"fl fl-sage" + (e.status ? " sage-" + e.status : "")}>
    <span class="fl-mark">●</span>
    <div class="fl-body">
      <p class="fl-t">${e.text}</p>
      ${e.timing ? html`<p class="fl-detail">${e.timing}</p>` : null}
    </div></div>`;
}

function Feed({ feed, ai, onAsk, onMove }) {
  const ref = useRef(null);
  useEffect(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }, [feed.length, ai.analyzing, ai.text]);
  return html`
    <div class="term-feed" ref=${ref} role="log" aria-live="polite">
      ${feed.length === 0 ? html`
        <div class="term-hint">
          <p class="term-hint-t">${t("term.hint")}</p>
          ${ASK_SUGGESTIONS.slice(0, 3).map(q => html`<button key=${q} type="button" class="term-chip"
            onClick=${() => onAsk(t(q))}>${t(q)}</button>`)}
        </div>` : feed.map(e => html`<${FeedLine} key=${e.id} e=${e} onMove=${onMove} />`)}
      ${ai.analyzing ? html`<div class="fl fl-work">
        <span class="fl-mark">◐</span>
        <div class="fl-body"><p class="fl-t">${t(ai.phase === "speaking" ? "timing.synth" : "timing.thinking")}${" "}
          <b><${Stopwatch} since=${ai.since || Date.now()} /></b></p></div>
      </div>` : null}
    </div>`;
}

function Agent({ ai, tts, ttsProv, hasDeepgram, packet, connected, speaking, chats, activeChat, feed, onNewChat, onSelectChat, onDeleteChat, onBrief, onSpeak, onAnalyze, onToggleTts, onToggleTtsProvider, onMock, onAsk, onReport, onMove }) {
  const intent = deriveIntent(ai, packet, connected);
  const v = assess(packet);
  const briefed = activeChat && activeChat.mission;
  const [draft, setDraft] = useState("");
  const send = (e) => {
    e.preventDefault();
    const txt = draft.trim();
    if (!txt || ai.analyzing) return;
    setDraft("");
    onAsk(txt);
  };
  return html`
    <section class=${"zone agent reveal is-" + intent.key + (ai.analyzing ? " is-analyzing" : "") + (speaking ? " is-speaking" : "")}
      style=${{ "--agent-c": intent.color }} aria-labelledby="agent-h">
      <${Head} title=${t("zone.agent")} tag=${t(ai.badge)} />
      <div class="agent-body">
        ${!activeChat
          ? html`<${ChatSelect} chats=${chats} onNew=${onNewChat} onSelect=${onSelectChat} onDelete=${onDeleteChat} />`
          : !briefed
          ? html`<${Briefing} onBrief=${onBrief} onBack=${() => onSelectChat("")} onSpeak=${onSpeak} busy=${ai.analyzing} />`
          : html`<div class="term">
        <div class="term-bar">
          <button type="button" class="term-back" onClick=${() => onSelectChat("")} title=${t("brief.sessions")}>←</button>
          <b class="term-who">SAGE</b>
          <span class="term-state">${t(intent.label)}</span>
          <span class=${"term-verdict is-" + v.kind} title=${v.cause}>${v.label}</span>
          <select class="agent-voice-sel" title=${t("agent.voiceTitle")} aria-label=${t("agent.voiceTitle")}
            value=${!tts ? "off" : (hasDeepgram && ttsProv === "deepgram" ? "deepgram" : "edge")}
            onChange=${e => {
              const val = e.target.value;
              if (val === "off") { if (tts) onToggleTts(); return; }
              if (!tts) onToggleTts();
              if (hasDeepgram && val !== ttsProv) onToggleTtsProvider();
            }}>
            <option value="off">${t("agent.voiceOff")}</option>
            <option value="edge">${t("agent.voiceEdge")}</option>
            ${hasDeepgram ? html`<option value="deepgram">${t("agent.voiceDg")}</option>` : null}
          </select>
        </div>
        ${""}
        <div class=${"term-hero" + (speaking ? " is-speaking" : "")}><${SageFace} mood=${intent.key} /></div>
        <${Feed} feed=${feed} ai=${ai} onAsk=${onAsk} onMove=${onMove} />
        <form class="agent-foot term-prompt" onSubmit=${send}>
          <input class="term-input" type="text" value=${draft} placeholder=${t("term.ph")}
            aria-label=${t("term.ph")} disabled=${ai.analyzing}
            onInput=${e => setDraft(e.target.value)} />
          <${Ask} onAsk=${onAsk} busy=${ai.analyzing} />
          ${""}
          <details class="foot-menu" onBlur=${e => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.open = false; }}>
            <summary class="btn foot-icon" title=${t("agent.more")} aria-label=${t("agent.more")}>⋯</summary>
            <div class="foot-menu-pop" onClick=${e => { e.currentTarget.closest("details").open = false; }}>
              <span class="menu-label">${t("agent.actions")}</span>
              <button class="menu-item is-lead" type="button" onClick=${() => onAnalyze()} disabled=${ai.analyzing}>
                <${Icon} n="camera" /> ${ai.analyzing ? t("agent.analyzing") : t("agent.runAnalysis")}
              </button>
              <button class="menu-item" type="button" onClick=${onMock} disabled=${ai.analyzing} title=${t("agent.mockTitle")}>
                ${t("agent.mock")}
              </button>
              <button class="menu-item" type="button" onClick=${onReport} title=${t("agent.reportTitle")}>
                ${t("agent.report")}
              </button>
              <hr class="menu-sep" />
              <span class="menu-label">${t("ask.pick")}</span>
              ${ASK_SUGGESTIONS.map(q => html`<button key=${q} class="menu-item" type="button"
                onClick=${() => onAsk(t(q))} disabled=${ai.analyzing}>${t(q)}</button>`)}
            </div>
          </details>
        </form>
      </div>`}
      </div>
    </section>`;
}

// ---- session report ----
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
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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

// ---- mic ----
const canMic = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
const MIC_MAX_MS = 15000;

const SIL_MS = 2000, SIL_RMS = 0.02;

function useMic(onText) {
  const [listening, setListening] = useState(false);
  const recRef = useRef(null);
  const toggle = useCallback(async () => {
    if (recRef.current) { recRef.current.stop(); return; }
    stopSpeech();
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { console.warn("[mic]", e.name, e.message); return; }
    const rec = new MediaRecorder(stream);
    const parts = [];
    let stopWatch = () => {};
    rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    rec.onstop = async () => {
      stopWatch();
      stream.getTracks().forEach((tr) => tr.stop());
      recRef.current = null; setListening(false);
      const blob = new Blob(parts, { type: rec.mimeType });
      if (blob.size < 2000) return;
      try {
        const r = await fetch(`/api/stt?lang=${speechLang()}`, {
          method: "POST", headers: { "Content-Type": blob.type }, body: blob,
        });
        const j = await r.json().catch(() => ({}));
        if (j.text) onText(j.text); else console.warn("[mic]", j.error || "no speech");
      } catch (e) { console.warn("[mic]", e.message); }
    };

    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const an = ac.createAnalyser(); an.fftSize = 512;
    ac.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    let loudAt = Date.now();
    const tick = setInterval(() => {
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) { const d = (v - 128) / 128; sum += d * d; }
      if (Math.sqrt(sum / buf.length) > SIL_RMS) loudAt = Date.now();
      if (Date.now() - loudAt > SIL_MS && rec.state === "recording") rec.stop();
    }, 100);
    stopWatch = () => { clearInterval(tick); ac.close().catch(() => {}); };

    recRef.current = rec; setListening(true); rec.start();
    setTimeout(() => { if (rec.state === "recording") rec.stop(); }, MIC_MAX_MS);
  }, [onText]);
  return { listening, toggle, supported: canMic };
}

// ---- briefing ----
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

  useEffect(() => {
    if (review) {
      onSpeak?.([{ clip: "rundown", text: ONBOARDING[getLang()].rundown }]);
      return;
    }
    const s = BRIEF_STEPS[step];
    const q = { clip: s.clip, text: t(s.q) };
    onSpeak?.(step === 0 ? [{ clip: "intro", text: ONBOARDING[getLang()].intro }, q] : [q]);
  }, [step]);

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

const ASK_SUGGESTIONS = ["ask.s0", "ask.s1", "ask.s2", "ask.s3", "ask.s4"];
function Ask({ onAsk, busy }) {
  const mic = useMic(onAsk);
  if (!mic.supported) return null;
  return html`<button type="button" class=${"btn foot-icon ask-mic" + (mic.listening ? " is-live" : "")} onClick=${mic.toggle}
    disabled=${busy} aria-pressed=${mic.listening} title=${t("ask.mic")} aria-label=${t("ask.mic")}>
    ${mic.listening ? "●" : html`<${Icon} n="mic" />`}</button>`;
}

// ---- logs ----
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

function SerialMonitor({ lines, onClear }) {
  const [paused, setPaused] = useState(false);
  const streamRef = useRef(null);

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

// ---- topbar + drawer ----
function Topbar({ connected, stale, bridge, onBridge, ping, packets, uptime, lanUrl, lanIp, lang, onLang, onConsole, consoleOpen, clients, onDevices, granted, cloud, onSettings }) {
  return html`
    <header class="topbar">
      <div class="brand">
        ${""}
        <img src="brand.svg" alt="" width="24" height="24" />
      </div>
      <p class="lamp visually-hidden" role="status" aria-live="polite">
        ${connected ? t("mast.linkLive") : t("mast.noSignal")}
      </p>
      ${VIEWER ? html`<span class=${"pill top-mirror" + (granted ? " is-go" : "")}>
        ◉ ${t(granted ? "mast.control" : "mast.mirror")}</span>` : html`
      <div class="top-conn">
        <div class="bridge-ctl">
          ${""}
          <button type="button" class=${"bridge-btn " + (bridge.running ? (stale ? "is-stale" : "is-on") : "")}
            disabled=${bridge.busy} onClick=${() => onBridge("toggle")}>
            <span class=${"lamp-dot " + (bridge.running && !stale ? "is-go" : "is-abort")}></span>
            ${bridge.busy ? t("mast.bridgeBusy") : !bridge.running ? t("mast.connect")
              : stale ? t("mast.stale") : t("mast.linked")}
          </button>
          <button type="button" class="bridge-repair" title=${t("mast.bridgeRepairTitle")}
            disabled=${bridge.busy} onClick=${() => onBridge("reconnect")}>⟳</button>
        </div>
      </div>`}
      ${""}
      ${cloud && html`<span class="top-cloud">
        <span class=${"pill " + (cloud.sage ? "is-go" : "is-abort")} title=${t("cloud.title")}>${t("cloud.sage")}</span>
        <span class=${"pill " + (cloud.tts ? "is-go" : "is-abort")} title=${t("cloud.title")}>${t("cloud.tts")}</span>
      </span>`}
      <div class="top-stats">
        <dl class="stat"><dt>${t("mast.ping")}</dt><dd>${ping}</dd></dl>
        <dl class="stat"><dt>${t("mast.packets")}</dt><dd>${packets}</dd></dl>
        <dl class="stat"><dt>${t("mast.uptime")}</dt><dd>${uptime}</dd></dl>
        ${lanUrl && html`
          <dl class="stat stat-lan"><dt>${t("mast.tablet")}</dt>
            <dd><button type="button" class="lan-btn" title=${lanIp ? `${t("mast.tabletTitle")} — ${lanIp}` : t("mast.tabletTitle")}
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

const SAVERS = ["saverOff", "matrix", "saverBounce", "saverStars", "saverTetris"];

function Drawer({ open, tab, onTab, onClose, logs, serialLines, onClearSerial, chat, onCmd, enabled, onTutorial, saver, onSaver, moves, onMoves, buzz, onBuzz }) {
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
        ${""}
        <button type="button" class=${"serial-btn drawer-moves" + (moves ? " is-on" : "")}
          aria-pressed=${!!moves} onClick=${onMoves} title=${t("drawer.movesTitle")}>
          ${t("drawer.moves")}: ${t(moves ? "drawer.on" : "drawer.off")}
        </button>
        ${""}
        <button type="button" class=${"serial-btn drawer-buzz" + (buzz ? " is-on" : "")}
          aria-pressed=${!!buzz} onClick=${onBuzz} title=${t("drawer.buzzTitle")}>
          ${t("drawer.buzz")}: ${t(buzz ? "drawer.on" : "drawer.off")}
        </button>
        ${""}
        <select class="serial-btn drawer-saver" disabled=${!enabled} value=${saver}
          onChange=${(e) => onSaver(Number(e.target.value))} title=${t("drawer.saverTitle")}
          aria-label=${t("drawer.saver")}>
          ${SAVERS.map((k, i) => html`<option key=${k} value=${i}>${i ? "▚ " : ""}${t("drawer." + k)}</option>`)}
        </select>
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

function appendLog(log, chunk) {
  return chunk.split(/(\r\n|\n|\r)/).reduce((acc, tok) => {
    if (tok === "\r") return acc.slice(0, acc.lastIndexOf("\n") + 1);
    if (tok === "\r\n") return acc + "\n";
    return acc + tok;
  }, log);
}

// ---- firmware update ----
const roverModel = (b) => b.giga ? "Blackout V3" : b.unor4 ? "Blackout V2" : "Blackout";
const anyBoard = (b) => !!(b.giga || b.unor4 || b.esp32cam);

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

const FLASH_TICKS_PER_BOARD = 2;
function flashProgress(log, boards, phase) {
  const heads = [...log.matchAll(/^▸ (.+?) @ /gm)].map(m => m[1]);
  const ticks = (log.match(/✔/g) || []).length;
  const planned = ["giga", "unor4", "esp32cam"].filter(k => boards[k]).length;
  const total = Math.max(planned, heads.length, 1) * FLASH_TICKS_PER_BOARD;
  const board = heads[heads.length - 1] || null;
  const step = !board ? "prep" : ticks % 2 === 0 ? "compile" : "upload";

  return { pct: phase === "done" ? 100 : Math.min(99, Math.round((ticks / total) * 100)), board, step };
}

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

function UpdateModal({ open, phase, boards, log, code, onFlash, onClose }) {
  const logRef = useRef(null);
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [log]);
  const locked = phase === "flashing";
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

// ---- modals ----
function Toasts({ items }) {
  return html`<div class="toasts">${items.map(t => html`<div key=${t.id} class=${"toast k-" + t.kind + (t.leaving ? " is-leaving" : "")}>${t.msg}</div>`)}</div>`;
}

const DEV_MODES = [["mirror", "devices.view"], ["judge", "devices.judge"], ["full", "devices.full"]];

function DevicesModal({ open, clients, selfId, onMode, onClose }) {
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
                : html`<select class=${"serial-btn device-mode" + (c.granted ? " is-on" : "")}
                    value=${c.mode || "mirror"} aria-label=${t("devices.modeLabel")}
                    onChange=${(e) => {
                      const m = e.target.value;

                      if (m === "full") { e.target.value = c.mode || "mirror"; setAsk({ c }); }
                      else onMode(c.id, m);
                    }}>
                    ${DEV_MODES.map(([v, k]) => html`<option key=${v} value=${v}>${t(k)}</option>`)}
                  </select>`}
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
                onClick=${() => { onMode(ask.c.id, "full"); closeAsk(); }}>
                ${t("devices.confirmGo")}<span class=${"warn-count" + (count > 0 ? "" : " is-done")}> (${count || 1})</span>
              </button>
            </div>
          </div>
        </div>`}
    </div>`;
}

function SettingsModal({ open, onClose }) {
  const [values, setValues] = useState({ GEMINI_API_KEY: "", GEMINI_MODEL: "", CEREBRAS_API_KEY: "", DEEPGRAM_API_KEY: "", CEREBRAS_MODEL: "", TTS_VOICE: "" });
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
          ${field("GEMINI_API_KEY", t("settings.geminiKey"), t("settings.unset"), "password")}
          ${field("GEMINI_MODEL", t("settings.geminiModel"), "gemini-3.6-flash")}
          ${field("CEREBRAS_API_KEY", t("settings.cerebrasKey"), t("settings.optional"), "password")}
          ${field("CEREBRAS_MODEL", t("settings.cerebrasModel"), "gemma-4-31b")}
          ${field("DEEPGRAM_API_KEY", t("settings.deepgramKey"), t("settings.optional"), "password")}
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

function BlePickerModal({ open, devices, onPick, onCancel }) {
  const names = devices.map((d) => d.deviceName);
  const label = (d) => {
    const name = d.deviceName || t("ble.unnamed");
    const dup = !d.deviceName || names.filter((n) => n === d.deviceName).length > 1;
    return dup ? `${name} · ${d.deviceId.replace(/[^a-zA-Z0-9]/g, "").slice(-4).toUpperCase()}` : name;
  };

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

// ---- onboarding ----
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

function OnboardModel({ onBack, onPickModel }) {
  const [legacyOpen, setLegacyOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
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

// ---- tour ----
const TOUR = [
  [".brand", "brand"],
  [".bridge-ctl, .top-mirror", "link"],
  [".bridge-ctl", "pair", () => !!window.blackout],
  [".stage-3d", "stage"],
  [".stage-cam", "cam"],
  [".strip", "strip"],
  [".agent", "agent"],
  [".drive", "drive"],
  [".console-btn:last-of-type", "console"],
  [".topbar .console-btn", "mirrorShare"],
];

function Tour({ closing, onDone }) {
  const steps = useRef(TOUR.filter(([sel, , when]) => (!when || when()) && document.querySelector(sel))).current;
  const [i, setI] = useState(0);
  const [box, setBox] = useState(null);
  const step = steps[i];
  const last = i >= steps.length - 1;

  useLayoutEffect(() => {
    if (!step) { onDone(); return; }

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

// ---- app ----
function App() {
  const [connected, setConnected] = useState(false);
  const [packet, setPacket] = useState(null);
  const [fresh, setFresh] = useState(false);
  const lastPkt = useRef(0);
  const [ping, setPing] = useState("—");
  const [packets, setPackets] = useState(0);
  const [logs, setLogs] = useState([]);
  const [ai, setAi] = useState({ text: t("ai.awaiting"), badge: "badge.standby", analyzing: false, history: [], phase: null, since: 0, llm: null, tts: null, status: null });

  const analyzingRef = useRef(false);
  analyzingRef.current = ai.analyzing;
  const presentingRef = useRef(false);
  const [tts, setTts] = useState(() => localStorage.getItem("tts") !== "false");
  const [ttsProv, setTtsProv] = useState(() => localStorage.getItem("ttsProvider") || "edge");
  const [hasDeepgram, setHasDeepgram] = useState(false);
  const [lang, setLangState] = useState(getLang());
  const [bridge, setBridge] = useState({ running: false, busy: false });
  const [toasts, setToasts] = useState([]);
  const [uptime, setUptime] = useState("00:00:00");
  const [lanUrl, setLanUrl] = useState(null);
  const [lanIp, setLanIp] = useState(null);
  const [serialLines, setSerialLines] = useState([]);
  const [tour, setTour] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [drawerTab, setDrawerTab] = useState("logs");
  const [warn, setWarn] = useState(false);
  const [warnCount, setWarnCount] = useState(3);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [flashPhase, setFlashPhase] = useState("choose");
  const [flashBoards, setFlashBoards] = useState({ giga: false, esp32cam: false, unor4: false, status: "none" });
  const [flashLog, setFlashLog] = useState("");
  const [flashCode, setFlashCode] = useState(null);
  const [speaking, setSpeaking] = useState(false);
  const [fpv, setFpv] = useState(false);
  const [fpvZoom, setFpvZoom] = useState(0);
  const [rec, setRec] = useState(null);
  const [runs, setRuns] = useState(null);
  const [replay, setReplay] = useState(null);
  const [recErr, setRecErr] = useState(null);
  const [report, setReport] = useState(null);
  const [reportClosing, setReportClosing] = useState(false);
  const [clients, setClients] = useState([]);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [detect, setDetect] = useState(() => localStorage.getItem("camDetect") === "1");
  const [detState, setDetState] = useState("off");
  const [onboardStep, setOnboardStep] = useState(false);
  const [onboardModel, setOnboardModel] = useState(null);
  const [onboardClosing, setOnboardClosing] = useState(false);

  const [granted, setGranted] = useState(!VIEWER);

  const [judge, setJudge] = useState(false);
  const [cloud, setCloud] = useState(null);
  const grantedRef = useRef(!VIEWER);
  grantedRef.current = granted;
  const canDrive = granted && !!bridge.running;

  const [driveMounted, setDriveMounted] = useState(!VIEWER);
  useEffect(() => {
    if (granted) { setDriveMounted(true); return; }
    const id = setTimeout(() => setDriveMounted(false), 260);
    return () => clearTimeout(id);
  }, [granted]);

  const [chats, setChats] = useState(() => { try { return JSON.parse(localStorage.getItem("chats") || "[]"); } catch { return []; } });
  const [activeId, setActiveId] = useState(() => localStorage.getItem("activeChat") || "");
  const activeChat = chats.find(c => c.id === activeId) || null;
  const activeRef = useRef(null);
  useEffect(() => { activeRef.current = activeChat; }, [activeChat]);

  const pushFeed = useCallback((e) => {
    const chat = activeRef.current;
    if (!chat) return;
    const item = { id: Date.now() + Math.random(), time: new Date().toLocaleTimeString(), ...e };
    setChats(cs => cs.map(c => c.id === chat.id ? { ...c, feed: [...(c.feed || []), item].slice(-80) } : c));
  }, []);

  const patchFeed = useCallback((id, patch) => {
    const chat = activeRef.current;
    if (!chat) return;
    setChats(cs => cs.map(c => c.id === chat.id
      ? { ...c, feed: (c.feed || []).map(f => f.id === id ? { ...f, ...patch } : f) } : c));
  }, []);

  const [moves, setMoves] = useState(() => localStorage.getItem("sageMoves") !== "false");
  const movesRef = useRef(moves);
  movesRef.current = moves;
  const toggleMoves = useCallback(() => setMoves(m => { localStorage.setItem("sageMoves", String(!m)); return !m; }), []);
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
  const lastBands = useRef({});
  useEffect(() => { lastBands.current = {}; }, [activeId]);

  const packetRef = useRef(null);

  useEffect(() => {
    const id = setInterval(() => setFresh(Date.now() - lastPkt.current < PKT_STALE_MS), 1000);
    return () => clearInterval(id);
  }, []);
  const view = fresh ? packet : null;
  const live = connected && fresh;
  useEffect(() => { packetRef.current = view; }, [view]);

  const addLog = useCallback((text, type = "system") => {
    setLogs(p => [...p, { text, type, time: new Date().toLocaleTimeString(), id: Date.now() + Math.random() }].slice(-80));
  }, []);
  const toast = useCallback((msg, kind = "system") => {
    const id = Date.now() + Math.random();
    setToasts(p => [...p, { msg, kind, id }]);
    setTimeout(() => setToasts(p => p.map(t => t.id === id ? { ...t, leaving: true } : t)), 3600);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 3820);
  }, []);

  const speakTimed = useCallback((text) => {
    const t = Date.now();
    setAi(p => ({ ...p, phase: "speaking", since: t, tts: null }));
    speak(text, {
      onStart: () => { setSpeaking(true); setAi(p => ({ ...p, phase: null, tts: Date.now() - t })); },
      onEnd: () => setSpeaking(false),
    });
  }, []);

  // ---- socket ----
  useEffect(() => {
    const socket = window.io();
    socketRef.current = socket;

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
      socket.emit("set-language", getLang());
      socket.emit("set-mission", activeRef.current?.mission || "");
    });
    socket.on("disconnect", () => { setConnected(false); setFresh(false); setPing("—"); addLog(t("log.linkLost"), "danger"); });
    socket.on("clients", list => {
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
      if (me) setJudge(me.mode === "judge");
      if (me) setGranted(g => {
        if (me.granted !== g) addLog(t(me.granted ? "log.controlGranted" : "log.controlRevoked"), me.granted ? "system" : "warn");
        return me.granted;
      });
    });
    socket.on("sensor-data", d => {
      if (!d) return;
      const lat = d.timestamp ? Math.max(0, Date.now() - d.timestamp) : NaN;
      setPing(isNaN(lat) ? "—" : lat + " ms");
      lastPkt.current = Date.now(); setFresh(true);
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

    socket.on("sage-finding", d => {
      if (!d?.text) return;
      const chat = activeRef.current;
      if (!chat || !chat.mission) return;
      const entry = { id: d.id || Date.now() + Math.random(), text: d.text, kind: "find", img: d.img || null,
        time: new Date(d.timestamp || Date.now()).toLocaleTimeString() };
      setChats(cs => cs.map(c => c.id === chat.id
        ? { ...c, findings: [...(c.findings || []), entry].slice(-40) } : c));

      const snap = d.text.startsWith("SNAPSHOT:");
      pushFeed({ kind: "tool", name: snap ? "snapshot" : "finding", detail: d.text.replace(/^SNAPSHOT:\s*/, ""), img: d.img || null });
    });

    socket.on("sage-step", d => {
      if (!d?.name) return;
      if (d.say) pushFeed({ kind: "sage", text: d.say });
      pushFeed({ kind: "tool", name: d.name, arg: d.arg || null, detail: d.detail || "", img: d.img || null });
      addLog(t("log.tool", { name: d.name, detail: d.detail || "" }), "ai");
    });

    socket.on("lamp-auto", d => {
      addLog(`headlamp ${d.from} → ${d.led}${d.mean != null ? ` (view ${d.mean}/255)` : ""}`, "ai");
      pushFeed({ kind: "tool", name: "lamp", detail: `${d.from} → ${d.led}` });
    });

    socket.on("blk-decision", d => {
      if (!d?.question) return;
      addLog(`${d.kind === "find" ? "find" : "ask"} "${d.question}" → ${d.yes ? "YES" : "no"}${d.text ? " · " + d.text : ""}`, d.yes ? "ai" : "system");
      pushFeed({ kind: "tool", name: "ask", detail: `"${d.question}" → ${d.yes ? "yes" : "no"}` });
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

    const sayAgent = (text, ts, logMsg, logKind, status = null) => {
      addLog(logMsg, logKind);
      setAi(p => ({
        text, badge: "badge.online", analyzing: false, status,
        phase: null, since: 0, llm: p.since ? Date.now() - p.since : null, tts: null,
        history: [...p.history, { text, time: new Date(ts || Date.now()).toLocaleTimeString(), id: Date.now() + Math.random() }].slice(-20),
      }));
      pushFeed({ kind: "sage", text, status });
      if (ttsRef.current) speakTimed(text);
    };

    socket.on("ai-analysis", d => {
      if (!d) return;

      if (!activeRef.current?.mission) {
        setAi(p => ({ ...p, analyzing: false, phase: null, badge: "badge.standby" }));
        return;
      }
      if (d.analysis) sayAgent(d.analysis, d.timestamp, t("log.aiReceived"), "ai", d.status);
      else if (d.error) sayAgent(d.error, d.timestamp, t("log.aiReceived"), "warn", null);
    });
    socket.on("agent-blurt", d => { if (d?.text && activeRef.current?.mission) sayAgent(d.text, d.timestamp, t("log.blurt", { text: d.text }), "warn"); });

    socket.on("cam-yield", () => window.dispatchEvent(new Event("cam:yield")));
    socket.on("cam-resume", () => window.dispatchEvent(new Event("cam:resume")));
    socket.on("mission-ack", d => { if (d?.text) sayAgent(d.text, d.timestamp, t("log.missionAck"), "ai", d.status); });

    socket.on("cmd", w => { if (bleRef.current.device?.gatt?.connected) sendCmdRef.current?.(w); });
    addLog(t("log.booted"), "system");
    return () => socket.close();
  }, [addLog, speakTimed, pushFeed]);

  useEffect(() => {
    document.documentElement.lang = lang;
    const sk = document.querySelector(".skip-link");
    if (sk) sk.textContent = t("skip");
  }, [lang]);

  useEffect(() => { fetch("/api/lan").then(r => r.json()).then(d => { setLanUrl(d.host || d.url); setLanIp(d.url); }).catch(() => {}); }, []);

  useEffect(() => {
    const t0 = Date.now();
    const id = setInterval(() => {
      const e = Date.now() - t0, p = n => String(n).padStart(2, "0");
      setUptime(`${p(Math.floor(e / 3600000))}:${p(Math.floor(e / 60000) % 60)}:${p(Math.floor(e / 1000) % 60)}`);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // ---- ble ----
  // same uuids the sketch advertises
  const BLE_SERVICE = "19b10000-e8f2-537e-4f6c-d104768a1214";
  const BLE_CHAR = "19b10001-e8f2-537e-4f6c-d104768a1214";
  const BLE_CMD = "19b10002-e8f2-537e-4f6c-d104768a1214";
  const bleRef = useRef({ device: null, char: null, cmd: null });
  const bleWriteRef = useRef(Promise.resolve());

  const bleWrite = useCallback((fn) => {
    const w = bleWriteRef.current.then(fn);
    bleWriteRef.current = w.catch(() => {});
    return w;
  }, []);

  const analyze = useCallback((mode, focus) => {
    if (analyzingRef.current) return;
    analyzingRef.current = true;
    setAi(p => ({ ...p, analyzing: true, badge: "badge.analyzing", phase: "thinking", since: Date.now(), llm: null, tts: null }));
    socketRef.current?.emit("request-analysis", { mode: mode || null, prompt: focus || null });
  }, []);

  const onBleNotify = useCallback((e) => {
    const line = new TextDecoder().decode(e.target.value);
    console.log("BLE notify:", line);

    if (line.startsWith("E:analyze")) {
      addLog(t("log.routineAnalyze"), "ai");
      analyze(presentingRef.current ? "present" : null);
      presentingRef.current = false;
      return;
    }

    if (line.startsWith("E:blk")) { window.dispatchEvent(new CustomEvent("blk:evt", { detail: line })); return; }
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

  const sendCmd = useCallback(async (word) => {
    if (!grantedRef.current && word !== "stop") { toast(t("toast.mirrorOnly"), "warn"); return false; }
    if (word.startsWith("go,")) presentingRef.current = word === "go,presentation";
    const { device, cmd } = bleRef.current;

    if (!device?.gatt?.connected) {
      if (socketRef.current?.connected) { socketRef.current.emit("cmd", word); return true; }
      toast(t("toast.cmdNoLink"), "danger"); return false;
    }
    if (!cmd) { toast(t("toast.cmdNoChar"), "danger"); return false; }
    try {
      await bleWrite(() => cmd.writeValue(new TextEncoder().encode(word)));

      if (!word.startsWith("blk,i,")) addLog(t("log.cmdSent", { cmd: word }), "system");
      return true;
    } catch (e) { addLog(t("log.error", { msg: e.message }), "danger"); return false; }
  }, [addLog, toast, bleWrite]);

  const sendCmdRef = useRef(sendCmd);
  sendCmdRef.current = sendCmd;

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== " " || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(el.tagName) ||
        el.getAttribute?.("role") === "button")) return;
      e.preventDefault();
      blkCancel();
      sendCmdRef.current("stop");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    let live = true;
    const probe = () => fetch("/api/cloud").then(r => r.json())
      .then(d => { if (live) setCloud(d); }).catch(() => { if (live) setCloud({ sage: false, tts: false }); });
    probe();
    const id = setInterval(probe, 30000);
    return () => { live = false; clearInterval(id); };
  }, []);

  const [saver, setSaver] = useState(0);
  const pickSaver = useCallback(async (n) => {
    if (await sendCmd("scr," + n)) setSaver(n);
  }, [sendCmd]);

  useEffect(() => { if (!bridge.running) setSaver(0); }, [bridge.running]);

  const [buzz, setBuzz] = useState(() => localStorage.getItem("buzzer") !== "false");
  const toggleBuzz = useCallback(() => setBuzz(b => {
    localStorage.setItem("buzzer", String(!b));
    sendCmd("buz," + (!b ? 1 : 0));
    return !b;
  }), [sendCmd]);
  useEffect(() => { if (bridge.running) sendCmd("buz," + (buzz ? 1 : 0)); }, [bridge.running]);

  const loadBridge = useCallback(async () => {
    try { const r = await fetch("/api/bridge"); const d = await r.json();
      setBridge(b => ({ ...b, running: d.running })); } catch {  }
  }, []);
  useEffect(() => { loadBridge(); const id = setInterval(loadBridge, 5000); return () => clearInterval(id); }, [loadBridge]);

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
      setBlePicker(o => o || "open");
    });
    const offClosed = window.blackout.onBleClosed(closeBlePicker);
    return () => { offDevs(); offClosed(); };
  }, [closeBlePicker]);

  // bridge is the browser's own web-bluetooth link; electron hands us its picker instead
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
        if (window.blackout) setBlePicker("open");

        const device = await navigator.bluetooth.requestDevice({
          filters: [{ services: [BLE_SERVICE] }],
          optionalServices: [BLE_SERVICE],
        });
        const server = await device.gatt.connect();
        const service = await server.getPrimaryService(BLE_SERVICE);
        const char = await service.getCharacteristic(BLE_CHAR);
        const cmd = await service.getCharacteristic(BLE_CMD).catch(() => null);
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
    } catch (e) { setBridge(b => ({ ...b, busy: false })); addLog(t("log.error", { msg: e.message }), "danger"); if (window.blackout) closeBlePicker(); }
    loadBridge();
  }, [bridge.running, addLog, toast, loadBridge, disconnectBle, onBleNotify, closeBlePicker]);

  const mockData = useCallback(() => {
    setAi(p => ({ ...p, analyzing: true, badge: "badge.analyzing", phase: "thinking", since: Date.now(), llm: null, tts: null }));
    socketRef.current?.emit("mock-data");
  }, []);

  const showSage = useCallback((sage, t0, speak = true) => {
    const textv = (sage && sage.text) || "No response.";
    setAi(p => ({
      text: textv, status: (sage && sage.status) || null,
      badge: "badge.online", analyzing: false, phase: null, since: 0,
      llm: t0 ? Date.now() - t0 : p.llm, tts: null,
      history: [...p.history, { text: textv, time: new Date().toLocaleTimeString(), id: Date.now() + Math.random() }].slice(-20),
    }));
    pushFeed({ kind: "sage", text: textv, status: (sage && sage.status) || null,
      timing: t0 ? `LLM ${((Date.now() - t0) / 1000).toFixed(1)}s` : null });

    if (sage && sage.move && movesRef.current) {
      const { program, errors } = blkParse(sage.move);
      if (!errors.length && program.length) {
        const { program: safe, added } = blkGuard(program);
        let board;
        try { board = blkCompile(safe).code.length; } catch (e) { board = e.message; }
        pushFeed({ kind: "move", text: blkSerialize(safe), board, guarded: added, state: "pending" });
      }
    }
    if (speak && ttsRef.current) speakTimed(textv);
  }, [speakTimed, pushFeed]);

  // one ask can take several visible steps — she calls her own tools server-side
  const ask = useCallback(async (text) => {
    text = (text || "").trim();
    const chat = activeRef.current;
    if (!text || !chat) return;
    addLog(t("log.operator", { text }), "system");
    pushFeed({ kind: "user", text });

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
        body: JSON.stringify({ messages: next, lang: getLang(), moves: movesRef.current }),
      });
      const data = await r.json();
      const sage = data.reply, ok = !!(sage && sage.text);
      if (ok) setChats(cs => cs.map(c => c.id === chat.id ? { ...c, messages: [...next, { role: "assistant", content: sage.text }].slice(-12) } : c));
      addLog(t("log.replied"), "ai");
      showSage(ok ? sage : { text: data.error || "No response.", status: null }, t0, ok);
    } catch (e) {
      setAi(p => ({ ...p, text: t("ai.comms", { msg: e.message }), badge: "badge.online", analyzing: false, phase: null }));
    }
  }, [addLog, showSage, pushFeed, sendCmd]);

  // a move card only ever runs when the operator presses RUN
  const onMove = useCallback(async (item, yes) => {
    if (!yes) return patchFeed(item.id, { state: "declined" });
    const { program, errors } = blkParse(item.text);
    if (errors.length || !program.length) return patchFeed(item.id, { state: "failed", note: errors[0] || "empty" });
    patchFeed(item.id, { state: "running" });
    addLog(t("log.moveRun"), "ai");
    const { where, cancelled } = await playBlk(program, {
      onCmd: sendCmd, onAnalyze: analyze, busyRef: analyzingRef, packetRef,
      onNote: (n) => addLog(n, "ai"),
    });
    patchFeed(item.id, { state: cancelled ? "stopped" : "done", note: where });
  }, [patchFeed, addLog, sendCmd, analyze]);

  const fpvMic = useMic(ask);
  const fpvMicRef = useRef(fpvMic);
  fpvMicRef.current = fpvMic;
  const fpvRef = useRef(fpv);
  fpvRef.current = fpv;

  const toggleFpv = useCallback((on) => {
    const go = () => flushSync(() => setFpv(p => (typeof on === "boolean" ? on : !p)));
    if (document.startViewTransition) document.startViewTransition(go); else go();
  }, []);
  const toggleFpvRef = useRef(toggleFpv);
  toggleFpvRef.current = toggleFpv;
  const cycleZoomRef = useRef(null);
  cycleZoomRef.current = () => setFpvZoom(i => (i + 1) % FPV_ZOOMS.length);

  const recActRef = useRef(null);
  useEffect(() => {
    let was = [false, false, false, false, false];
    const id = setInterval(() => {
      const pad = [...navigator.getGamepads()].find(Boolean);
      if (!pad || tourOpen) return;

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

  const speakBrief = useCallback((items) => {
    if (!ttsRef.current) return;
    const play = (i) => { if (i < items.length) playOnboard(items[i].clip, items[i].text, { onEnd: () => play(i + 1) }); };
    play(0);
  }, []);
  const changeLang = useCallback((code) => {
    setLang(code); setLangState(code);
    socketRef.current?.emit("set-language", code);
  }, []);
  const newChat = useCallback(() => {
    const id = "c" + Date.now();
    setChats(cs => [...cs, { id, title: t("chat.newTitle"), mission: "", messages: [], created: Date.now() }]);
    setActiveId(id);
    socketRef.current?.emit("set-mission", "");
  }, []);
  const selectChat = useCallback((id) => {
    setActiveId(id);
    socketRef.current?.emit("set-mission", (chats.find(c => c.id === id)?.mission) || "");
  }, [chats]);
  const deleteChat = useCallback((id) => {
    setChats(cs => cs.filter(c => c.id !== id));
    setActiveId(a => {
      if (a !== id) return a;

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
  const clearSerial = useCallback(() => setSerialLines([]), []);

  const closeDrawer = useCallback(() => {
    setDrawer(o => o === "open" ? "closing" : o);
    setTimeout(() => setDrawer(false), 240);
  }, []);

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

  const toggleDrawerRef = useRef(toggleDrawer);
  toggleDrawerRef.current = toggleDrawer;
  useEffect(() => {
    const id = initPadNav({
      blocked: () => fpvRef.current || tourOpen,
      onMenu: () => toggleDrawerRef.current(),
    });
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (localStorage.getItem("tourDone")) return;
    const id = setTimeout(() => setOnboardStep("hero"), 900);
    return () => clearTimeout(id);
  }, []);
  const endTour = useCallback(() => {
    localStorage.setItem("tourDone", "1");
    setTour(s => s === "open" ? "closing" : s);
    setTimeout(() => setTour(false), 240);
  }, []);

  const closeOnboard = useCallback((next) => {
    if (window.blackout && blePicker) window.blackout.selectBleDevice("");
    setOnboardClosing(true);
    setTimeout(() => { setOnboardStep(false); setOnboardClosing(false); next?.(); }, 300);
  }, [blePicker]);
  const finishOnboard = useCallback(() => closeOnboard(() => setTour("open")), [closeOnboard]);
  const skipOnboard = useCallback(() => { localStorage.setItem("tourDone", "1"); closeOnboard(); }, [closeOnboard]);

  const onboardStart = useCallback(() => { if (VIEWER) finishOnboard(); else setOnboardStep("model"); }, [finishOnboard]);
  const onboardPickModel = useCallback((m) => { setOnboardModel(m); setOnboardStep("pair"); }, []);
  const restartTour = useCallback(() => {
    localStorage.removeItem("tourDone");
    setOnboardModel(null);
    closeDrawer();
    setTimeout(() => setOnboardStep("hero"), 260);
  }, [closeDrawer]);

  useEffect(() => {
    if (onboardStep !== "pair" || !bridge.running) return;
    const id = setTimeout(finishOnboard, 700);
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

  useEffect(() => {
    if (warn !== "open") return;
    setWarnCount(3);
    const id = setInterval(() => setWarnCount(c => Math.max(0, c - 1)), 1000);
    return () => clearInterval(id);
  }, [warn]);

  // firmware update: the server owns arduino-cli, we just poll it
  const openUpdate = useCallback(() => {
    setFlashPhase("detect");
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

  useEffect(() => {
    if (VIEWER || flashPhase === "flashing") return;
    const poll = () => fetch("/api/flash/boards").then(r => r.json()).then(setFlashBoards).catch(() => {});
    poll();
    const id = setInterval(poll, updateOpen === "open" ? 1200 : 5000);
    return () => clearInterval(id);
  }, [updateOpen, flashPhase]);

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

  useEffect(() => { fetch("/api/rec").then(r => r.json()).then(d => setRec(d.now)).catch(() => {}); }, []);
  const recRef = useRef(rec); recRef.current = rec;
  const toggleRec = useCallback(() => {
    const on = !!recRef.current;
    fetch(on ? "/api/rec/stop" : "/api/rec/start", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: activeRef.current?.title || "" }),
    }).then(async r => {
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "server said " + r.status);
      setRec(on ? null : d.now);
      setRecErr(null);
      addLog(on ? "recording saved" : "recording started", "system");
    }).catch(err => {
      addLog("recorder: " + err.message, "danger");
      toast(err.message, "danger");
      setRecErr(err.message);
    });
  }, [addLog, toast]);
  const openReplays = useCallback(() => {
    fetch("/api/rec").then(r => r.json()).then(d => { setRec(d.now); setRuns(d.runs); }).catch(() => setRuns([]));
  }, []);
  const pickReplay = useCallback((id) => {
    fetch("/api/rec/" + id).then(r => r.json()).then(run => { setRuns(null); setReplay(run); }).catch(() => {});
  }, []);
  recActRef.current = { rec: toggleRec, replays: openReplays };
  const deleteReplay = useCallback((id) => {
    fetch("/api/rec/" + id, { method: "DELETE" })
      .then(() => setRuns(rs => (rs || []).filter(r => r.id !== id))).catch(() => {});
  }, []);

  const openReport = useCallback(() => {
    setReport(buildReport({ chat: activeRef.current, packet: packetRef.current, logs, ai, connected: live, ping, packets, uptime }));
  }, [logs, ai, live, ping, packets, uptime]);

  const drawerTabRef = useRef(drawerTab);
  drawerTabRef.current = drawerTab;
  const drawerRef = useRef(drawer);
  drawerRef.current = drawer;

  // ---- render ----
  return html`
    <${React.Fragment}>
      <div class=${"shell" + (fpv ? " is-fpv" : "") + (FPV_ZOOMS[fpvZoom].z ? "" : " fpv-fill")}
        style=${{ "--fpv-zoom": FPV_ZOOMS[fpvZoom].z || 1 }}>
        ${fpv && html`
          <${React.Fragment}>
            <${FpvOverlay} packet=${view} />
            <${FpvSage} ai=${ai} packet=${view} speaking=${speaking} connected=${live} />
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
        <${Topbar} connected=${live} stale=${!fresh} bridge=${bridge} onBridge=${toggleBridge}
          ping=${fresh ? ping : "—"} packets=${packets} uptime=${uptime} lanUrl=${lanUrl} lanIp=${lanIp}
          lang=${lang} onLang=${changeLang} onConsole=${toggleDrawer} consoleOpen=${drawer === "open"}
          clients=${clients} onDevices=${() => setDevicesOpen("open")} granted=${granted}
          cloud=${cloud} onSettings=${() => setSettingsOpen("open")} />

        ${!VIEWER && flashBoards.status !== "none" && html`<${UpdateBar} boards=${flashBoards} onUpdate=${openUpdate} />`}

        ${judge ? html`<${JudgeView} packet=${view} connected=${live} ai=${ai} />` : html`
        <main class="cockpit" id="sensors">
          <div class="col-main">
            <div class="stage-row">
              <${ThreeDeeBox} packet=${view} onLog=${addLog} />
              <${CamBox} packet=${view} onFpv=${() => toggleFpv(true)} />
            </div>
            <${SensorStrip} packet=${view} />
          </div>
          <aside class="col-rail">
            <${Agent} ai=${ai} tts=${tts} ttsProv=${ttsProv} hasDeepgram=${hasDeepgram} packet=${view} connected=${live} speaking=${speaking}
              chats=${chats} activeChat=${activeChat} feed=${activeChat?.feed || NO_FEED} onNewChat=${newChat} onSelectChat=${selectChat}
              onDeleteChat=${deleteChat} onBrief=${briefMission} onSpeak=${speakBrief}
              onAnalyze=${analyze} onToggleTts=${toggleTts} onToggleTtsProvider=${toggleTtsProvider} onMock=${mockData} onAsk=${ask}
              onReport=${openReport} onMove=${onMove} />
            ${
              driveMounted && html`
              <${Drive} onCmd=${sendCmd} onAnalyze=${analyze} enabled=${canDrive} leaving=${!granted}
                busyRef=${analyzingRef} packetRef=${packetRef} />`}
          </aside>
        </main>`}

        ${!judge && html`<${Drawer} open=${drawer} tab=${drawerTab} onTab=${setDrawerTab} onClose=${closeDrawer}
          logs=${logs} serialLines=${serialLines} onClearSerial=${clearSerial}
          chat=${activeChat} onCmd=${sendCmd} enabled=${canDrive} onTutorial=${restartTour}
          saver=${saver} onSaver=${pickSaver} moves=${moves} onMoves=${toggleMoves}
            buzz=${buzz} onBuzz=${toggleBuzz} />`}
      </div>

      <${Toasts} items=${toasts} />

      ${updateOpen && createPortal(html`
        <${UpdateModal} open=${updateOpen} phase=${flashPhase} boards=${flashBoards}
          log=${flashLog} code=${flashCode}
          onFlash=${startFlash} onClose=${closeUpdate} />`, document.body)}

      ${devicesOpen && createPortal(html`
        <${DevicesModal} open=${devicesOpen} clients=${clients} selfId=${socketRef.current?.id}
          onMode=${(id, mode) => socketRef.current?.emit("grant", { id, mode })}
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
