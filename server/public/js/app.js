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
import { loadDetector, detectUpright, drawBoxes, ROTS, CAM_ROT_DEFAULT, norm as camNorm } from "./detect.mjs";

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

// One group per camera, the addresses that cam answers on, tried in order -- the
// same shape (and the same reason) as CAM_URL / overCam() in vision.js: the cams
// move between the sim router, the iPhone hotspot and school DHCP, and a feed
// pinned to one address dies on every move while Sage, who walks the list, keeps
// working. That asymmetry is exactly what "Sage sees the cam but the feed is
// blank" looks like.
const CAM_HOSTS = [
  ["192.168.1.10", "172.20.10.10", "192.168.1.111", "blackout-cam.local"],
  ["192.168.1.11", "172.20.10.11", "blackout-cam2.local"],
];
const CAM_HOST_DEFAULT = CAM_HOSTS[0][0];
// Cam 0 is the front cam and keeps the old unsuffixed keys, so a rig that already
// has a host or an angle saved doesn't lose it. Cam 1 is the arm/gripper view --
// the headlamp is still cam 0's alone, but Sage can ask for cam 1 ("armcam"), so
// both cams push their angle to the server, each tagged with its index.
const CAM_DEFAULTS = CAM_HOSTS.map(g => g[0]);
// The saved host is a starting guess, not a fact -- a working one is written back
// on the first frame, so the feed re-pins itself to whatever answered.
// A hand-typed host that isn't in the list gets one try, then the list takes over:
// an override that doesn't stream is not worth retrying forever.
const nextCamHost = (cam, h) => {
  const list = CAM_HOSTS[cam] || CAM_HOSTS[0];
  return list[(list.indexOf(h) + 1) % list.length];
};
const camKey = (base, cam) => base + (cam || "");
// Which eye a full analysis looks through: the MAXIMIZED feed, the same
// `camMain` the pip swap writes -- the operator points the big picture at what
// they want looked at, and a separate picker was one more thing to keep in step.
// Sage's own "camera"/"armcam" tools still choose for themselves; this is only
// the analysis the operator presses (and the presentation greeting, which is one).
const anaCam = () => Math.min(Math.max(0, +localStorage.getItem("camMain") || 0), CAM_HOSTS.length - 1);
const camHost = (cam = 0) => localStorage.getItem(camKey("camHost", cam)) || CAM_DEFAULTS[cam];
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

// ---- demo mode ----
// a sensor that dies mid-run blanks its tile and drags the verdict to NOT READING, in front of
// the judges. Demo mode fills those in with plausible drifting numbers so the run carries on.
// dist is deliberately absent: the sonar is what the rover steers on, and a faked wall is worse
// than a blank one. Browser-side only — nothing fake reaches the server's history or Sage.
const DEMO_RANGE = { temp: [28, 30], humid: [60, 70], alt: [-1, 0], pressure: [999.5, 1000.5], lux: [2, 15] };
const DEMO_KEYS = Object.keys(DEMO_RANGE);
const demoVal = (key, now = Date.now()) => {
  const [lo, hi] = DEMO_RANGE[key];
  const p = (Math.sin(now / 9000 + DEMO_KEYS.indexOf(key) * 1.7) + 1) / 2;  // slow wander, no state to keep
  return lo + p * (hi - lo);
};
const demoFill = (pkt, now) => {
  const out = { ...pkt };
  for (const s of SENSORS) if (DEMO_RANGE[s.key] && !reads(s, out[s.key])) out[s.key] = demoVal(s.key, now);
  return out;
};

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

// A trigger with `tape` plays a recorded run straight from here — no model round
// trip, so it fires instantly and works with the venue offline. "present
// yourself" is a tape and NOT the on-board PRESENTATION routine any more: the run
// talks, looks at the room and works the claw, and none of those exist in
// routines.h. The name has to match the file in server/tapes/.
const CMD_TRIGGERS = [
  { re: /present yourself|present urself|presentate/, tape: "PRESENT YOURSELF" },
  { re: /say hello|di hola/,                          tape: "SAY HELLO" },
  { re: /the mission|la mision/,                       tape: "NO CLAW DEMO" },
  { re: /about (your|the|its) arm|sobre (tu|el) brazo/,  tape: "ABOUT THE ARM" },
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
  u.rate = 1.08; u.lang = sl;   // a tape waits on every line now, so a slow read is dead air

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

// Deepgram Aura has no speed parameter, so the Edge fallback's TTS_RATE (+12% SSML)
// has no counterpart there and she reads slow — a tape waits on every line now, so
// that is dead air. The knob is the player instead: playbackRate keeps pitch
// (preservesPitch defaults on), and it is only applied to deepgram or the Edge
// lines would be sped up twice. Bench knob — raise until she clips.
const TTS_PLAYBACK = 1.15;
const ttsUrl = (p) => "/api/tts?text=" + encodeURIComponent(p) + "&voice=" + encodeURIComponent(ttsVoice()) + "&provider=" + ttsProviderRef;

// A queued line only started fetching its audio once the line before it had
// finished speaking, so every gap in a tape carried a whole synth round trip as
// silence. Warming makes the request NOW and parks the element here; speak()
// takes it instead of building its own. A tape warms every scripted line the
// moment it starts, so the model turn at the head of a run pays for the rest.
// speakFlush() drops them: a killed run must not leave a run's worth of audio.
const ttsWarm = new Map();
function ttsPrewarm(text) {
  for (const part of splitSpeech(text || "")) {
    const u = ttsUrl(part);
    if (ttsWarm.has(u)) continue;
    const a = new Audio(u); a.preload = "auto"; a.load();
    ttsWarm.set(u, a);
  }
}

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
  const mk = (p) => { const u = ttsUrl(p); const a = ttsWarm.get(u) || new Audio(u); ttsWarm.delete(u); a.preload = "auto"; a.playbackRate = ttsProviderRef === "deepgram" ? TTS_PLAYBACK : 1; return a; };
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

// A tape's lines fire off a clock, and a clock has no idea how long a sentence
// takes to say — so speak()'s stopSpeech() made her talk over herself every time
// a line ran long. Queued lines wait their turn. A new operator turn still cuts
// in through speak() directly, and speakFlush() drops whatever has not started
// yet, so the panic key does not leave a sentence queued behind it.
let speakChain = Promise.resolve(), speakGen = 0;
const speakFlush = () => { speakGen++; speakChain = Promise.resolve(); ttsWarm.clear(); speakWake?.(); stopSpeech(); };
function speakQueued(text, opts) {
  const gen = speakGen;
  speakWake?.();                       // an @analyze step is waiting for exactly this
  speakChain = speakChain
    .then(() => gen === speakGen
      ? new Promise((res) => speak(text, { ...opts, onEnd: () => { opts?.onEnd?.(); res(); } }))
      : null)
    .catch(() => {});
  return speakChain;
}

// An "@analyze" step hands off to the model and has nothing to wait on yet — the
// line is spoken whenever it comes back, seconds later. So wait for the next
// sentence to be QUEUED (capped: a failed analysis never speaks at all), then
// for the queue to drain.
let speakWake = null;
function whenSpoken(capMs) {
  return new Promise((res) => {
    const to = setTimeout(res, capMs);
    speakWake = () => { clearTimeout(to); speakWake = null; res(); };
  }).then(() => speakChain);
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
        <${CamStage} />
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
// (ARM_JOG_MS, 3s) kills the pulse the moment the repeats stop — a closed tab
// or a dropped link must not outlive the hand on the button.
const ARM_REPEAT_MS = 300;
// A tap is a ~60ms burst, and 60ms of a 360 is nothing you can see — which is
// what "I press it and it does nothing" is. The stop is held back so a press is
// worth at least this long; it is under the board's ARM_JOG_MS deadman, so
// nothing has to be re-sent to cover the gap.
const ARM_MIN_JOG_MS = 250;
const ARM_PAD_DZ = 0.35;   // stick deadzone for the arm — wider than Drive's, a nudge must not jog
const ARM_JOINTS = ["base", "shoulder", "elbow", "wrist", "gripwrist", "gripper"];
// The hold/sag trim is NOT on this pad (removed 2026-09-03, operator's call).
// Everything it drove is still on the board — the armh command,
// armSetHold() and the hold+sag columns in armSv[] — and the bench recorder
// (server/armrec.py) can still send it. The dashboard just has no knob, so the
// browser can no longer put the board out of step with the arm.h table, and
// that table is 0/0 on every row: a released joint free-wheels.

// ---- arm ledger ----
// The tape lives out here, not inside <Arm/>: the pad unmounts every time the
// operator flips to MOTORS or another tab, and Sage's arm cards fire from the
// agent feed with no pad on screen at all. One robot, one ledger.
const armLedger = {
  tape: [],            // pending playback timeouts, killed by the panic key
  tapeTok: 0,          // bumped by every stop — a tape awaiting a spoken line checks it before going on
  tapeOn: false,       // a run is playing: her lines queue behind each other instead of cutting in
};

// The one choke point every arm command goes through — the pad, a tapped move
// and Sage's cards all land here, so there is one place to put anything that
// has to see every arm command.
function armSend(cmd, onCmd) {
  onCmd(cmd);
}

// A queued step firing after the panic key restarts the arm the instant it was
// stopped, so the tape has to die with it. Bound at the app root, next to the
// global stop.
const armStopTape = () => { armLedger.tape.forEach(clearTimeout); armLedger.tape = []; armLedger.tapeTok++; armLedger.tapeOn = false; };

// Recorded on the bench by armrec.py, or assembled by the server from one of
// Sage's arm proposals: a flat list of {ms, cmd} replayed with its original
// gaps. The gaps ARE the take — the board's deadman lives on them — so this is
// timeouts off one clock, never a loop with waits.
function armPlay(steps, onCmd) {
  armStopTape();
  clawClear();
  const last = steps.length ? steps[steps.length - 1].ms : 0;
  armLedger.tape = steps.map((st) => setTimeout(() => armSend(st.cmd, onCmd), st.ms));
  armLedger.tape.push(setTimeout(() => armSend("arm,", onCmd), last + ARM_REPEAT_MS));
  return last + ARM_REPEAT_MS;
}

function armRehome(onCmd) {
  armSend("armz,", onCmd);
}

// ---- claw ----
// The gripper is not a jog like the other five. It has two jaw stops and a job
// (hold the thing), so the arrows on its row are OPEN and CLOSE, not <>. The
// shape is the Uno R4 bench rig's (claw_cmd.ino + claw_web.py, 2026-09-07):
//
//   OPEN  — a one-shot burst that parks itself. THAT is the open limit: a 360
//           has no end stop to find, so the only thing that can stop it opening
//           is a clock. Holding the button longer does not open it further, and
//           it LATCHES OPEN: a second burst just opens further with nothing to
//           catch it, so the button is dead until CLOSE takes the joint back.
//   CLOSE — latches. Full pace into the jaw stop to grab, then it stays latched
//           at CLAW_HOLD so the thing does not drop. Press it again to release.
//
// The latch lives out here with armLedger and NOT in <Arm/>, for the reason the
// ledger does: the pad unmounts on every tab switch, and closing on an object
// and then flipping to MOTORS to drive is the normal case — a latch that died
// with the component would open the claw the moment you went to move.
// IMPORTANT NOTE: a latched claw draws current until it is released. That is
// the trade for a claw that holds; the panic key and STOP are the release.
const CLAW_JOINT = 5;
const CLAW_OPEN_MS = 200;    // one-shot open travel at full pace. 300 on the
                             // bench, trimmed down twice on the real claw.
const CLAW_GRAB_MS = 800;    // bench: full pace long enough to reach the stop
const CLAW_HOLD = 35;        // then hold at this. Pulse width is force here, so
                             // it is enough torque to keep the jaws shut and not
                             // enough to sit stalled flat out. MEASURE IT on the
                             // bench with the actual payload — too low drops it,
                             // too high cooks the servo.
// One PCA9685 frame at ARM_HZ (50Hz) = 20ms, and that is the floor on any burst
// here: the chip only reloads its outputs on a frame boundary, so a burst
// shorter than one frame is a coin flip on whether the servo sees it at all.
// The pulse-width floor is the chip's own 12-bit step, 20000us/4096 = 4.88us —
// but that is NOT the knob to turn. Pulse width is speed AND torque on a 360, so
// a gentler nudge is a weaker one and a loaded claw will not break away at all;
// the nudge runs at FULL power and gets small by being SHORT. (The 360's own
// deadband around neutral is 50-100us wide, tens of chip steps, which is why
// trimming us to make a small move does nothing until suddenly it does.)
// Sitting on top of that: the browser's setTimeout and the ~15ms BLE connection
// interval, so a single frame is about as fine as this link can honestly resolve.
// test-arm.mjs cross-checks CLAW_FRAME_MS against ARM_HZ in arm.h.
const CLAW_FRAME_MS = 20;
const CLAW_NUDGE_MAX = 200;
const CLAW_NUDGE_KEY = "clawNudgeMs";
const clawLatch = { on: "", timer: null, repeat: null };

// Timers only — the caller decides whether a stop command still has to go out.
// The panic key does not need one (the board's `stop` already killed the arm),
// but a leftover interval would restart it a moment later.
function clawClear() {
  clearTimeout(clawLatch.timer); clearInterval(clawLatch.repeat);
  clawLatch.timer = clawLatch.repeat = null;
  clawLatch.on = "";
}

function clawStop(onCmd) {
  clawClear();
  armSend(`arm,${CLAW_JOINT},0`, onCmd);
}

// Everything a panic stop has to kill. A bare `stop` is not one: a queued tape
// or arm step, and the claw's hold repeat, each restart the robot the instant it
// lands. The panic key and AUTO's STOP bar both go through here.
const panicStop = (send) => { blkCancel(); armStopTape(); clawClear(); speakFlush(); send("stop"); };

// One deliberate twitch, for letting go of something without flinging the jaws
// open into their stop. Full power for `ms` and then park — see CLAW_FRAME_MS
// for why this is timed and not throttled. It drops the latch: the claw is now
// somewhere between open and closed and neither button should claim it.
function clawNudge(dir, ms, onCmd) {
  clawClear();
  armSend(`arm,${CLAW_JOINT},${dir < 0 ? -100 : 100}`, onCmd);
  clawLatch.timer = setTimeout(() => armSend(`arm,${CLAW_JOINT},0`, onCmd),
                               Math.max(CLAW_FRAME_MS, ms));
}

// dir < 0 opens, > 0 closes — same sign the rest of the pad uses.
function clawGo(dir, onCmd) {
  const want = dir < 0 ? "open" : "close";
  if (clawLatch.on === want) {
    if (want === "open") return;               // already open: only CLOSE clears it
    return void clawStop(onCmd);               // press the live CLOSE again = let go
  }
  clawClear();
  clawLatch.on = want;
  armSend(`arm,${CLAW_JOINT},${dir < 0 ? -100 : 100}`, onCmd);
  if (dir < 0) {
    // park the joint but keep the latch lit — the claw IS open, and that is what
    // the dead OPEN button is telling the operator
    clawLatch.timer = setTimeout(() => armSend(`arm,${CLAW_JOINT},0`, onCmd), CLAW_OPEN_MS);
    return;
  }
  // grabbed: ease off to the hold and keep it alive against the board's deadman
  clawLatch.timer = setTimeout(() => {
    const hold = () => armSend(`arm,${CLAW_JOINT},${CLAW_HOLD}`, onCmd);
    hold();
    clawLatch.repeat = setInterval(hold, ARM_REPEAT_MS);
  }, CLAW_GRAB_MS);
}

// ---- tapes ----
// A whole manual run written down. sendCmd is the one place every command leaves
// the browser, so recording is a tap there — drive, arm, lights, routines, all of
// it, with the gaps. A step is the arm take's {ms, cmd}, so the player below is
// the arm player with one branch added: a cmd starting with "@" never reaches the
// board, it is one of the things only the PC has (say/analyze/log/led), typed in
// by hand when the tape is edited. English-only on purpose: bench tool.
// `name` rides along because the component unmounts with the drawer — see Tapes().
const tapeRec = { on: false, t0: 0, steps: [], name: "" };
const tapeStart = (name) => { tapeRec.on = true; tapeRec.t0 = Date.now(); tapeRec.steps = []; tapeRec.name = name; };
const tapeWatch = (cmd) => {
  // blk upload chatter is not a move — a workflow is its own file already
  if (tapeRec.on && !cmd.startsWith("blk,")) tapeRec.steps.push({ ms: Date.now() - tapeRec.t0, cmd });
};
// the clock starts at REC, so every take carries the operator's reaction time as
// dead air at the head. Shift to the first step — the GAPS are the take, the head
// is not. Same rule as armrec.py's clean().
const tapeStop = () => {
  tapeRec.on = false;
  const t0 = tapeRec.steps.length ? tapeRec.steps[0].ms : 0;
  const out = tapeRec.steps.map(s => ({ ...s, ms: s.ms - t0 }));
  tapeRec.steps = [];          // a second stop must not save the last take again
  return out;
};

const TAPE_EVENTS = ["sage", "say", "present", "tape", "analyze", "log", "led"];
const TAPE_LINE_MS = 6000;   // she gets this long to answer; after it, the cue
const TAPE_ANALYZE_MS = 25000;  // an @analyze holds the run this long; a failed one never speaks at all

// "@say" is a script — the same words every run, and it sounds like it.
// "@sage" is a CUE: she writes the sentence herself off the cue and whatever the
// rover can read at the time, so a rehearsed run still comes out different every
// time and grounded in the room. The ask goes out when the tape STARTS, not when
// the step fires — waiting two seconds for a model in the middle of a
// presentation is dead air — and whatever hasn't landed by then falls back to
// speaking the cue as written. The venue has no internet, so that fallback is
// the normal case, not the unhappy one: a tape always talks.
function tapeCue(cue) {
  const slot = { line: null };
  fetch("/api/tape-line", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cue, lang: getLang() }), signal: AbortSignal.timeout(TAPE_LINE_MS),
  }).then(r => r.json()).then(d => { slot.line = d.text || null; }).catch(() => {});
  return slot;
}

// "@say.es <texto>" beside "@say <text>": a step may carry a language suffix, and
// the same tape then speaks whichever the dashboard is set to. Split here so the
// cue prefetch and the step both read the name the same way.
const tapeParse = (cmd) => {
  const m = /^@(\w+)(?:\.([a-z]{2}))?\s*([^]*)$/.exec(cmd);
  return { kind: m?.[1], lang: m?.[2] || null, text: (m?.[3] || "").trim() };
};

function tapeStep(cmd, io, cues, sub) {
  if (!cmd.startsWith("@")) return void armSend(cmd, io.onCmd);
  const { kind, text } = tapeParse(cmd);
  if (kind === "sage") {
    // whatever is in hand right now — never a wait, this is live
    const line = cues?.get(text)?.line || text;
    io.onSay?.(line);
    return speakQueued(line);
  }
  else if (kind === "say") { io.onSay?.(text); return speakQueued(text); }
  // The judge greeting: the same camera still an @analyze takes, read against
  // prompts/present.md instead of the cave prompt — she counts the people in
  // front of her, greets that many and compliments them, so the open of a run is
  // never the same words twice. Nothing to prewarm, the line does not exist yet.
  else if (kind === "present") { io.onAnalyze?.("present", text || null); return whenSpoken(TAPE_ANALYZE_MS); }
  // "@tape <name>" plays another recorded run inline. The claw wave a
  // presentation ends on lives in its own file so it can be re-recorded without
  // touching the script around it. ONE level deep: a tape that names itself, or
  // a pair that name each other, would recurse until the browser gave up.
  else if (kind === "tape") {
    if (!sub) { io.onNote?.(`tape: ${text} is nested too deep to play`); return null; }
    return fetch("/api/tapes/" + encodeURIComponent(text))
      .then(r => r.ok ? r.json() : Promise.reject(new Error("404")))
      .then(d => sub(Array.isArray(d) ? d : d.steps || []))
      .catch(() => io.onNote?.(`tape: no recorded run called "${text}"`));
  }
  else if (kind === "analyze") { io.onAnalyze?.(null, text || null); return whenSpoken(TAPE_ANALYZE_MS); }
  else if (kind === "log") io.onNote?.(text);
  else if (kind === "led") fetch("/api/led", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: +text || 0 }) }).catch(() => {});
  else io.onNote?.(`tape: unknown event ${cmd}`);
}

// THE CLOCK STOPS WHILE SHE TALKS. Steps used to fire off absolute timestamps,
// which is right until a line runs long — and every line runs long: the gaps
// were timed to an operator's finger, not to a sentence, and an "@analyze" waits
// on the model for as long as the model takes. So the gestures ran ahead of the
// words and the arm waved before "and the best part, I have an arm!" was said.
// Now a step's recorded gap is measured from the END of the one before it, and a
// spoken step ends when the speech does. The gaps between two *board* commands
// are untouched, which is what the deadman lives on.
//
// It is still one timeout at a time in armLedger.tape, so the panic key kills a
// tape mid-run exactly as it kills an arm take — plus a token, because a step
// parked on a sentence is not in that array and has to check for itself.
function tapePlay(steps, io) {
  armStopTape();
  clawClear();
  speakFlush();          // a leftover line from the last run must not open this one
  // A suffixed step only ever fires in its own language. The unsuffixed ones are
  // the English original, and they drop out as soon as the tape carries a set for
  // the language on screen — so a half-translated tape speaks what was translated
  // and falls back to English for the rest instead of saying both.
  const lang = getLang();
  const dubbed = steps.some(st => tapeParse(st.cmd).lang === lang);
  steps = steps.filter(st => {
    if (!st.cmd.startsWith("@")) return true;
    const { kind, lang: l } = tapeParse(st.cmd);
    return l ? l === lang : !(dubbed && (kind === "say" || kind === "sage"));
  });
  const cues = new Map();
  for (const st of steps) {
    const p = tapeParse(st.cmd);
    if (!st.cmd.startsWith("@")) continue;
    if (p.kind === "sage" && !cues.has(p.text)) cues.set(p.text, tapeCue(p.text));
    // Every scripted line's audio is asked for now, while the run is still on its
    // first sentence — otherwise each line's synth round trip is silence.
    if (p.kind === "say") ttsPrewarm(p.text);
  }
  const tok = ++armLedger.tapeTok;
  armLedger.tapeOn = true;
  const alive = () => tok === armLedger.tapeTok;
  const wait = (ms) => new Promise((res) => armLedger.tape.push(setTimeout(res, ms)));
  const runSteps = async (list, depth = 0) => {
    let at = 0;
    for (const st of list) {
      await wait(Math.max(0, st.ms - at));
      if (!alive()) return false;
      at = st.ms;
      // a spoken step hands back its sentence; an "@tape" hands back the run it played
      const held = tapeStep(st.cmd, io, cues, depth ? null : (s) => runSteps(s, depth + 1));
      if (held) { await held; if (!alive()) return false; }
    }
    return true;
  };
  return (async () => {
    if (!await runSteps(steps)) return;
    await wait(ARM_REPEAT_MS);
    if (!alive()) return;
    armLedger.tapeOn = false;
    io.onCmd("stop");
    armSend("arm,", io.onCmd);
  })();
}

function Tapes({ onCmd, onAnalyze, onNote, onSay, enabled }) {
  const [files, setFiles] = useState([]);
  // Seeded from the module flag, not false: the drawer unmounts this whole
  // component when the console is closed (or another tab is picked), and the arm
  // pad is BEHIND the drawer — so recording a run means closing the console
  // mid-take. tapeRec lives outside the component and keeps recording; this is
  // what makes it come back reading ■ STOP + SAVE instead of wiping the take.
  const [rec, setRec] = useState(tapeRec.on);
  const [name, setName] = useState(tapeRec.on ? tapeRec.name : "");
  const [edit, setEdit] = useState(null);      // { name, text } — the raw json
  const [err, setErr] = useState("");
  const load = () => fetch("/api/tapes").then(r => r.json()).then(d => setFiles(d.files || [])).catch(() => {});
  useEffect(() => { load(); }, []);   // load() returns a promise; React calls an effect's return value as cleanup

  const save = async (n, steps) => {
    const r = await fetch(`/api/tapes/${encodeURIComponent(n)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ steps }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return void setErr(d.error || "save failed");
    setErr(""); load();
    return true;
  };

  const stop = async () => {
    const steps = tapeStop();
    setRec(false);
    if (!steps.length) return void setErr("nothing was sent — nothing to save");
    await save(name.trim() || "take", steps);
    setName("");
  };

  const open = async (n) => {
    const r = await fetch(`/api/tapes/${encodeURIComponent(n)}`);
    setEdit({ name: n, text: await r.text() });
    setErr("");
  };

  const saveEdit = async () => {
    let parsed;
    try { parsed = JSON.parse(edit.text); } catch (e) { return void setErr("bad json: " + e.message); }
    if (await save(edit.name, parsed.steps || parsed)) setEdit(null);
  };

  const del = async (n) => {
    if (!confirm(`Delete tape "${n}"?`)) return;
    await fetch(`/api/tapes/${encodeURIComponent(n)}`, { method: "DELETE" });
    if (edit?.name === n) setEdit(null);
    load();
  };

  return html`
    <div class="tapes">
      <div class="tapes-bar">
        <input class="tapes-name" placeholder="tape name" value=${name} disabled=${rec}
          onInput=${(e) => setName(e.target.value)} />
        <button type="button" class=${"btn" + (rec ? " is-rec" : "")} disabled=${!enabled && !rec}
          onClick=${() => (rec ? stop() : (tapeStart(name.trim()), setErr(""), setRec(true)))}>
          ${rec ? "■ STOP + SAVE" : "● RECORD"}
        </button>
        <span class="tapes-hint">${rec ? "recording every command — drive, arm, lights" : `add by hand: @sage <what to talk about — she writes the line> · ${TAPE_EVENTS.slice(1).map(e => "@" + e).join(" ")} · @say.es <texto> for a spoken line in another language`}</span>
      </div>
      ${err && html`<div class="tapes-err">${err}</div>`}
      <ul class="tapes-list">
        ${files.map(n => html`<li key=${n} class="tapes-row">
          <span class="tapes-row-name">${n}</span>
          <button type="button" class="serial-btn" disabled=${!enabled || rec}
            onClick=${async () => {
              const r = await fetch(`/api/tapes/${encodeURIComponent(n)}`);
              const d = await r.json().catch(() => null);
              if (d) tapePlay(d.steps || [], { onCmd, onAnalyze, onNote, onSay });
            }}>▶ PLAY</button>
          <button type="button" class="serial-btn" onClick=${() => open(n)}>EDIT</button>
          <button type="button" class="serial-btn" onClick=${() => del(n)}>✕</button>
        </li>`)}
      </ul>
      ${edit && html`<div class="tapes-edit">
        <textarea class="tapes-json" spellcheck="false" value=${edit.text}
          onInput=${(e) => setEdit({ ...edit, text: e.target.value })}></textarea>
        <div class="tapes-bar">
          <button type="button" class="btn" onClick=${saveEdit}>SAVE ${edit.name}</button>
          <button type="button" class="serial-btn" onClick=${() => setEdit(null)}>CLOSE</button>
        </div>
      </div>`}
    </div>`;
}

// Shift-click an arrow to name it. "gripper ▶" says nothing about which way is
// open — the crew's own word for it does, and it is per rig, so it lives in
// localStorage rather than in a table someone has to edit and reflash.
// A take that only ever drives ONE joint ONE way is a jog somebody wrote down
// and named — so it gets the arrows' behaviour (hold to run, release to stop)
// instead of replaying a fixed burst. Anything mixed is a real sequence and
// stays a tape. Derived from the file, so naming a take is all it takes.
const armJogOf = (steps) => {
  const on = (steps || []).map((st) => /^arm,(\d+),(-?\d+)$/.exec(st.cmd)).filter((m) => m && +m[2] !== 0);
  if (!on.length) return null;
  return on.every((m) => m[1] === on[0][1] && m[2] === on[0][2]) ? [+on[0][1], +on[0][2]] : null;
};

// Three-way jog speed for the arrows. It scales the ±100 the pad sends, so the
// wire command is the same `arm,<j>,<speed>` the firmware always took. Pulse
// width is speed AND torque on a 360, so SLOW is also weak — a gravity-loaded
// joint may not lift at SLOW at all. Floor is armrec.py's SPEED_MIN (20): below
// that the pulse is inside the servo deadband and the joint only buzzes.
// Recorded takes keep their own recorded speed — that is part of the take.
// SLOW is 55, not 40: at 40 the base moved one way and not the other — its
// neutral (1490) sits off-centre in the servo's own deadband, so the same
// magnitude clears it going one way and dies going the other. 55 is above
// break-away both ways. The real fix is trimming that neutral on the bench.
// R2 boost cap. 255 is everything the L298N has; below MANUAL_PWM the boost
// would be slower than no boost at all, which is why the low chip is 140.
const BOOSTS = [["140", 140], ["200", 200], ["255", 255]];
const BOOST_KEY = "boostPwm";
const ARM_SPEEDS = [["SLOW", 55], ["MED", 75], ["FAST", 100]];
const ARM_SPD_KEY = "armPadSpd";

const ARM_LABELS_KEY = "armLabels";
const armLabelsLoad = () => { try { return JSON.parse(localStorage.getItem(ARM_LABELS_KEY)) || {}; } catch { return {}; } };

function Arm({ onCmd, enabled }) {
  const heldRef = useRef(null);
  const downRef = useRef(0);
  const [moves, setMoves] = useState({});
  // which joint the gamepad drives. Six joints and one stick, so the pad picks
  // one at a time; the on-screen arrows still work on any row and set this too.
  const [sel, setSel] = useState(0);
  const [labels, setLabels] = useState(armLabelsLoad);
  const [claw, setClaw] = useState(clawLatch.on);   // the ledger is the truth, this only paints it
  const [nudge, setNudge] = useState(() => +localStorage.getItem(CLAW_NUDGE_KEY) || CLAW_FRAME_MS * 2);
  const [spd, setSpd] = useState(() => +localStorage.getItem(ARM_SPD_KEY) || 100);
  const spdRef = useRef(100);
  spdRef.current = spd;
  const jog = (dir) => Math.round((dir * spdRef.current) / 100);
  const [ren, setRen] = useState(null);   // {i, dir} being named
  const renRef = useRef(null);
  const selRef = useRef(0);
  selRef.current = sel;

  useEffect(() => {
    fetch("/api/arm-moves").then((r) => r.json()).then(setMoves).catch(() => {});
  }, []);

  useEffect(() => {
    if (!enabled) { armStopTape(); return; }
    const id = setInterval(() => {
      setClaw(() => clawLatch.on);   // released by the panic key while we were unmounted?
      const h = heldRef.current;
      if (!h) return;
      armSend(`arm,${h[0]},${h[1]}`, onCmd);
    }, ARM_REPEAT_MS);
    return () => { clearInterval(id); heldRef.current = null; };
  }, [onCmd, enabled]);

  // Gamepad: LB/RB step the selected joint, right stick Y jogs it. The stick is
  // a direction, not a throttle — pulse width is speed AND torque on these 360s,
  // so a half-deflected jog is just a weak one; ±100 like the buttons. It feeds
  // the same heldRef the interval above repeats and limit-checks, so the pad
  // gets the deadman for free.
  useEffect(() => {
    if (!enabled) return;
    const w = { lb: false, rb: false, want: "" };
    const id = setInterval(() => {
      const pad = [...navigator.getGamepads()].find(Boolean);
      if (!pad) return;
      const lb = !!pad.buttons[4]?.pressed, rb = !!pad.buttons[5]?.pressed;
      if (lb && !w.lb) setSel((s) => (s + ARM_JOINTS.length - 1) % ARM_JOINTS.length);
      if (rb && !w.rb) setSel((s) => (s + 1) % ARM_JOINTS.length);
      w.lb = lb; w.rb = rb;

      const v = pad.axes[3] ?? 0;   // right stick Y — the left one is still driving
      const dir = Math.abs(v) < ARM_PAD_DZ ? 0 : jog(v < 0 ? 100 : -100);
      const i = selRef.current;
      const want = dir ? `${i},${dir}` : "";
      if (want === w.want) return;   // held: the 300ms repeat keeps it alive
      if (w.want) { heldRef.current = null; armSend(`arm,${w.want.split(",")[0]},0`, onCmd); }
      w.want = want;
      if (want) {
        if (i === CLAW_JOINT) clawClear();   // a jog takes the joint; two repeats on one channel is a fight
        heldRef.current = [i, dir]; armSend(`arm,${want}`, onCmd);
      }
    }, 60);
    return () => { clearInterval(id); if (w.want) armSend(`arm,${w.want.split(",")[0]},0`, onCmd); };
  }, [enabled, onCmd]);

  // <dialog>, not prompt(): Electron never implemented window.prompt, so the
  // shift-click did nothing at all inside the app.
  useEffect(() => { if (ren) renRef.current?.showModal(); }, [ren]);
  const saveRen = (raw) => {
    const key = `${ren.i}:${ren.dir}`;
    const v = String(raw || "").trim().slice(0, 12).toLowerCase();
    const next = { ...labels };
    if (v) next[key] = v; else delete next[key];
    setLabels(next);
    localStorage.setItem(ARM_LABELS_KEY, JSON.stringify(next));
    setRen(null);
  };

  const press = (i, dir, nameable) => (e) => {
    e.preventDefault();
    setSel(i);
    if (nameable && e.shiftKey) { setRen({ i, dir }); return; }
    if (!enabled) return;
    downRef.current = Date.now();
    heldRef.current = [i, jog(dir)];
    armSend(`arm,${i},${jog(dir)}`, onCmd);   // first one now, the interval only repeats it
  };
  // release stops the joint outright rather than waiting out the deadman — but
  // never before ARM_MIN_JOG_MS, or a tap is a burst too short to see. A press
  // that lands in the meantime owns the joint, so the late stop drops itself.
  const release = (i) => () => {
    if (heldRef.current?.[0] !== i) return;
    heldRef.current = null;
    const left = ARM_MIN_JOG_MS - (Date.now() - downRef.current);
    if (left > 0) setTimeout(() => { if (!heldRef.current) armSend(`arm,${i},0`, onCmd); }, left);
    else armSend(`arm,${i},0`, onCmd);
  };

  return html`
    <div class=${"arm-pad" + (enabled ? "" : " is-off")}>
      <div class="arm-spd">
        ${ARM_SPEEDS.map(([lbl, v]) => html`
          <button type="button" key=${v} class=${"chip" + (spd === v ? " is-on" : "")}
            aria-pressed=${spd === v}
            title="scales the arrows — slow is also weak on these 360s"
            onClick=${() => { setSpd(v); localStorage.setItem(ARM_SPD_KEY, v); }}>${lbl}</button>`)}
      </div>
      <div class="arm-rows">
      ${ARM_JOINTS.map((name, i) => html`
        <div class=${"arm-row" + (i === sel ? " is-sel" : "")} key=${name}>
          <button type="button" class="arm-name" onClick=${() => setSel(i)}
            aria-pressed=${i === sel} title="pick this joint for the gamepad">${name}</button>
          ${[["\u25c0", -100], ["\u25b6", 100]].map(([glyph, dir]) => {
            // the claw is a latch, not a jog — see clawGo(). One tap, no holding.
            const isClaw = i === CLAW_JOINT;
            const lit = isClaw && claw === (dir < 0 ? "open" : "close");
            // a second OPEN burst has nothing to stop it, so the button goes dead
            // until CLOSE. aria-disabled + a class, never disabled: a disabled
            // button emits no pointer events, and shift-click still names it.
            const dead = lit && dir < 0;
            const held = isClaw ? {
              onClick: (e) => {
                setSel(i);
                if (e.shiftKey) return void setRen({ i, dir });
                if (enabled) { clawGo(dir, onCmd); setClaw(clawLatch.on); }
              },
            } : {
              onPointerDown: press(i, dir, true), onPointerUp: release(i),
              onPointerLeave: release(i), onPointerCancel: release(i),
            };
            return html`
            <button type="button" key=${dir}
              class=${"pad-btn arm-btn" + (enabled && !dead ? "" : " is-off") + (lit ? " is-live" : "")}
              aria-disabled=${!enabled || dead} aria-pressed=${isClaw ? lit : undefined}
              aria-label=${`${name} ${labels[`${i}:${dir}`] || (isClaw ? (dir < 0 ? "open" : "close") : (dir < 0 ? "reverse" : "forward"))}`}
              title=${isClaw
                ? (dir < 0 ? (dead ? "already open — press CLOSE to take the joint back"
                                   : "one burst, parks itself — how far it opens is CLAW_OPEN_MS")
                           : "latches closed and holds — press again to let go")
                : "hold to jog — shift-click to name this direction"}
              ...${held}
              onContextMenu=${(e) => e.preventDefault()}>
              <span class="pad-glyph" aria-hidden="true">${glyph}</span>
              ${(labels[`${i}:${dir}`] || (isClaw && (dir < 0 ? "open" : "close"))) &&
                html`<small class="arm-lbl">${labels[`${i}:${dir}`] || (dir < 0 ? "open" : "close")}</small>`}
            </button>`;
          })}
        </div>`)}
      <div class="arm-row claw-nudge">
        <label>
          <span class="arm-name">nudge</span>
          <input type="range" min=${CLAW_FRAME_MS} max=${CLAW_NUDGE_MAX} step=${CLAW_FRAME_MS / 2}
            value=${nudge} disabled=${!enabled}
            title="how long one nudge drives — full power, so short IS small"
            onInput=${(e) => { const v = +e.target.value; setNudge(v); localStorage.setItem(CLAW_NUDGE_KEY, v); }} />
          <small class="claw-ms">${nudge}ms</small>
        </label>
        ${[["\u25c0", -100], ["\u25b6", 100]].map(([glyph, dir]) => html`
          <button type="button" key=${dir}
            class=${"pad-btn arm-btn" + (enabled ? "" : " is-off")}
            aria-disabled=${!enabled}
            aria-label=${`nudge gripper ${dir < 0 ? "open" : "closed"} ${nudge}ms`}
            title=${`one ${nudge}ms twitch ${dir < 0 ? "open" : "closed"} — for letting go without slamming the jaws`}
            onClick=${() => enabled && (clawNudge(dir, nudge, onCmd), setClaw(""))}>
            <span class="pad-glyph" aria-hidden="true">${glyph}</span>
            <small class="arm-lbl">${dir < 0 ? "open" : "close"}</small>
          </button>`)}
      </div>
      </div>
      <small class="drive-hint">${t("drive.armPad")}</small>
      ${ren && html`
        <dialog class="arm-ren" ref=${renRef} onClose=${() => setRen(null)}>
          <form onSubmit=${(e) => { e.preventDefault(); saveRen(e.target.elements.n.value); }}>
            <p class="arm-ren-t">set custom name — ${ARM_JOINTS[ren.i]} ${ren.dir < 0 ? "\u25c0" : "\u25b6"}</p>
            <input name="n" class="arm-ren-in" autoFocus maxLength="12" placeholder="open / close / up…"
              defaultValue=${labels[`${ren.i}:${ren.dir}`] || ""} />
            <div class="arm-ren-btns">
              <button type="button" class="chip" onClick=${() => saveRen("")}>CLEAR</button>
              <button type="button" class="chip" onClick=${() => setRen(null)}>CANCEL</button>
              <button type="submit" class="chip">SAVE</button>
            </div>
          </form>
        </dialog>`}
      <div class="arm-moves">
        ${Object.keys(moves).map((name) => {
          const j = armJogOf(moves[name]);
          return j ? html`
            <button type="button" key=${name}
              class=${"pad-btn arm-move" + (enabled ? "" : " is-off")}
              aria-disabled=${!enabled}
              title=${`hold to jog ${ARM_JOINTS[j[0]]}`}
              onPointerDown=${press(j[0], j[1])} onPointerUp=${release(j[0])}
              onPointerLeave=${release(j[0])} onPointerCancel=${release(j[0])}
              onContextMenu=${(e) => e.preventDefault()}>${name}</button>`
          : html`
            <button type="button" key=${name} class="pad-btn arm-move" disabled=${!enabled}
              title="recorded sequence — tap to replay"
              onClick=${() => enabled && armPlay(moves[name] || [], onCmd)}>${name}</button>`;
        })}
        <button type="button" class="pad-btn arm-move" disabled=${!enabled}
          title="clears the board's own travel count — needed after a board reset"
          onClick=${() => enabled && armRehome(onCmd)}>RE-HOME</button>
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
  // the wheels park while the arm pad is up: same stick, and a jog that also
  // rolls the rover off the bench is how a joint gets wound into the frame
  const subRef = useRef(sub);
  subRef.current = sub;
  const keysRef = useRef(new Set());
  const moving = useRef(false);
  const sqWas = useRef(false);
  // R2 boost cap, per rig — the ceiling the pad's trigger drives at
  const [boost, setBoost] = useState(() => +localStorage.getItem(BOOST_KEY) || BOOSTS[1][1]);
  const boostRef = useRef(boost);
  boostRef.current = boost;
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
      if (!armedRef.current || subRef.current === "arm" || tourOpen || cursorOn()) { if (moving.current) { moving.current = false; setVerb(null); onCmd("stop"); } return; }
      const pad = [...navigator.getGamepads()].find(Boolean);

      const turbo = !!pad && (pad.buttons[7]?.pressed || (pad.buttons[7]?.value ?? 0) > 0.35);
      const cap = turbo ? boostRef.current : MANUAL_PWM;
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

  const stopAll = () => { heldRef.current = null; keysRef.current.clear(); moving.current = false; setVerb(null); panicStop(onCmd); };

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
            <small class="drive-hint">${hint}</small>
            <div class="arm-spd boost-row">
              <span class="label">R2</span>
              ${BOOSTS.map(([lbl, v]) => html`
                <button type="button" key=${v} class=${"chip" + (boost === v ? " is-on" : "")}
                  aria-pressed=${boost === v} title="pwm cap while the R2 trigger is held"
                  onClick=${() => { setBoost(v); localStorage.setItem(BOOST_KEY, v); }}>${lbl}</button>`)}
            </div>`
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
// The newest bytes off each feed, so the server can borrow one for Sage instead of
// opening a second stream the cam can't serve (setFrameSource in vision.js). Lives
// outside CamView for the same reason armLedger does -- the component unmounts on
// every tab switch. Stamped, so a stalled feed answers nothing rather than handing
// her a frozen frame to report on.
const camFrames = [];
const FRAME_LEND_MS = 2000;

const DET_MS = 100;
const DET_MIN_SCORE = 0.5;

function CamView({ cam = 0, pip = false, onSwap }) {
  const [state, setState] = useState("loading");
  const [nonce, setNonce] = useState(0);
  const [host, setHost] = useState(camHost(cam));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [detect, setDetect] = useState(() => localStorage.getItem("camDetect") === "1");
  const [detState, setDetState] = useState("off");
  // Mount angle, kept per rig. It drives three things at once: the css transform on
  // the feed, the frame detect.mjs hands the model, and the still Sage is shown --
  // flip the cam and rotate only the picture and her vision quietly goes sideways.
  const [rot, setRot] = useState(() => camNorm(Number(localStorage.getItem(camKey("camRot", cam)) ?? CAM_ROT_DEFAULT)));

  const [sliders, setSliders] = useState({ brightness: -1, contrast: -1, saturation: 0, ae_level: 0, led: 15 });
  const [picks, setPicks] = useState({ wb_mode: 0, framesize: 8 });
  const imgRef = useRef(null);
  const boxRef = useRef(null);

  useEffect(() => {
    const on = (e) => setSliders(p => (p.led === e.detail ? p : { ...p, led: e.detail }));
    window.addEventListener("cam-led", on);
    return () => window.removeEventListener("cam-led", on);
  }, []);

  const fail = useCallback(() => setState("offline"), []);
  const lastFrame = useRef(0);

  useEffect(() => {
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
      camFrames[cam] = { bytes, at: lastFrame.current };
      if (first) {
        first = false;
        setState("live");
        localStorage.setItem(camKey("camHost", cam), host);
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
  }, [nonce, host]);

  // one detector, on whichever feed is big: the pip is for lining the gripper up
  // by eye, and a second model doubles 25ms/frame on webgl but 280ms on the cpu
  // fallback, which is past the feed's own ~10fps.
  const canDetect = detect && !pip;
  useEffect(() => {
    if (!canDetect || state !== "live") { setDetState("off"); return; }
    let alive = true, model = null, busy = false;
    setDetState("loading");
    loadDetector().then((m) => { if (alive) { model = m; setDetState("on"); } })
      .catch(() => { if (alive) setDetState("failed"); });
    const id = setInterval(async () => {
      const img = imgRef.current, cv = boxRef.current;
      if (!model || busy || !img || !cv || !img.naturalWidth) return;
      busy = true;
      try {
        const boxes = await detectUpright(model, img, 20, DET_MIN_SCORE, rot);
        if (!alive) return;
        if (cv.width !== img.naturalWidth) { cv.width = img.naturalWidth; cv.height = img.naturalHeight; }
        drawBoxes(cv.getContext("2d"), boxes, cv.width, cv.height, rot);
      } catch {  }
      finally { busy = false; }
    }, DET_MS);
    return () => { alive = false; clearInterval(id); };
  }, [canDetect, state, rot]);

  useEffect(() => {
    if (state !== "live") return;
    const id = setInterval(() => {
      if (Date.now() - lastFrame.current > STALL_MS) setNonce(n => n + 1);
    }, 1000);
    return () => clearInterval(id);
  }, [state]);

  useEffect(() => {
    if (state !== "loading") return;
    const id = setTimeout(fail, 12000);
    return () => clearTimeout(id);
  }, [state, nonce, host, fail]);

  useEffect(() => {
    if (state !== "offline") return;
    const id = setTimeout(() => {
      setHost(h => nextCamHost(cam, h));
      setState("loading"); setNonce(n => n + 1);
    }, 5000);
    return () => clearTimeout(id);
  }, [state, cam]);

  const base = camUrl(host);

  const applyHost = (v) => {
    const h = v.trim() || CAM_DEFAULTS[cam];
    localStorage.setItem(camKey("camHost", cam), h);
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

  const turn = () => {
    const v = ROTS[(ROTS.indexOf(rot) + 1) % ROTS.length];
    setRot(v);
    localStorage.setItem(camKey("camRot", cam), v);
  };

  // Sage grabs her own stills server-side, so the angle has to go with it -- for
  // both cams now that she can ask for the gripper view. Posting it without the
  // cam index is exactly how her vision goes sideways. It rides on MOUNT and not
  // just on the button: the angle is per rig in localStorage, the server's is a
  // process-lifetime default (CAM_ROTATE), so after any reload or server restart
  // the two disagreed until somebody happened to press ROTATE -- the feed looked
  // right and every still she read, and every one shown in the transcript, was
  // 90deg off.
  useEffect(() => {
    fetch("/api/cam-rot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: rot, cam }) }).catch(() => {});
  }, [rot, cam]);

  const pick = (varName, val) => {
    setPicks(p => ({ ...p, [varName]: val }));
    fetch(`http://${host}/control?var=${varName}&val=${val}`)
      .then(() => { if (varName === "framesize") forceAwb(); })
      .catch(() => {});
  };

  return html`
    <div class=${"stage-view stage-view--cam" + (pip ? " is-pip" : "")}>
      ${state !== "offline"
        ? html`<${React.Fragment}>
            <img ref=${imgRef} alt="" class="cam-feed" style=${{ "--cam-rot": rot + "deg" }} />
            ${canDetect ? html`<canvas ref=${boxRef} class="cam-feed cam-boxes" aria-hidden="true" style=${{ "--cam-rot": rot + "deg" }} />` : null}
          <//>`
        : html`<div class="viewport-fallback">${t("cam.offline")}<br/>
            <small>${base}</small><br/>
            <input type="text" class="cam-host" defaultValue=${host} aria-label=${t("zone.camera")}
              placeholder=${CAM_DEFAULTS[cam]}
              onKeyDown=${(e) => { if (e.key === "Enter") applyHost(e.target.value); }}
              onBlur=${(e) => applyHost(e.target.value)} /><br/>
            <button type="button" class="btn" onClick=${() => { setState("loading"); setNonce(n => n + 1); }}>${t("cam.retry")}</button>
          </div>`}
      <span class="stage-chip">${t("cam.tag." + state)}</span>
      ${pip ? html`<button type="button" class="cam-swap" onClick=${onSwap}
        title=${t("cam.swap")} aria-label=${t("cam.swap")}></button>` : null}
      ${state === "live" && !pip ? html`
        <div class="cam-tools">
          <button type="button" class=${"hud-btn" + (detect ? " is-active" : "")} aria-pressed=${detect}
            onClick=${() => { const v = !detect; setDetect(v); localStorage.setItem("camDetect", v ? "1" : "0"); }}>
            ${t("cam.detect")}${detect && detState !== "on" ? " · " + t("cam.detect." + detState) : ""}</button>
          <button type="button" class="hud-btn" onClick=${turn}
            title=${t("cam.rotate")}>${t("cam.rotate")} · ${rot}°</button>
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

// Both feeds run at once -- the arm cam is for lining the gripper up, which you do
// while driving. The two CamViews stay mounted in a fixed order and only swap a
// class: keying them on which one is big would tear down and reopen both streams
// on every tap, and a reopened stream is ~12s of "loading".
function CamStage() {
  const [main, setMain] = useState(() => Number(localStorage.getItem("camMain")) || 0);
  const swap = (cam) => { setMain(cam); localStorage.setItem("camMain", String(cam)); };
  return html`
    <${React.Fragment}>
      ${[0, 1].map(cam => html`
        <${CamView} key=${cam} cam=${cam} pip=${cam !== main} onSwap=${() => swap(cam)} />`)}
    <//>`;
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

// ---- pane splitters ----
// Drag a divider and the pane AFTER it takes a fixed px size; the pane before it
// keeps flex:1 and absorbs the rest, so panes always tile — no gaps, no overlap,
// no second layout to keep in step. Sizes are per rig in localStorage;
// double-click or Enter hands the pane back to the stylesheet.
// IMPORTANT NOTE: dead under 1024px — that layout stacks everything into one
// column and a pinned px size there is just a broken pane.
const SPLIT_MIN = 120;
function Split({ id, axis = "x" }) {
  const ref = useRef(null);
  const key = "split." + id;
  const y = axis === "y";
  // px === null hands the pane back to css.
  const size = (px) => {
    const pane = ref.current?.nextElementSibling;
    if (!pane) return;
    if (px == null) { pane.style.flex = ""; localStorage.removeItem(key); return; }
    const box = ref.current.parentElement;
    const room = (y ? box.clientHeight : box.clientWidth) - SPLIT_MIN;
    const v = Math.round(Math.min(Math.max(px, SPLIT_MIN), Math.max(SPLIT_MIN, room)));
    pane.style.flex = `0 0 ${v}px`;
    try { localStorage.setItem(key, v); } catch {}
  };
  useEffect(() => {
    if (window.innerWidth <= 1024) return;
    const v = +localStorage.getItem(key);
    if (v) size(v);
  }, []);
  const down = (e) => {
    const pane = ref.current.nextElementSibling;
    const from = y ? pane.offsetHeight : pane.offsetWidth;
    const p0 = y ? e.clientY : e.clientX;
    e.currentTarget.setPointerCapture(e.pointerId);
    // dragging toward the pane shrinks it, which is what a divider does
    const move = (ev) => size(from - ((y ? ev.clientY : ev.clientX) - p0));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const keys = (e) => {
    const pane = ref.current.nextElementSibling;
    const step = { ArrowLeft: 1, ArrowUp: 1, ArrowRight: -1, ArrowDown: -1 }[e.key];
    if (step) { e.preventDefault(); size((y ? pane.offsetHeight : pane.offsetWidth) + step * (e.shiftKey ? 40 : 10)); }
    else if (e.key === "Enter") { e.preventDefault(); size(null); }
  };
  return html`<div ref=${ref} class=${"split split--" + axis} role="separator" tabIndex="0"
    aria-orientation=${y ? "horizontal" : "vertical"} aria-label=${t("split.resize")}
    onPointerDown=${down} onDblClick=${() => size(null)} onKeyDown=${keys} />`;
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

function JudgeView({ packet, connected, ai, feed }) {
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
        ${feed?.length ? html`<div class="judge-chat">
          <span class="judge-key">${t("zone.agent")}</span>
          <div class="judge-chat-log" role="log" aria-live="polite">
            ${feed.slice().reverse().map(e => html`<${FeedLine} key=${e.id} e=${e} onAnswer=${() => {}} />`)}
          </div>
        </div>` : null}
      </div>
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
  armcam:   { icon: "camera", label: "tool.armcam",  of: "tool.lookAt" },
  sensors:  { icon: "timer",  label: "tool.sensors",  of: "tool.readingsOf" },
  snapshot: { icon: "step",   label: "tool.snapshot" },
  finding:  { icon: "warn",   label: "tool.finding" },
  lamp:     { icon: "gear",   label: "tool.lamp" },
  ask:      { icon: "mic",    label: "tool.ask" },
  analysis: { icon: "camera", label: "tool.analysis" },
};

// One card for every yes/no Sage puts in front of the operator: a drive move, an
// arm move, or a tool call waiting on CONSOLE -> ASK FIRST. Nothing happens until
// the operator presses it, and NO sends nothing at all.
function AskCard({ e, onAnswer }) {
  const st = e.state || "pending";
  return html`<div class=${"fl fl-move is-" + st}>
    <span class="fl-mark">◆</span>
    <div class="fl-body">
      <p class="fl-t">${e.title}</p>
      ${e.code ? html`<pre class="fl-code">${e.code}</pre>` : null}
      ${e.detail ? html`<p class="fl-detail">└ ${e.detail}</p>` : null}
      ${e.warn ? html`<p class="fl-detail fl-guard"><${Icon} n="warn" /> ${e.warn}</p>` : null}
      ${st === "pending" ? html`<div class="fl-btns">
        <button type="button" class="term-chip is-go" onClick=${() => onAnswer(e, true)}>▶ ${t(e.yes || "move.yes")} <i class="fl-pad">✕</i></button>
        <button type="button" class="term-chip" onClick=${() => onAnswer(e, false)}>${t(e.no || "move.no")} <i class="fl-pad">○</i></button>
      </div>` : html`<p class=${"fl-detail fl-st is-" + st}>└ ${t("move.st." + st)}${e.note ? ` · ${e.note}` : ""}</p>`}
    </div></div>`;
}

const ASK_KINDS = {
  move: (e) => ({
    title: t("move.asks"), code: e.text,
    detail: typeof e.board === "number" ? t("move.onBoard", { n: e.board }) : t("move.inBrowser", { why: e.board || "?" }),
    warn: e.guarded ? t("move.guarded", { n: e.guarded, cm: GUARD_CM }) : null,
  }),
  arm: (e) => ({ title: t("arm.asks"), code: e.text, detail: t("arm.steps", { n: e.tape.length }) }),
  tape: (e) => ({ title: t("tape.asks"), code: e.text, detail: t("tape.steps", { n: e.tape.length, s: Math.round(e.dur / 1000) }) }),
  confirm: (e) => ({
    title: t("confirm.asks", { what: t((TOOLS[e.name] || {}).label || "tool.unknown") }),
    detail: e.arg || null, yes: "confirm.yes", no: "confirm.no",
  }),
};

function FeedLine({ e, onAnswer }) {
  const fields = ASK_KINDS[e.kind];
  if (fields) return html`<${AskCard} e=${{ ...e, ...fields(e) }} onAnswer=${onAnswer} />`;
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

function Feed({ feed, ai, onAsk, onAnswer }) {
  const ref = useRef(null);
  useEffect(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }, [feed.length, ai.analyzing, ai.text]);
  return html`
    <div class="term-feed" ref=${ref} role="log" aria-live="polite">
      ${feed.length === 0 ? html`
        <div class="term-hint">
          <p class="term-hint-t">${t("term.hint")}</p>
          ${ASK_SUGGESTIONS.slice(0, 3).map(q => html`<button key=${q} type="button" class="term-chip"
            onClick=${() => onAsk(t(q))}>${t(q)}</button>`)}
        </div>` : feed.map(e => html`<${FeedLine} key=${e.id} e=${e} onAnswer=${onAnswer} />`)}
      ${ai.analyzing ? html`<div class="fl fl-work">
        <span class="fl-mark">◐</span>
        <div class="fl-body"><p class="fl-t">${t(ai.phase === "speaking" ? "timing.synth" : "timing.thinking")}${" "}
          <b><${Stopwatch} since=${ai.since || Date.now()} /></b></p></div>
      </div>` : null}
    </div>`;
}

function Agent({ ai, tts, ttsProv, hasDeepgram, confirm, onConfirm, packet, connected, speaking, chats, activeChat, feed, onNewChat, onSelectChat, onDeleteChat, onBrief, onSpeak, onAnalyze, onToggleTts, onToggleTtsProvider, onMock, onAsk, onReport, onAnswer }) {
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
          ${""}
          <button type="button" class=${"term-perm is-" + (confirm ? "ask" : "bypass")}
            onClick=${onConfirm} aria-pressed=${!!confirm} title=${t("agent.permTitle")}>
            <${Icon} key=${confirm} n=${confirm ? "shield" : "shield-off"} />
            <span class="term-perm-t" key=${"t" + confirm}>${t(confirm ? "agent.permAsk" : "agent.permBypass")}</span>
          </button>
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
        <${Feed} feed=${feed} ai=${ai} onAsk=${onAsk} onAnswer=${onAnswer} />
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
// full-scale for the meter — speech peaks around 0.2 rms, so a bar that only fills
// at 1.0 never moves. Bench knob: raise it if the meter pins on a loud room.
const LVL_FULL = 0.25;

function useMic(onText) {
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState(false);
  const recRef = useRef(null);
  // the level meter is a css var written straight onto the button, never state:
  // the fpv mic's hook lives at the app root, and a 10Hz setState there re-renders
  // the whole dashboard to move a 2px bar.
  const btnRef = useRef(null);
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
      recRef.current = null; setListening(false); setHeard(false);
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
    // the silence cut is only armed once speech has actually been heard: counting
    // from mic-open cut the operator off during their own reaction time (~2s), which
    // is why a press-talk-press cycle worked and press-talk did not. MIC_MAX_MS is
    // what bounds a press with nobody speaking.
    let loudAt = 0;
    const tick = setInterval(() => {
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) { const d = (v - 128) / 128; sum += d * d; }
      const rms = Math.sqrt(sum / buf.length);
      btnRef.current?.style.setProperty("--lvl", Math.min(1, rms / LVL_FULL).toFixed(2));
      if (rms > SIL_RMS) { if (!loudAt) setHeard(true); loudAt = Date.now(); }
      if (loudAt && Date.now() - loudAt > SIL_MS && rec.state === "recording") rec.stop();
    }, 100);
    stopWatch = () => {
      clearInterval(tick); ac.close().catch(() => {});
      btnRef.current?.style.removeProperty("--lvl");
    };

    recRef.current = rec; setListening(true); setHeard(false); rec.start();
    setTimeout(() => { if (rec.state === "recording") rec.stop(); }, MIC_MAX_MS);
  }, [onText]);
  return { listening, heard, toggle, btnRef, supported: canMic };
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
          ${mic.supported ? html`<button type="button" ref=${mic.btnRef} class=${"ask-mic brief-mic" + (mic.listening ? " is-live" : "") + (mic.heard ? " is-heard" : "")}
            onClick=${mic.toggle} disabled=${busy} aria-pressed=${mic.listening}>
            <${Icon} n="mic" /> ${!mic.listening ? t("brief.speak") : mic.heard ? t("brief.heard") : t("brief.listening")}</button>` : null}
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
  return html`<button type="button" ref=${mic.btnRef} class=${"btn foot-icon ask-mic" + (mic.listening ? " is-live" : "") + (mic.heard ? " is-heard" : "")} onClick=${mic.toggle}
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
      ${!VIEWER && html`
        <button type="button" class=${"console-btn" + (consoleOpen ? " is-active" : "")}
          onClick=${onConsole} aria-pressed=${consoleOpen} title=${t("serial.toggleTitle")}>
          ▤ ${t("drawer.console")}
        </button>`}
    </header>`;
}

const SAVERS = ["saverOff", "matrix", "saverBounce", "saverStars", "saverTetris"];

function Drawer({ open, tab, onTab, onClose, logs, serialLines, onClearSerial, chat, onCmd, onAnalyze, onNote, onSay, enabled, onTutorial, saver, onSaver, moves, onMoves, lamp, onLamp, buzz, onBuzz, demo, onDemo }) {
  if (!open) return null;
  const tabs = [["logs", t("zone.logs")], ["findings", t("zone.analysis")], ["serial", t("zone.serial")], ["motor", t("colo.motor")], ["tapes", "Tapes"]];
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
        <button type="button" class=${"serial-btn drawer-lamp" + (lamp ? " is-on" : "")}
          aria-pressed=${!!lamp} onClick=${onLamp} title=${t("drawer.lampTitle")}>
          ${t("drawer.lamp")}: ${t(lamp ? "drawer.on" : "drawer.off")}
        </button>
        ${""}
        <button type="button" class=${"serial-btn drawer-demo" + (demo ? " is-on" : "")}
          aria-pressed=${!!demo} onClick=${onDemo} title=${t("drawer.demoTitle")}>
          ${t("drawer.demo")}: ${t(demo ? "drawer.on" : "drawer.off")}
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
        : tab === "tapes" ? html`<${Tapes} onCmd=${onCmd} onAnalyze=${onAnalyze} onNote=${onNote} onSay=${onSay} enabled=${enabled} />`
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
            ${board(t("update.esp32cam"), boards.esp32cam,
              boards.esp32cam > 1 ? t("update.detectedN", { n: boards.esp32cam }) : null)}
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
    socketRef.current?.emit("feed", item);
    return item.id;
  }, []);

  // A tape's spoken line is Sage talking, so it goes in the transcript as an
  // ordinary ● row — the log is for the machinery (@log), not for her voice.
  const sayFeed = useCallback((line) => { pushFeed({ text: line }); }, [pushFeed]);

  const patchFeed = useCallback((id, patch) => {
    const chat = activeRef.current;
    if (!chat) return;
    setChats(cs => cs.map(c => c.id === chat.id
      ? { ...c, feed: (c.feed || []).map(f => f.id === id ? { ...f, ...patch } : f) } : c));
    socketRef.current?.emit("feed", { id, patch });
  }, []);

  const [confirm, setConfirm] = useState(() => localStorage.getItem("sageConfirm") !== "false");
  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;
  const toggleConfirm = useCallback(() => setConfirm(c => { localStorage.setItem("sageConfirm", String(!c)); return !c; }), []);

  const [moves, setMoves] = useState(() => localStorage.getItem("sageMoves") !== "false");
  const movesRef = useRef(moves);
  movesRef.current = moves;
  const toggleMoves = useCallback(() => setMoves(m => { localStorage.setItem("sageMoves", String(!m)); return !m; }), []);

  // SAGE LAMP off (the default) means she never writes the headlamp on her own —
  // asking her for it in words still works, the server reads that off the turn.
  const [lamp, setLamp] = useState(() => localStorage.getItem("sageLamp") !== "false");
  const lampRef = useRef(lamp);
  lampRef.current = lamp;
  const toggleLamp = useCallback(() => setLamp(l => { localStorage.setItem("sageLamp", String(!l)); return !l; }), []);
  useEffect(() => { localStorage.setItem("chats", JSON.stringify(chats)); }, [chats]);
  useEffect(() => { localStorage.setItem("activeChat", activeId); }, [activeId]);
  useEffect(() => { localStorage.setItem("ttsProvider", ttsProv); ttsProviderRef = ttsProv; }, [ttsProv]);
  useEffect(() => {
    fetch("/api/tts/providers").then(r => r.json()).then(d => {
      setHasDeepgram(d.deepgram);
      if (!d.deepgram) setTtsProv("edge");
    }).catch(() => {});
  }, []);

  // what the judge tablet shows: the host's transcript, relayed. Own state because
  // chats live in the host's localStorage and never reach another browser.
  const [mirrorFeed, setMirrorFeed] = useState([]);

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
  const [demo, setDemo] = useState(() => localStorage.getItem("demoMode") === "1");
  const toggleDemo = useCallback(() => setDemo(d => { localStorage.setItem("demoMode", d ? "0" : "1"); return !d; }), []);
  const [demoTick, setDemoTick] = useState(0);
  useEffect(() => {
    if (!demo) return;
    const id = setInterval(() => setDemoTick(n => n + 1), 1000);  // stale packets stop re-rendering; keep the wander alive
    return () => clearInterval(id);
  }, [demo]);

  const view = demo ? demoFill(fresh ? packet : {}, Date.now()) : fresh ? packet : null;
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
    // Mid-tape her analysis lands in the queue with the scripted lines — speak()
    // opens with stopSpeech(), so it used to cut whatever the run was saying.
    // Off a tape a new turn still cuts in, which is the interruption we want.
    (armLedger.tapeOn ? speakQueued : speak)(text, {
      onStart: () => { setSpeaking(true); socketRef.current?.emit("speaking", true); setAi(p => ({ ...p, phase: null, tts: Date.now() - t })); },
      onEnd: () => { setSpeaking(false); socketRef.current?.emit("speaking", false); },
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

    // Sage is holding a tool until the operator answers. A card she never gets an
    // answer to times out server-side as NO, so a closed tab is never a yes.
    socket.on("sage-confirm", d => {
      if (!d?.id) return;
      pushFeed({ kind: "confirm", confirmId: d.id, name: d.name, arg: d.arg || null, state: "pending" });
    });

    socket.on("sage-step", d => {
      if (!d?.name) return;
      if (d.say) pushFeed({ kind: "sage", text: d.say });
      pushFeed({ kind: "tool", name: d.name, arg: d.arg || null, detail: d.detail || "", img: d.img || null });
      addLog(t("log.tool", { name: d.name, detail: d.detail || "" }), "ai");
    });

    // The lamp has one level and three people reaching for it (this slider, Sage,
    // the dark ramp). The server echoes every change; a window event carries it to
    // whichever CamViews are mounted without threading the socket through them.
    socket.on("led", v => window.dispatchEvent(new CustomEvent("cam-led", { detail: v })));

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

    // the server borrows Sage's still off the live feed rather than opening a
    // second stream on a cam that only serves one
    socket.on("cam-frame", (cam, ack) => {
      const f = camFrames[cam || 0];
      ack(f && Date.now() - f.at < FRAME_LEND_MS ? f.bytes : null);
    });
    socket.on("mission-ack", d => { if (d?.text) sayAgent(d.text, d.timestamp, t("log.missionAck"), "ai", d.status); });

    socket.on("feed", d => setMirrorFeed(f => !d ? f : d.patch
      ? f.map(x => x.id === d.id ? { ...x, ...d.patch } : x)
      : [...f, d].slice(-40)));
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

  const analyze = useCallback((mode, focus, cam) => {
    if (analyzingRef.current) return;
    analyzingRef.current = true;
    setAi(p => ({ ...p, analyzing: true, badge: "badge.analyzing", phase: "thinking", since: Date.now(), llm: null, tts: null }));
    socketRef.current?.emit("request-analysis", { mode: mode || null, prompt: focus || null, cam: cam ?? anaCam() });
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

    // the board's black box, dumped on every connect: why the LAST link died
    if (line.startsWith("E:log")) {
      if (!line.startsWith("E:logend")) {
        const [, ms, ...rest] = line.split(",");
        addLog(`board ${(+ms / 1000).toFixed(1)}s — ${rest.join(",")}`, "system");
      }
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
    tapeWatch(word);
    const { device, cmd } = bleRef.current;

    if (!device?.gatt?.connected) {
      if (socketRef.current?.connected) { socketRef.current.emit("cmd", word); return true; }
      toast(t("toast.cmdNoLink"), "danger"); return false;
    }
    if (!cmd) { toast(t("toast.cmdNoChar"), "danger"); return false; }
    try {
      // A with-response write costs an ATT ack, so it is round-trip bound at the
      // connection interval -- ~2x the latency of a fire-and-forget write, and it
      // serializes behind every write already queued. The high-rate manual traffic
      // (drv/arm, resent every 300ms against the board's deadman) doesn't need the
      // ack: a dropped one is replaced 300ms later. `stop` and the blk upload do --
      // stop must not be droppable, and the ack is what paces `blk,i,` lines so
      // they can't outrun the board's parser.
      const acked = word === "stop" || word.startsWith("blk,");
      const buf = new TextEncoder().encode(word);
      await bleWrite(() => (acked || !cmd.writeValueWithoutResponse)
        ? cmd.writeValue(buf)
        : cmd.writeValueWithoutResponse(buf));

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
      panicStop(sendCmdRef.current);
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
        // ask for the black box now that notifications are subscribed: the reason
        // for the last disconnect lands in the log before the next run starts
        cmd?.writeValue(new TextEncoder().encode("log,")).catch(() => {});
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
    // The server already resolved her arm proposal or her recorded run into a
    // {ms, cmd} tape — the same shape armrec.py records — so a card is one press
    // away from the pad, or from the TAPES tab's play button.
    // It plays with no press when the take's own file says so
    // (`sage_ask_permission_for_this: false` — a spoken hello is not a thing to
    // ask permission for), and BYPASS plays anything. `ask` comes off the file,
    // never off the card, so a run that drives keeps its YES in both modes.
    const propose = (kind, p, extra = {}) => {
      const ask = p.ask !== false && confirmRef.current;
      const id = pushFeed({ kind, text: p.text, tape: p.tape, state: ask ? "pending" : "running", ...extra });
      if (ask || id == null) return;
      if (kind === "tape")
        tapePlay(p.tape, { onCmd: sendCmd, onAnalyze: analyze, onNote: (n) => addLog(n, "ai"), onSay: sayFeed })
          .then(() => patchFeed(id, { state: "done" }));
      else setTimeout(() => patchFeed(id, { state: "done" }), armPlay(p.tape, sendCmd));
    };
    if (sage && sage.arm && movesRef.current) propose("arm", sage.arm);
    if (sage && sage.tape && movesRef.current)
      propose("tape", sage.tape, { dur: sage.tape.tape[sage.tape.tape.length - 1].ms });
    if (speak && ttsRef.current) speakTimed(textv);
  }, [speakTimed, pushFeed, patchFeed, sendCmd, analyze, addLog, sayFeed]);

  // A recorded run played by name — the trigger path above, and anywhere else a
  // run is started without a card in front of it.
  const runTape = useCallback(async (name) => {
    const r = await fetch(`/api/tapes/${encodeURIComponent(name)}`);
    if (!r.ok) return void addLog(`no recorded run called "${name}"`, "system");
    const steps = (await r.json()).steps || [];
    if (!steps.length) return void addLog(`recorded run "${name}" is empty`, "system");
    const id = pushFeed({ kind: "tape", text: name, tape: steps, state: "running",
      dur: steps[steps.length - 1].ms });
    await tapePlay(steps, { onCmd: sendCmd, onAnalyze: analyze, onNote: (n) => addLog(n, "ai"), onSay: sayFeed });
    if (id != null) patchFeed(id, { state: "done" });
  }, [addLog, pushFeed, patchFeed, sendCmd, analyze, sayFeed]);

  // one ask can take several visible steps — she calls her own tools server-side
  const ask = useCallback(async (text) => {
    text = (text || "").trim();
    const chat = activeRef.current;
    if (!text || !chat) return;
    addLog(t("log.operator", { text }), "system");
    pushFeed({ kind: "user", text });

    const trigger = matchCmd(norm(text));
    if (trigger?.tape) return void runTape(trigger.tape);
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
        body: JSON.stringify({ messages: next, lang: getLang(), moves: movesRef.current, lamp: lampRef.current, confirm: confirmRef.current }),
      });
      const data = await r.json();
      const sage = data.reply, ok = !!(sage && sage.text);
      if (ok) setChats(cs => cs.map(c => c.id === chat.id ? { ...c, messages: [...next, { role: "assistant", content: sage.text }].slice(-12) } : c));
      addLog(t("log.replied"), "ai");
      showSage(ok ? sage : { text: data.error || "No response.", status: null }, t0, ok);
    } catch (e) {
      setAi(p => ({ ...p, text: t("ai.comms", { msg: e.message }), badge: "badge.online", analyzing: false, phase: null }));
    }
  }, [addLog, showSage, pushFeed, sendCmd, runTape]);

  // a card only ever runs when the operator presses YES. NO sends nothing at all.
  const onAnswer = useCallback(async (item, yes) => {
    if (item.kind === "confirm") {
      socketRef.current?.emit("sage-confirm-res", { id: item.confirmId, ok: yes });
      return patchFeed(item.id, { state: yes ? "done" : "declined" });
    }
    if (!yes) return patchFeed(item.id, { state: "declined" });

    if (item.kind === "tape") {
      patchFeed(item.id, { state: "running" });
      addLog(`playing recorded run "${item.text}"`, "ai");
      tapePlay(item.tape, { onCmd: sendCmd, onAnalyze: analyze, onNote: (n) => addLog(n, "ai"), onSay: sayFeed })
        .then(() => patchFeed(item.id, { state: "done" }));
      return;
    }
    if (item.kind === "arm") {
      patchFeed(item.id, { state: "running" });
      addLog(t("log.armRun"), "ai");
      const ms = armPlay(item.tape, sendCmd);
      setTimeout(() => patchFeed(item.id, { state: "done" }), ms);
      return;
    }
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

  // The newest unanswered card is the one the gamepad and the FPV popup act on:
  // ✕ accepts, ○ declines, same faces padnav already presses and backs out with.
  const pendingAsk = (activeChat?.feed || NO_FEED).filter(e => ASK_KINDS[e.kind] && (e.state || "pending") === "pending").slice(-1)[0] || null;
  const pendingAskRef = useRef(null);
  pendingAskRef.current = pendingAsk;
  const onAnswerRef = useRef(onAnswer);
  onAnswerRef.current = onAnswer;

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
      // a card waiting on the operator owns ✕/○ outright — rec and mic can wait
      if (pendingAskRef.current) {
        if (now[3] && !was[3]) onAnswerRef.current(pendingAskRef.current, true);
        else if (now[1] && !was[1]) onAnswerRef.current(pendingAskRef.current, false);
        was = now;
        return;
      }
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
    if (!n) { stopSpeech(); setSpeaking(false); socketRef.current?.emit("speaking", false); }
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
      blocked: () => fpvRef.current || tourOpen || !!pendingAskRef.current,
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
              <button type="button" ref=${fpvMic.btnRef} class=${"hud-btn mic-lvl" + (fpvMic.listening ? " is-active" : "")}
                disabled=${!fpvMic.supported} onClick=${fpvMic.toggle} aria-pressed=${fpvMic.listening}>
                ${fpvMic.heard ? "●" : "○"} ${!fpvMic.listening ? t("ask.mic") : fpvMic.heard ? t("ask.heard") : t("ask.listening")}
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
            ${pendingAsk && html`<div class="fpv-ask" role="alertdialog">
              <${FeedLine} e=${pendingAsk} onAnswer=${onAnswer} />
            </div>`}
            ${recErr && !rec && html`<p class="rec-err" role="alert">✕ ${recErr}</p>`}
          <//>`}
        ${window.blackout?.platform === "darwin" && html`<div class="mac-titlebar"></div>`}
        <${Topbar} connected=${live} stale=${!fresh} bridge=${bridge} onBridge=${toggleBridge}
          ping=${fresh ? ping : "—"} packets=${packets} uptime=${uptime} lanUrl=${lanUrl} lanIp=${lanIp}
          lang=${lang} onLang=${changeLang} onConsole=${toggleDrawer} consoleOpen=${drawer === "open"}
          clients=${clients} onDevices=${() => setDevicesOpen("open")} granted=${granted}
          cloud=${cloud} onSettings=${() => setSettingsOpen("open")} />

        ${!VIEWER && flashBoards.status !== "none" && html`<${UpdateBar} boards=${flashBoards} onUpdate=${openUpdate} />`}

        ${judge ? html`<${JudgeView} packet=${view} connected=${live} ai=${ai} feed=${mirrorFeed} />` : html`
        <main class="cockpit" id="sensors">
          <div class="col-main">
            <div class="stage-row">
              <${ThreeDeeBox} packet=${view} onLog=${addLog} />
              <${Split} id="cam" />
              <${CamBox} packet=${view} onFpv=${() => toggleFpv(true)} />
            </div>
            <${Split} id="strip" axis="y" />
            <${SensorStrip} packet=${view} />
          </div>
          <${Split} id="rail" />
          <aside class="col-rail">
            <${Agent} ai=${ai} tts=${tts} ttsProv=${ttsProv} hasDeepgram=${hasDeepgram} confirm=${confirm} onConfirm=${toggleConfirm} packet=${view} connected=${live} speaking=${speaking}
              chats=${chats} activeChat=${activeChat} feed=${activeChat?.feed || NO_FEED} onNewChat=${newChat} onSelectChat=${selectChat}
              onDeleteChat=${deleteChat} onBrief=${briefMission} onSpeak=${speakBrief}
              onAnalyze=${analyze} onToggleTts=${toggleTts} onToggleTtsProvider=${toggleTtsProvider} onMock=${mockData} onAsk=${ask}
              onReport=${openReport} onAnswer=${onAnswer} />
            ${
              driveMounted && html`
              <${React.Fragment}>
              <${Split} id="drive" axis="y" />
              <${Drive} onCmd=${sendCmd} onAnalyze=${analyze} enabled=${canDrive} leaving=${!granted}
                busyRef=${analyzingRef} packetRef=${packetRef} />
              <//>`}
          </aside>
        </main>`}

        ${!judge && html`<${Drawer} open=${drawer} tab=${drawerTab} onTab=${setDrawerTab} onClose=${closeDrawer}
          logs=${logs} serialLines=${serialLines} onClearSerial=${clearSerial}
          chat=${activeChat} onCmd=${sendCmd} onAnalyze=${analyze} onNote=${(n) => addLog(n, "system")} onSay=${sayFeed}
          enabled=${canDrive} onTutorial=${restartTour}
          saver=${saver} onSaver=${pickSaver} moves=${moves} onMoves=${toggleMoves}
            lamp=${lamp} onLamp=${toggleLamp}
            buzz=${buzz} onBuzz=${toggleBuzz} demo=${demo} onDemo=${toggleDemo} />`}
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
