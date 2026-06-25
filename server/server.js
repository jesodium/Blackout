require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");
const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");
const OpenAI = require("openai");
const keypress = require("keypress");

const openai = new OpenAI({
  baseURL: "https://api.cerebras.ai/v1",
  apiKey: process.env.CEREBRAS_API_KEY,
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.json());
app.use(express.text({ type: "text/plain" }));
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const SERIAL_BAUD = parseInt(process.env.SERIAL_BAUD || "9600", 10);

async function listSerialPorts() {
  const { glob } = await import("glob");
  return await glob("/dev/cu.*");
}

app.get("/api/ports", async (req, res) => {
  // Hide the BT port from the dropdown — node can't read it and selecting it
  // collides with the pyserial bridge. Bluetooth is the "BT Bridge" button only.
  const ports = (await listSerialPorts()).filter(p => p !== BT_PORT);
  res.json({ ports, current: serialPort?.path || null });
});

// TTS proxy. Deepgram Aura-2 (low-latency streaming) when DEEPGRAM_API_KEY is
// set, else / on failure falls back to Microsoft Edge neural voices (free, no key).
// GET form lets an <audio> element play progressively (starts on first chunk).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DG_RETRIES = parseInt(process.env.DEEPGRAM_RETRIES || "3", 10);

async function speakDeepgram(text, res, voice = "en") {
  // Match the Aura-2 model language to the voice, else Spanish text gets spoken
  // by an English model. Override per-language via env.
  const isEs = voice.toLowerCase().startsWith("es");
  const model = isEs
    ? process.env.DEEPGRAM_VOICE_ES || "aura-2-selena-es"    // Selena — female, neutral Latin American (not regional)
    : process.env.DEEPGRAM_VOICE || "aura-2-thalia-en";      // Thalia (Sage) — female. ponytail: one fixed female voice; override via DEEPGRAM_VOICE
  const url = `https://api.deepgram.com/v1/speak?model=${model}&encoding=mp3`;
  // Retry the fetch (transient 429/5xx/network blips) BEFORE we start streaming —
  // once audio is piping we can't retry. 4xx other than 429 is permanent, bail fast.
  let r, lastErr;
  for (let i = 0; i <= DG_RETRIES; i++) {
    try {
      r = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (r.ok && r.body) break;
      const body = await r.text().catch(() => "");
      lastErr = new Error(`Deepgram ${r.status}: ${body}`);
      if (r.status < 500 && r.status !== 429) throw lastErr; // permanent (401/402/400) — don't retry, fall back now
    } catch (e) {
      if (e === lastErr) throw e; // permanent error — stop, let caller fall back to Edge
      lastErr = e;               // network/transient error — keep retrying
    }
    if (i < DG_RETRIES) await sleep(250 * (i + 1)); // 250/500/750ms backoff
  }
  if (!r || !r.ok || !r.body) throw lastErr || new Error("Deepgram failed");
  res.setHeader("Content-Type", "audio/mpeg");
  Readable.fromWeb(r.body).on("error", () => res.destroy()).pipe(res);
}

async function speakEdge(text, voice, res) {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  res.setHeader("Content-Type", "audio/mpeg");
  tts.toStream(text).audioStream.on("error", () => res.destroy()).pipe(res);
}

async function ttsHandler(req, res) {
  const src = req.method === "GET" ? req.query : req.body;
  const voice = src?.voice || process.env.TTS_VOICE || "en-US-AndrewNeural";
  const text = (src?.text || "").trim();
  const provider = src?.provider || "auto"; // "edge", "deepgram", or "auto"
  if (!text) return res.status(400).json({ error: "text required" });
  try {
    const wantDeep = provider === "deepgram" || (provider === "auto" && process.env.DEEPGRAM_API_KEY && (voice.startsWith("en") || voice.startsWith("es")));
    if (wantDeep && process.env.DEEPGRAM_API_KEY) {
      try { return await speakDeepgram(text, res, voice); }
      catch (e) { console.error("Deepgram TTS failed, falling back to Edge:", e.message); }
    }
    await speakEdge(text, voice, res);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
}
app.get("/api/tts", ttsHandler);
app.post("/api/tts", ttsHandler);

app.get("/api/tts/providers", (req, res) => {
  res.json({ edge: true, deepgram: !!process.env.DEEPGRAM_API_KEY });
});

// Ask-questions mode: operator chats with SAGE. Client sends the running
// message array (no server-side history); we prepend persona + live telemetry.
app.post("/api/chat", async (req, res) => {
  if (!process.env.CEREBRAS_API_KEY) return res.status(503).json({ error: "AI key not set" });
  const msgs = Array.isArray(req.body?.messages) ? req.body.messages.slice(-12) : [];
  if (!msgs.length) return res.status(400).json({ error: "messages required" });
  const lang = LANG_INSTRUCT[req.body?.lang] ? req.body.lang : "en";
  try {
    const ctx = latestData ? buildChatContext(latestData) : "No live readings yet — running dark.";
    const resp = await openai.chat.completions.create({
      model: process.env.CEREBRAS_MODEL || "gpt-oss-120b",
      messages: [
        { role: "system", content: CHAT_SYSTEM },
        ...langMsg(lang),
        { role: "system", content: ctx },
        ...msgs.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "") })),
      ],
      max_tokens: 400,
    });
    res.json({ reply: resp.choices[0]?.message?.content || "No response." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Process a raw line: emit to serial monitor, parse "S:" telemetry for dashboard.
function processLine(raw) {
  const line = raw.trim();
  if (!line) return;
  io.emit("serial-line", { line, timestamp: Date.now() });
  if (!line.startsWith("S:")) return;
  const parts = line.slice(2).split(",");
  if (parts.length < 8) return;
  const data = {
    temp: parseFloat(parts[0]),
    humid: parseFloat(parts[1]),
    dist: parseFloat(parts[2]),
    smoke: parseFloat(parts[3]),
    airq: parseFloat(parts[4]),
    roll: parseFloat(parts[5]),
    pitch: parseFloat(parts[6]),
    yaw: parseFloat(parts[7]),
    co: parts.length > 8 ? parseFloat(parts[8]) : 0,
    co_alert: parts.length > 9 ? parts[9].trim() === "1" : false,
    timestamp: Date.now(),
  };
  latestData = data;
  dataHistory.push(data);
  if (dataHistory.length > 1000) dataHistory.shift();
  io.emit("sensor-data", data);
  maybeAutoAnalyze(data);
}

// Pipe a readline parser onto a port.
function attachParser(sp) {
  const parser = sp.pipe(new ReadlineParser({ delimiter: "\n" }));
  parser.on("data", (raw) => processLine(raw));
}

// Accept batched sensor data from the ESP32-CAM over WiFi.
app.post("/api/mega/sensor", (req, res) => {
  let raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  if (!raw || !raw.length) return res.status(400).json({ error: "empty" });
  const lines = raw.split("\n");
  for (const l of lines) processLine(l);
  res.json({ ok: true, lines: lines.length });
});

// --- Bluetooth bridge control ---
// node's serialport can't read the macOS BT SPP port, so bt_bridge.py (pyserial)
// reads it and POSTs to /api/mega/sensor. These endpoints spawn/kill it and run
// the blueutil re-pair dance that the ESP32's BT needs for a fresh connection.
const { spawn, execFile } = require("child_process");
const BT_MAC = process.env.BT_MAC || "c8-f0-9e-a4-9f-6e";
const BT_PORT = process.env.BT_PORT || "/dev/cu.BLACKOUT-V1";
let bridgeProc = null;
let bridgeLast = "";

const sh = (cmd, args) => new Promise((res) =>
  execFile(cmd, args, { timeout: 15000 }, (e, so) => res(so || "")));

async function ensureBtPort() {
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(BT_PORT)) return true;
    await sh("blueutil", ["--connect", BT_MAC]);
    await new Promise((r) => setTimeout(r, 7000));
  }
  return fs.existsSync(BT_PORT);
}

app.get("/api/bridge", (req, res) =>
  res.json({ running: !!bridgeProc, last: bridgeLast }));

app.post("/api/bridge/start", async (req, res) => {
  if (bridgeProc) return res.json({ ok: true, already: true });
  disconnectSerial(); // Close USB when BT bridge starts
  try {
    if (req.body && req.body.repair) {
      console.log("Bridge: re-pairing BT...");
      await sh("blueutil", ["--unpair", BT_MAC]);
      await new Promise((r) => setTimeout(r, 2000));
      await sh("blueutil", ["--pair", BT_MAC]);
      await new Promise((r) => setTimeout(r, 2000));
    }
    await ensureBtPort();
  } catch (e) { /* fall through to existence check */ }
  if (!fs.existsSync(BT_PORT))
    return res.status(500).json({ error: "Bluetooth port unavailable — try Re-pair" });
  bridgeProc = spawn("python3", [path.join(__dirname, "bt_bridge.py")], {
    env: { ...process.env, BT_PORT, SERVER_URL: `http://localhost:${PORT}/api/mega/sensor` },
  });
  const cap = (d) => { bridgeLast = d.toString().trim().split("\n").pop() || bridgeLast; };
  bridgeProc.stdout.on("data", cap);
  bridgeProc.stderr.on("data", cap);
  bridgeProc.on("exit", () => { bridgeProc = null; });
  console.log("Bridge: started");

  // Wait up to 8s for the bridge to actually receive sensor data from the ESP32.
  // bt_bridge.py prints "-> S:..." for each valid line — if nothing arrives
  // the ESP32 likely isn't paired, powered, or sending.
  for (let i = 0; i < 8; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (bridgeLast.includes("-> S:")) {
      console.log("Bridge: data flowing");
      return res.json({ ok: true });
    }
    if (!bridgeProc) break; // process exited early
  }
  // No data within window — kill bridge, tell the truth, don't pretend it works
  if (bridgeProc) { bridgeProc.kill(); bridgeProc = null; }
  bridgeLast = "";
  return res.status(500).json({ error: "BT port opened but no data from ESP32 — check power, pairing, then Re-pair" });
});

app.post("/api/bridge/stop", (req, res) => {
  if (bridgeProc) { bridgeProc.kill(); bridgeProc = null; }
  bridgeLast = "";
  res.json({ ok: true });
});

// connMode: mutually exclusive BT/USB switch. Callers should only use this
// instead of manually calling bridge/start + ports/switch.
app.post("/api/connMode", async (req, res) => {
  const { mode } = req.body;
  if (!mode || !["usb", "bt"].includes(mode))
    return res.status(400).json({ error: "mode must be 'usb' or 'bt'" });

  if (mode === "bt") {
    disconnectSerial(); // close USB, block reconnect
    if (!bridgeProc) {
      try { await ensureBtPort(); } catch { /* fall through */ }
      if (!fs.existsSync(BT_PORT))
        return res.status(500).json({ error: "Bluetooth port unavailable" });
      bridgeProc = spawn("python3", [path.join(__dirname, "bt_bridge.py")], {
        env: { ...process.env, BT_PORT, SERVER_URL: `http://localhost:${PORT}/api/mega/sensor` },
      });
      const cap = (d) => { bridgeLast = d.toString().trim().split("\n").pop() || bridgeLast; };
      bridgeProc.stdout.on("data", cap);
      bridgeProc.stderr.on("data", cap);
      bridgeProc.on("exit", () => { bridgeProc = null; });
      console.log("Bridge: started via connMode switch");
    }
  } else {
    if (bridgeProc) { bridgeProc.kill(); bridgeProc = null; bridgeLast = ""; }
    connectSerial(selectedPortPath);
  }

  res.json({ ok: true, mode });
});

app.post("/api/ports/switch", async (req, res) => {
  const { path } = req.body;
  if (!path) return res.status(400).json({ error: "path required" });
  // Refuse the BT port: node-serialport can't read it and it collides with the
  // bridge's pyserial reader (corrupts both streams). Use the BT Bridge button.
  if (path === BT_PORT)
    return res.status(400).json({ error: "Use the BT Bridge button for Bluetooth, not the port selector" });
  selectedPortPath = path;
  if (serialPort) {
    serialPort.removeAllListeners("close");
    serialPort.close();
  }
  serialPort = new SerialPort({ path, baudRate: SERIAL_BAUD }, (err) => {
    if (err) {
      console.error(`Failed to open ${path}: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
    console.log(`Switched to ${path}`);
    res.json({ ok: true, path });
  });
  attachParser(serialPort);
  serialPort.on("error", (err) => {
    console.error("Serial error:", err.message);
  });
  serialPort.on("close", () => {
    console.log("Serial disconnected. Reconnecting in 5s...");
    setTimeout(() => connectSerial(selectedPortPath), 5000);
  });
});

function selectPortMenu(ports) {
  return new Promise((resolve) => {
    let selectedIndex = 0;

    function render() {
      console.clear();
      console.log("\n  Select serial port (↑/↓ arrows, Enter to confirm):\n");
      ports.forEach((port, i) => {
        const prefix = i === selectedIndex ? "▸ " : "  ";
        const marker = port.includes("usbserial") ? " ← Arduino?" : "";
        console.log(`  ${prefix}${port}${marker}`);
      });
      console.log("\n  Press 'r' to refresh, 'q' to quit\n");
    }

    function handleKey(ch, key) {
      if (!key) return;
      if (key.name === "up") {
        selectedIndex = (selectedIndex - 1 + ports.length) % ports.length;
        render();
      } else if (key.name === "down") {
        selectedIndex = (selectedIndex + 1) % ports.length;
        render();
      } else if (key.name === "return") {
        cleanup();
        resolve(ports[selectedIndex]);
      } else if (key.name === "r") {
        refreshPorts();
      } else if (key.name === "q" || (key.ctrl && key.name === "c")) {
        cleanup();
        process.exit(0);
      }
    }

    async function refreshPorts() {
      const newPorts = await listSerialPorts();
      if (newPorts.length === 0) {
        console.log("\n  No serial ports found. Waiting...");
        setTimeout(refreshPorts, 2000);
        return;
      }
      ports.length = 0;
      ports.push(...newPorts);
      selectedIndex = 0;
      render();
    }

    function cleanup() {
      process.stdin.removeListener("keypress", handleKey);
      keypress.disableMouse();
      process.stdin.pause();
    }

    keypress(process.stdin);
    process.stdin.on("keypress", handleKey);
    process.stdin.resume();

    render();
  });
}

let latestData = null;
let dataHistory = [];
let currentMission = "";   // operator's briefing — colors all agent replies until changed
let currentLanguage = "en"; // UI language — the agent must reply in this language

// One extra system line forcing the reply language. English is the default
// (prompts are written in English), so it needs no instruction.
const LANG_INSTRUCT = {
  es: "IMPORTANTE: Responde SIEMPRE en español natural y fluido, sin importar el idioma de las lecturas, etiquetas o del mensaje del operador. Mantén tu personaje y tono.",
};
const langMsg = (lang) => (LANG_INSTRUCT[lang] ? [{ role: "system", content: LANG_INSTRUCT[lang] }] : []);

// Onboarding lines spoken during the briefing wizard. Pre-rendered to
// public/audio on boot so the wizard plays them instantly (no 5-7s synth wait).
// Text + voices MUST match public/js/i18n.js (ONBOARDING + LANGS).
const ONBOARDING = {
  en: {
    voice: "en-US-AvaNeural",
    lines: {
      intro: "Hey — I'm Sage, the AI running the recon unit you're sending into the dark. Walk me through the job, one thing at a time.",
      q0: "What's the job down there — what am I going in to do?",
      q1: "What kind of place am I dropping into?",
      q2: "What should I be watching for down there?",
      rundown: "Got it — here's the rundown. Good to go?",
    },
  },
  es: {
    voice: "es-ES-ElviraNeural",
    lines: {
      intro: "Hola — soy Sage, la IA que controla la unidad de reconocimiento que envías a la oscuridad. Cuéntame el trabajo, paso a paso.",
      q0: "¿Cuál es el trabajo allí abajo — qué voy a hacer?",
      q1: "¿A qué tipo de lugar voy a entrar?",
      q2: "¿Qué debo vigilar allí abajo?",
      rundown: "Entendido — aquí está el resumen. ¿Todo listo?",
    },
  },
};

// Generate any missing onboarding clips by hitting our own /api/tts and saving
// the audio to disk. Runs once on boot; skips files that already exist.
async function pregenOnboarding() {
  const dir = path.join(__dirname, "public", "audio");
  fs.mkdirSync(dir, { recursive: true });
  for (const [lang, { voice, lines }] of Object.entries(ONBOARDING)) {
    for (const [key, text] of Object.entries(lines)) {
      const file = path.join(dir, `onboard-${lang}-${key}.mp3`);
      if (fs.existsSync(file) && fs.statSync(file).size > 0) continue;
      try {
        const url = `http://localhost:${PORT}/api/tts?text=${encodeURIComponent(text)}&voice=${encodeURIComponent(voice)}`;
        const r = await fetch(url);
        if (!r.ok) { console.error(`pregen ${lang}/${key} failed: HTTP ${r.status}`); continue; }
        fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
        console.log(`pregen onboarding: ${path.basename(file)}`);
      } catch (e) { console.error(`pregen ${lang}/${key} error:`, e.message); }
    }
  }
}

// System prompts live in prompts/*.md so they're easy to tweak without touching code.
const loadPrompt = (name) => fs.readFileSync(path.join(__dirname, "prompts", name), "utf8").trim();
const AI_SYSTEM = loadPrompt("analysis.md");
const CHAT_SYSTEM = loadPrompt("chat.md");

// ponytail: status thresholds live here (server), single source of truth. The
// model only verbalizes the tag — it must NOT re-judge from the raw number.
function band(v, warn, danger) {
  if (v == null || isNaN(v)) return "UNKNOWN";
  return v >= danger ? "DANGER" : v >= warn ? "CAUTION" : "NORMAL";
}
function statuses(d) {
  return {
    temp: band(d.temp, 35, 45),
    dist: d.dist < 10 ? "NEAR" : "CLEAR",
    smoke: band(d.smoke, 300, 600),
    airq: band(d.airq, 450, 800),
    // MQ-9 raw: ~250-300 is normal room air, danger >=350.
    // ponytail: hardware DO flag (d.co_alert) is IGNORED — the module's digital out is
    // active-low and pot-tuned, so it false-fires DANGER in clean air. Judge from raw.
    // Re-enable only after fixing the pin polarity in the Mega firmware.
    co: band(d.co, 300, 350),
  };
}

// Severity rank so we can tell when a reading got WORSE (not just changed).
const RANK = { CLEAR: 0, NORMAL: 0, UNKNOWN: 0, NEAR: 1, CAUTION: 1, DANGER: 2 };

// Instant in-character one-liners fired the moment a reading worsens — no LLM
// round-trip, so the agent reacts immediately while the full analysis catches up.
const BLURTS = {
  en: {
    dist:  { NEAR: "Wall's right up on us — easing around it." },
    smoke: { CAUTION: "Smoke's picking up in here.", DANGER: "Heavy smoke now — this is getting bad." },
    airq:  { CAUTION: "Air's getting thick.", DANGER: "Air's gone foul down here." },
    co:    { CAUTION: "Gas reading's climbing.", DANGER: "Gas pocket — that's real danger." },
    temp:  { CAUTION: "Heat's coming up.", DANGER: "It's cooking down here." },
  },
  es: {
    dist:  { NEAR: "El muro está justo encima — lo esquivo con cuidado." },
    smoke: { CAUTION: "El humo está aumentando aquí.", DANGER: "Humo denso ahora — esto se está poniendo feo." },
    airq:  { CAUTION: "El aire se está volviendo espeso.", DANGER: "El aire está viciado aquí abajo." },
    co:    { CAUTION: "La lectura de gas está subiendo.", DANGER: "Bolsa de gas — esto es peligro real." },
    temp:  { CAUTION: "El calor está subiendo.", DANGER: "Esto es un horno aquí abajo." },
  },
};

// Short memory line so replies reference the recent past, not just this instant.
function buildTrend(d) {
  const h = dataHistory;
  if (h.length < 8) return "";
  const old = h[Math.max(0, h.length - 20)];
  const dir = (now, then, eps) => (now - then > eps ? "rising" : then - now > eps ? "falling" : null);
  const bits = [];
  const push = (k, label, eps) => { const x = dir(d[k], old[k], eps); if (x) bits.push(`${label} ${x}`); };
  push("temp", "temperature", 1);
  push("airq", "air quality", 30);
  push("smoke", "smoke", 30);
  push("co", "gas", 30);
  return bits.length ? `Trend over the last little while: ${bits.join(", ")}.` : "";
}

// Edge-triggered analysis: fire only when a status actually changes, blurt the
// instant the change is for the worse, and rate-limit the full LLM analysis.
let lastStatuses = null;
let lastAutoAnalysis = 0;
let lastBlurt = 0;
let pendingAnalysis = null;
const AUTO_MIN_GAP = parseInt(process.env.AUTO_ANALYSIS_GAP || "12", 10) * 1000;
const BLURT_MIN_GAP = 6000; // don't let a flapping sensor spam instant reactions

function emitBlurt(prev, cur) {
  if (!prev || Date.now() - lastBlurt < BLURT_MIN_GAP) return;
  const lines = BLURTS[currentLanguage] || BLURTS.en;
  let best = null;
  for (const k of Object.keys(cur)) {
    if (RANK[cur[k]] > RANK[prev[k]] && lines[k]?.[cur[k]]) {
      if (!best || RANK[cur[k]] > RANK[cur[best]]) best = k;
    }
  }
  if (best) { lastBlurt = Date.now(); io.emit("agent-blurt", { text: lines[best][cur[best]], timestamp: Date.now() }); }
}

function maybeAutoAnalyze(data) {
  const s = statuses(data);
  const changed = lastStatuses && Object.keys(s).some(k => lastStatuses[k] !== s[k]);
  if (changed && currentMission) emitBlurt(lastStatuses, s);
  lastStatuses = s;
  if (!changed || !currentMission) return; // no active mission → agent stays quiet
  const now = Date.now();
  if (now - lastAutoAnalysis < AUTO_MIN_GAP) return; // don't spam the LLM on flapping
  lastAutoAnalysis = now;
  clearTimeout(pendingAnalysis);
  pendingAnalysis = setTimeout(runAiAnalysis, 600); // debounce a burst of changes into one
}

// Agent acknowledges the operator's mission briefing in character.
async function ackMission(text) {
  const fallback = currentLanguage === "es"
    ? "Recibido. Misión confirmada — entrando."
    : "Copy that. Mission's locked in — heading in.";
  if (!process.env.CEREBRAS_API_KEY) {
    io.emit("mission-ack", { text: fallback, timestamp: Date.now() });
    return;
  }
  try {
    const resp = await openai.chat.completions.create({
      model: process.env.CEREBRAS_MODEL || "gpt-oss-120b",
      messages: [
        { role: "system", content: CHAT_SYSTEM },
        ...langMsg(currentLanguage),
        { role: "user", content: `The operator is briefing you on the mission before you head in: "${text}". Acknowledge it back in character in one or two sentences — confirm you've got it and you're ready. Don't ask questions, just lock it in.` },
      ],
      max_tokens: 150,
    });
    io.emit("mission-ack", { text: resp.choices[0]?.message?.content || fallback, timestamp: Date.now() });
  } catch (err) {
    console.error("Mission ack error:", err.message);
    io.emit("mission-ack", { text: fallback, timestamp: Date.now() });
  }
}

// Plain-language readings for chat — no sensor part names to parrot, keeps the
// model inside the cave fiction. Each reading carries a pre-judged status tag.
const missionLine = () => (currentMission ? `Your mission, briefed by the operator: ${currentMission}\n\n` : "");
const trendLine = (data) => { const t = buildTrend(data); return t ? `\n${t}` : ""; };

function buildChatContext(data) {
  const s = statuses(data);
  return `${missionLine()}Current readings from the rover right now (each line is already judged — trust the [STATUS] tag, do NOT re-judge from the number, and do NOT recite the raw number):
Temperature: ${data.temp}°C [${s.temp}]
Humidity: ${data.humid}%
Distance to the rock face ahead: ${data.dist} cm [${s.dist}]
Smoke/gas level: ${data.smoke} [${s.smoke}]
Air quality: ${data.airq} [${s.airq}]
Combustible gas: ${data.co} [${s.co}]
Tilt: roll ${data.roll}°, pitch ${data.pitch}°, yaw ${data.yaw}°${trendLine(data)}`;
}

function buildAiPrompt(data) {
  const s = statuses(data);
  return `${missionLine()}Latest telemetry from your sensors — read the room and report to the operator. Each line is already judged: trust the [STATUS] tag, do NOT re-judge from the raw number, and do NOT recite the raw number aloud.

Temperature: ${data.temp}°C [${s.temp}]
Humidity: ${data.humid}%
Distance ahead: ${data.dist} cm [${s.dist}]
Smoke/gas level: ${data.smoke} [${s.smoke}]
Air quality (CO2/etc): ${data.airq} [${s.airq}]
CO/combustible gas: ${data.co} [${s.co}]
Roll: ${data.roll}°  Pitch: ${data.pitch}°  Yaw: ${data.yaw}°${trendLine(data)}`;
}

async function runAiAnalysis() {
  if (!process.env.CEREBRAS_API_KEY || !latestData) return;
  try {
    const resp = await openai.chat.completions.create({
      model: process.env.CEREBRAS_MODEL || "gpt-oss-120b",
      messages: [
        { role: "system", content: AI_SYSTEM },
        ...langMsg(currentLanguage),
        { role: "user", content: buildAiPrompt(latestData) },
      ],
      max_tokens: 400,
    });
    const analysis = resp.choices[0]?.message?.content || "No analysis returned.";
    io.emit("ai-analysis", { analysis, timestamp: Date.now() });
  } catch (err) {
    console.error("AI analysis error:", err.message);
  }
}

let serialPort;
let selectedPortPath = null;
let manualDisconnect = false; // true = USB serial intentionally closed (BT mode); block auto-reconnect

function disconnectSerial() {
  manualDisconnect = true;
  if (serialPort) {
    serialPort.removeAllListeners("close");
    serialPort.removeAllListeners("error");
    try { serialPort.close(); } catch { /* already closed */ }
    serialPort = null;
  }
}

async function connectSerial(path) {
  manualDisconnect = false;
  if (!path) {
    const ports = await listSerialPorts();
    const usbPorts = ports.filter(p => p.includes("usbserial"));
    if (usbPorts.length === 0) {
      console.log("No usbserial ports found. Waiting for device...");
      setTimeout(() => connectSerial(), 3000);
      return;
    }
    path = usbPorts[0];
    selectedPortPath = path;
    console.log(`Auto-selected: ${path}`);
  } else {
    selectedPortPath = path;
    console.log(`Connecting to selected port: ${path}`);
  }

  serialPort = new SerialPort({ path, baudRate: SERIAL_BAUD }, (err) => {
    if (err) {
      console.error(`Failed to open ${path}: ${err.message}`);
      if (!selectedPortPath) {
        console.log("Retrying in 5s...");
        setTimeout(() => connectSerial(), 5000);
      }
    } else {
      console.log(`Connected to ${path}`);
    }
  });

  attachParser(serialPort);

  serialPort.on("error", (err) => {
    console.error("Serial error:", err.message);
  });

  serialPort.on("close", () => {
    if (manualDisconnect) {
      console.log("Serial closed by mode switch — not reconnecting.");
      return;
    }
    console.log("Serial disconnected. Reconnecting in 5s...");
    setTimeout(() => connectSerial(selectedPortPath), 5000);
  });
}

connectSerial();

// Analysis is on-demand only (request-analysis below) — no auto interval.

io.on("connection", (socket) => {
  console.log("Client connected");
  if (latestData) socket.emit("sensor-data", latestData);
  socket.on("request-analysis", () => {
    console.log("On-demand analysis requested");
    runAiAnalysis();
  });
  // Send the agent the current mission so a freshly-connected dashboard shows it.
  socket.emit("mission-set", { mission: currentMission });
  socket.on("set-mission", (text) => {
    currentMission = String(text || "").trim();
    console.log("Mission set:", currentMission || "(cleared)");
    io.emit("mission-set", { mission: currentMission });
    if (currentMission) ackMission(currentMission);
  });
  socket.on("set-language", (code) => {
    currentLanguage = (code === "es") ? "es" : "en";
    console.log("Language set:", currentLanguage);
  });
  // Debug: fake a sensor packet so the dashboard + AI work without the Arduino.
  socket.on("mock-data", () => {
    const r = (lo, hi, d = 0) => +(lo + Math.random() * (hi - lo)).toFixed(d);
    latestData = {
      temp: r(20, 50, 1), humid: r(20, 90, 1), dist: r(10, 200),
      smoke: r(0, 800), airq: r(50, 900), co: r(0, 600),
      co_alert: Math.random() > 0.7,
      roll: r(-8, 8, 1), pitch: r(-8, 8, 1), yaw: r(0, 30, 1), // keep rover ~level

      timestamp: Date.now(),
    };
    console.log("Mock data injected");
    io.emit("sensor-data", latestData);
    runAiAnalysis();
  });
});

server.listen(PORT, () => {
  console.log(`Server at http://localhost:${PORT}`);
  pregenOnboarding(); // warm onboarding audio cache (skips already-generated clips)
});
