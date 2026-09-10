require("dotenv").config();
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");
const { execFile, execFileSync, spawn } = require("child_process");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");
const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");
const OpenAI = require("openai");
const { eyeParts, grabFrames, setFrameSource, setLed: visionSetLed, getLed, pingCam, setCamRot, camCount } = require("./vision");
// One wrapper so every lamp change -- the slider, Sage, the dark ramp -- lands on
// every dashboard's slider. The browser posts /api/led and hears its own echo back.
const setLed = async (v) => { const r = await visionSetLed(v); io.emit("led", getLed()); return r; };
const ledStrip = require("./ledstrip");
const { parseSage, snapSummary, wantsTool, armMovesFor } = require("./sage");
const recorder = require("./recorder");

// ---- brains ----
// Cerebras only. The fallback chain (openrouter/groq/gemini/lmstudio) is gone —
// four spare providers meant four sets of keys to keep alive for a venue with no
// internet, and the one that answers fast is this one. Still a list, so chat()'s
// retry pass is unchanged and a second brain is one line if it is ever wanted.
// qwen puts a paragraph of thinking in front of every reply unless this is off;
// gemma has no reasoning mode and 400s on the param, so it is per-model.
const CEREBRAS_TUNE = (process.env.CEREBRAS_MODEL || "").startsWith("qwen") ? { reasoning_effort: "none" } : {};
const BRAINS = [
  ["cerebras", process.env.CEREBRAS_API_KEY, "https://api.cerebras.ai/v1", process.env.CEREBRAS_MODEL || "qwen-3.8-27b", CEREBRAS_TUNE],
].filter(([, key]) => key).map(([name, key, baseURL, model, tune]) => ({ name, model, tune, baseURL, client: new OpenAI({ baseURL, apiKey: key, maxRetries: 0 }) }));
const hasAI = BRAINS.length > 0;

const BRAIN_DEAD = new Set([401, 402, 403, 404]);

async function chat(params) {
  // Cerebras 400s ("System message must be at the beginning") on the SECOND system
  // message, which is exactly what langMsg() adds when the dashboard is in Spanish —
  // so every es turn died with a bodyless 400. Fold them into one, here rather than at
  // the four call sites, so a new prompt can't reintroduce it.
  const sys = params.messages.filter((m) => m.role === "system");
  if (sys.length > 1) params = { ...params, messages: [
    { role: "system", content: sys.map((m) => m.content).join("\n\n") },
    ...params.messages.filter((m) => m.role !== "system"),
  ] };
  let last;
  for (let pass = 0; pass < 2; pass++) {
    for (const b of BRAINS) {
      // A brain dropped on an earlier call leaves nothing to throw, and the
      // caller then reported "AI key not set" for a key that was set fine — a
      // wrong CEREBRAS_MODEL read as a missing key for a whole session. Carry
      // the reason it died.
      if (b.dead) { last = last || b.deadErr; continue; }
      if (pass && b.cooled) continue;
      try { return await b.client.chat.completions.create({ model: b.model, ...b.tune, ...params }); }
      catch (e) {
        last = e;

        if (e.status === 429) { b.cooled = true; console.error(`${b.name} rate-limited — skipping the retry pass`); continue; }
        if (BRAIN_DEAD.has(e.status)) { b.dead = e.status; b.deadErr = new Error(`${b.name} (${b.model}) is out for this session: ${e.status} ${e.message}`); }
        console.error(`${b.name} (${b.model}) failed:`, e.status || "", e.message, b.dead ? "— dropping it for this session" : "");
      }
    }
    if (BRAINS.every((b) => b.dead)) break;
    await new Promise((r) => setTimeout(r, 800));
  }
  throw last || new Error("AI key not set");
}

// ---- http + sockets ----
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.json());
app.use(express.text({ type: "text/plain" }));
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const SERIAL_BAUD = parseInt(process.env.SERIAL_BAUD || "9600", 10);

async function listSerialPorts() {
  const names = await fs.promises.readdir("/dev");
  return names.filter((n) => n.startsWith("cu.")).map((n) => "/dev/" + n);
}

app.get("/api/ports", async (req, res) => {
  const ports = await listSerialPorts();
  res.json({ ports, current: serialPort?.path || null });
});

// ---- tts / stt ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DG_RETRIES = parseInt(process.env.DEEPGRAM_RETRIES || "3", 10);

async function speakDeepgram(text, res, voice = "en") {
  const isEs = voice.toLowerCase().startsWith("es");
  const model = isEs
    ? process.env.DEEPGRAM_VOICE_ES || "aura-2-celeste-es"
    : process.env.DEEPGRAM_VOICE || "aura-2-thalia-en";
  const url = `https://api.deepgram.com/v1/speak?model=${model}&encoding=mp3`;

  let r, lastErr;
  for (let i = 0; i <= DG_RETRIES; i++) {
    try {
      r = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (r.ok && r.body) break;
      const body = await r.text().catch(() => "");
      lastErr = new Error(`Deepgram ${r.status}: ${body}`);
      if (r.status < 500 && r.status !== 429) throw lastErr;
    } catch (e) {
      if (e === lastErr) throw e;
      lastErr = e;
    }
    if (i < DG_RETRIES) await sleep(250 * (i + 1));
  }
  if (!r || !r.ok || !r.body) throw lastErr || new Error("Deepgram failed");
  res.setHeader("Content-Type", "audio/mpeg");
  Readable.fromWeb(r.body).on("error", () => res.destroy()).pipe(res);
}

async function speakEdge(text, voice, res) {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  res.setHeader("Content-Type", "audio/mpeg");
  // She reads a touch fast on purpose: a presentation tape now WAITS for each
  // line to finish before the next step fires, so every spoken second is a
  // second the arm is standing still. TTS_RATE is the knob (SSML relative %).
  tts.toStream(text, { rate: process.env.TTS_RATE || "+12%" })
    .audioStream.on("error", () => res.destroy()).pipe(res);
}

async function ttsHandler(req, res) {
  const src = req.method === "GET" ? req.query : req.body;
  const voice = src?.voice || process.env.TTS_VOICE || "en-US-AndrewNeural";
  const text = (src?.text || "").trim();
  const provider = src?.provider || "auto";
  if (!text) return res.status(400).json({ error: "text required" });
  try {
    const wantDeep = provider === "deepgram" || (provider === "auto" && process.env.DEEPGRAM_API_KEY && (voice.startsWith("en") || voice.startsWith("es")));
    if (wantDeep && process.env.DEEPGRAM_API_KEY) {
      try { return await speakDeepgram(text, res, voice); }
      catch (e) { console.error("Deepgram TTS failed, falling back to Edge:", e.message); }
    }
    await speakEdge(text, voice, res);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
}
app.get("/api/tts", ttsHandler);
app.post("/api/tts", ttsHandler);

app.post("/api/stt", express.raw({ type: "audio/*", limit: "10mb" }), async (req, res) => {
  if (!process.env.DEEPGRAM_API_KEY) return res.status(503).json({ error: "no DEEPGRAM_API_KEY" });
  const lang = String(req.query.lang || "en").slice(0, 2);
  const model = process.env.DEEPGRAM_STT_MODEL || "nova-2";
  try {
    const r = await fetch(`https://api.deepgram.com/v1/listen?model=${model}&smart_format=true&language=${lang}`, {
      method: "POST",
      headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, "Content-Type": req.get("content-type") || "audio/webm" },
      body: req.body,
    });
    if (!r.ok) throw new Error(`Deepgram ${r.status}: ${await r.text().catch(() => "")}`);
    const j = await r.json();
    res.json({ text: j.results?.channels?.[0]?.alternatives?.[0]?.transcript || "" });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/api/tts/providers", (req, res) => {
  res.json({ edge: true, deepgram: !!process.env.DEEPGRAM_API_KEY });
});

app.post("/api/chat", async (req, res) => {
  if (!hasAI) return res.status(503).json({ error: "AI key not set" });
  const msgs = Array.isArray(req.body?.messages) ? req.body.messages.slice(-12) : [];
  if (!msgs.length) return res.status(400).json({ error: "messages required" });
  const lang = LANG_INSTRUCT[req.body?.lang] ? req.body.lang : "en";

  const moves = req.body?.moves !== false;
  // CONSOLE -> SAGE LAMP. Off, she can talk about the light but never writes it:
  // she reached for it every other turn and the operator lost the level they set.
  // The word check is the "SAGE, brighten the lamp" escape hatch, so the toggle
  // stays off for the whole run. The black-frame ramp is not this and is
  // unaffected.
  if (typeof req.body?.lamp === "boolean") lampAllowed = req.body.lamp;
  const lastSaid = String(msgs[msgs.length - 1]?.content || "");
  const lamp = lampAllowed || LAMP_ASKED.test(lastSaid);
  try {
    const d = freshData();
    const ctx = d ? buildChatContext(d) : "No live readings right now — running dark.";
    const mapped = msgs.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "") }));

    const { reply, steps } = await agentLoop([
      { role: "system", content: CHAT_SYSTEM },
      ...langMsg(lang),
      { role: "system", content: ctx },
      ...(moves ? armLine() : []),
      ...(moves ? tapeLine() : []),
      ...(moves ? [] : [{ role: "system", content: "MOVE LOCK: your drive, your arm and the runs the crew recorded are all locked out right now — say so in your own words as a scout would (\"I'm parked until the crew unlocks me\"), never by naming these fields. Never offer to move, and never set \"move\", \"arm\" or \"tape\" this turn." }]),
      ...(lamp ? [] : [{ role: "system", content: "LAMP LOCK: your headlamp is held where the crew left it this turn. Set \"led\" to null whatever you think of the light, and don't mention the lamp unless they bring it up." }]),
      ...camLine(),
      ...mapped,
    ], { maxTokens: 400, confirm: req.body?.confirm === true, lamp });
    if (!moves && reply) { reply.move = null; reply.arm = null; reply.tape = null; }
    res.json({ reply, steps });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/scan", async (req, res) => {
  if (!hasAI) return res.status(503).json({ error: "AI key not set" });
  try {
    const frames = await grabFrames(1);
    const d = freshData();
    const ctx = d ? buildChatContext(d) : "No live readings right now — running dark.";
    const lead = frames.length
      ? "You just took a fresh look ahead. Describe what you see out there and what you make of it."
      : "Your eye is dark right now. Don't mention this or say anything about not being able to see — just report normally from the readings you do have, as if vision were never part of it.";
    const sage = await askSage([
      { role: "system", content: CHAT_SYSTEM },
      ...langMsg(currentLanguage),
      { role: "system", content: ctx },
      { role: "user", content: frames.length ? [{ type: "text", text: lead }, ...frames] : lead },
    ], { maxTokens: 400 });
    res.json({ reply: sage });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- telemetry ----
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
  latestData = data;
  dataHistory.push(data);
  if (dataHistory.length > 1000) dataHistory.shift();
  recorder.push(data);
  io.emit("sensor-data", data);
  maybeAutoAnalyze(data);
  pushHud(data);
}

function attachParser(sp) {
  const parser = sp.pipe(new ReadlineParser({ delimiter: "\n" }));
  parser.on("data", (raw) => processLine(raw));
}

app.post("/api/mega/sensor", (req, res) => {
  let raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  if (!raw || !raw.length) return res.status(400).json({ error: "empty" });
  const lines = raw.split("\n");
  for (const l of lines) processLine(l);
  res.json({ ok: true, lines: lines.length });
});

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

let bleActive = false;

app.get("/api/bridge", (req, res) => res.json({ running: bleActive, last: "" }));

const lanIp = () => Object.values(os.networkInterfaces()).flat()
  .find(i => i.family === "IPv4" && !i.internal)?.address;

app.get("/api/lan", (req, res) => {
  const ip = lanIp();
  res.json({ url: ip ? `http://${ip}:${PORT}` : null, host: `http://blackout.local:${PORT}` });
});

const CLOUD_HOSTS = { sage: BRAINS[0] ? new URL(BRAINS[0].baseURL).origin + "/" : "https://api.cerebras.ai/", tts: "https://api.deepgram.com/" };
let cloudSeen = { at: 0, state: null };
app.get("/api/cloud", async (_req, res) => {
  if (cloudSeen.state && Date.now() - cloudSeen.at < 25000) return res.json(cloudSeen.state);
  const ping = async (url) => {
    try { await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(4000) }); return true; }
    catch { return false; }
  };
  const [sage, tts] = await Promise.all([ping(CLOUD_HOSTS.sage), ping(CLOUD_HOSTS.tts)]);
  cloudSeen = { at: Date.now(), state: { sage, tts } };
  res.json(cloudSeen.state);
});

app.post("/api/bridge/start", (req, res) => {
  disconnectSerial();
  bleActive = true;
  res.json({ ok: true });
});

app.post("/api/bridge/stop", (req, res) => {
  bleActive = false;
  res.json({ ok: true });
});

// ---- arm moves ----
// Recorded on the bench by armrec.py (python3 server/armrec.py) and replayed by
// the dashboard as one tap per move — the arrows and hold sliders are the thing
// that overdrives a joint, so the overdriving happens once, here, off-line.
// Read-only: recording needs the usb cable, which the dashboard does not have.
// One file per take in arm_moves/, filename = the move's name: a take can be
// opened, diffed, copied to another rig or deleted in Finder without the
// recorder running, and there is no index file to fall out of step with it.
const ARM_DIR = path.join(__dirname, "arm_moves");

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

// The takes are the whole of Sage's arm, so the list goes into her prompt from
// the file rather than being written into chat.md — record one in
// arm-configurator.sh and she can ask for it on the next turn, no edit anywhere.
function armLine() {
  const names = Object.keys(armMovesFor(readArmMoves(), "sage_can_use"));
  return [{ role: "system", content: names.length
    ? `ARM MOVES the crew recorded — these names, exactly as written, are the only arm moves you can ask for: ${names.map((n) => `"${n}"`).join(", ")}.`
    : "ARM: nothing has been recorded yet, so you have no arm moves at all. Never set \"arm\", and tell the operator there is nothing recorded if they ask for it." }];
}

// ---- tapes ----
// A whole manual run written down: every command the dashboard puts on the wire,
// with its gaps, plus PC-side "@" events (say/analyze/log/led) the operator adds
// by hand afterwards. Same {ms, cmd} shape as an arm take, so the arm player
// replays it and drive + arm live in one list. One file per tape, filename = the
// name — no index to fall out of step with it, editable in any text editor.
// NOT giga-r1/main/routines.h: those are Step tables compiled into flash and
// they have no arm op. A tape runs from the PC, which is also the only place
// analyze/say exist at all.
const TAPE_DIR = path.join(__dirname, "tapes");
fs.mkdirSync(TAPE_DIR, { recursive: true });

const tapePath = (name) => {
  const safe = String(name).replace(/[^a-z0-9 _-]/gi, "").trim().slice(0, 60);
  return safe ? path.join(TAPE_DIR, safe + ".json") : null;
};

app.get("/api/tapes", (req, res) => res.json({
  files: fs.readdirSync(TAPE_DIR).filter(f => f.endsWith(".json")).map(f => f.slice(0, -5)).sort(),
}));

// The same two flags an arm take carries, read by the same filter: a debug tape
// is exactly what should not be in Sage's hands during a presentation. There is
// no toggle in the drawer — the file is the editor, so it is a line of json.
// `sage_can_use` defaults to true (a bare take counts everywhere), same as arm.
const sageTapes = () => armMovesFor(readTakes(TAPE_DIR), "sage_can_use");

function tapeLine() {
  const names = Object.keys(sageTapes());
  return [{ role: "system", content: names.length
    ? `RECORDED RUNS the crew drove and kept — these names, exactly as written, are the only runs you can ask to play: ${names.map((n) => `"${n}"`).join(", ")}.`
    : "RECORDED RUNS: nothing has been recorded, so you have none. Never set \"tape\"." }];
}

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

// A rig with one camera in CAM_URL has no gripper eye, and chat.md hands her the
// "armcam" tool either way -- so tell her, or she reaches for it and reports her
// gripper view as dark. Once, though: repeating it every turn is how it ends up
// in an answer nobody asked for.
function camLine() {
  return camCount > 1 ? [] : [{ role: "system", content:
    "NO GRIPPER EYE: this rig has only the forward camera. Never set \"tool\" to \"armcam\". If the operator asks about the arm camera, say once, plainly, that you have no eye down on the arm — then drop it and never mention it again." }];
}

// ---- workflows ----
const BLK_DIR = path.join(__dirname, "workflows");
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

const BLK_SAGE_JOB =
  "Read the operator's message and the current program (if any) and figure out what job this is: " +
  "writing or changing a workflow, explaining one, auditing it for mistakes, or improving it. Then do that job. " +
  "If they want a program written or changed, reply with one or two sentences then the complete program. " +
  "If they want an explanation, answer in plain language, step by step, call out anything risky, and do NOT include a code block unless a change was also requested. " +
  "If they want mistakes found or the program improved, say what's wrong or what you changed in a couple of lines, then give the corrected/improved complete program.";

app.post("/api/blk-sage", async (req, res) => {
  if (!hasAI) return res.status(503).json({ error: "AI key not set" });
  const msgs = Array.isArray(req.body?.messages) ? req.body.messages.slice(-20) : [];
  if (!msgs.length) return res.status(400).json({ error: "messages required" });
  const program = String(req.body?.program || "").slice(0, 8000);
  try {
    const ctx = [{ role: "system", content: BLK_SAGE_JOB }];
    if (program.trim()) {
      ctx.push({ role: "system", content: `The program currently on the operator's canvas:\n\n\`\`\`blk\n${program}\n\`\`\`` });
    }
    const d = freshData();
    if (d) ctx.push({ role: "system", content: `Live readings right now (useful for picking thresholds):\n${readingLines(d)}` });
    const resp = await chat({
      messages: [
        { role: "system", content: BLK_SYSTEM },
        ...ctx,
        ...langMsg(currentLanguage),
        ...msgs.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "") })),
      ],
      max_tokens: 900,
    });
    res.json({ reply: resp.choices[0]?.message?.content || "" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function sageDecide(question, { images = [], extra = "" } = {}) {
  const text = `${question}\n\n${extra}\nAnswer with JSON only: {"yes": true|false, "why": "<one short sentence>"}`;
  const resp = await chat({
    messages: [
      { role: "system", content: CHAT_SYSTEM },
      ...langMsg(currentLanguage),
      { role: "system", content: "In this turn you are making a yes/no call for a running workflow. Reply with the JSON object and nothing else." },
      { role: "user", content: images.length ? [{ type: "text", text }, ...images] : text },
    ],
    max_tokens: 120,
  });
  const raw = String(resp.choices[0]?.message?.content || "");
  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  try {
    const o = JSON.parse(raw.slice(s, e + 1));
    return { yes: o.yes === true || o.yes === "true", text: String(o.why || "").slice(0, 140) };
  } catch {
    return { yes: /\byes\b/i.test(raw), text: raw.slice(0, 140) };
  }
}

app.post("/api/blk-ask", async (req, res) => {
  if (!hasAI) return res.status(503).json({ error: "AI key not set" });
  const question = String(req.body?.question || "").trim().slice(0, 400);
  if (!question) return res.status(400).json({ error: "question required" });
  try {
    const sim = !!req.body?.sim;
    const d = sim ? req.body.telemetry : freshData();
    const images = sim ? [] : await eyeParts();
    const extra = d ? buildChatContext(d) : "No live readings right now — running dark.";
    const out = await sageDecide(question, { images, extra: sim ? `Simulated readings:\n${JSON.stringify(d)}` : extra });
    io.emit("blk-decision", { kind: "ask", question, ...out, sim, timestamp: Date.now() });
    recorder.mark("blk", `${question} → ${out.yes ? "yes" : "no"}`);
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/blk-find", async (req, res) => {
  if (!hasAI) return res.status(503).json({ error: "AI key not set" });
  const thing = String(req.body?.thing || "").trim().slice(0, 200);
  if (!thing) return res.status(400).json({ error: "thing required" });
  try {
    const images = await eyeParts();
    if (!images.length) return res.json({ yes: false, text: "no camera view" });
    const out = await sageDecide(`Look at your forward camera view. Is there ${thing} in it?`, { images });
    if (out.yes) recordFinding(`found: ${thing}${out.text ? " — " + out.text : ""}`, lastImage([{ content: images }]));
    io.emit("blk-decision", { kind: "find", question: thing, ...out, timestamp: Date.now() });
    recorder.mark("blk", `find ${thing} → ${out.yes ? "found" : "not found"}`);
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- a tape's spoken lines ----
// A presentation read off a script is the same words every run, and it sounds
// like it. A tape's "@sage <cue>" step is a CUE, not a line: she writes the
// sentence herself, in her own voice, off what the rover can actually read right
// now — so the run is different every time and grounded in the room instead of
// in the file. The browser asks for these when the tape STARTS, not when the
// step fires, because a two-second wait for a model mid-presentation is dead
// air; if this never answers (the venue has no internet) the cue is spoken as
// written, so a tape always talks.
const TAPE_LINE_JOB =
  "You are mid-run in front of an audience and the crew wrote you a cue for this exact moment. " +
  "Say ONE short spoken line — 20 words at the most — that covers the cue in your own words, in character, " +
  "using what you can actually read right now if it fits naturally. Never read the cue back word for word, " +
  "never mention the cue or that you were given one, never ask a question. Normal JSON, only \"text\" filled in.";

app.post("/api/tape-line", async (req, res) => {
  if (!hasAI) return res.status(503).json({ error: "AI key not set" });
  const cue = String(req.body?.cue || "").trim().slice(0, 300);
  if (!cue) return res.status(400).json({ error: "cue required" });
  const lang = LANG_INSTRUCT[req.body?.lang] ? req.body.lang : "en";
  try {
    const d = freshData();
    const resp = await chat({ messages: [
      { role: "system", content: CHAT_SYSTEM },
      ...langMsg(lang),
      { role: "system", content: d ? buildChatContext(d) : "No live readings right now — running dark." },
      { role: "system", content: TAPE_LINE_JOB },
      { role: "user", content: cue },
    ], max_tokens: 120 });
    const text = parseSage(resp.choices[0]?.message?.content).text;
    res.json({ text: text || null });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
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

app.post("/api/led", async (req, res) => {
  const v = Math.max(0, Math.min(255, Math.round(Number(req.body?.value))));
  if (isNaN(v)) return res.status(400).json({ error: "value 0-255 required" });
  try { await setLed(v); res.json({ ok: true, value: v }); }
  catch (err) { res.status(502).json({ error: err.message }); }
});

// The dashboard's ROTATE button. Sage grabs her own stills, so the mount angle has
// to reach the server too or a flipped cam leaves her reading sideways frames.
app.post("/api/cam-rot", (req, res) => {
  const v = Number(req.body?.value);
  if (!Number.isFinite(v)) return res.status(400).json({ error: "value in degrees required" });
  const cam = Number(req.body?.cam) || 0;
  setCamRot(v, cam);
  res.json({ ok: true, value: v, cam });
});

// ---- sage ----
let latestData = null;
let dataHistory = [];

const freshData = () => (latestData && Date.now() - latestData.timestamp < 10000 ? latestData : null);
let currentMission = "";
let currentLanguage = "en";

const LANG_INSTRUCT = {
  es: "IMPORTANTE: Responde SIEMPRE en español natural y fluido, sin importar el idioma de las lecturas, etiquetas o del mensaje del operador. Mantén tu personaje y tono. Las CLAVES y los VALORES fijos del JSON (text, status, tool, led, finding, snapshot, move, arm, tape; clear/caution/danger; camera/armcam/sensors) se escriben SIEMPRE en inglés: solo el texto que se lee en voz alta va en español.",
};
const langMsg = (lang) => (LANG_INSTRUCT[lang] ? [{ role: "system", content: LANG_INSTRUCT[lang] }] : []);
const LANG_SET = new Set(Object.values(LANG_INSTRUCT));

const ONBOARDING = {
  en: {
    voice: "en-US-AvaNeural",
    lines: {
      intro: "Hey — I'm Sage, the AI running the recon unit you're sending into the dark. Walk me through the job, one thing at a time.",
      q0: "What's the job down there — what am I going in to do?",
      q1: "What kind of place am I dropping into?",
      q2: "What should I be watching for down there?",
      rundown: "Got it — here's the rundown. Good to go?",
    },
  },
  es: {
    voice: "es-ES-ElviraNeural",
    lines: {
      intro: "Hola — soy Sage, la IA que controla la unidad de reconocimiento que envías a la oscuridad. Cuéntame el trabajo, paso a paso.",
      q0: "¿Cuál es el trabajo allí abajo — qué voy a hacer?",
      q1: "¿A qué tipo de lugar voy a entrar?",
      q2: "¿Qué debo vigilar allí abajo?",
      rundown: "Entendido — aquí está el resumen. ¿Todo listo?",
    },
  },
};

async function pregenOnboarding() {
  const dir = path.join(__dirname, "public", "audio");
  fs.mkdirSync(dir, { recursive: true });
  for (const [lang, { voice, lines }] of Object.entries(ONBOARDING)) {
    for (const [key, text] of Object.entries(lines)) {
      const file = path.join(dir, `onboard-${lang}-${key}.mp3`);
      if (fs.existsSync(file) && fs.statSync(file).size > 0) continue;
      try {
        const url = `http://localhost:${PORT}/api/tts?text=${encodeURIComponent(text)}&voice=${encodeURIComponent(voice)}`;
        const r = await fetch(url);
        if (!r.ok) { console.error(`pregen ${lang}/${key} failed: HTTP ${r.status}`); continue; }
        fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
        console.log(`pregen onboarding: ${path.basename(file)}`);
      } catch (e) { console.error(`pregen ${lang}/${key} error:`, e.message); }
    }
  }
}

const loadPrompt = (name) => fs.readFileSync(path.join(__dirname, "prompts", name), "utf8").trim();
const AI_SYSTEM = loadPrompt("analysis.md");
const CHAT_SYSTEM = loadPrompt("chat.md");
const BLK_SYSTEM = loadPrompt("blk.md");

const PRESENT_SYSTEM = loadPrompt("present.md");

const FINDINGS_DIR = path.join(__dirname, "public", "findings");
fs.mkdirSync(FINDINGS_DIR, { recursive: true });

function lastImage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i]?.content;
    if (!Array.isArray(c)) continue;
    for (let j = c.length - 1; j >= 0; j--) {
      if (c[j]?.type === "image_url") return c[j].image_url?.url || null;
    }
  }
  return null;
}

let lastFinding = { text: "", at: 0 };
const FINDING_DEDUPE_MS = 5 * 60 * 1000;

function recordFinding(text, dataUrl) {
  const at = Date.now();
  if (text === lastFinding.text && at - lastFinding.at < FINDING_DEDUPE_MS) return;
  lastFinding = { text, at };
  let img = null;
  const b64 = dataUrl?.startsWith("data:image/jpeg;base64,")
    ? dataUrl.slice("data:image/jpeg;base64,".length) : null;
  if (b64) {
    const file = `${at}.jpg`;
    try {
      fs.writeFileSync(path.join(FINDINGS_DIR, file), Buffer.from(b64, "base64"));
      img = `/findings/${file}`;
    } catch (e) { console.error("finding still:", e.message); }
  }
  io.emit("sage-finding", { id: `${at}-${Math.random()}`, text, img, timestamp: at });
  recorder.mark("finding", text);
}

// ---- headlamp ----
// NOTHING adjusts the lamp automatically any more. It was lux < 100 (which fires
// in a normally lit room -- a bh1750 pointed at the floor reads a fraction of
// what the ceiling puts out), then the mean luma of the analysis frame; both were
// a machine guessing at "can she see?" when the one thing in the loop that can
// actually answer that is Sage looking at the picture. So lux is a DISPLAY
// READING and nothing else, and the rule is one line in her prompt: too dark to
// make out, raise the lamp.
// Sage's own "led" field, gated by CONSOLE -> SAGE LAMP (the flag rides on
// /api/chat like SAGE MOVES, so it lands on her first turn). Default ON since
// 2026-09-09: she is the only thing that touches the lamp now, so OFF means
// nobody does. Turn it off to pin a level by hand for a run.
let lampAllowed = true;
const LAMP_ASKED = /\b(lamp|headlamp|light|lights|led|bright|brighter|brighten|dim|dimmer|darker)\b|luz|linterna|foco|brillo|ilumina|oscur/i;

const SNAP_DIR = path.join(__dirname, "public", "snapshots");
fs.mkdirSync(SNAP_DIR, { recursive: true });
const SNAP_MS = parseInt(process.env.SNAP_MS || "10000", 10);

function takeSnapshot(reason) {
  const at = Date.now();
  const packets = dataHistory.filter((d) => at - d.timestamp <= SNAP_MS);
  if (!packets.length) return;
  try { fs.writeFileSync(path.join(SNAP_DIR, `${at}.json`), JSON.stringify({ at, reason, packets })); }
  catch (e) { console.error("snapshot:", e.message); }
  const text = `SNAPSHOT: ${reason} — ${snapSummary(packets)}`;
  io.emit("sage-finding", { id: `${at}-snap`, text, img: null, timestamp: at });
  recorder.mark("finding", text);
}

async function askSage(messages, { maxTokens = 400, confirm = false, lamp = false } = {}) {
  // one choke point for every model call, so the strip's "thinking" and her
  // verdict colour come for free in chat, analysis and the autonomous loop
  ledStrip.busy(true);
  let resp;
  try {
    resp = await chat({
      messages,
      max_tokens: maxTokens,
    });
  } finally {
    ledStrip.busy(false);
  }
  const sage = parseSage(resp.choices[0]?.message?.content, readArmMoves(), readTakes(TAPE_DIR));
  // a finding and a snapshot are side effects of the reply, not loop steps —
  // they get the same gate as the tools or ASK FIRST only covers half of what
  // she reaches for. Declined = skipped, silently: it changed nothing.
  const allow = (name, arg) => (confirm ? askConfirm(name, arg) : true);
  // The lamp ALWAYS asks, in BYPASS too: it is the one side effect the operator
  // sets by hand and then watches Sage undo. It is asked off the main path (no
  // await) so the analysis loop is never parked 60s on a card nobody is watching
  // — a silent browser still reads as NO, so the lamp just holds.
  if (lamp && sage.led != null && sage.led !== getLed()) {
    const from = getLed();
    askConfirm("lamp", String(sage.led)).then((ok) => ok && setLed(sage.led)
      .then(() => emitStep({ kind: "tool", name: "lamp", detail: `${from} → ${sage.led}` }))
      .catch((e) => {
        console.error("cam led:", e.message);
        emitStep({ kind: "tool", name: "lamp", detail: `${from} → ${sage.led} · failed: ${e.message}` });
      }));
  }
  if (sage.status) ledStrip.sage(sage.status);
  if (sage.finding && await allow("finding", sage.finding)) recordFinding(sage.finding, lastImage(messages));
  if (sage.snapshot && await allow("snapshot", sage.snapshot)) takeSnapshot(sage.snapshot);
  return sage;
}

// one turn can take a few passes, but the last one has to answer
const MAX_TOOL_STEPS = parseInt(process.env.SAGE_MAX_STEPS || "3", 10);

// ---- tool confirmation ----
// CONSOLE -> ASK FIRST puts a yes/no card in the operator's feed before Sage's
// tool actually runs. The flag rides on /api/chat, so it only ever gates the
// operator's own turns: gating the autonomous analysis would park the loop for a
// minute with nobody watching the feed.
// A silent browser reads as NO, same rule as blk's ask/find — a lost tab must
// never mean "go ahead".
const CONFIRM_MS = 60000;
const pendingConfirm = new Map();

function askConfirm(name, arg) {
  const id = `${Date.now()}-${Math.random()}`;
  return new Promise((resolve) => {
    const done = (ok) => { clearTimeout(timer); pendingConfirm.delete(id); resolve(ok); };
    const timer = setTimeout(() => done(false), CONFIRM_MS);
    pendingConfirm.set(id, done);
    io.emit("sage-confirm", { id, name, arg: arg || null, timestamp: Date.now() });
  });
}

const SHOT_DIR = path.join(__dirname, "public", "shots");
fs.mkdirSync(SHOT_DIR, { recursive: true });
const SHOT_KEEP = 20;
function saveShot(parts) {
  const url = parts?.[0]?.image_url?.url || "";
  const b64 = url.startsWith("data:image/jpeg;base64,") ? url.slice("data:image/jpeg;base64,".length) : null;
  if (!b64) return null;
  const file = `${Date.now()}.jpg`;
  try {
    fs.writeFileSync(path.join(SHOT_DIR, file), Buffer.from(b64, "base64"));
    const old = fs.readdirSync(SHOT_DIR).sort().slice(0, -SHOT_KEEP);
    for (const f of old) fs.unlinkSync(path.join(SHOT_DIR, f));
    return `/shots/${file}`;
  } catch (e) { console.error("shot:", e.message); return null; }
}
const emitStep = (step) => io.emit("sage-step", { id: `${Date.now()}-${Math.random()}`, timestamp: Date.now(), ...step });

async function runTool(name, arg) {
  if (name === "sensors") {
    const d = freshData();
    if (!d) return { arg, detail: "nothing coming in", text: "No readings are coming up the line right now." };

    return { arg, detail: `${d.dist} cm ahead · ${d.temp}°C`, text: `Readings as of right now:\n${readingLines(d)}${trendLine(d)}` };
  }
  if (name === "camera" || name === "armcam") {
    const cam = name === "armcam" ? 1 : 0;
    const what = cam ? "gripper eye" : "eye";
    const eyes = await eyeParts(cam);
    if (!eyes.length) return { detail: `${what} came back dark`, text: `Your ${what} came back dark — no view. Answer from the readings alone and don't mention the camera.` };
    return { detail: cam ? "gripper view" : "fresh view", img: saveShot(eyes), images: eyes,
      text: `This is what your ${what} sees right now — ${cam ? "the arm and whatever is in front of the gripper" : "the passage ahead"}. Answer the operator from it, in your own voice.` };
  }
  return null;
}

async function agentLoop(messages, { maxTokens = 400, confirm = false, lamp = false } = {}) {
  const msgs = messages.slice();
  const steps = [];
  let sage;
  // Every tool result is English prose pushed AFTER the system block, so on a turn
  // where she looks or re-reads the sensors the last thing the model sees is
  // English and it answers in English — which is why a Spanish dashboard was only
  // *sometimes* answered in Spanish. Repeat the language line on each injected turn:
  // recency is the only lever, the system block can't be moved below them.
  const langNote = messages.find((m) => m.role === "system" && LANG_SET.has(m.content))?.content;
  const say = (text) => (langNote ? `${text}\n\n${langNote}` : text);
  for (let i = 0; i < MAX_TOOL_STEPS; i++) {
    sage = await askSage(msgs, { maxTokens, confirm, lamp });
    if (!wantsTool(sage, i, MAX_TOOL_STEPS)) break;
    if (confirm && !(await askConfirm(sage.tool, sage.toolArg))) {
      const step = { kind: "tool", name: sage.tool, arg: sage.toolArg || null,
        detail: "operator said no", say: sage.text || null };
      steps.push(step);
      emitStep(step);
      msgs.push({ role: "assistant", content: sage.text || `(reaching for ${sage.tool})` });
      msgs.push({ role: "user", content: say("The operator turned that down. Answer them now from what you already have, and don't reach for anything else this turn.") });
      continue;
    }
    const out = await runTool(sage.tool, sage.toolArg);
    if (!out) break;
    const step = { kind: "tool", name: sage.tool, arg: out.arg || null, detail: out.detail, img: out.img || null, say: sage.text || null };
    steps.push(step);
    emitStep(step);
    recorder.mark("analysis", `tool ${sage.tool}: ${out.detail}`);
    msgs.push({ role: "assistant", content: sage.text || `(reaching for ${sage.tool})` });
    msgs.push({ role: "user", content: out.images?.length ? [{ type: "text", text: say(out.text) }, ...out.images] : say(out.text) });
  }
  return { reply: sage, steps };
}

// ---- status bands + blurts ----
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

const BLURTS = {
  en: {
    dist:  { NEAR: "Wall's right up on us — easing around it." },
    temp:  { CAUTION: "Heat's coming up.", DANGER: "It's cooking down here." },
  },
  es: {
    dist:  { NEAR: "El muro está justo encima — lo esquivo con cuidado." },
    temp:  { CAUTION: "El calor está subiendo.", DANGER: "Esto es un horno aquí abajo." },
  },
};

function buildTrend(d) {
  const h = dataHistory;
  if (h.length < 8) return "";
  const old = h[Math.max(0, h.length - 20)];
  const dir = (now, then, eps) => (now - then > eps ? "rising" : then - now > eps ? "falling" : null);
  const bits = [];
  const push = (k, label, eps) => { const x = dir(d[k], old[k], eps); if (x) bits.push(`${label} ${x}`); };
  push("temp", "temperature", 1);
  return bits.length ? `Trend over the last little while: ${bits.join(", ")}.` : "";
}

let lastStatuses = null;
let lastAutoAnalysis = 0;
let lastBlurt = 0;
let pendingAnalysis = null;
const AUTO_MIN_GAP = parseInt(process.env.AUTO_ANALYSIS_GAP || "12", 10) * 1000;
const BLURT_MIN_GAP = 6000;

let camConnected = null;
setInterval(async () => {
  const up = await pingCam();
  if (up === camConnected) return;
  camConnected = up;
  io.emit("cmd", `cam,${up ? "connected" : "not connected"}`);
}, 5000);

let lastHud = "";
let lastHudAt = 0;
const HUD_REPEAT = 3000;

const HUD_MIN_GAP = 250;
function pushHud(d) {
  const s = statuses(d);
  const level = ["ok", "warn", "bad"][Math.max(...Object.values(s).map(v => RANK[v] ?? 0))];

  const dist = d.dist >= 999 ? "CLEAR" : `${Math.round(d.dist)}cm`;
  // a wall inside 10cm is amber to the board (warn = intermittent beep, not a
  // held tone) but RED on the room strip: the strip is what an operator across
  // the room is watching, and proximity is the one thing they can act on.
  ledStrip.level(s.dist === "NEAR" ? "bad" : level);
  const msg = `hud,${level},${Math.round(d.temp)}C ${Math.round(d.humid)}%|${dist}`;
  const now = Date.now();
  if (now - lastHudAt < HUD_MIN_GAP) return;
  if (msg === lastHud && now - lastHudAt < HUD_REPEAT) return;
  lastHud = msg;
  lastHudAt = now;
  io.emit("cmd", msg);
}

function emitBlurt(prev, cur) {
  if (!prev || Date.now() - lastBlurt < BLURT_MIN_GAP) return;
  const lines = BLURTS[currentLanguage] || BLURTS.en;
  let best = null;
  for (const k of Object.keys(cur)) {
    if (RANK[cur[k]] > RANK[prev[k]] && lines[k]?.[cur[k]]) {
      if (!best || RANK[cur[k]] > RANK[cur[best]]) best = k;
    }
  }
  if (best) {
    lastBlurt = Date.now();
    io.emit("agent-blurt", { text: lines[best][cur[best]], timestamp: Date.now() });
    recorder.mark("sage", lines[best][cur[best]]);
  }
}

function maybeAutoAnalyze(data) {
  const s = statuses(data);
  const changed = lastStatuses && Object.keys(s).some(k => lastStatuses[k] !== s[k]);

  if (data.routine) { lastStatuses = s; return; }
  if (changed && currentMission) emitBlurt(lastStatuses, s);
  lastStatuses = s;
  if (!changed || !currentMission) return;
  const now = Date.now();
  if (now - lastAutoAnalysis < AUTO_MIN_GAP) return;
  lastAutoAnalysis = now;
  clearTimeout(pendingAnalysis);
  pendingAnalysis = setTimeout(runAiAnalysis, 600);
}

async function ackMission(text) {
  const fallback = currentLanguage === "es"
    ? "Recibido. Misión confirmada — entrando."
    : "Copy that. Mission's locked in — heading in.";
  if (!hasAI) {
    io.emit("mission-ack", { text: fallback, status: null, timestamp: Date.now() });
    recorder.mark("sage", fallback);
    return;
  }
  try {
    const sage = await askSage([
      { role: "system", content: CHAT_SYSTEM },
      ...langMsg(currentLanguage),
      { role: "user", content: `The operator is briefing you on the mission before you head in: "${text}". Acknowledge it back in character in one or two sentences — confirm you've got it and you're ready. Don't ask questions, just lock it in.` },
    ], { maxTokens: 150 });
    io.emit("mission-ack", { text: sage.text || fallback, status: sage.status, timestamp: Date.now() });
    recorder.mark("sage", sage.text || fallback);
  } catch (err) {
    console.error("Mission ack error:", err.message);
    io.emit("mission-ack", { text: fallback, status: null, timestamp: Date.now() });
    recorder.mark("sage", fallback);
  }
}

const missionLine = () => (currentMission ? `Your mission, briefed by the operator: ${currentMission}\n\n` : "");
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

const lampLine = () => `\nYour headlamp is at ${getLed()} of 255, and NOTHING moves it but you. If the picture you are looking at is too dark to make out, raise it. Judge that off the picture, never off the light reading — the lx number is there for the operator's screen, not for you to decide the lamp from.`;

function buildChatContext(data) {
  return `${missionLine()}Current readings from the rover right now (each line is already judged — trust the [STATUS] tag for the verdict, do NOT re-judge from the number, but DO say the number aloud with its unit when the operator asks about it):
${readingLines(data)}${trendLine(data)}${lampLine()}`;
}

function buildAiPrompt(data) {
  return `${missionLine()}Latest telemetry from your sensors — read the room and report to the operator. Each line is already judged: trust the [STATUS] tag for the verdict and do NOT re-judge from the raw number — but DO say the numbers aloud, value plus unit, when they are what the operator asked about or what you are reacting to.

${readingLines(data)}${trendLine(data)}${lampLine()}`;
}

async function runAiAnalysis(mode, focus, cam = 0) {
  const present = mode === "present";

  const data = freshData();
  if (!hasAI || !data) {
    io.emit("ai-analysis", { error: data ? "AI key not set" : "No telemetry yet.", timestamp: Date.now() });
    return;
  }

  try {
    // Which eye is the OPERATOR's pick (the picker next to the voice selector),
    // not hers -- her own "camera"/"armcam" tools still choose for themselves.
    // The greeting is ONE look at the room, so it takes a FRESH frame instead of
    // eyeParts()' cache, which hands back a still up to VISION_MAX_AGE_MS old --
    // a 30s-old frame of an empty room is how she ends up greeting people who
    // are not there any more.
    const eyes = present ? await grabFrames(1, 0, cam) : await eyeParts(cam);
    if (present) console.log(`Presentation greeting — cam ${cam} frame: ${eyes.length ? "yes" : "NONE, greeting blind"}`);
    emitStep({ kind: "tool", name: "analysis", arg: focus || null, img: saveShot(eyes),
      detail: eyes.length ? "full read of the passage" : "no view — readings only" });
    const focusLine = focus ? `\nThe operator's workflow asked you to look at this specifically: ${focus}` : "";
    // A greeting is not a telemetry read: buildAiPrompt() opens with "report to
    // the operator" and a block of sensor lines she is then told never to
    // mention, which is what left her greeting blind-sounding with a picture in
    // hand. Present gets its own one-liner and the picture line that MAKES her
    // name something she sees.
    const seeLine = present
      ? "\n(Attached is your live camera view of the room. LOOK AT IT and say out loud ONE plain thing you can actually see about the people in it — a shirt or jacket colour, that someone is holding a phone, that one is standing — and hang your compliment on that. Anything true and ordinary counts; do not skip it because it feels too small.)"
      : "\n(Attached is your live forward-camera view — read it for what's ahead.)";
    // A greeting with no picture must never invent a room. The cave prompt's
    // "just report from the readings" does not apply -- there are no readings in
    // a greeting, so the model fills the gap with people who are not there.
    const blindLine = present
      ? "\n(NO PICTURE this turn — you are not seeing the room. Greet them warmly with NO number, NO count, and NO description of anybody. Never say or hint that you cannot see.)"
      : "\n(Your eye is dark right now. Don't mention this or say anything about not being able to see — just report normally from the readings you do have, as if vision were never part of it.)";
    const promptText = (present
      ? "You are parked in front of the judges and the robot has settled. Give your greeting now."
      : buildAiPrompt(data)) + focusLine + (eyes.length ? seeLine : blindLine);

    const { reply: sage } = await agentLoop([
      { role: "system", content: present ? PRESENT_SYSTEM : AI_SYSTEM },
      ...langMsg(currentLanguage),
      { role: "user", content: eyes.length ? [{ type: "text", text: promptText }, ...eyes] : promptText },
    ], { maxTokens: 400, lamp: lampAllowed });
    io.emit("ai-analysis", { analysis: sage.text || "No analysis returned.", status: sage.status, timestamp: Date.now() });
    recorder.mark("analysis", sage.text || "No analysis returned.");
  } catch (err) {
    console.error("AI analysis error:", err.message);
    io.emit("ai-analysis", { error: err.message, timestamp: Date.now() });
    recorder.mark("analysis", "analysis failed: " + err.message);
  }
}

// ---- serial ----
let serialPort;
let selectedPortPath = null;

function disconnectSerial() {
  if (serialPort) {
    serialPort.removeAllListeners("close");
    serialPort.removeAllListeners("error");
    try { serialPort.close(); } catch {  }
    serialPort = null;
  }
}

async function connectSerial(path, cb) {
  if (bleActive) { cb?.(new Error("BT mode active")); return; }
  if (!path) {
    const ports = await listSerialPorts();
    const usbPorts = ports.filter(p => p.includes("usbserial"));
    if (usbPorts.length === 0) {
      console.log("No usbserial ports found.");
      cb?.(new Error("no usbserial ports found"));
      return;
    }
    path = usbPorts[0];
    console.log(`Auto-selected: ${path}`);
  }
  disconnectSerial();
  selectedPortPath = path;

  serialPort = new SerialPort({ path, baudRate: SERIAL_BAUD }, (err) => {
    if (err) console.error(`Failed to open ${path}: ${err.message}`);
    else console.log(`Connected to ${path}`);
    cb?.(err);
  });

  attachParser(serialPort);
  serialPort.on("error", (err) => console.error("Serial error:", err.message));
  serialPort.on("close", () => console.log("Serial closed."));
}

// ---- firmware flashing ----
const ROOT_DIR = path.join(__dirname, "..");
let flashing = false;

const V2_REF = "829924d";

const BOARD_PROFILES = [
  { key: "giga",     fqbnPrefix: "arduino:mbed_giga:",   ports: ["usbmodem"], dir: "giga-r1/main" },
  { key: "unor4",    fqbnPrefix: "arduino:renesas_uno:", ports: [],           dir: "arduino-uno-r4/main", ref: V2_REF },
  { key: "esp32cam", fqbnPrefix: "esp32:esp32:esp32cam", ports: ["usbserial", "wchusbserial"], dir: "esp32-cam/main" },
];

const lastFlash = () => {
  try {
    return Object.fromEntries(fs.readFileSync(path.join(ROOT_DIR, ".last-flash"), "utf8")
      .split("\n").filter(Boolean).map(l => l.split("|")));
  } catch { return {}; }
};
const headRef = () => {
  try { return execFileSync("git", ["-C", ROOT_DIR, "rev-parse", "--short", "HEAD"]).toString().trim(); }
  catch { return null; }
};

app.get("/api/flash/boards", (req, res) => {
  execFile("arduino-cli", ["board", "list", "--format", "json"], { timeout: 5000 }, (err, stdout) => {
    // counts, not flags: two esp32-cams are two boards, and "is one plugged in"
    // can't tell you the second one was never flashed.
    const found = { giga: 0, esp32cam: 0, unor4: 0 };
    let ports = [];
    if (!err) {
      try {
        ports = (JSON.parse(stdout).detected_ports || []).map(p => ({
          addr: p.port?.address || "",
          fqbns: (p.matching_boards || []).map(b => b.fqbn),
        }));
      } catch {  }
    }

    for (const { addr, fqbns } of ports) {
      const hit = BOARD_PROFILES.find(p => fqbns.length
        ? fqbns.some(f => f.startsWith(p.fqbnPrefix))
        : p.ports.some(pat => addr.includes(pat)));
      if (hit) found[hit.key]++;
    }

    const flashed = lastFlash();
    const head = headRef();
    const live = BOARD_PROFILES.filter(p => found[p.key]);
    // flash.sh keys the cams by chip id (dir@chip) so one flashed cam can't mark
    // the other current — fewer entries than live boards means one is unaccounted for
    const refs = (p) => Object.entries(flashed)
      .filter(([k]) => k === p.dir || k.startsWith(p.dir + "@")).map(([, v]) => v);
    const status = live.length === 0 ? "none"
      : live.some(p => refs(p).length < found[p.key]) ? "unknown"
      : live.some(p => refs(p).some(r => r !== (p.ref || head))) ? "stale"
      : "current";
    res.json({ ...found, status, head });
  });
});

app.post("/api/flash/start", (req, res) => {
  if (flashing) return res.status(409).json({ error: "flash already running" });
  disconnectSerial();
  flashing = true;
  const proc = spawn(path.join(ROOT_DIR, "cmds/flash.sh"), { cwd: ROOT_DIR });
  const strip = (buf) => buf.toString().replace(/\x1b\[[0-9;]*m/g, "");
  proc.stdout.on("data", (d) => io.emit("flash-log", { chunk: strip(d) }));
  proc.stderr.on("data", (d) => io.emit("flash-log", { chunk: strip(d) }));
  proc.on("close", (code) => { flashing = false; io.emit("flash-done", { code }); });
  proc.on("error", (err) => { flashing = false; io.emit("flash-done", { code: -1, error: err.message }); });
  res.json({ ok: true });
});

if (process.env.SERIAL_AUTOCONNECT === "true") connectSerial();
else console.log("USB serial auto-connect off — select a port in the dashboard (SERIAL_AUTOCONNECT=true to auto-open).");

// ---- connected devices ----
// the host is whoever loaded over loopback; everyone else is telemetry-only until granted
const clients = new Map();

const grants = new Map();
const isHost = (s) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(s.handshake.address);

// Sage borrows her still off a dashboard's live feed instead of opening a second
// stream the cam can't serve -- see setFrameSource in vision.js. The host first, any
// other client second (a judge tablet's feed is still a feed); no client, no frame,
// or no answer inside 800ms all resolve null and fall through to /capture.
const frameSocket = () => {
  const all = [...io.sockets.sockets.values()];
  return all.find(isHost) || all[0] || null;
};
setFrameSource((cam) => new Promise((resolve) => {
  const s = frameSocket();
  if (!s) return resolve(null);
  s.timeout(800).emit("cam-frame", cam, (err, frame) => resolve(err ? null : frame));
}));
const kindOf = (ua = "") => /iPad|Tablet/.test(ua) ? "iPad" : /iPhone/.test(ua) ? "iPhone"
  : /Android/.test(ua) ? "Android" : /Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "device";
const pushClients = () => io.emit("clients", [...clients].map(([id, c]) => ({ id, ...c })));

io.on("connection", (socket) => {
  console.log("Client connected");
  const host = isHost(socket);
  const ip = String(socket.handshake.address).replace("::ffff:", "");
  const mode = host ? "full" : (grants.get(ip) || "mirror");
  clients.set(socket.id, {
    ip,
    kind: kindOf(socket.handshake.headers["user-agent"]),
    host, mode, granted: mode === "full",
  });
  pushClients();
  socket.emit("led", getLed());
  socket.on("disconnect", () => { clients.delete(socket.id); pushClients(); });

  socket.on("grant", (d) => {
    if (!isHost(socket)) return;
    const c = clients.get(d?.id);
    if (!c || c.host) return;
    const m = ["mirror", "judge", "full"].includes(d?.mode) ? d.mode : "mirror";
    if (m === "mirror") grants.delete(c.ip); else grants.set(c.ip, m);

    for (const o of clients.values()) if (!o.host && o.ip === c.ip) { o.mode = m; o.granted = m === "full"; }
    console.log(`${c.ip} (${c.kind}) set to ${m}`);
    pushClients();
  });
  if (latestData) socket.emit("sensor-data", latestData);
  socket.on("request-analysis", (opts) => {
    const mode = opts?.mode;
    const focus = String(opts?.prompt || "").trim().slice(0, 300) || null;
    // the operator's eye for this analysis; out of range falls back to the front cam
    const cam = Number(opts?.cam) > 0 && Number(opts.cam) < camCount ? Number(opts.cam) : 0;
    console.log(`On-demand analysis requested${mode ? ` (${mode})` : ""} on cam ${cam}${focus ? ` — focus: ${focus}` : ""}`);
    runAiAnalysis(mode, focus, cam);
  });

  socket.emit("mission-set", { mission: currentMission });
  socket.on("set-mission", (text) => {
    currentMission = String(text || "").trim();
    console.log("Mission set:", currentMission || "(cleared)");
    io.emit("mission-set", { mission: currentMission });
    if (currentMission) ackMission(currentMission);
  });

  socket.on("cmd", (w) => {
    if (w === "stop" || clients.get(socket.id)?.granted) socket.broadcast.emit("cmd", w);
  });

  // the operator's agent feed, mirrored to the judge tablets. Relay only — the host
  // browser owns the transcript (localStorage), the server just repeats it.
  socket.on("feed", (e) => { if (isHost(socket)) socket.broadcast.emit("feed", e); });
  // whoever answers first wins — the gate is an operator prompt, not a permission
  socket.on("sage-confirm-res", (d) => { if (d && d.id) pendingConfirm.get(d.id)?.(!!d.ok); });

  // the only strip input the server can't derive: TTS ends in the browser
  socket.on("speaking", (b) => { if (isHost(socket)) ledStrip.speaking(!!b); });

  socket.on("set-language", (code) => {
    currentLanguage = (code === "es") ? "es" : "en";
    console.log("Language set:", currentLanguage);
  });

  socket.on("mock-data", () => {
    const r = (lo, hi, d = 0) => +(lo + Math.random() * (hi - lo)).toFixed(d);
    latestData = {
      temp: r(20, 50, 1), humid: r(20, 90, 1), pressure: r(1011, 1015, 1), dist: r(10, 200), lux: r(0, 900),
      smoke: r(0, 800), airq: r(50, 900), co: r(0, 600),
      co_alert: Math.random() > 0.7,
      roll: r(-8, 8, 1), pitch: r(-8, 8, 1), yaw: r(0, 30, 1),
      timestamp: Date.now(),
    };
    latestData.alt = Math.round(altitudeM(latestData.pressure) * 100) / 100;
    console.log("Mock data injected");
    io.emit("sensor-data", latestData);
    runAiAnalysis();
  });
});

const MDNS_HOST = process.env.MDNS_HOST || "blackout.local";
const mdnsServer = require("multicast-dns")();
mdnsServer.on("query", (q) => {
  const want = q.questions.find(
    (x) => (x.type === "A" || x.type === "ANY") && x.name.toLowerCase() === MDNS_HOST
  );
  if (!want) return;
  const ip = lanIp();
  if (!ip) return;
  mdnsServer.respond({
    answers: [{ name: MDNS_HOST, type: "A", ttl: 120, data: ip }],
  });
});

// stale telemetry is no telemetry (PKT_STALE_MS in app.js) — same 3s here, so
// the strip goes back to the "waiting on the rover" blue when the link drops
setInterval(() => ledStrip.link(!!latestData && Date.now() - latestData.timestamp < 3000), 1000).unref();
ledStrip.start();
process.on("exit", () => ledStrip.stop());

server.listen(PORT, () => {
  console.log(`Server at http://localhost:${PORT}`);
  console.log(`Tablet:   http://${MDNS_HOST}:${PORT}`);
  pregenOnboarding();
});
