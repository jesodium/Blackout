// One Sage turn: askSage() is the single choke point for every model call, and
// agentLoop() lets her reach for her own tools (camera, armcam, sensors) a few
// times before she has to answer. Side effects of a reply — the lamp, a finding,
// a snapshot — fire here, behind the operator's ASK gate.
const fs = require("fs");
const path = require("path");
const { io } = require("../http");
const { chat } = require("../brain");
const state = require("../state");
const recorder = require("../recorder");
const { eyeParts } = require("../vision");
const { setLed, getLed } = require("../lights");
const { readArmMoves, readTapes } = require("../data");
const { readingLines, trendLine } = require("../status");
const { parseSage, snapSummary, wantsTool } = require("./parse");
const { langLast } = require("./prompts");

const PUBLIC = path.join(__dirname, "..", "..", "public");

// ---- findings ----
const FINDINGS_DIR = path.join(PUBLIC, "findings");
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
// Sage's own "led" field, gated by CONSOLE -> SAGE LAMP (state.lampAllowed; the
// flag rides on /api/chat like SAGE MOVES, so it lands on her first turn). Default
// ON since 2026-09-09: she is the only thing that touches the lamp now, so OFF
// means nobody does. Turn it off to pin a level by hand for a run.
const LAMP_ASKED = /\b(lamp|headlamp|light|lights|led|bright|brighter|brighten|dim|dimmer|darker)\b|luz|linterna|foco|brillo|ilumina|oscur/i;

// ---- snapshots ----
const SNAP_DIR = path.join(PUBLIC, "snapshots");
fs.mkdirSync(SNAP_DIR, { recursive: true });
const SNAP_MS = parseInt(process.env.SNAP_MS || "10000", 10);

function takeSnapshot(reason) {
  const at = Date.now();
  const packets = state.dataHistory.filter((d) => at - d.timestamp <= SNAP_MS);
  if (!packets.length) return;
  try { fs.writeFileSync(path.join(SNAP_DIR, `${at}.json`), JSON.stringify({ at, reason, packets })); }
  catch (e) { console.error("snapshot:", e.message); }
  const text = `SNAPSHOT: ${reason} — ${snapSummary(packets)}`;
  io.emit("sage-finding", { id: `${at}-snap`, text, img: null, timestamp: at });
  recorder.mark("finding", text);
}

async function askSage(messages, { maxTokens = 400, confirm = false, lamp = false } = {}) {
  const resp = await chat({
    // json_object because the language instruction costs her the envelope:
    // asked to answer in Spanish she answered in Spanish PROSE, and a reply
    // with no json is a reply with no status, no tool and no card -- 3 of 8
    // carried a status against 8 of 8 with the mode on. parseSage still takes
    // bare prose, so this is belt over braces, not a new contract.
    messages: langLast(messages),
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
  });
  // names the cause when parseSage has to salvage: "length" is her running out
  // of max_tokens mid-json, which the Spanish dashboard hits first (same
  // sentence, ~25% more tokens). Raise maxTokens if this starts showing up.
  if (resp.choices[0]?.finish_reason === "length") console.warn(`sage: reply cut off at ${maxTokens} tokens`);
  const sage = parseSage(resp.choices[0]?.message?.content, readArmMoves(), readTapes());
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
// whoever answers first wins — the gate is an operator prompt, not a permission
const answerConfirm = (id, ok) => pendingConfirm.get(id)?.(ok);

// ---- tools ----
const SHOT_DIR = path.join(PUBLIC, "shots");
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
    const d = state.freshData();
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
  // A tool result is English prose pushed after the system block, so on a turn
  // where she looks or re-reads the sensors the last thing the model sees is
  // English and it answers in English. langLast() in askSage is what repeats the
  // language line below it -- and below the image, which is the half that a note
  // pasted onto the text part here could never do.
  for (let i = 0; i < MAX_TOOL_STEPS; i++) {
    sage = await askSage(msgs, { maxTokens, confirm, lamp });
    if (!wantsTool(sage, i, MAX_TOOL_STEPS)) break;
    if (confirm && !(await askConfirm(sage.tool, sage.toolArg))) {
      const step = { kind: "tool", name: sage.tool, arg: sage.toolArg || null,
        detail: "operator said no", say: sage.text || null };
      steps.push(step);
      emitStep(step);
      msgs.push({ role: "assistant", content: sage.text || `(reaching for ${sage.tool})` });
      msgs.push({ role: "user", content: "The operator turned that down. Answer them now from what you already have, and don't reach for anything else this turn." });
      continue;
    }
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

module.exports = { askSage, agentLoop, answerConfirm, recordFinding, lastImage, saveShot, emitStep, LAMP_ASKED };
