// What the numbers mean: the status bands, the readings as Sage reads them, the
// trend line, and the hud level pushed to the board's panel.
const { io } = require("./http");
const { usbWrite } = require("./link");
const state = require("./state");

function band(v, warn, danger) {
  if (v == null || isNaN(v)) return "UNKNOWN";
  return v >= danger ? "DANGER" : v >= warn ? "CAUTION" : "NORMAL";
}
function statuses(d) {
  return {
    temp: band(d.temp, 35, 45),
    dist: d.dist < 10 ? "NEAR" : "CLEAR",
  };
}

const RANK = { CLEAR: 0, NORMAL: 0, UNKNOWN: 0, NEAR: 1, CAUTION: 1, DANGER: 2 };

function buildTrend(d) {
  const h = state.dataHistory;
  if (h.length < 8) return "";
  const old = h[Math.max(0, h.length - 20)];
  const dir = (now, then, eps) => (now - then > eps ? "rising" : then - now > eps ? "falling" : null);
  const bits = [];
  const push = (k, label, eps) => { const x = dir(d[k], old[k], eps); if (x) bits.push(`${label} ${x}`); };
  push("temp", "temperature", 1);
  return bits.length ? `Trend over the last little while: ${bits.join(", ")}.` : "";
}
const trendLine = (data) => { const t = buildTrend(data); return t ? `\n${t}` : ""; };

function readingLines(data) {
  const s = statuses(data);
  return [
    `Temperature: ${data.temp}°C [${s.temp}]`,
    `Humidity: ${data.humid}%`,
    data.pressure ? `Pressure: ${data.pressure} hPa` : null,
    data.pressure ? `Elevation: ${Math.round(data.alt)} m relative to where you started` : null,
    `Distance to the rock face ahead: ${data.dist} cm [${s.dist}]`,
    data.lux != null ? `Ambient light: ${Math.round(data.lux)} lx` : null,
    (data.roll || data.pitch || data.yaw) ? `Tilt: roll ${data.roll}°, pitch ${data.pitch}°, yaw ${data.yaw}°` : null,
  ].filter(Boolean).join("\n");
}

let lastHud = "";
let lastHudAt = 0;
const HUD_REPEAT = 3000;

const HUD_MIN_GAP = 250;
function pushHud(d) {
  const s = statuses(d);
  const level = ["ok", "warn", "bad"][Math.max(...Object.values(s).map(v => RANK[v] ?? 0))];

  const dist = d.dist >= 999 ? "CLEAR" : `${Math.round(d.dist)}cm`;
  const msg = `hud,${level},${Math.round(d.temp)}C ${Math.round(d.humid)}%|${dist}`;
  const now = Date.now();
  if (now - lastHudAt < HUD_MIN_GAP) return;
  if (msg === lastHud && now - lastHudAt < HUD_REPEAT) return;
  lastHud = msg;
  lastHudAt = now;
  usbWrite(msg);
  io.emit("cmd", msg);
}

module.exports = { statuses, RANK, buildTrend, trendLine, readingLines, pushHud };
