require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");
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

app.post("/api/ports/switch", async (req, res) => {
  const { path } = req.body;
  if (!path) return res.status(400).json({ error: "path required" });
  if (serialPort) {
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
  const parser = serialPort.pipe(new ReadlineParser({ delimiter: "\n" }));
  parser.on("data", (line) => {
    line = line.trim();
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
      timestamp: Date.now(),
    };
    latestData = data;
    dataHistory.push(data);
    if (dataHistory.length > 1000) dataHistory.shift();
    io.emit("sensor-data", data);
  });
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

function buildAiPrompt(data) {
  return `You are a rover exploration AI. Analyze this sensor data from a robot exploring a hazardous environment and give a 2-3 sentence overview of the area conditions.

Temperature: ${data.temp}°C
Humidity: ${data.humid}%
Distance ahead: ${data.dist} cm
Smoke/gas level: ${data.smoke}
Air quality (CO2/etc): ${data.airq}
Roll: ${data.roll}°  Pitch: ${data.pitch}°  Yaw: ${data.yaw}°`;
}

async function runAiAnalysis() {
  if (!process.env.CEREBRAS_API_KEY || !latestData) return;
  try {
    const resp = await openai.chat.completions.create({
      model: process.env.CEREBRAS_MODEL || "gpt-oss-120b",
      messages: [
        { role: "system", content: "You are a rover exploration AI assistant. Keep responses concise, 2-3 sentences." },
        { role: "user", content: buildAiPrompt(latestData) },
      ],
      max_tokens: 200,
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

  const parser = serialPort.pipe(new ReadlineParser({ delimiter: "\n" }));
  parser.on("data", (line) => {
    line = line.trim();
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
      timestamp: Date.now(),
    };
    latestData = data;
    dataHistory.push(data);
    if (dataHistory.length > 1000) dataHistory.shift();
    io.emit("sensor-data", data);
  });

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
});

server.listen(PORT, () => {
  console.log(`Server at http://localhost:${PORT}`);
});
