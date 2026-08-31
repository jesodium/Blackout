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
const { eyeParts, grabFrames, setLed, getLed, pingCam, rampTo, LAMP_MAX } = require("./vision");
const { parseSage, snapSummary, wantsTool } = require("./sage");
const recorder = require("./recorder");

// ---- brains ----
// tried in order, so a dead or rate-limited primary costs one retry, not the run
const BRAINS = [
  ["cerebras", process.env.CEREBRAS_API_KEY, "https://api.cerebras.ai/v1", process.env.CEREBRAS_MODEL || "gemma-4-31b", {}],
  ["openrouter", process.env.OPENROUTER_API_KEY, "https://openrouter.ai/api/v1", process.env.OPENROUTER_MODEL || "google/gemma-4-31b-it:free", {}],
  ["groq", process.env.GROQ_API_KEY, "https://api.groq.com/openai/v1", process.env.GROQ_MODEL || "qwen/qwen3.6-27b", { reasoning_effort: "none" }],
  ["gemini", process.env.GEMINI_API_KEY, "https://generativelanguage.googleapis.com/v1beta/openai/", process.env.GEMINI_MODEL || "gemini-3.6-flash", { reasoning_effort: "minimal" }],
  ["lmstudio", process.env.LMSTUDIO_URL && "lm-studio", process.env.LMSTUDIO_URL || "http://localhost:1234/v1", process.env.LMSTUDIO_MODEL || "google/gemma-4-12b", {}],
].filter(([, key]) => key).map(([name, key, baseURL, model, tune]) => ({ name, model, tune, baseURL, client: new OpenAI({ baseURL, apiKey: key, maxRetries: 0 }) }));
const hasAI = BRAINS.length > 0;

const BRAIN_DEAD = new Set([401, 402, 403, 404]);

async function chat(params) {
  let last;
  for (let pass = 0; pass < 2; pass++) {
    for (const b of BRAINS) {
      if (b.dead || (pass && b.cooled)) continue;
      try { return await b.client.chat.completions.create({ model: b.model, ...b.tune, ...params }); }
      catch (e) {
        last = e;

        if (e.status === 429) { b.cooled = true; console.error(`${b.name} rate-limited — skipping the retry pass`); continue; }
        if (BRAIN_DEAD.has(e.status)) b.dead = e.status;
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
  tts.toStream(text).audioStream.on("error", () => res.destroy()).pipe(res);
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
  try {
    const d = freshData();
    const ctx = d ? buildChatContext(d) : "No live readings right now — running dark.";
    const mapped = msgs.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "") }));

    const { reply, steps } = await agentLoop([
      { role: "system", content: CHAT_SYSTEM },
      ...langMsg(lang),
      { role: "system", content: ctx },
      ...(moves ? [] : [{ role: "system", content: "MOVE LOCK: your drive is locked out right now. Never offer to move or set \"move\" this turn." }]),
      ...mapped,
    ], { maxTokens: 400 });
    if (!moves && reply) reply.move = null;
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
  if (data.lux != null) darkCheck(data.lux);
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

const CLOUD_HOSTS = { sage: BRAINS[0] ? new URL(BRAINS[0].baseURL).origin + "/" : "https://api.groq.com/", tts: "https://api.deepgram.com/" };
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

app.post("/api/led", async (req, res) => {
  const v = Math.max(0, Math.min(255, Math.round(Number(req.body?.value))));
  if (isNaN(v)) return res.status(400).json({ error: "value 0-255 required" });
  try { await setLed(v); res.json({ ok: true, value: v }); }
  catch (err) { res.status(502).json({ error: err.message }); }
});

// ---- sage ----
let latestData = null;
let dataHistory = [];

const freshData = () => (latestData && Date.now() - latestData.timestamp < 10000 ? latestData : null);
let currentMission = "";
let currentLanguage = "en";

const LANG_INSTRUCT = {
  es: "IMPORTANTE: Responde SIEMPRE en español natural y fluido, sin importar el idioma de las lecturas, etiquetas o del mensaje del operador. Mantén tu personaje y tono.",
};
const langMsg = (lang) => (LANG_INSTRUCT[lang] ? [{ role: "system", content: LANG_INSTRUCT[lang] }] : []);

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

// ---- auto headlamp ----
// latches until the light comes back, so it ramps once per dark spell instead of flapping
const LUX_DARK = parseFloat(process.env.LUX_DARK || "100");
const LUX_LIGHT = parseFloat(process.env.LUX_LIGHT || String(LUX_DARK * 1.5));
const LAMP_RAMP_MS = parseInt(process.env.LAMP_RAMP_MS || "200", 10);
const LAMP_BLURT = {
  en: "It's going dark in here — turning the headlamp on so we can see.",
  es: "Se está poniendo oscuro — enciendo la linterna para que veamos.",
};
let lampBusy = false, lampAuto = false;
function darkCheck(lux) {
  if (lampBusy) return;
  if (lux < LUX_DARK && !lampAuto && getLed() < LAMP_MAX) rampLamp(lux);

  else if (lux >= LUX_LIGHT && lampAuto) {
    lampAuto = false;
    setLed(0).catch((e) => console.error("auto lamp off:", e.message));
  }
}

async function rampLamp(lux) {
  lampBusy = true;
  lampAuto = true;
  const from = getLed();
  const text = LAMP_BLURT[currentLanguage] || LAMP_BLURT.en;
  io.emit("agent-blurt", { text, timestamp: Date.now() });
  recorder.mark("sage", text);
  try {
    for (const v of rampTo(from)) {
      await setLed(v);
      await new Promise((r) => setTimeout(r, LAMP_RAMP_MS));
    }
    io.emit("lamp-auto", { from, led: getLed(), timestamp: Date.now() });
    recorder.mark("analysis", `headlamp ${from} → ${getLed()} (dark, ${Math.round(lux)} lx)`);
  } catch (e) {
    console.error("auto lamp:", e.message);
    lampAuto = false;
  } finally {
    lampBusy = false;
  }
}

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

async function askSage(messages, { maxTokens = 400 } = {}) {
  const resp = await chat({
    messages,
    max_tokens: maxTokens,
  });
  const sage = parseSage(resp.choices[0]?.message?.content);
  if (sage.led != null && sage.led !== getLed()) {
    const from = getLed();

    setLed(sage.led)
      .then(() => emitStep({ kind: "tool", name: "lamp", detail: `${from} → ${sage.led}` }))
      .catch((e) => {
        console.error("cam led:", e.message);
        emitStep({ kind: "tool", name: "lamp", detail: `${from} → ${sage.led} · failed: ${e.message}` });
      });
  }
  if (sage.finding) recordFinding(sage.finding, lastImage(messages));
  if (sage.snapshot) takeSnapshot(sage.snapshot);
  return sage;
}

// one turn can take a few passes, but the last one has to answer
const MAX_TOOL_STEPS = parseInt(process.env.SAGE_MAX_STEPS || "3", 10);

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
  if (name === "camera") {
    io.emit("cam-yield");
    try {
      await new Promise((r) => setTimeout(r, 400));
      const eyes = await eyeParts();
      if (!eyes.length) return { detail: "eye came back dark", text: "Your eye came back dark — no view. Answer from the readings alone and don't mention the camera." };
      return { detail: "fresh view", img: saveShot(eyes), images: eyes, text: "This is what your eye sees right now. Answer the operator from it, in your own voice." };
    } finally {
      io.emit("cam-resume");
    }
  }
  return null;
}

async function agentLoop(messages, { maxTokens = 400 } = {}) {
  const msgs = messages.slice();
  const steps = [];
  let sage;
  for (let i = 0; i < MAX_TOOL_STEPS; i++) {
    sage = await askSage(msgs, { maxTokens });
    if (!wantsTool(sage, i, MAX_TOOL_STEPS)) break;
    const out = await runTool(sage.tool, sage.toolArg);
    if (!out) break;
    const step = { kind: "tool", name: sage.tool, arg: out.arg || null, detail: out.detail, img: out.img || null, say: sage.text || null };
    steps.push(step);
    emitStep(step);
    recorder.mark("analysis", `tool ${sage.tool}: ${out.detail}`);
    msgs.push({ role: "assistant", content: sage.text || `(reaching for ${sage.tool})` });
    msgs.push({ role: "user", content: out.images?.length ? [{ type: "text", text: out.text }, ...out.images] : out.text });
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

const lampLine = () => `\nYour headlamp is currently at ${getLed()} of 255 (it trims itself when the passage goes pitch dark, so leave it alone unless you want a level it is not finding on its own).`;

function buildChatContext(data) {
  return `${missionLine()}Current readings from the rover right now (each line is already judged — trust the [STATUS] tag for the verdict, do NOT re-judge from the number, but DO say the number aloud with its unit when the operator asks about it):
${readingLines(data)}${trendLine(data)}${lampLine()}`;
}

function buildAiPrompt(data) {
  return `${missionLine()}Latest telemetry from your sensors — read the room and report to the operator. Each line is already judged: trust the [STATUS] tag for the verdict and do NOT re-judge from the raw number — but DO say the numbers aloud, value plus unit, when they are what the operator asked about or what you are reacting to.

${readingLines(data)}${trendLine(data)}${lampLine()}`;
}

async function runAiAnalysis(mode, focus) {
  const present = mode === "present";

  const data = freshData();
  if (!hasAI || !data) {
    io.emit("ai-analysis", { error: data ? "AI key not set" : "No telemetry yet.", timestamp: Date.now() });
    return;
  }

  io.emit("cam-yield");
  try {
    const eyes = await eyeParts();
    emitStep({ kind: "tool", name: "analysis", arg: focus || null, img: saveShot(eyes),
      detail: eyes.length ? "full read of the passage" : "no view — readings only" });
    const focusLine = focus ? `\nThe operator's workflow asked you to look at this specifically: ${focus}` : "";
    const promptText = buildAiPrompt(data) + focusLine + (eyes.length
      ? "\n(Attached is your live forward-camera view — read it for what's ahead.)"
      : "\n(Your eye is dark right now. Don't mention this or say anything about not being able to see — just report normally from the readings you do have, as if vision were never part of it.)");

    const { reply: sage } = await agentLoop([
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
    const found = { giga: false, esp32cam: false, unor4: false };
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
      if (hit) found[hit.key] = true;
    }

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
    console.log(`On-demand analysis requested${mode ? ` (${mode})` : ""}${focus ? ` — focus: ${focus}` : ""}`);
    runAiAnalysis(mode, focus);
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

server.listen(PORT, () => {
  console.log(`Server at http://localhost:${PORT}`);
  console.log(`Tablet:   http://${MDNS_HOST}:${PORT}`);
  pregenOnboarding();
});
