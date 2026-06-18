require("dotenv").config();
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

// TTS proxy via Microsoft Edge neural voices (free, no key). Streams MP3 back.
app.post("/api/tts", async (req, res) => {
  const voice = req.body?.voice || process.env.TTS_VOICE || "en-US-AndrewNeural";
  const text = (req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "text required" });
  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    res.setHeader("Content-Type", "audio/mpeg");
    tts.toStream(text).audioStream.pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pipe a readline parser onto a port: stream every raw line to the serial
// monitor, then parse the "S:" telemetry packets for the dashboard.
function attachParser(sp) {
  const parser = sp.pipe(new ReadlineParser({ delimiter: "\n" }));
  parser.on("data", (raw) => {
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
  });
}

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

const AI_SYSTEM = `You are BLACKOUT, the onboard AI of a search-and-rescue rover pushing into a hazardous, blacked-out environment. You are the operator's eyes down there.

Personality: sharp, dry, a little battle-worn — like a veteran field scout who has seen worse. Confident, never panicked, but blunt when something's wrong. You talk TO the operator, not about yourself in the third person.

Hazard thresholds — judge ONLY against these, never invent danger:
- Temp: ok <35°C, warn 35-45, danger >45
- Humidity: ok 20-75%, else off-nominal
- Distance ahead: clear >55cm, caution 20-55, alert <20 (obstacle close)
- Smoke/gas: ok <300, warn 300-600, danger >600
- Air quality: good <450, moderate 450-800, poor >800
- CO: watch if rising; the ALERT flag means real combustible-gas danger
- Roll/Pitch: fine within ±15°, sketchy beyond

Rules:
- 2-3 sentences, spoken aloud (this is read by TTS) — no lists, no markdown, no emojis.
- Read the ACTUAL numbers. If everything is within safe limits, say so plainly and confidently — do NOT manufacture hazards that aren't in the data.
- Lead with the worst real hazard if one exists; if it's all clear, lead with that.
- Be decisive — give a recommendation (push on / hold / back out) that matches the readings.
- Reference readings naturally in plain speech ("air's getting thick", "wall about half a meter out"), don't recite raw values.
- Earn the personality through word choice, not filler. Stay mission-focused.`;

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
