// The cam's headlamp, driven over http to the cam.
const { app, io } = require("./http");
const { setLed: visionSetLed, getLed } = require("./vision");

// One wrapper so every lamp change -- the slider, Sage -- lands on every
// dashboard's slider. The browser posts /api/led and hears its own echo back.
const setLed = async (v) => { const r = await visionSetLed(v); io.emit("led", getLed()); return r; };

app.post("/api/led", async (req, res) => {
  const v = Math.max(0, Math.min(255, Math.round(Number(req.body?.value))));
  if (isNaN(v)) return res.status(400).json({ error: "value 0-255 required" });
  try { await setLed(v); res.json({ ok: true, value: v }); }
  catch (err) { res.status(502).json({ error: err.message }); }
});

module.exports = { setLed, getLed };
