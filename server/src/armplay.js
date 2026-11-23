// Plays a recorded arm take on the server: the dashboard's take buttons and Sage's
// "arm" field both end up here, so a take runs the same whoever asked for it.
// Each step goes where /api/cmd sends one: the usb cable, and the host browser's BLE.
const { app, io, localReq } = require("./http");
const { usbWrite } = require("./link");
const { readArmMoves } = require("./data");
const { armMovesFor } = require("./sage/parse");

const send = (w) => { usbWrite(w); io.emit("cmd", w); };

// One take at a time: a new one, or `stop`, drops whatever is still queued.
let timers = [];
function stopTake() { timers.forEach(clearTimeout); timers = []; }
function playTake(steps) {
  stopTake();
  for (const st of steps || []) timers.push(setTimeout(() => send(st.cmd), st.ms));
}

app.post("/api/arm-play", (req, res) => {
  if (!localReq(req)) return res.status(403).json({ error: "loopback only" });
  const name = String(req.body?.name || "");
  const steps = armMovesFor(readArmMoves(), "show_in_app")[name];
  if (!steps) return res.status(404).json({ error: "no such take" });
  playTake(steps);
  res.json({ ok: true, name });
});

module.exports = { playTake, stopTake };
