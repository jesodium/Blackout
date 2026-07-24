require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");
const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");
const OpenAI = require("openai");
const { eyeParts, grabFrames, setLed, getLed } = require("./vision");
const { parseSage } = require("./sage");

const openai = new OpenAI({
  baseURL: "https://api.cerebras.ai/v1",
  apiKey: process.env.CEREBRAS_API_KEY,
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
  const { glob } = await import("glob");
  return await glob("/dev/cu.*");
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
    timestamp: Date.now(),
  };
  latestData = data;
  dataHistory.push(data);
  if (dataHistory.length > 1000) dataHistory.shift();
  io.emit("sensor-data", data);
  maybeAutoAnalyze(data);
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

// --- bluetooth "bridge" intent flag ---
// the actual ble connection lives in the browser (web bluetooth). these just
// track intent server-side so usb serial and bt stay mutually exclusive.
let bleActive = false;

app.get("/api/bridge", (req, res) => res.json({ running: bleActive, last: "" }));

app.post("/api/bridge/start", (req, res) => {
  disconnectSerial(); // close usb when bt takes over
  bleActive = true;
  res.json({ ok: true });
});

app.post("/api/bridge/stop", (req, res) => {
  bleActive = false;
  res.json({ ok: true });
});

// connmode: mutually exclusive bt/usb switch. callers should only use this
// instead of manually calling bridge/start + ports/switch.
app.post("/api/connMode", async (req, res) => {
  const { mode } = req.body;
  if (!mode || !["usb", "bt"].includes(mode))
    return res.status(400).json({ error: "mode must be 'usb' or 'bt'" });

  if (mode === "bt") {
    disconnectSerial(); // close usb, block reconnect — actual ble connect happens client-side via /api/bridge/start
  } else {
    bleActive = false;
    connectSerial(selectedPortPath);
  }

  res.json({ ok: true, mode });
});

app.post("/api/ports/switch", (req, res) => {
  const { path } = req.body;
  if (!path) return res.status(400).json({ error: "path required" });
  if (bleActive) return res.status(409).json({ error: "BT mode active — switch link to USB first" });
  connectSerial(path, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    console.log(`Switched to ${path}`);
    res.json({ ok: true, path });
  });
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
app.post("/api/blk-sage", async (req, res) => {
  if (!process.env.CEREBRAS_API_KEY) return res.status(503).json({ error: "AI key not set" });
  const msgs = Array.isArray(req.body?.messages) ? req.body.messages.slice(-10) : [];
  if (!msgs.length) return res.status(400).json({ error: "messages required" });
  try {
    const resp = await openai.chat.completions.create({
      model: process.env.CEREBRAS_MODEL || "gemma-4-31b",
      messages: [
        { role: "system", content: BLK_SYSTEM },
        ...msgs.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "") })),
      ],
      max_tokens: 700,
    });
    res.json({ reply: resp.choices[0]?.message?.content || "" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

function emitBlurt(prev, cur) {
  if (!prev || Date.now() - lastBlurt < BLURT_MIN_GAP) return;
  const lines = BLURTS[currentLanguage] || BLURTS.en;
  let best = null;
  for (const k of Object.keys(cur)) {
    if (RANK[cur[k]] > RANK[prev[k]] && lines[k]?.[cur[k]]) {
      if (!best || RANK[cur[k]] > RANK[cur[best]]) best = k;
    }
  }
  if (best) { lastBlurt = Date.now(); io.emit("agent-blurt", { text: lines[best][cur[best]], timestamp: Date.now() }); }
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
    return;
  }
  try {
    const sage = await askSage([
      { role: "system", content: CHAT_SYSTEM },
      ...langMsg(currentLanguage),
      { role: "user", content: `The operator is briefing you on the mission before you head in: "${text}". Acknowledge it back in character in one or two sentences — confirm you've got it and you're ready. Don't ask questions, just lock it in.` },
    ], { maxTokens: 150 });
    io.emit("mission-ack", { text: sage.text || fallback, status: sage.status, timestamp: Date.now() });
  } catch (err) {
    console.error("Mission ack error:", err.message);
    io.emit("mission-ack", { text: fallback, status: null, timestamp: Date.now() });
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

async function runAiAnalysis(mode) {
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
    const promptText = buildAiPrompt(data) + (eyes.length
      ? "\n(Attached is your live forward-camera view — read it for what's ahead.)"
      : "\n(Your eye is dark right now. Don't mention this or say anything about not being able to see — just report normally from the readings you do have, as if vision were never part of it.)");
    const sage = await askSage([
      { role: "system", content: present ? PRESENT_SYSTEM : AI_SYSTEM },
      ...langMsg(currentLanguage),
      { role: "user", content: eyes.length ? [{ type: "text", text: promptText }, ...eyes] : promptText },
    ], { maxTokens: 400 });
    io.emit("ai-analysis", { analysis: sage.text || "No analysis returned.", status: sage.status, timestamp: Date.now() });
  } catch (err) {
    console.error("AI analysis error:", err.message);
    io.emit("ai-analysis", { error: err.message, timestamp: Date.now() });
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

// no auto-grab at boot: the server used to blindly open the first usbserial
// port, which stole the esp32-cam's ftdi (and isn't even the uno — that's
// usbmodem). sensors arrive over ble anyway. connect usb only when explicitly
// asked: pick a port in the dashboard, or set serial_autoconnect=true to
// restore the old behavior.
if (process.env.SERIAL_AUTOCONNECT === "true") connectSerial();
else console.log("USB serial auto-connect off — select a port in the dashboard (SERIAL_AUTOCONNECT=true to auto-open).");

// analysis is on-demand only (request-analysis below) — no auto interval.

io.on("connection", (socket) => {
  console.log("Client connected");
  if (latestData) socket.emit("sensor-data", latestData);
  socket.on("request-analysis", (opts) => {
    const mode = opts?.mode;
    console.log(`On-demand analysis requested${mode ? ` (${mode})` : ""}`);
    runAiAnalysis(mode);
  });
  // send the agent the current mission so a freshly-connected dashboard shows it.
  socket.emit("mission-set", { mission: currentMission });
  socket.on("set-mission", (text) => {
    currentMission = String(text || "").trim();
    console.log("Mission set:", currentMission || "(cleared)");
    io.emit("mission-set", { mission: currentMission });
    if (currentMission) ackMission(currentMission);
  });
  socket.on("set-language", (code) => {
    currentLanguage = (code === "es") ? "es" : "en";
    console.log("Language set:", currentLanguage);
  });
  // debug: fake a sensor packet so the dashboard + ai work without the arduino.
  socket.on("mock-data", () => {
    const r = (lo, hi, d = 0) => +(lo + Math.random() * (hi - lo)).toFixed(d);
    latestData = {
      temp: r(20, 50, 1), humid: r(20, 90, 1), pressure: r(980, 1030, 1), dist: r(10, 200),
      smoke: r(0, 800), airq: r(50, 900), co: r(0, 600),
      co_alert: Math.random() > 0.7,
      roll: r(-8, 8, 1), pitch: r(-8, 8, 1), yaw: r(0, 30, 1), // keep rover ~level

      timestamp: Date.now(),
    };
    console.log("Mock data injected");
    io.emit("sensor-data", latestData);
    runAiAnalysis();
  });
});

server.listen(PORT, () => {
  console.log(`Server at http://localhost:${PORT}`);
  pregenOnboarding(); // warm onboarding audio cache (skips already-generated clips)
});
