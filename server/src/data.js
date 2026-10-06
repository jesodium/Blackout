// Everything under data/: recorded arm takes, tapes, and BLK workflows. Each is
// one file per entry, filename = the name, so the folder IS the index and
// nothing here caches.
const fs = require("fs");
const path = require("path");
const { app } = require("./http");
const { armMovesFor } = require("./sage/parse");

const DATA = path.join(__dirname, "..", "data");

// ---- arm moves ----
// Recorded on the bench by armrec.py (python3 server/tools/armrec.py) and replayed by
// the dashboard as one tap per move — the arrows and hold sliders are the thing
// that overdrives a joint, so the overdriving happens once, here, off-line.
// Read-only: recording needs the usb cable, which the dashboard does not have.
// One file per take in data/arm_moves/, filename = the move's name: a take can be
// opened, diffed, copied to another rig or deleted in Finder without the
// recorder running, and there is no index file to fall out of step with it.
const ARM_DIR = path.join(DATA, "arm_moves");

// arm takes and tapes are the same file in two folders — a name, a list of
// {ms, cmd} steps and the two flags — so one reader and one filter (armMovesFor)
// serve both. Nothing caches: the folder IS the index.
function readTakes(dir) {
  const out = {};
  let files;
  try { files = fs.readdirSync(dir).sort(); }
  catch { return out; }              // no folder yet = no moves, not a 500
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try { out[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); }
    catch { }                        // a half-written take is skipped, not fatal
  }
  return out;
}
const readArmMoves = () => readTakes(ARM_DIR);

app.get("/api/arm-moves", (req, res) => res.json(armMovesFor(readArmMoves(), "show_in_app")));

// ---- tapes ----
// A whole manual run written down: every command the dashboard puts on the wire,
// with its gaps, plus PC-side "@" events (say/analyze/log/led) the operator adds
// by hand afterwards. Same {ms, cmd} shape as an arm take, so the arm player
// replays it and drive + arm live in one list. One file per tape, filename = the
// name — no index to fall out of step with it, editable in any text editor.
// NOT firmware/giga/main/routines.h: those are Step tables compiled into flash and
// they have no arm op. A tape runs from the PC, which is also the only place
// analyze/say exist at all.
const TAPE_DIR = path.join(DATA, "tapes");
fs.mkdirSync(TAPE_DIR, { recursive: true });

const tapePath = (name) => {
  const safe = String(name).replace(/[^a-z0-9 _-]/gi, "").trim().slice(0, 60);
  return safe ? path.join(TAPE_DIR, safe + ".json") : null;
};
const readTapes = () => readTakes(TAPE_DIR);

app.get("/api/tapes", (req, res) => res.json({
  files: fs.readdirSync(TAPE_DIR).filter(f => f.endsWith(".json")).map(f => f.slice(0, -5)).sort(),
}));

app.get("/api/tapes/:name", (req, res) => {
  const p = tapePath(req.params.name);
  if (!p || !fs.existsSync(p)) return res.status(404).json({ error: "not found" });
  res.type("application/json").send(fs.readFileSync(p, "utf8"));
});

app.post("/api/tapes/:name", (req, res) => {
  const p = tapePath(req.params.name);
  if (!p) return res.status(400).json({ error: "bad name" });
  const steps = req.body?.steps;
  // hand-edited json arrives here, so the shape is checked before it can be
  // saved as a tape the operator will later press play on
  if (!Array.isArray(steps) || steps.length > 5000) return res.status(400).json({ error: "steps must be an array (max 5000)" });
  for (const s of steps) {
    if (!s || !Number.isFinite(s.ms) || s.ms < 0 || typeof s.cmd !== "string" || !s.cmd)
      return res.status(400).json({ error: "every step needs {ms: number >= 0, cmd: string}" });
  }
  const flags = {};
  for (const k of ["sage_can_use", "show_in_app"]) if (typeof req.body[k] === "boolean") flags[k] = req.body[k];
  fs.writeFileSync(p, JSON.stringify({ steps, ...flags }, null, 2));
  res.json({ ok: true });
});

app.delete("/api/tapes/:name", (req, res) => {
  const p = tapePath(req.params.name);
  if (!p || !fs.existsSync(p)) return res.status(404).json({ error: "not found" });
  fs.unlinkSync(p);
  res.json({ ok: true });
});

// ---- workflows ----
const BLK_DIR = path.join(DATA, "workflows");
fs.mkdirSync(BLK_DIR, { recursive: true });

function blkPath(name) {
  const safe = String(name).replace(/[^a-z0-9 _-]/gi, "").trim().slice(0, 60);
  return safe ? path.join(BLK_DIR, safe + ".blk") : null;
}

app.get("/api/blk", (req, res) => {
  res.json({ files: fs.readdirSync(BLK_DIR).filter(f => f.endsWith(".blk")).map(f => f.slice(0, -4)).sort() });
});

app.get("/api/blk/:name", (req, res) => {
  const p = blkPath(req.params.name);
  if (!p || !fs.existsSync(p)) return res.status(404).json({ error: "not found" });
  res.type("text/plain").send(fs.readFileSync(p, "utf8"));
});

app.post("/api/blk/:name", (req, res) => {
  const p = blkPath(req.params.name);
  if (!p) return res.status(400).json({ error: "bad name" });
  if (typeof req.body !== "string" || req.body.length > 20000)
    return res.status(400).json({ error: "body must be blk text (content-type: text/plain)" });
  fs.writeFileSync(p, req.body);
  res.json({ ok: true });
});

app.delete("/api/blk/:name", (req, res) => {
  const p = blkPath(req.params.name);
  if (!p || !fs.existsSync(p)) return res.status(404).json({ error: "not found" });
  fs.unlinkSync(p);
  res.json({ ok: true });
});

module.exports = { readArmMoves, readTapes };
