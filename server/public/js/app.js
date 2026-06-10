import React, { useState, useEffect, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import htm from "htm";
import { createRoverScene } from "./scene.js";

const html = htm.bind(React.createElement);

/* ---------------- sensor model ---------------- */
const fmt = (v, d) => (v == null || isNaN(v) ? "--" : Number(v).toFixed(d));

// min/max define the bar's full travel.
const SENSORS = [
  { key: "temp",  name: "Temp",       unit: "°C",  d: 1, min: 0, max: 60,   st: v => v > 45 ? ["Critical", "abort"] : v > 35 ? ["High", "warn"] : ["Normal", "go"] },
  { key: "humid", name: "Humidity",   unit: "%",   d: 1, min: 0, max: 100,  st: v => (v > 75 || v < 20) ? ["Out of range", "warn"] : ["Good", "go"] },
  { key: "dist",  name: "Distance",   unit: "cm",  d: 0, min: 0, max: 200,  invert: true, st: v => v < 20 ? ["Alert", "abort"] : v < 55 ? ["Caution", "warn"] : ["Clear", "go"] },
  { key: "smoke", name: "Smoke / Gas",unit: "ppm", d: 0, min: 0, max: 1000, st: v => v > 600 ? ["Hazard", "abort"] : v > 300 ? ["Warning", "warn"] : ["Normal", "go"] },
  { key: "airq",  name: "Air Qual",   unit: "ppm", d: 0, min: 0, max: 1000, st: v => v > 800 ? ["Poor", "abort"] : v > 450 ? ["Moderate", "warn"] : ["Good", "go"] },
];

const TRENDS = [
  { key: "dist", name: "Dist", color: "#778da9" },
  { key: "airq", name: "Air",  color: "#4ade80" },
  { key: "temp", name: "Temp", color: "#f87171" },
];

/* ---------------- TTS ---------------- */
let voices = [];
const loadVoices = () => { voices = window.speechSynthesis?.getVoices() || []; };
loadVoices();
if (window.speechSynthesis) speechSynthesis.onvoiceschanged = loadVoices;
function speak(text) {
  if (!text || !window.speechSynthesis || !voices.length) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 0.9; u.lang = "en-US";
  u.voice = voices.find(v => v.lang.startsWith("en") && /samantha|alex|google|enhanced/i.test(v.name))
    || voices.find(v => v.lang.startsWith("en")) || voices[0];
  speechSynthesis.speak(u);
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
    ctx.strokeStyle = "rgba(119,141,169,0.10)"; ctx.lineWidth = 1;
    for (let i = 1; i < 8; i++) { ctx.beginPath(); ctx.moveTo((i / 8) * w, 0); ctx.lineTo((i / 8) * w, h); ctx.stroke(); }
    for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(0, (i / 4) * h); ctx.lineTo(w, (i / 4) * h); ctx.stroke(); }
    if (H.length < 2) {
      ctx.fillStyle = "rgba(119,141,169,0.6)"; ctx.font = `${11 * devicePixelRatio}px 'IBM Plex Sans', sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("Awaiting telemetry", w / 2, h / 2); return;
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

/* ---------------- gauge (vertical level bar) ---------------- */
function Gauge({ s, value, delay }) {
  const has = value != null && !isNaN(value);
  const [label, kind] = has ? s.st(value) : ["—", ""];
  const raw = has ? Math.max(0, Math.min(100, ((value - s.min) / (s.max - s.min)) * 100)) : 0;
  const pct = s.invert ? 100 - raw : raw;
  return html`
    <article class="panel gauge reveal" style=${{ animationDelay: delay + "ms" }}>
      <div class="gauge-top">
        <h2 class="gauge-name">${s.name}</h2>
        <span class=${"pill " + (kind ? "is-" + kind : "")}>${label}</span>
      </div>
      <div class="bar" role="meter" aria-label=${s.name}
        aria-valuenow=${has ? Number(value) : undefined} aria-valuemin=${s.min} aria-valuemax=${s.max}>
        <div class=${"bar-fill " + (kind ? "is-" + kind : "")} style=${{ height: pct + "%" }}></div>
        <div class="bar-val">
          <span class="bar-num">${fmt(value, s.d)}</span><span class="bar-unit">${s.unit}</span>
        </div>
      </div>
    </article>`;
}

/* ---------------- orientation ---------------- */
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
    <section class="panel reveal" style=${{ animationDelay: "260ms" }} aria-labelledby="vis-h">
      <div class="panel-head">
        <h2 id="vis-h">Orientation</h2>
        <span class="tag">${packet ? "Gyro · Locked" : "Gyro · Standby"}</span>
      </div>
      <div class="viewport">
        <canvas id="vis-canvas" ref=${canvasRef}></canvas>
        ${failed && html`<div class="viewport-fallback">3D view unavailable<br/><small>${failed} — telemetry below is live</small></div>`}
        <div class="hud">
          <div class="hud-cams" role="group" aria-label="Camera angle">
            ${cams.map(c => html`<button key=${c} type="button"
              class=${"btn btn--ghost" + (cam === c ? " is-active" : "")}
              onClick=${() => pick(c)}>${c}</button>`)}
          </div>
          <div class="compass" aria-hidden="true">
            <svg ref=${compassRef} viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(119,141,169,0.45)" stroke-width="1.5"/>
              <text x="50" y="25" fill="#778da9" font-size="12" font-weight="700" text-anchor="middle" font-family="IBM Plex Sans, sans-serif">N</text>
              <polygon points="50,15 45,50 55,50" fill="#f87171"/>
              <polygon points="50,85 45,50 55,50" fill="rgba(224,225,221,0.4)"/>
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
    </section>`;
}

/* ---------------- trends panel ---------------- */
function TrendsPanel({ packet }) {
  return html`
    <section class="panel reveal" style=${{ animationDelay: "320ms" }} aria-labelledby="tr-h">
      <div class="panel-head">
        <h2 id="tr-h">Trends</h2>
        <div class="legend" aria-label="Series">
          ${TRENDS.map(s => html`<span key=${s.key}><i style=${{ background: s.color }}></i>${s.name}</span>`)}
        </div>
      </div>
      <div class="trend-body"><${Trends} packet=${packet} /></div>
    </section>`;
}

/* ---------------- AI panel ---------------- */
function AIPanel({ ai, tts, onAnalyze, onToggleTts, onPick }) {
  return html`
    <section class=${"panel reveal" + (ai.analyzing ? " is-analyzing" : "")} style=${{ animationDelay: "380ms" }} aria-labelledby="ai-h">
      <div class="panel-head">
        <h2 id="ai-h">AI Analysis</h2>
        <span class="tag">${ai.badge}</span>
      </div>
      <div class="panel-body ai-body">
        <p class="ai-out" role="status" aria-live="polite">${ai.text}</p>
        <div class="ai-foot">
          <button class="btn btn--go" type="button" onClick=${onAnalyze} disabled=${ai.analyzing}>
            ${ai.analyzing ? "Analyzing…" : "Analyze now"}
          </button>
          <label class="switch">
            <input type="checkbox" checked=${tts} onChange=${onToggleTts} />
            <span class="switch-track" aria-hidden="true"><span class="switch-knob"></span></span>
            Voice
          </label>
        </div>
        <details class="ai-hist">
          <summary>History · ${ai.history.length}</summary>
          <div class="ai-hist-list">
            ${ai.history.map(h => html`
              <div key=${h.id} class="ai-hist-item" onClick=${() => onPick(h.text)}>
                <span class="ai-hist-time">${h.time}</span>${h.text.length > 90 ? h.text.slice(0, 90) + "…" : h.text}
              </div>`)}
          </div>
        </details>
      </div>
    </section>`;
}

/* ---------------- logs ---------------- */
function Logs({ logs }) {
  const [f, setF] = useState("all");
  const tabs = [["all", "All"], ["system", "System"], ["alerts", "Alerts"], ["ai", "AI"]];
  const view = logs.filter(l => f === "all" ? true : f === "alerts" ? (l.type === "warn" || l.type === "danger") : l.type === f);
  return html`
    <section class="panel logs reveal" style=${{ animationDelay: "440ms" }} aria-labelledby="log-h">
      <div class="panel-head"><h2 id="log-h">Activity Log</h2></div>
      <div class="log-tabs" role="tablist">
        ${tabs.map(([k, lbl]) => html`<button key=${k} type="button" role="tab" aria-selected=${f === k}
          class=${"log-tab" + (f === k ? " is-active" : "")} onClick=${() => setF(k)}>${lbl}</button>`)}
      </div>
      <div class="log-stream" role="log" aria-live="polite">
        ${view.map(l => html`<div key=${l.id} class=${"log-line k-" + l.type}>
          <span class="t">${l.time}</span><span class="m">${l.text}</span></div>`)}
      </div>
    </section>`;
}

/* ---------------- top bar ---------------- */
function TopBar({ connected, ports, currentPort, ping, packets, uptime, onPort }) {
  return html`
    <header class="panel console-top reveal">
      <div class="brand">
        <div class="brand-text"><h1>BLACKOUT</h1></div>
      </div>
      <div class="console-status">
        <p class="lamp" role="status" aria-live="polite">
          <span class=${"lamp-dot " + (connected ? "is-go" : "is-abort")}></span>
          <span class="lamp-label">${connected ? "Link Live" : "No Signal"}</span>
        </p>
        <label class="lamp">
          <span class="visually-hidden">Serial port</span>
          <select class="port-select" value=${currentPort || ""} onChange=${e => onPort(e.target.value)}>
            ${ports.length === 0 && html`<option value="">no ports</option>`}
            ${ports.map(p => html`<option key=${p} value=${p}>${p}</option>`)}
          </select>
        </label>
        <dl class="readouts">
          <div class="readout"><dt>Ping</dt><dd>${ping}</dd></div>
          <div class="readout"><dt>Packets</dt><dd>${packets}</dd></div>
          <div class="readout"><dt>Uptime</dt><dd>${uptime}</dd></div>
        </dl>
      </div>
    </header>`;
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
  const [ai, setAi] = useState({ text: "Awaiting telemetry…", badge: "Standby", analyzing: false, history: [] });
  const [tts, setTts] = useState(() => localStorage.getItem("tts") !== "false");
  const [ports, setPorts] = useState([]);
  const [currentPort, setCurrentPort] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [uptime, setUptime] = useState("00:00:00");

  const socketRef = useRef(null);
  const ttsRef = useRef(localStorage.getItem("tts") !== "false");
  const lastObstacle = useRef(0);
  const lastDist = useRef(0);

  const addLog = useCallback((text, type = "system") => {
    setLogs(p => [...p, { text, type, time: new Date().toLocaleTimeString(), id: Date.now() + Math.random() }].slice(-80));
  }, []);
  const toast = useCallback((msg, kind = "system") => {
    const id = Date.now() + Math.random();
    setToasts(p => [...p, { msg, kind, id }]);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 3600);
  }, []);

  // socket
  useEffect(() => {
    const url = window.location.port !== "3000" ? "http://localhost:3000" : undefined;
    const socket = window.io(url);
    socketRef.current = socket;

    socket.on("connect", () => { setConnected(true); addLog("Link established. Awaiting telemetry…", "system"); });
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
    });
    socket.on("ai-analysis", d => {
      if (!d?.analysis) return;
      addLog("AI analysis received.", "ai");
      setAi(p => ({
        text: d.analysis, badge: "Online", analyzing: false,
        history: [...p.history, { text: d.analysis, time: new Date(d.timestamp || Date.now()).toLocaleTimeString(), id: Date.now() + Math.random() }].slice(-20),
      }));
      if (ttsRef.current) speak(d.analysis);
    });
    addLog("Console booted. Standing by.", "system");
    return () => socket.close();
  }, [addLog]);

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
    setAi(p => ({ ...p, analyzing: true, badge: "Analyzing…" }));
    socketRef.current?.emit("request-analysis");
  }, []);
  const toggleTts = useCallback(() => setTts(p => { const n = !p; ttsRef.current = n; localStorage.setItem("tts", n); return n; }), []);
  const pickHistory = useCallback((text) => setAi(p => ({ ...p, text })), []);

  return html`
    <${React.Fragment}>
      <${TopBar} connected=${connected} ports=${ports} currentPort=${currentPort}
        ping=${ping} packets=${packets} uptime=${uptime} onPort=${switchPort} />

      <main class="deck">
        <section class="bay" id="sensors" aria-label="Live sensor readings">
          ${SENSORS.map((s, i) => html`<${Gauge} key=${s.key} s=${s} value=${packet?.[s.key]} delay=${60 + i * 45} />`)}
        </section>

        <div class="deck-row deck-row--mid">
          <${Orientation} packet=${packet} onLog=${addLog} />
          <${TrendsPanel} packet=${packet} />
        </div>

        <div class="deck-row deck-row--bot">
          <${AIPanel} ai=${ai} tts=${tts} onAnalyze=${analyze} onToggleTts=${toggleTts} onPick=${pickHistory} />
          <${Logs} logs=${logs} />
        </div>
      </main>

      <${Toasts} items=${toasts} />
    <//>`;
}

createRoot(document.getElementById("root")).render(html`<${App} />`);
