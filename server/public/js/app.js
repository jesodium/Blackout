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
  { key: "humid", name: "Humidity",   unit: "%",   d: 1, min: 0, max: 100,  st: v => (v > 75 || v < 20) ? ["Out of range", "warn"] : ["Good", "go"] },
  { key: "dist",  name: "Distance",   unit: "cm",  d: 0, min: 0, max: 200,  invert: true, st: v => v < 20 ? ["Alert", "abort"] : v < 55 ? ["Caution", "warn"] : ["Clear", "go"] },
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
function speak(text) {
  if (!text || !window.speechSynthesis || !voices.length) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 0.9; u.lang = "en-US";
  u.voice = voices.find(v => v.lang.startsWith("en") && /samantha|alex|google|enhanced/i.test(v.name))
    || voices.find(v => v.lang.startsWith("en")) || voices[0];
  speechSynthesis.speak(u);
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
      <${Head} folio="02" title="Environment" tag="05 ch" />
      <div class="zone-body">
        ${SENSORS.map((s, i) => html`<${Reading} key=${s.key} s=${s}
          value=${packet?.[s.key]} index=${String(i + 1).padStart(2, "0")} />`)}
      </div>
    </section>`;
}

/* ---------------- trends panel ---------------- */
function TrendsPanel({ packet }) {
  return html`
    <section class="zone reveal" style=${{ animationDelay: "200ms" }} aria-labelledby="tr-h">
      <${Head} folio="03" title="Trends">
        <div class="legend" aria-label="Series">
          ${TRENDS.map(s => html`<span key=${s.key}><i style=${{ background: s.color }}></i>${s.name}</span>`)}
        </div>
      <//>
      <div class="trend-body"><${Trends} packet=${packet} /></div>
    </section>`;
}

/* ---------------- dispatch (AI) ---------------- */
function AIPanel({ ai, tts, onAnalyze, onToggleTts, onPick }) {
  return html`
    <section class=${"zone dispatch reveal" + (ai.analyzing ? " is-analyzing" : "")} style=${{ animationDelay: "260ms" }} aria-labelledby="ai-h">
      <${Head} folio="04" title="Field Analysis" tag=${ai.badge} />
      <div class="zone-body">
        <p class="ai-out" role="status" aria-live="polite">${ai.text}</p>
        <div class="ai-foot">
          <button class="btn btn--primary" type="button" onClick=${onAnalyze} disabled=${ai.analyzing}>
            ${ai.analyzing ? "Analyzing…" : "Run Analysis"}
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
                <span class="ai-hist-time">${h.time}</span>
                <span>${h.text.length > 90 ? h.text.slice(0, 90) + "…" : h.text}</span>
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
  const [ai, setAi] = useState({ text: "Awaiting telemetry…", badge: "Standby", analyzing: false, history: [] });
  const [tts, setTts] = useState(() => localStorage.getItem("tts") !== "false");
  const [ports, setPorts] = useState([]);
  const [currentPort, setCurrentPort] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [uptime, setUptime] = useState("00:00:00");
  const [serialLines, setSerialLines] = useState([]);
  const [serialHidden, setSerialHidden] = useState(() => localStorage.getItem("serialHidden") === "true");

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
    socket.on("serial-line", d => {
      if (!d?.line) return;
      setSerialLines(p => [...p, {
        text: d.line, s: d.line.startsWith("S:"),
        time: new Date(d.timestamp || Date.now()).toLocaleTimeString(),
        id: Date.now() + Math.random(),
      }].slice(-300));
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
        <${Ticker} packet=${packet} connected=${connected} />

        <main class="deck" id="sensors">
          <div class="row row--stage">
            <${Orientation} packet=${packet} onLog=${addLog} />
            <${ReadingsPanel} packet=${packet} />
          </div>

          <div class="row">
            <${TrendsPanel} packet=${packet} />
          </div>

          <div class="row row--report">
            <${AIPanel} ai=${ai} tts=${tts} onAnalyze=${analyze} onToggleTts=${toggleTts} onPick=${pickHistory} />
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
