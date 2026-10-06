// The two lights the PC drives: the cam's headlamp (over http to the cam) and
// the room's LED strip (ledstrip.js, over wifi).
const { app, io } = require("./http");
const { setLed: visionSetLed, getLed } = require("./vision");
const ledStrip = require("./ledstrip");
const state = require("./state");

// One wrapper so every lamp change -- the slider, Sage -- lands on every
// dashboard's slider. The browser posts /api/led and hears its own echo back.
const setLed = async (v) => { const r = await visionSetLed(v); io.emit("led", getLed()); return r; };

app.post("/api/led", async (req, res) => {
  const v = Math.max(0, Math.min(255, Math.round(Number(req.body?.value))));
  if (isNaN(v)) return res.status(400).json({ error: "value 0-255 required" });
  try { await setLed(v); res.json({ ok: true, value: v }); }
  catch (err) { res.status(502).json({ error: err.message }); }
});

// the room strip, held or released. {hue 0-359, sat/val 0-1000} pins it there,
// null hands it back to the status colours.
app.post("/api/strip", (req, res) => {
  const b = req.body || {};
  if (b.fx !== undefined) return res.json({ ok: true, fx: ledStrip.fx(b.fx), fxNames: ledStrip.fxNames });
  if (b.frame === null || b.frame === undefined) { ledStrip.manual(null); return res.json({ ok: true, manual: null }); }
  const n = (v, hi) => Math.max(0, Math.min(hi, Math.round(Number(v) || 0)));
  const f = { h: n(b.frame.h, 359), s: n(b.frame.s ?? 1000, 1000), v: n(b.frame.v ?? 1000, 1000) };
  ledStrip.manual(f);
  res.json({ ok: true, manual: f });
});

function startStrip() {
  // stale telemetry is no telemetry (PKT_STALE_MS in app.js) — same 3s here, so
  // the strip goes back to the "waiting on the rover" blue when the link drops
  setInterval(() => ledStrip.link(!!state.latestData && Date.now() - state.latestData.timestamp < 3000), 1000).unref();
  ledStrip.start();
  process.on("exit", () => ledStrip.stop());
}

module.exports = { setLed, getLed, startStrip };
