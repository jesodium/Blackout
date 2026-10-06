// The board's CSV in, one packet out. Lines arrive off the usb cable (link.js)
// or POSTed by the browser that holds the BLE link (/api/mega/sensor); either
// way they go through processLine().
const { app, io } = require("./http");
const link = require("./link");
const state = require("./state");
const recorder = require("./recorder");
const { pushHud } = require("./status");
const { maybeAutoAnalyze } = require("./sage/analysis");

// elevation comes off the bme's pressure. the reference leaks toward ambient (REF_TAU) or
// the day's weather reads as tens of metres of climbing while the rover sits still.
const REF_TAU = +process.env.REF_TAU_S || 300;
const absRef = !!process.env.SEA_LEVEL_HPA;
let refHPa = absRef ? parseFloat(process.env.SEA_LEVEL_HPA) : null;
let refT = 0;
const altitudeM = (hPa) => {
  if (!(hPa > 0)) return 0;
  const now = Date.now();
  if (refHPa == null) refHPa = hPa;
  else if (!absRef) refHPa += (hPa - refHPa) * (1 - Math.exp(-(now - refT) / 1000 / REF_TAU));
  refT = now;
  return 44330 * (1 - Math.pow(hPa / refHPa, 1 / 5.255));
};

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
    pressure: parts.length > 10 ? parseFloat(parts[10]) : 0,
    routine: parts.length > 11 ? parts[11].trim() === "1" : false,
    lux: parts.length > 12 ? parseFloat(parts[12]) : null,
    timestamp: Date.now(),
  };

  data.alt = Math.round(altitudeM(data.pressure) * 100) / 100;
  state.latestData = data;
  state.dataHistory.push(data);
  if (state.dataHistory.length > 1000) state.dataHistory.shift();
  recorder.push(data);
  io.emit("sensor-data", data);
  maybeAutoAnalyze(data);
  pushHud(data);
}
link.onLine(processLine);

app.post("/api/mega/sensor", (req, res) => {
  let raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  if (!raw || !raw.length) return res.status(400).json({ error: "empty" });
  const lines = raw.split("\n");
  for (const l of lines) processLine(l);
  res.json({ ok: true, lines: lines.length });
});

// CONSOLE -> MOCK: one made-up packet, for working on the dashboard with no rover
function mockPacket() {
  const r = (lo, hi, d = 0) => +(lo + Math.random() * (hi - lo)).toFixed(d);
  const data = {
    temp: r(20, 50, 1), humid: r(20, 90, 1), pressure: r(1011, 1015, 1), dist: r(10, 200), lux: r(0, 900),
    smoke: r(0, 800), airq: r(50, 900), co: r(0, 600),
    co_alert: Math.random() > 0.7,
    roll: r(-8, 8, 1), pitch: r(-8, 8, 1), yaw: r(0, 30, 1),
    timestamp: Date.now(),
  };
  data.alt = Math.round(altitudeM(data.pressure) * 100) / 100;
  state.latestData = data;
  io.emit("sensor-data", data);
}

module.exports = { mockPacket };
