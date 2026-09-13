// run recorder: telemetry and findings written to disk so a run can be replayed
// a run is a folder: telemetry samples, findings, and a meta.json

const fs = require("fs");
const path = require("path");
const { grabFrame } = require("./vision");

const DIR = path.join(__dirname, "recordings");

const FPS = parseFloat(process.env.REC_FPS || "2");
const MAX_MIN = parseInt(process.env.REC_MAX_MIN || "15", 10);

let rec = null;

const runDir = (id) => (/^[A-Za-z0-9_-]+$/.test(id) ? path.join(DIR, id) : null);
const slug = (s) => String(s || "").replace(/[^a-z0-9 _-]/gi, "").trim().slice(0, 40).replace(/\s+/g, "-");

function start(name) {
  if (rec) return state();
  const stamp = new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "");
  const id = (slug(name) || "run") + "-" + stamp;
  const dir = path.join(DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  rec = { id, name: String(name || "").trim() || id, dir, t0: Date.now(),
    packets: [], frames: [], events: [], busy: false, camDown: false };
  if (FPS > 0) rec.timer = setInterval(tick, 1000 / FPS);
  rec.capTimer = setTimeout(stop, MAX_MIN * 60_000);
  return state();
}

async function tick() {
  if (!rec || rec.busy) return;
  rec.busy = true;
  const t = Date.now() - rec.t0;
  try {
    const jpeg = await grabFrame(0, 4000);
    if (!rec) return;
    const f = String(rec.frames.length).padStart(4, "0") + ".jpg";
    fs.writeFileSync(path.join(rec.dir, f), jpeg);
    rec.frames.push({ t, f });
    if (rec.camDown) { rec.camDown = false; mark("camback", "camera back"); }
  } catch (err) {
    if (rec && !rec.camDown) { rec.camDown = true; mark("camlost", err.message); }
  } finally { if (rec) rec.busy = false; }
}

function push(data) {
  if (rec) rec.packets.push({ ...data, t: Date.now() - rec.t0 });
}

function mark(kind, text) {
  if (!rec || rec.events.length >= 500) return;
  rec.events.push({ t: Date.now() - rec.t0, kind, text: String(text || "").trim().slice(0, 200) });
}

function stop() {
  if (!rec) return null;
  clearInterval(rec.timer);
  clearTimeout(rec.capTimer);
  const run = { id: rec.id, name: rec.name, at: rec.t0, dur: Date.now() - rec.t0,
    frames: rec.frames, packets: rec.packets, events: rec.events };
  fs.writeFileSync(path.join(rec.dir, "run.json"), JSON.stringify(run));
  rec = null;
  return run;
}

const state = () => rec && { id: rec.id, name: rec.name, since: rec.t0, frames: rec.frames.length, packets: rec.packets.length };

function list() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).map((id) => {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(DIR, id, "run.json"), "utf8"));
      return { id, name: r.name, at: r.at, dur: r.dur, frames: r.frames.length,
        packets: r.packets.length, events: (r.events || []).length };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.at - a.at);
}

function read(id) {
  const dir = runDir(id);
  try { return JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8")); }
  catch { return null; }
}

function remove(id) {
  const dir = runDir(id);
  if (!dir || (rec && rec.id === id)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

module.exports = { DIR, start, stop, push, mark, state, list, read, remove };
