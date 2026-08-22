// mission recorder — telemetry + cam stills to disk, replayed by the dashboard.
// grabs happen server-side on purpose: the cam is a different origin, so a
// <canvas> drawn from the dashboard's mjpeg <img> is tainted and can't be read
// back. vision.js already owns the /capture path (and un-rotates), so reuse it.
const fs = require("fs");
const path = require("path");
const { grabFrame } = require("./vision");

const DIR = path.join(__dirname, "recordings");
// the ai-thinker board shares ram between /stream and /capture. 2 fps alongside
// a live dashboard feed is what it takes without starving the stream.
// IMPORTANT NOTE: fixed rate, no adaptive backoff — drop REC_FPS if the feed stutters.
const FPS = parseFloat(process.env.REC_FPS || "2");
const MAX_MIN = parseInt(process.env.REC_MAX_MIN || "15", 10); // safety stop; disk isn't infinite

let rec = null; // the run in progress, or null

// ids are ours (slug + timestamp), so anything else in a url is an attack, not a typo.
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

// one still. a slow grab must never stack up behind the interval, hence `busy`.
// the cam dropping is marked once, not once per failed grab — the replay draws
// it as a "camera dead" stretch, so it needs the edges, not every miss.
async function tick() {
  if (!rec || rec.busy) return;
  rec.busy = true;
  const t = Date.now() - rec.t0;
  try {
    const jpeg = await grabFrame(4000);
    if (!rec) return;
    const f = String(rec.frames.length).padStart(4, "0") + ".jpg";
    fs.writeFileSync(path.join(rec.dir, f), jpeg);
    rec.frames.push({ t, f });
    if (rec.camDown) { rec.camDown = false; mark("camback", "camera back"); }
  } catch (err) {
    if (rec && !rec.camDown) { rec.camDown = true; mark("camlost", err.message); }
  } finally { if (rec) rec.busy = false; }
}

// every telemetry packet, stamped relative to the run start.
function push(data) {
  if (rec) rec.packets.push({ ...data, t: Date.now() - rec.t0 });
}

// a beat worth seeing again on the timeline: a finding, an analysis, sage
// talking, the cam dying. kinds are the client's EVENT_META keys.
// IMPORTANT NOTE: capped at 500 — a long run with a chatty sage shouldn't
// turn run.json into something the browser has to think about.
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

// a run with no run.json is either the one recording now or one a crash orphaned — skip both.
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
