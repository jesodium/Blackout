// Recorded runs (recorder.js): start, stop, list, replay, delete.
const express = require("express");
const { app } = require("./http");
const { pingCam } = require("./vision");
const recorder = require("./recorder");

app.use("/recordings", express.static(recorder.DIR));
app.get("/api/rec", (req, res) => res.json({ now: recorder.state(), runs: recorder.list() }));

app.post("/api/rec/start", async (req, res) => {
  if (!(await pingCam())) return res.status(503).json({ error: "camera offline — nothing to record" });
  res.json({ now: recorder.start(req.body?.name) });
});
app.post("/api/rec/stop", (req, res) => {
  const run = recorder.stop();
  res.json({ id: run?.id || null });
});
app.get("/api/rec/:id", (req, res) => {
  const run = recorder.read(req.params.id);
  run ? res.json(run) : res.status(404).json({ error: "no such run" });
});
app.delete("/api/rec/:id", (req, res) => res.json({ ok: recorder.remove(req.params.id) }));
