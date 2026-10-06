// Sage's voice and ears: TTS (Deepgram if keyed, Edge neural voices otherwise),
// STT (Deepgram), and the onboarding lines pre-rendered to disk at boot.
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const express = require("express");
const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");
const { app, PORT } = require("./http");

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

// ---- onboarding ----
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
  const dir = path.join(__dirname, "..", "public", "audio");
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

module.exports = { pregenOnboarding };
