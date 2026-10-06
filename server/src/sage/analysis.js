// Sage reading the room on her own: a full analysis (on demand, or whenever a
// status band changes while a mission is set), the one-line blurts between them,
// and the mission that switches the loop on.
const { io } = require("../http");
const { hasAI } = require("../brain");
const state = require("../state");
const recorder = require("../recorder");
const { eyeParts, grabFrames } = require("../vision");
const { statuses, RANK } = require("../status");
const { askSage, agentLoop, saveShot, emitStep } = require("./agent");
const { buildAiPrompt } = require("./context");
const { AI_SYSTEM, CHAT_SYSTEM, PRESENT_SYSTEM, demoLine, langMsg } = require("./prompts");

// ---- status bands + blurts ----
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

let lastStatuses = null;
let lastAutoAnalysis = 0;
let lastBlurt = 0;
let pendingAnalysis = null;
const AUTO_MIN_GAP = parseInt(process.env.AUTO_ANALYSIS_GAP || "12", 10) * 1000;
const BLURT_MIN_GAP = 6000;

function emitBlurt(prev, cur) {
  if (!prev || Date.now() - lastBlurt < BLURT_MIN_GAP) return;
  const lines = BLURTS[state.currentLanguage] || BLURTS.en;
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
  if (changed && state.currentMission) emitBlurt(lastStatuses, s);
  lastStatuses = s;
  if (!changed || !state.currentMission) return;
  const now = Date.now();
  if (now - lastAutoAnalysis < AUTO_MIN_GAP) return;
  lastAutoAnalysis = now;
  clearTimeout(pendingAnalysis);
  pendingAnalysis = setTimeout(runAiAnalysis, 600);
}

// ---- mission ----
// a mission is what turns the autonomous analysis loop on (maybeAutoAnalyze)
function setMission(text) {
  state.currentMission = String(text || "").trim();
  console.log("Mission set:", state.currentMission || "(cleared)");
  io.emit("mission-set", { mission: state.currentMission });
  if (state.currentMission) ackMission(state.currentMission);
}

async function ackMission(text) {
  const fallback = state.currentLanguage === "es"
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
      ...demoLine(),
      ...langMsg(state.currentLanguage),
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

// ---- full analysis ----
async function runAiAnalysis(mode, focus, cam = 0) {
  const present = mode === "present";

  const data = state.freshData();
  if (!hasAI || !data) {
    io.emit("ai-analysis", { error: data ? "AI key not set" : "No telemetry yet.", timestamp: Date.now() });
    return;
  }

  try {
    // Which eye is the OPERATOR's pick (the maximized feed), not hers -- her
    // own "camera"/"armcam" tools still choose for themselves.
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
      ...(present ? [] : demoLine()),
      ...langMsg(state.currentLanguage),
      { role: "user", content: eyes.length ? [{ type: "text", text: promptText }, ...eyes] : promptText },
    ], { maxTokens: 400, lamp: state.lampAllowed });
    io.emit("ai-analysis", { analysis: sage.text || "No analysis returned.", status: sage.status, timestamp: Date.now() });
    recorder.mark("analysis", sage.text || "No analysis returned.");
  } catch (err) {
    console.error("AI analysis error:", err.message);
    io.emit("ai-analysis", { error: err.message, timestamp: Date.now() });
    recorder.mark("analysis", "analysis failed: " + err.message);
  }
}

module.exports = { maybeAutoAnalyze, setMission, runAiAnalysis };
