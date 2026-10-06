import { useEffect, useRef, useState } from "react";
import { t } from "../i18n.js";
import { createRoverScene } from "../scene.js";
import { CamStage } from "./camera.js";
import { SENSORS, TRENDS, fmt, html, reads } from "./core.js";

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

export { CamBox, Head, MotorDebug, Reading, ThreeDeeBox, Trends };
