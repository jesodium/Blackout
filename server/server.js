require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");
const OpenAI = require("openai");

const openai = new OpenAI({
  baseURL: "https://api.cerebras.ai/v1",
  apiKey: process.env.CEREBRAS_API_KEY,
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const SERIAL_PATH = process.env.SERIAL_PORT || "/dev/cu.HC-06-SPP";
const SERIAL_BAUD = parseInt(process.env.SERIAL_BAUD || "9600", 10);
const AI_INTERVAL = parseInt(process.env.AI_INTERVAL || "30", 10) * 1000;

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
function connectSerial() {
  serialPort = new SerialPort({ path: SERIAL_PATH, baudRate: SERIAL_BAUD }, (err) => {
    if (err) {
      console.error(`Failed to open ${SERIAL_PATH}: ${err.message}`);
      console.log("Retrying in 5s...");
      setTimeout(connectSerial, 5000);
    } else {
      console.log(`Connected to ${SERIAL_PATH}`);
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
    setTimeout(connectSerial, 5000);
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
