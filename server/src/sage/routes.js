// Sage's http endpoints: the operator's chat turn, a one-shot scan, the BLK
// editor's helper, the yes/no calls a running workflow makes, and a tape's
// spoken lines.
const { app, io, localReq } = require("../http");
const { hasAI, chat } = require("../brain");
const state = require("../state");
const recorder = require("../recorder");
const { linked } = require("../link");
const { eyeParts, grabFrames, camCount } = require("../vision");

// eyeParts() falls back to cam 0 for a camera that isn't in CAM_URL, so "is it clear
// behind me" would get answered off the FRONT view. A blk call names its camera, so
// a missing one is no view at all.
const blkEyes = (cam) => (cam = +cam || 0) < camCount ? eyeParts(cam) : Promise.resolve([]);
const { readingLines } = require("../status");
const { parseSage, parseArm, armMovesFor } = require("./parse");
const { readArmMoves } = require("../data");
const { askSage, agentLoop, askConfirm, recordFinding, lastImage, emitStep, LAMP_ASKED } = require("./agent");
const { playTake } = require("../armplay");
const { delegate, jobLine } = require("./claude");
const { contextOrDark, armLine, tapeLine, camLine, folderLine } = require("./context");
const { CHAT_SYSTEM, BLK_SYSTEM, demoLine, LANG_INSTRUCT, langMsg } = require("./prompts");

const ARM_CUE = /my arm|mi brazo/i;
const INTRO_DONE = /this is my arm|este es mi brazo/i;
let cuedTake = null;
app.post("/api/arm-cue", (req, res) => {
  if (cuedTake) playTake(cuedTake);
  cuedTake = null;
  res.json({ ok: true });
});

app.post("/api/chat", async (req, res) => {
  if (!hasAI) return res.status(503).json({ error: "AI key not set" });
  const msgs = Array.isArray(req.body?.messages) ? req.body.messages.slice(-30) : [];
  if (!msgs.length) return res.status(400).json({ error: "messages required" });
  const lang = LANG_INSTRUCT[req.body?.lang] ? req.body.lang : "en";

  const moves = req.body?.moves !== false;
  // `arm: true` unlocks only the arm under a move lock: the dashboard plays her
  // recorded takes (armplay.js) but nothing there runs her drive or tape cards yet.
  // No YES card either — the dashboard has none, and she only names a take when the
  // operator asked for the arm in words, so the ask IS the permission.
  const armOn = moves || req.body?.arm === true;
  // CONSOLE -> SAGE LAMP. Off, she can talk about the light but never writes it:
  // she reached for it every other turn and the operator lost the level they set.
  // The word check is the "SAGE, brighten the lamp" escape hatch, so the toggle
  // stays off for the whole run.
  if (typeof req.body?.lamp === "boolean") state.lampAllowed = req.body.lamp;
  if (typeof req.body?.demo === "boolean") state.demoMode = req.body.demo;
  const lastSaid = String(msgs[msgs.length - 1]?.content || "");
  const lamp = state.lampAllowed || LAMP_ASKED.test(lastSaid);
  // Claude runs with a shell, so only the PC's own dashboard can hand it work —
  // same loopback rule as /api/claude. A tablet's Sage is told she can't.
  const handoff = localReq(req);
  // No BLE or usb link: every move/arm/tape she names would go nowhere, and she'd
  // still say "lowering the arm". Told up front, and stripped below in case she forgets.
  // IMPORTANT NOTE: BLE "linked" is the browser's flag -- a tab closed mid-link leaves it on.
  const online = linked();
  try {
    const mapped = msgs.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "") }));

    const { reply, steps } = await agentLoop([
      { role: "system", content: CHAT_SYSTEM },
      ...demoLine(),
      ...langMsg(lang),
      { role: "system", content: contextOrDark(state.freshData()) },
      ...folderLine(req.body?.mission, req.body?.chat),
      ...(armOn ? armLine() : []),
      ...(moves ? tapeLine() : []),
      ...(moves ? [] : armOn
        ? [{ role: "system", content: "MOVE LOCK: your drive and the runs the crew recorded are locked out right now — say so in your own words as a scout would (\"I can't drive until the crew unlocks me\"), never by naming these fields. Never offer to drive, and never set \"move\" or \"tape\" this turn. Your ARM is free: there is no card for it, the move you name in \"arm\" runs the instant you answer. So \"text\" says what you are doing, short and present tense (\"Lowering the arm.\", \"Opening the gripper.\"), never asks permission for it and never claims it already finished." }]
        : [{ role: "system", content: "MOVE LOCK: your drive, your arm and the runs the crew recorded are all locked out right now — say so in your own words as a scout would (\"I'm parked until the crew unlocks me\"), never by naming these fields. Never offer to move, and never set \"move\", \"arm\" or \"tape\" this turn." }]),
      ...(lamp ? [] : [{ role: "system", content: "LAMP LOCK: your headlamp is held where the crew left it this turn. Set \"led\" to null whatever you think of the light, and don't mention the lamp unless they bring it up." }]),
      ...camLine(),
      ...(online ? [] : [{ role: "system", content: "ROBOT OFFLINE: the rover is not connected to you right now — no Bluetooth, no cable. Nothing you ask for can reach it. If the operator asks you to drive, move the arm, the gripper or play a run, say plainly that you're not connected to the robot right now (e.g. \"I'm not connected to the rover right now — link me up first.\"), never pretend you're doing it. Still fill \"move\", \"arm\" or \"tape\" exactly as you would online: it is blocked before it reaches the rover and shown to the operator as failed." }]),
      ...(handoff ? jobLine() : [{ role: "system", content: "CLAUDE LOCK: jobs can't be handed to Claude from this device. Set \"claude\" null; if asked for one, say it has to be asked from the crew's PC." }]),
      ...mapped,
    ], { maxTokens: 400, confirm: req.body?.confirm === true, lamp, effort: req.body?.effort });
    if (!moves && reply) { reply.move = null; reply.tape = null; if (!armOn) reply.arm = null; }
    // Backstop: she gave the intro but forgot the "arm" field (or spent the turn on
    // a tool) -- her own words decide, so the arm never sits out the presentation.
    if (armOn && reply && !reply.arm && INTRO_DONE.test(reply.text || "")) reply.arm = parseArm("PRESENT", armMovesFor(readArmMoves(), "sage_can_use"));
    if (!online && reply) {
      // shown in the chat's action trace as a failed row, so a silent arm has a reason
      for (const name of ["arm", "move", "tape"]) if (reply[name]) steps.push({ kind: "tool", name, detail: "robot not connected", error: true });
      reply.move = reply.tape = reply.arm = null;
    }
    if (!moves && reply?.arm) {
      // "...and this is my arm!": the browser fires /api/arm-cue when her voice gets there
      if (req.body?.armCue && ARM_CUE.test(reply.text || "")) { cuedTake = reply.arm.tape; reply.armCue = true; }
      else playTake(reply.arm.tape);
      const step = { kind: "tool", name: "arm", detail: reply.arm.text.replace(/\n/g, " → ") };
      steps.push(step);
      emitStep(step);
    }
    // The hand-off always asks, in BYPASS too: it is a shell on the crew's PC and
    // she suggests, never drives. Asked off the main path like the lamp, so her
    // "handing that to Claude" is spoken now and the card waits on its own.
    if (reply?.claude && handoff) {
      const task = reply.claude, opts = { lang, model: req.body?.claude?.model, effort: req.body?.claude?.effort };
      askConfirm("claude", task).then((ok) => ok && !delegate(task, opts) &&
        io.emit("claude-job", { id: `${Date.now()}`, task, state: "busy", text: null }));
    }
    if (reply && !handoff) reply.claude = null;
    res.json({ reply, steps });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/scan", async (req, res) => {
  if (!hasAI) return res.status(503).json({ error: "AI key not set" });
  try {
    const frames = await grabFrames(1);
    const lead = frames.length
      ? "You just took a fresh look ahead. Describe what you see out there and what you make of it."
      : "Your eye is dark right now. Don't mention this or say anything about not being able to see — just report normally from the readings you do have, as if vision were never part of it.";
    const sage = await askSage([
      { role: "system", content: CHAT_SYSTEM },
      ...demoLine(),
      ...langMsg(state.currentLanguage),
      { role: "system", content: contextOrDark(state.freshData()) },
      { role: "user", content: frames.length ? [{ type: "text", text: lead }, ...frames] : lead },
    ], { maxTokens: 400 });
    res.json({ reply: sage });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- the BLK editor's helper ----
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
    const d = state.freshData();
    if (d) ctx.push({ role: "system", content: `Live readings right now (useful for picking thresholds):\n${readingLines(d)}` });
    const resp = await chat({
      messages: [
        { role: "system", content: BLK_SYSTEM },
        ...ctx,
        ...langMsg(state.currentLanguage),
        ...msgs.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "") })),
      ],
      max_tokens: 900,
    });
    res.json({ reply: resp.choices[0]?.message?.content || "" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- a running workflow's yes/no calls (blk `ask` / `find`) ----
async function sageDecide(question, { images = [], extra = "" } = {}) {
  const text = `${question}\n\n${extra}\nAnswer with JSON only: {"yes": true|false, "why": "<one short sentence>"}`;
  const resp = await chat({
    messages: [
      { role: "system", content: CHAT_SYSTEM },
      ...demoLine(),
      ...langMsg(state.currentLanguage),
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
    const d = sim ? req.body.telemetry : state.freshData();
    const images = sim ? [] : await blkEyes(req.body?.cam);
    // a named camera with nothing on it is a "no", not a guess off telemetry
    if (!sim && +req.body?.cam && !images.length) return res.json({ yes: false, text: `camera ${req.body.cam} has no view` });
    const out = await sageDecide(question, { images, extra: sim ? `Simulated readings:\n${JSON.stringify(d)}` : contextOrDark(d) });
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
    const images = await blkEyes(req.body?.cam);
    if (!images.length) return res.json({ yes: false, text: "no camera view" });
    const out = await sageDecide(`Look at your camera view. Is there ${thing} in it?`, { images });
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
    const resp = await chat({ messages: [
      { role: "system", content: CHAT_SYSTEM },
      ...demoLine(),
      ...langMsg(lang),
      { role: "system", content: contextOrDark(state.freshData()) },
      { role: "system", content: TAPE_LINE_JOB },
      { role: "user", content: cue },
    ], max_tokens: 120 });
    const text = parseSage(resp.choices[0]?.message?.content).text;
    res.json({ text: text || null });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});
