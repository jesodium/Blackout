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
const AI_INTERVAL = parseInt(process.env.AI_INTERVAL || "30", 10) * 1000;

async function listSerialPorts() {
  const { glob } = await import("glob");
  return await glob("/dev/cu.*");
}

app.get("/api/ports", async (req, res) => {
  const ports = await listSerialPorts();
  res.json({ ports, current: serialPort?.path || null });
});

// TTS proxy. Deepgram Aura-2 (low-latency streaming) when DEEPGRAM_API_KEY is
// set, else / on failure falls back to Microsoft Edge neural voices (free, no key).
// GET form lets an <audio> element play progressively (starts on first chunk).
async function speakDeepgram(text, res) {
  const model = process.env.DEEPGRAM_VOICE || "aura-2-orion-en";
  const r = await fetch(`https://api.deepgram.com/v1/speak?model=${model}&encoding=mp3`, {
    method: "POST",
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!r.ok || !r.body) throw new Error(`Deepgram ${r.status}: ${await r.text().catch(() => "")}`);
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
  if (!text) return res.status(400).json({ error: "text required" });
  try {
    if (process.env.DEEPGRAM_API_KEY) {
      try { return await speakDeepgram(text, res); }
      catch (e) { console.error("Deepgram TTS failed, falling back to Edge:", e.message); }
    }
    await speakEdge(text, voice, res);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
}
app.get("/api/tts", ttsHandler);
app.post("/api/tts", ttsHandler);

// Ask-questions mode: operator chats with BLACKOUT. Client sends the running
// message array (no server-side history); we prepend persona + live telemetry.
app.post("/api/chat", async (req, res) => {
  if (!process.env.CEREBRAS_API_KEY) return res.status(503).json({ error: "AI key not set" });
  const msgs = Array.isArray(req.body?.messages) ? req.body.messages.slice(-12) : [];
  if (!msgs.length) return res.status(400).json({ error: "messages required" });
  try {
    const ctx = latestData ? buildChatContext(latestData) : "No live readings yet — running dark.";
    const resp = await openai.chat.completions.create({
      model: process.env.CEREBRAS_MODEL || "gpt-oss-120b",
      messages: [
        { role: "system", content: CHAT_SYSTEM },
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

app.post("/api/ports/switch", async (req, res) => {
  const { path } = req.body;
  if (!path) return res.status(400).json({ error: "path required" });
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

// System prompts live in prompts/*.md so they're easy to tweak without touching code.
const loadPrompt = (name) => fs.readFileSync(path.join(__dirname, "prompts", name), "utf8").trim();
const AI_SYSTEM = loadPrompt("analysis.md");
const CHAT_SYSTEM = loadPrompt("chat.md");

// Plain-language readings for chat — no sensor part names to parrot, keeps the
// model inside the cave fiction.
function buildChatContext(data) {
  return `Current readings from the rover right now:
Temperature: ${data.temp}°C
Humidity: ${data.humid}%
Distance to the rock face ahead: ${data.dist} cm
Smoke/gas level: ${data.smoke}
Air quality: ${data.airq}
Combustible gas: ${data.co}${data.co_alert ? " — DANGER, gas pocket detected" : ""}
Tilt: roll ${data.roll}°, pitch ${data.pitch}°, yaw ${data.yaw}°`;
}

function buildAiPrompt(data) {
  return `Latest telemetry from your sensors — read the room and report to the operator.

Temperature: ${data.temp}°C
Humidity: ${data.humid}%
Distance ahead: ${data.dist} cm
Smoke/gas level: ${data.smoke}
Air quality (CO2/etc): ${data.airq}
CO/combustible gas (MQ-9 raw): ${data.co}${data.co_alert ? " ⚠ ALERT" : ""}
Roll: ${data.roll}°  Pitch: ${data.pitch}°  Yaw: ${data.yaw}°`;
}

async function runAiAnalysis() {
  if (!process.env.CEREBRAS_API_KEY || !latestData) return;
  try {
    const resp = await openai.chat.completions.create({
      model: process.env.CEREBRAS_MODEL || "gpt-oss-120b",
      messages: [
        { role: "system", content: AI_SYSTEM },
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

async function connectSerial(path) {
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
    console.log("Serial disconnected. Reconnecting in 5s...");
    setTimeout(() => connectSerial(selectedPortPath), 5000);
  });
}

connectSerial();

if (AI_INTERVAL > 0) {
  setInterval(runAiAnalysis, AI_INTERVAL);
}

io.on("connection", (socket) => {
  console.log("Client connected");
  if (latestData) socket.emit("sensor-data", latestData);
  socket.on("request-analysis", () => {
    console.log("On-demand analysis requested");
    runAiAnalysis();
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
});
