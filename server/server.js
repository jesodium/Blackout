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
const { eyeParts, grabFrames, setLed, getLed, pingCam } = require("./vision");
const { parseSage } = require("./sage");
const recorder = require("./recorder");

const openai = new OpenAI({
  baseURL: "https://api.cerebras.ai/v1",
  // "unset" keeps the client constructable with no key (fresh desktop install,
  // no .env yet) — the dashboard must boot; Sage calls just fail with an auth
  // error until a real key lands in settings.
  apiKey: process.env.CEREBRAS_API_KEY || "unset",
});

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

// tts proxy. deepgram aura-2 when deepgram_api_key is
// set, else falls back to microsoft edge neural voices (free).
// lets <audio> play progressively.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DG_RETRIES = parseInt(process.env.DEEPGRAM_RETRIES || "3", 10);

async function speakDeepgram(text, res, voice = "en") {
  // match model language to voice, else spanish gets spoken
  // by an english model. override per-language via env.
  const isEs = voice.toLowerCase().startsWith("es");
  const model = isEs
    ? process.env.DEEPGRAM_VOICE_ES || "aura-2-celeste-es"   // celeste — female, colombian; clearest aura-2 spanish. alts: estrella-es (mx), carina-es (es-ES)
    : process.env.DEEPGRAM_VOICE || "aura-2-thalia-en";      // thalia (sage) — female. one fixed female voice; override via deepgram_voice
  const url = `https://api.deepgram.com/v1/speak?model=${model}&encoding=mp3`;
  // retry the fetch (transient 429/5xx/network blips) before we start streaming —
  // once audio is piping we can't retry. 4xx other than 429 is permanent, bail fast.
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
      if (r.status < 500 && r.status !== 429) throw lastErr; // permanent (401/402/400) — don't retry, fall back now
    } catch (e) {
      if (e === lastErr) throw e; // permanent error — stop, let caller fall back to edge
      lastErr = e;               // network/transient error — keep retrying
    }
    if (i < DG_RETRIES) await sleep(250 * (i + 1)); // 250/500/750ms backoff
  }
  if (!r || !r.ok || !r.body) throw lastErr || new Error("Deepgram failed");
  res.setHeader("Content-Type", "audio/mpeg");
  Readable.fromWeb(r.body).on("error", () => res.destroy()).pipe(res);
}

async function speakEdge(text, voice, res) {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  res.setHeader("Content-Type", "audio/mpeg");
  tts.toStream(text).audioStream.on("error", () => res.destroy()).pipe(res);
}

async function ttsHandler(req, res) {
  const src = req.method === "GET" ? req.query : req.body;
  const voice = src?.voice || process.env.TTS_VOICE || "en-US-AndrewNeural";
  const text = (src?.text || "").trim();
  const provider = src?.provider || "auto"; // "edge", "deepgram", or "auto"
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

app.get("/api/tts/providers", (req, res) => {
  res.json({ edge: true, deepgram: !!process.env.DEEPGRAM_API_KEY });
});

// ask-questions mode: operator chats with sage. client sends the running
// message array (no server-side history); we prepend persona + live telemetry.
app.post("/api/chat", async (req, res) => {
  if (!process.env.CEREBRAS_API_KEY) return res.status(503).json({ error: "AI key not set" });
  const msgs = Array.isArray(req.body?.messages) ? req.body.messages.slice(-12) : [];
  if (!msgs.length) return res.status(400).json({ error: "messages required" });
  const lang = LANG_INSTRUCT[req.body?.lang] ? req.body.lang : "en";
  try {
    const d = freshData();
    const ctx = d ? buildChatContext(d) : "No live readings right now — running dark.";
    const mapped = msgs.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "") }));
    // attach the live cam frame to the operator's latest turn so gemma sees it.
    const eyes = await eyeParts();
    if (eyes.length && mapped.length) {
      const last = mapped[mapped.length - 1];
      last.content = [{ type: "text", text: last.content + "\n(Attached is your live forward-camera view.)" }, ...eyes];
    }
    const sage = await askSage([
      { role: "system", content: CHAT_SYSTEM },
      ...langMsg(lang),
      { role: "system", content: ctx },
      ...mapped,
    ], { maxTokens: 400 });
    res.json({ reply: sage });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// take a look: sage asked for a fresh view (action:"analyze"). grabs a still and
// lets sage narrate what it sees. same json reply shape as /api/chat.
// the camera is fixed forward — it used to ride a pin-9 servo and this grabbed
// several stills across a slow pan, hence the frame-count arg below.
app.post("/api/scan", async (req, res) => {
  if (!process.env.CEREBRAS_API_KEY) return res.status(503).json({ error: "AI key not set" });
  try {
    // 1 frame: the view no longer moves, so extra stills would be the same picture
    // at more base64 bytes — and 4 svga stills blow past cerebras' request cap (413).
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

// elevation from the bme280's pressure — same barometric formula Adafruit's
// readAltitude() runs, derived here so the reference is a knob, not a reflash.
// the reference defaults to the FIRST valid reading, so the tile reads elevation
// *relative to where the rover started*: metres climbed/descended, self-zeroing at
// any venue. that's the number a rover in a cave needs, and 1013.25 was flat wrong
// anywhere the day's QNH differed (it read tens of metres off, often negative).
// set SEA_LEVEL_HPA (venue QNH) to get true height above sea level instead.
// IMPORTANT NOTE: pressure 0 means no bme wired, not sea level — no reading, not 0m.
//
// the zero LEAKS toward ambient (REF_TAU). a fixed zero looks broken over a session
// and it isn't the code: the weather moves the air 1-2 hPa an hour, which the same
// formula reads as 8-17 m of climbing while the rover sits still. leaking the
// reference is a high-pass — anything slower than REF_TAU is absorbed as weather,
// anything faster than it shows. a ramp takes seconds, so it lands well inside.
// IMPORTANT NOTE: the cost is that a HELD height decays to 0 over ~REF_TAU, and
// ~1m of instantaneous noise is the bme's own, not fixable here. sub-metre absolute
// height needs a different sensor (tof/sonar to the floor), not a better filter.
const REF_TAU = +process.env.REF_TAU_S || 300; // s. shorter = flatter but forgets a climb sooner.
const absRef = !!process.env.SEA_LEVEL_HPA; // an explicit QNH is absolute — never leak it
let refHPa = absRef ? parseFloat(process.env.SEA_LEVEL_HPA) : null;
let refT = 0;
const altitudeM = (hPa) => {
  if (!(hPa > 0)) return 0;
  const now = Date.now();
  if (refHPa == null) refHPa = hPa;  // first reading is the zero
  else if (!absRef) refHPa += (hPa - refHPa) * (1 - Math.exp(-(now - refT) / 1000 / REF_TAU));
  refT = now;
  return 44330 * (1 - Math.pow(hPa / refHPa, 1 / 5.255));
};

// process a raw line: emit to serial monitor, parse "S:" telemetry for dashboard.
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
    // board says whether a motion routine is running. absent on older firmware —
    // false keeps auto-analysis behaving as before.
    routine: parts.length > 11 ? parts[11].trim() === "1" : false,
    // bh1750 ambient light. parsed so runs record it; nothing displays it yet.
    lux: parts.length > 12 ? parseFloat(parts[12]) : 0,
    timestamp: Date.now(),
  };
  // derived, not a csv field. 2dp = cm resolution, which the dashboard's cm view reads.
  data.alt = Math.round(altitudeM(data.pressure) * 100) / 100;
  latestData = data;
  dataHistory.push(data);
  if (dataHistory.length > 1000) dataHistory.shift();
  recorder.push(data); // no-op unless a run is being recorded
  io.emit("sensor-data", data);
  maybeAutoAnalyze(data);
  pushHud(data);
}

// pipe a readline parser onto a port.
function attachParser(sp) {
  const parser = sp.pipe(new ReadlineParser({ delimiter: "\n" }));
  parser.on("data", (raw) => processLine(raw));
}

// sensor data pushed over http — the r4 wifi's ble notify data arrives via the
// browser's own web bluetooth (no server-side native bt lib), which forwards
// each line here. also usable directly over wifi if a board posts here itself.
app.post("/api/mega/sensor", (req, res) => {
  let raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  if (!raw || !raw.length) return res.status(400).json({ error: "empty" });
  const lines = raw.split("\n");
  for (const l of lines) processLine(l);
  res.json({ ok: true, lines: lines.length });
});

// --- mission recordings: telemetry + cam stills, played back in the dashboard ---
// not gated behind mirror-mode grant: recording touches nothing on the robot.
app.use("/recordings", express.static(recorder.DIR));
app.get("/api/rec", (req, res) => res.json({ now: recorder.state(), runs: recorder.list() }));
// no cam, no recording — a run with no video is a scrubber over a black screen,
// and the operator finds out after the run instead of before it.
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

// --- bluetooth "bridge" intent flag ---
// the actual ble connection lives in the browser (web bluetooth). these just
// track intent server-side so usb serial and bt stay mutually exclusive.
let bleActive = false;

app.get("/api/bridge", (req, res) => res.json({ running: bleActive, last: "" }));

// the laptop's lan address, so the judges' tablet can be pointed at this dashboard
// without anyone opening a terminal. first non-internal ipv4 — on a hotspot that's the only one.
const lanIp = () => Object.values(os.networkInterfaces()).flat()
  .find(i => i.family === "IPv4" && !i.internal)?.address;

app.get("/api/lan", (req, res) => {
  const ip = lanIp();
  res.json({ url: ip ? `http://${ip}:${PORT}` : null, host: `http://blackout.local:${PORT}` });
});

// cloud reachability for the dashboard's pills. the venue has no internet and both of
// these fail silently without it. a 401/404 still means the host answered — only a thrown
// request counts as unreachable. cached, because every dashboard on the lan polls it.
// the api roots, not real endpoints: the question is only whether the host answers at
// all. an authenticated path hangs for an unauthenticated probe and reads as "offline".
const CLOUD_HOSTS = { sage: "https://api.cerebras.ai/", tts: "https://api.deepgram.com/" };
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
  disconnectSerial(); // close usb when bt takes over
  bleActive = true;
  res.json({ ok: true });
});

app.post("/api/bridge/stop", (req, res) => {
  bleActive = false;
  res.json({ ok: true });
});

// --- blk workflows: plain .blk text files in ./workflows, name comes from url ---
const BLK_DIR = path.join(__dirname, "workflows");
fs.mkdirSync(BLK_DIR, { recursive: true });
// sanitized name -> path, null if nothing safe remains (also kills traversal)
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

// sage as workflow author: editor chats here, sage replies with prose + one
// fenced blk program. plain text reply — not the json persona used elsewhere.
// own path (not /api/blk/:name) so it can't collide with a workflow's name.
// no client-picked mode — sage reads the operator's message itself and decides
// whether it's a write/explain/fix/improve job. `program` is whatever is on
// the editor canvas right now, so "add a turn at the end" has something to add to.
const BLK_SAGE_JOB =
  "Read the operator's message and the current program (if any) and figure out what job this is: " +
  "writing or changing a workflow, explaining one, auditing it for mistakes, or improving it. Then do that job. " +
  "If they want a program written or changed, reply with one or two sentences then the complete program. " +
  "If they want an explanation, answer in plain language, step by step, call out anything risky, and do NOT include a code block unless a change was also requested. " +
  "If they want mistakes found or the program improved, say what's wrong or what you changed in a couple of lines, then give the corrected/improved complete program.";

app.post("/api/blk-sage", async (req, res) => {
  if (!process.env.CEREBRAS_API_KEY) return res.status(503).json({ error: "AI key not set" });
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
    const resp = await openai.chat.completions.create({
      model: process.env.CEREBRAS_MODEL || "gemma-4-31b",
      messages: [
        { role: "system", content: BLK_SYSTEM },
        ...ctx,
        ...msgs.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "") })),
      ],
      max_tokens: 900,
    });
    res.json({ reply: resp.choices[0]?.message?.content || "" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// yes/no judgement for the blk `ask` and `find` ops. one shared helper: both
// want a decision the program can branch on, not prose, so the model is pinned
// to a tiny json shape and anything unparseable reads as "no".
async function sageDecide(question, { images = [], extra = "" } = {}) {
  const text = `${question}\n\n${extra}\nAnswer with JSON only: {"yes": true|false, "why": "<one short sentence>"}`;
  const resp = await openai.chat.completions.create({
    model: process.env.CEREBRAS_MODEL || "gemma-4-31b",
    messages: [
      { role: "system", content: CHAT_SYSTEM },
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

// `ask <question>` — judged from telemetry (+ the live view when there is one).
app.post("/api/blk-ask", async (req, res) => {
  if (!process.env.CEREBRAS_API_KEY) return res.status(503).json({ error: "AI key not set" });
  const question = String(req.body?.question || "").trim().slice(0, 400);
  if (!question) return res.status(400).json({ error: "question required" });
  try {
    // the simulator has no camera and its own fake telemetry — take what it sends
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

// `find <thing>` — camera-backed: is that thing in view right now? a hit is
// logged to the analysis panel like any other discovery.
app.post("/api/blk-find", async (req, res) => {
  if (!process.env.CEREBRAS_API_KEY) return res.status(503).json({ error: "AI key not set" });
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

// headlamp from a workflow's `led` step (0-255). fire-and-forget on the cam side.
app.post("/api/led", async (req, res) => {
  const v = Math.max(0, Math.min(255, Math.round(Number(req.body?.value))));
  if (isNaN(v)) return res.status(400).json({ error: "value 0-255 required" });
  try { await setLed(v); res.json({ ok: true, value: v }); }
  catch (err) { res.status(502).json({ error: err.message }); }
});

let latestData = null;
let dataHistory = [];
// latestdata is only "current" while the link is alive — telemetry lands every
// ~100ms, so anything older than 10s means the link died. don't present a
// minutes-old reading to sage as "right now".
const freshData = () => (latestData && Date.now() - latestData.timestamp < 10000 ? latestData : null);
let currentMission = "";   // operator's briefing — colors all agent replies until changed
let currentLanguage = "en"; // ui language — the agent must reply in this language

// one extra system line forcing the reply language. english is the default
// (prompts are written in english), so it needs no instruction.
const LANG_INSTRUCT = {
  es: "IMPORTANTE: Responde SIEMPRE en español natural y fluido, sin importar el idioma de las lecturas, etiquetas o del mensaje del operador. Mantén tu personaje y tono.",
};
const langMsg = (lang) => (LANG_INSTRUCT[lang] ? [{ role: "system", content: LANG_INSTRUCT[lang] }] : []);

// onboarding lines spoken during the briefing wizard. pre-rendered to
// public/audio on boot so the wizard plays them instantly (no 5-7s synth wait).
// text + voices must match public/js/i18n.js (onboarding + langs).
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

// generate any missing onboarding clips by hitting our own /api/tts and saving
// the audio to disk. runs once on boot; skips files that already exist.
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

// system prompts live in prompts/*.md so they're easy to tweak without touching code.
const loadPrompt = (name) => fs.readFileSync(path.join(__dirname, "prompts", name), "utf8").trim();
const AI_SYSTEM = loadPrompt("analysis.md");
const CHAT_SYSTEM = loadPrompt("chat.md");
const BLK_SYSTEM = loadPrompt("blk.md");
// the presentation routine's closing look is a greeting to the judges, not a cave
// read — same camera grab, different system prompt.
const PRESENT_SYSTEM = loadPrompt("present.md");

// sage's discoveries land in the dashboard's analysis panel with the still she saw.
// the image is written to disk and the finding carries only its url: findings ride
// inside `chats` in the browser, which is json.stringify'd to localstorage on every
// change — base64 stills there would blow the ~5mb quota and throw on every later
// chat edit. public/ is already static-served, so /findings/x.jpg just resolves, and
// the file outliving a restart is why no findings list is kept server-side.
// important note: never pruned — ~40kb a find. cap it if a session ever makes enough
// to matter.
const FINDINGS_DIR = path.join(__dirname, "public", "findings");
fs.mkdirSync(FINDINGS_DIR, { recursive: true });

// the still sage actually saw is already in the messages we sent her — pull it back
// out rather than re-grabbing (a second grab would be a different moment, and would
// hit the flaky ai-thinker board again). covers every path, including /api/scan's
// grabframes(1), which bypasses vision's framecache.
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

// the prompt tells sage to log a find once, but she's staring at the same drawing for
// as long as it's in frame — so guard the repeat here rather than trusting her, same
// as the lamp hook checks getled() first. re-logging the identical text is a dupe;
// the same find seen again much later is worth its own row.
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
    } catch (e) { console.error("finding still:", e.message); } // log it text-only
  }
  io.emit("sage-finding", { id: `${at}-${Math.random()}`, text, img, timestamp: at });
  recorder.mark("finding", text);
}

// sage now answers in json: { text, status, action, led, finding }. text is the only
// thing voiced/shown; status tints the ui; action:"analyze" lets sage ask for a fresh
// look; led (0-255) drives the cam lamp; finding logs a discovery to the analysis
// panel. parsesage lives in ./sage so it's testable without booting the server. every
// caller goes through here, so the lamp and finding hooks live here too — the lamp
// fire-and-forget, since a cam that won't answer must not stall the reply.
async function askSage(messages, { maxTokens = 400 } = {}) {
  const resp = await openai.chat.completions.create({
    model: process.env.CEREBRAS_MODEL || "gemma-4-31b",
    messages,
    max_tokens: maxTokens,
  });
  const sage = parseSage(resp.choices[0]?.message?.content);
  if (sage.led != null && sage.led !== getLed()) {
    setLed(sage.led).catch((e) => console.error("cam led:", e.message));
  }
  if (sage.finding) recordFinding(sage.finding, lastImage(messages));
  return sage;
}

// ponytail: status thresholds live here (server), single source of truth. the
// model only verbalizes the tag — it must not re-judge from the raw number.
function band(v, warn, danger) {
  if (v == null || isNaN(v)) return "UNKNOWN";
  return v >= danger ? "DANGER" : v >= warn ? "CAUTION" : "NORMAL";
}
function statuses(d) {
  return {
    temp: band(d.temp, 35, 45),
    dist: d.dist < 10 ? "NEAR" : "CLEAR",
    smoke: band(d.smoke, 300, 600),
    airq: band(d.airq, 450, 800),
    // important note: no gas sensor wired right now (mq-9/mq-2 retired with the
    // mega) — smoke/airq/co arrive as 0 from the r4 firmware. thresholds kept
    // for mock data and for when a sensor lands. d.co_alert stays ignored.
    co: band(d.co, 300, 350),
  };
}

// severity rank so we can tell when a reading got worse (not just changed).
const RANK = { CLEAR: 0, NORMAL: 0, UNKNOWN: 0, NEAR: 1, CAUTION: 1, DANGER: 2 };

// instant in-character one-liners fired the moment a reading worsens — no llm
// round-trip, so the agent reacts immediately while the full analysis catches up.
const BLURTS = {
  en: {
    dist:  { NEAR: "Wall's right up on us — easing around it." },
    smoke: { CAUTION: "Smoke's picking up in here.", DANGER: "Heavy smoke now — this is getting bad." },
    airq:  { CAUTION: "Air's getting thick.", DANGER: "Air's gone foul down here." },
    co:    { CAUTION: "Gas reading's climbing.", DANGER: "Gas pocket — that's real danger." },
    temp:  { CAUTION: "Heat's coming up.", DANGER: "It's cooking down here." },
  },
  es: {
    dist:  { NEAR: "El muro está justo encima — lo esquivo con cuidado." },
    smoke: { CAUTION: "El humo está aumentando aquí.", DANGER: "Humo denso ahora — esto se está poniendo feo." },
    airq:  { CAUTION: "El aire se está volviendo espeso.", DANGER: "El aire está viciado aquí abajo." },
    co:    { CAUTION: "La lectura de gas está subiendo.", DANGER: "Bolsa de gas — esto es peligro real." },
    temp:  { CAUTION: "El calor está subiendo.", DANGER: "Esto es un horno aquí abajo." },
  },
};

// short memory line so replies reference the recent past, not just this instant.
function buildTrend(d) {
  const h = dataHistory;
  if (h.length < 8) return "";
  const old = h[Math.max(0, h.length - 20)];
  const dir = (now, then, eps) => (now - then > eps ? "rising" : then - now > eps ? "falling" : null);
  const bits = [];
  const push = (k, label, eps) => { const x = dir(d[k], old[k], eps); if (x) bits.push(`${label} ${x}`); };
  push("temp", "temperature", 1);
  push("airq", "air quality", 30);
  push("smoke", "smoke", 30);
  push("co", "gas", 30);
  return bits.length ? `Trend over the last little while: ${bits.join(", ")}.` : "";
}

// edge-triggered analysis: fire only when a status actually changes, blurt the
// instant the change is for the worse, and rate-limit the full llm analysis.
let lastStatuses = null;
let lastAutoAnalysis = 0;
let lastBlurt = 0;
let pendingAnalysis = null;
const AUTO_MIN_GAP = parseInt(process.env.AUTO_ANALYSIS_GAP || "12", 10) * 1000;
const BLURT_MIN_GAP = 6000; // don't let a flapping sensor spam instant reactions

// cam has no wire to the giga (own wifi, own power) — the giga's oled can only
// learn cam state secondhand. this is the only clock-driven poll in the server;
// everything else here is event-triggered off telemetry. "cmd" is the same
// channel drive commands already ride — whichever browser tab holds the real
// ble link relays it on (app.js's socket "cmd" listener), same as "drv,"/"go,".
let camConnected = null; // null = not checked yet
setInterval(async () => {
  const up = await pingCam();
  if (up === camConnected) return;
  camConnected = up;
  io.emit("cmd", `cam,${up ? "connected" : "not connected"}`);
}, 5000);

// the giga's oled hud. the board draws it but decides nothing: the safety level is
// the worst of the same statuses() the agent reasons over, and the metrics line is
// formatted here, so the screen can never contradict what the agent is saying.
// rides the same "cmd" channel drive commands do — the tab holding the ble link relays it.
let lastHud = "";
let lastHudAt = 0;
const HUD_REPEAT = 3000; // telemetry is 10hz, the screen isn't. resend anyway on this
                         // beat so a board that reconnected mid-stream fills in.
// IMPORTANT NOTE: ble does one write at a time. a hand waving at the sonar changes
// the metrics line every 100ms, and at 10hz those writes collide and get dropped —
// the screen ends up lagging the dashboard by seconds. 4hz is faster than an eye
// reads a 4px font and leaves the link free for drive commands.
const HUD_MIN_GAP = 250;
function pushHud(d) {
  const s = statuses(d);
  const level = ["ok", "warn", "bad"][Math.max(...Object.values(s).map(v => RANK[v] ?? 0))];
  // 999 = sonar timeout = nothing within range, not a real 999cm reading.
  const dist = d.dist >= 999 ? "CLEAR" : `${Math.round(d.dist)}cm`;
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
  // a routine picks its own analysis moments with analyze steps. auto-analysis and
  // blurts fire on status changes at arbitrary times — a proximity trip mid-run
  // would talk over those deliberate reads. stay silent for the whole run. the flag
  // rides every telemetry line, so this clears itself when the routine ends, even if
  // the board is reset mid-run.
  if (data.routine) { lastStatuses = s; return; }
  if (changed && currentMission) emitBlurt(lastStatuses, s);
  lastStatuses = s;
  if (!changed || !currentMission) return; // no active mission → agent stays quiet
  const now = Date.now();
  if (now - lastAutoAnalysis < AUTO_MIN_GAP) return; // don't spam the llm on flapping
  lastAutoAnalysis = now;
  clearTimeout(pendingAnalysis);
  pendingAnalysis = setTimeout(runAiAnalysis, 600); // debounce a burst of changes into one
}

// agent acknowledges the operator's mission briefing in character.
async function ackMission(text) {
  const fallback = currentLanguage === "es"
    ? "Recibido. Misión confirmada — entrando."
    : "Copy that. Mission's locked in — heading in.";
  if (!process.env.CEREBRAS_API_KEY) {
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

// plain-language readings for chat — no sensor part names to parrot, keeps the
// model inside the cave fiction. each reading carries a pre-judged status tag.
const missionLine = () => (currentMission ? `Your mission, briefed by the operator: ${currentMission}\n\n` : "");
const trendLine = (data) => { const t = buildTrend(data); return t ? `\n${t}` : ""; };

// one line per reading. gas/pressure/imu aren't wired yet (r4 firmware sends 0)
// — skip their lines so sage isn't told "pressure: 0 hpa" as a real reading.
// mock data still populates them, so the demo keeps its flavor.
function readingLines(data) {
  const s = statuses(data);
  return [
    `Temperature: ${data.temp}°C [${s.temp}]`,
    `Humidity: ${data.humid}%`,
    data.pressure ? `Pressure: ${data.pressure} hPa` : null,
    data.pressure ? `Elevation: ${Math.round(data.alt)} m relative to where you started` : null,
    `Distance to the rock face ahead: ${data.dist} cm [${s.dist}]`,
    data.smoke ? `Smoke/gas level: ${data.smoke} [${s.smoke}]` : null,
    data.airq ? `Air quality: ${data.airq} [${s.airq}]` : null,
    data.co ? `Combustible gas: ${data.co} [${s.co}]` : null,
    (data.roll || data.pitch || data.yaw) ? `Tilt: roll ${data.roll}°, pitch ${data.pitch}°, yaw ${data.yaw}°` : null,
  ].filter(Boolean).join("\n");
}

const lampLine = () => `\nYour headlamp is currently at ${getLed()} of 255.`;

function buildChatContext(data) {
  return `${missionLine()}Current readings from the rover right now (each line is already judged — trust the [STATUS] tag, do NOT re-judge from the number, and do NOT recite the raw number):
${readingLines(data)}${trendLine(data)}${lampLine()}`;
}

function buildAiPrompt(data) {
  return `${missionLine()}Latest telemetry from your sensors — read the room and report to the operator. Each line is already judged: trust the [STATUS] tag, do NOT re-judge from the raw number, and do NOT recite the raw number aloud.

${readingLines(data)}${trendLine(data)}${lampLine()}`;
}

// `focus` is the optional text a workflow's `analyze <what to look at>` step
// carries — it steers this one read without changing the persona.
async function runAiAnalysis(mode, focus) {
  const present = mode === "present";
  // always emit a result: the dashboard locks into "analyzing" on request and only
  // an ai-analysis event releases it, so a silent return here = infinite spinner.
  const data = freshData();
  if (!process.env.CEREBRAS_API_KEY || !data) {
    io.emit("ai-analysis", { error: data ? "AI key not set" : "No telemetry yet.", timestamp: Date.now() });
    return;
  }
  // grabbing eyeparts() hits the cam's /capture, which fights its /stream task for
  // the same starved ram — tell the dashboard to drop its live feed for the grab,
  // same trade the single-shot scan (runscan in app.js) already makes. auto-fired
  // analysis has no client-side call site to yield from, so the signal has to come
  // from here instead.
  io.emit("cam-yield");
  try {
    const eyes = await eyeParts();
    const focusLine = focus ? `\nThe operator's workflow asked you to look at this specifically: ${focus}` : "";
    const promptText = buildAiPrompt(data) + focusLine + (eyes.length
      ? "\n(Attached is your live forward-camera view — read it for what's ahead.)"
      : "\n(Your eye is dark right now. Don't mention this or say anything about not being able to see — just report normally from the readings you do have, as if vision were never part of it.)");
    const sage = await askSage([
      { role: "system", content: present ? PRESENT_SYSTEM : AI_SYSTEM },
      ...langMsg(currentLanguage),
      { role: "user", content: eyes.length ? [{ type: "text", text: promptText }, ...eyes] : promptText },
    ], { maxTokens: 400 });
    io.emit("ai-analysis", { analysis: sage.text || "No analysis returned.", status: sage.status, timestamp: Date.now() });
    recorder.mark("analysis", sage.text || "No analysis returned.");
  } catch (err) {
    console.error("AI analysis error:", err.message);
    io.emit("ai-analysis", { error: err.message, timestamp: Date.now() });
    recorder.mark("analysis", "analysis failed: " + err.message);
  } finally {
    io.emit("cam-resume");
  }
}

let serialPort;
let selectedPortPath = null;

function disconnectSerial() {
  if (serialPort) {
    serialPort.removeAllListeners("close");
    serialPort.removeAllListeners("error");
    try { serialPort.close(); } catch { /* already closed */ }
    serialPort = null;
  }
}

// open `path` (or auto-pick the first usbserial port) as the active link.
// cb(err) fires once with the open result. important note: no auto-reconnect
// anywhere, on purpose — an unplugged/closed port stays closed until the
// dashboard explicitly picks one again.
async function connectSerial(path, cb) {
  if (bleActive) { cb?.(new Error("BT mode active")); return; } // bt owns the link
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
  disconnectSerial(); // one link at a time
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

/* ---- firmware flash (dashboard "Update Blackout") ----
   the actual work is cmds/flash.sh verbatim — it already detects, compiles,
   uploads and prints its own done line. don't reimplement it in js. */
const ROOT_DIR = path.join(__dirname, "..");
let flashing = false;

// keep dir/ref in step with cmds/flash.sh — it writes .last-flash with these keys.
// V2's sketch only exists at that one commit, so V2 is never "behind" head.
const V2_REF = "829924d";
// order matters, same as the script's table: an unidentified usbmodem reads as a giga.
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
    const found = { giga: false, esp32cam: false, unor4: false };
    let ports = [];
    if (!err) {
      try {
        ports = (JSON.parse(stdout).detected_ports || []).map(p => ({
          addr: p.port?.address || "",
          fqbns: (p.matching_boards || []).map(b => b.fqbn),
        }));
      } catch { /* arduino-cli printed something that isn't json — report nothing found */ }
    }
    // same rule as cmds/flash.sh: trust a reported fqbn, and fall back to the port
    // name only for boards that report none — the esp32-cam's ftdi/ch340 never does.
    for (const { addr, fqbns } of ports) {
      const hit = BOARD_PROFILES.find(p => fqbns.length
        ? fqbns.some(f => f.startsWith(p.fqbnPrefix))
        : p.ports.some(pat => addr.includes(pat)));
      if (hit) found[hit.key] = true;
    }
    // "out of date" = a connected board isn't running what this repo would flash it with
    const flashed = lastFlash();
    const head = headRef();
    const live = BOARD_PROFILES.filter(p => found[p.key]);
    const status = live.length === 0 ? "none"
      : live.some(p => !flashed[p.dir]) ? "unknown"
      : live.some(p => flashed[p.dir] !== (p.ref || head)) ? "stale"
      : "current";
    res.json({ ...found, status, head });
  });
});

app.post("/api/flash/start", (req, res) => {
  if (flashing) return res.status(409).json({ error: "flash already running" });
  disconnectSerial(); // arduino-cli needs exclusive access to the usb port
  flashing = true;
  const proc = spawn(path.join(ROOT_DIR, "cmds/flash.sh"), { cwd: ROOT_DIR });
  const strip = (buf) => buf.toString().replace(/\x1b\[[0-9;]*m/g, "");
  proc.stdout.on("data", (d) => io.emit("flash-log", { chunk: strip(d) }));
  proc.stderr.on("data", (d) => io.emit("flash-log", { chunk: strip(d) }));
  proc.on("close", (code) => { flashing = false; io.emit("flash-done", { code }); });
  proc.on("error", (err) => { flashing = false; io.emit("flash-done", { code: -1, error: err.message }); });
  res.json({ ok: true });
});

// no auto-grab at boot: the server used to blindly open the first usbserial
// port, which stole the esp32-cam's ftdi (and isn't even the uno — that's
// usbmodem). sensors arrive over ble anyway. connect usb only when explicitly
// asked: pick a port in the dashboard, or set serial_autoconnect=true to
// restore the old behavior.
if (process.env.SERIAL_AUTOCONNECT === "true") connectSerial();
else console.log("USB serial auto-connect off — select a port in the dashboard (SERIAL_AUTOCONNECT=true to auto-open).");

// analysis is on-demand only (request-analysis below) — no auto interval.

// connected dashboards. the host is whoever loaded this over loopback — the operator's
// own laptop. everything else is a tablet: telemetry only until the host grants it drive.
const clients = new Map(); // socket.id -> { ip, kind, host, mode, granted }
// grants are held by ip, not socket.id: a tablet that drops wifi for two seconds
// reconnects as a new socket, and re-granting it blind mid-run is worse than
// remembering. IMPORTANT NOTE: ip is the identity — dhcp handing that lease to
// another device would inherit the grant. fine for a match-length competition lan.
// mode: "mirror" (telemetry) | "judge" (telemetry, presentation layout) | "full" (drive).
// granted is just mode === "full" — the client and the cmd gate below still read that.
const grants = new Map(); // ip -> mode
const isHost = (s) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(s.handshake.address);
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
  socket.on("disconnect", () => { clients.delete(socket.id); pushClients(); });
  // only the host hands out control, and its own row can't be revoked.
  socket.on("grant", (d) => {
    if (!isHost(socket)) return;
    const c = clients.get(d?.id);
    if (!c || c.host) return;
    const m = ["mirror", "judge", "full"].includes(d?.mode) ? d.mode : "mirror";
    if (m === "mirror") grants.delete(c.ip); else grants.set(c.ip, m);
    // the mode belongs to the device, so it has to catch its other tabs too.
    for (const o of clients.values()) if (!o.host && o.ip === c.ip) { o.mode = m; o.granted = m === "full"; }
    console.log(`${c.ip} (${c.kind}) set to ${m}`);
    pushClients();
  });
  if (latestData) socket.emit("sensor-data", latestData);
  socket.on("request-analysis", (opts) => {
    const mode = opts?.mode;
    const focus = String(opts?.prompt || "").trim().slice(0, 300) || null;
    console.log(`On-demand analysis requested${mode ? ` (${mode})` : ""}${focus ? ` — focus: ${focus}` : ""}`);
    runAiAnalysis(mode, focus);
  });
  // send the agent the current mission so a freshly-connected dashboard shows it.
  socket.emit("mission-set", { mission: currentMission });
  socket.on("set-mission", (text) => {
    currentMission = String(text || "").trim();
    console.log("Mission set:", currentMission || "(cleared)");
    io.emit("mission-set", { mission: currentMission });
    if (currentMission) ackMission(currentMission);
  });
  // tablet clients have no web bluetooth — hand their drive commands to whichever client holds the ble link.
  // stop is never gated — an e-stop from the judges' tablet must always land.
  socket.on("cmd", (w) => {
    if (w === "stop" || clients.get(socket.id)?.granted) socket.broadcast.emit("cmd", w);
  });
  socket.on("set-language", (code) => {
    currentLanguage = (code === "es") ? "es" : "en";
    console.log("Language set:", currentLanguage);
  });
  // debug: fake a sensor packet so the dashboard + ai work without the arduino.
  socket.on("mock-data", () => {
    const r = (lo, hi, d = 0) => +(lo + Math.random() * (hi - lo)).toFixed(d);
    latestData = {
      // pressure jitters over a few hPa, not the full 980-1030 range: elevation is
      // relative now, and a 50 hPa swing reads as the rover teleporting 400m.
      temp: r(20, 50, 1), humid: r(20, 90, 1), pressure: r(1011, 1015, 1), dist: r(10, 200),
      smoke: r(0, 800), airq: r(50, 900), co: r(0, 600),
      co_alert: Math.random() > 0.7,
      roll: r(-8, 8, 1), pitch: r(-8, 8, 1), yaw: r(0, 30, 1), // keep rover ~level

      timestamp: Date.now(),
    };
    latestData.alt = Math.round(altitudeM(latestData.pressure) * 100) / 100;
    console.log("Mock data injected");
    io.emit("sensor-data", latestData);
    runAiAnalysis();
  });
});

// --- mdns: answer to blackout.local ---
// the judges' tablet needs one address that survives dhcp. macos already
// advertises the laptop's own hostname, but that name follows the laptop, not
// the robot — this pins the rover's dashboard to the same naming as
// blackout-cam.local. ios resolves .local natively, so it's http://blackout.local:PORT
// in safari and nothing to type twice.
// IMPORTANT NOTE: unicast responses only for A queries we're asked for. no
// service (_http._tcp) record — nothing browses for one, add it if a client does.
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

server.listen(PORT, () => {
  console.log(`Server at http://localhost:${PORT}`);
  console.log(`Tablet:   http://${MDNS_HOST}:${PORT}`);
  pregenOnboarding(); // warm onboarding audio cache (skips already-generated clips)
});
