// Everything that moves the robot and is not a React component: the BLK runner,
// the arm ledger + claw latch, the panic stop, and the tape recorder/player.
// The pads in app.js are views over this; nothing here touches the dom.
import { getLang } from "./i18n.js";
import { run as blkRun, compile as blkCompile, insLine as blkInsLine, interp as blkInterp,
         evalExpr as blkEval, clampArg as blkClamp } from "./blk.mjs";
import { speak, speakQueued, speakFlush, ttsPrewarm, whenSpoken } from "./speech.js";

// ---- blk runner ----
// the board plays the program; the browser only services the say/log/ask events it sends back.
let blkEvt = null;
window.addEventListener("blk:evt", (e) => blkEvt?.(e.detail));

let blkToken = 0;
const blkCancel = () => { blkToken++; };

const blkWaitFor = (pred, ms, kick) => new Promise((res) => {
  const to = setTimeout(() => { blkEvt = null; res(null); }, ms);
  blkEvt = (line) => { if (!pred(line)) return; clearTimeout(to); blkEvt = null; res(line); };
  kick?.();
});

function blkIo(deps, stopped, sleep) {
  const { onCmd, onAnalyze, busyRef, packetRef, onNote, onProgress } = deps;

  const decide = async (path, body) => {
    try {
      const r = await fetch(path, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const d = await r.json();
      onNote?.(`${d.yes ? "yes" : "no"}${d.text ? " — " + d.text : ""}`);
      return !!d.yes;
    } catch { onNote?.("AI didn't answer — treating as no"); return false; }
  };
  return {
    stopped, sleep,
    drive: async (verb, pwm, ms) => { onCmd(`drv,${verb},${pwm},${ms}`); await sleep(ms + 150); },
    analyze: async (focus) => {
      onAnalyze(null, focus);
      await sleep(500);
      const t0 = Date.now();
      while (!stopped() && busyRef.current && Date.now() - t0 < 30000) await sleep(300);
    },
    ask: (q) => decide("/api/blk-ask", { question: q }),
    find: (thing) => decide("/api/blk-find", { thing }),
    led: (v) => { fetch("/api/led", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: v }) }).catch(() => {}); },
    log: (txt) => onNote?.(txt),
    say: (txt) => speak(txt),
    sensors: () => packetRef?.current,
    halt: () => onCmd("stop"),
    onStep: (node, n, st) => onProgress?.({ n, label: node.op.replace("_", " "), vars: { ...st.vars } }),
  };
}

async function blkOnBoard({ code, nodes, slots }, io, deps, stopped) {
  const { onCmd, onProgress } = deps;
  if (!await blkWaitFor(l => l.startsWith("E:blkrdy"), 2000, () => onCmd(`blk,n,${code.length}`))) return false;

  for (let i = 0; i < code.length; i++) {
    if (stopped()) return true;
    await onCmd(blkInsLine(i, code[i]));
  }
  let n = 0;
  return new Promise((res) => {
    const finish = (v) => { clearInterval(poll); blkEvt = null; res(v); };
    const poll = setInterval(() => { if (stopped()) finish(true); }, 200);
    blkEvt = async (line) => {
      if (line.startsWith("E:blkend")) return finish(true);
      if (line.startsWith("E:blkerr")) return finish(false);
      if (!line.startsWith("E:blk,")) return;
      const f = line.slice(6).split(",");
      const node = nodes[+f[0]];
      const kind = +f[1];
      if (!node) return void onCmd("blk,res,0");

      const vars = {};
      for (const [name, i] of Object.entries(slots)) vars[name] = +f[2 + i] || 0;
      onProgress?.({ n: ++n, label: node.op.replace("_", " "), vars, board: true });
      const ctx = { st: { vars }, sensors: io.sensors };
      const txt = () => blkInterp(node.text, ctx);
      let val = 0;
      switch (node.op) {
        case "say": io.say(txt()); break;
        case "log": io.log(txt()); break;
        case "led": io.led(blkClamp("led", blkEval(node.arg, ctx) || 0)); break;
        case "analyze": await io.analyze(txt()); break;
        case "ask": val = (await io.ask(txt())) ? 1 : 0; break;
        case "find": val = (await io.find(txt())) ? 1 : 0; break;
      }
      if (kind) await onCmd(`blk,res,${val}`);
    };
    onCmd("blk,go");
  });
}

async function playBlk(program, deps) {
  const my = ++blkToken;
  const stopped = () => blkToken !== my;
  const sleep = async (ms) => {
    const t0 = Date.now();
    while (!stopped() && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 50));
  };
  const io = blkIo(deps, stopped, sleep);
  let built = null;
  try { built = blkCompile(program); } catch (e) { deps.onNote?.(`running in browser — ${e.message}`); }
  if (built && await blkOnBoard(built, io, deps, stopped)) return { where: "board", cancelled: stopped() };
  await blkRun(program, io);
  return { where: "browser", cancelled: stopped() };
}

// ---- arm ----
// Every joint is a 360 with no encoder or end stop, so there is no "go to 45deg":
// a button held sends the same jog over and over and the board's deadman
// (ARM_JOG_MS, 3s) kills the pulse the moment the repeats stop — a closed tab
// or a dropped link must not outlive the hand on the button.
const ARM_REPEAT_MS = 300;
// A tap is a ~60ms burst, and 60ms of a 360 is nothing you can see — which is
// what "I press it and it does nothing" is. The stop is held back so a press is
// worth at least this long; it is under the board's ARM_JOG_MS deadman, so
// nothing has to be re-sent to cover the gap.
const ARM_MIN_JOG_MS = 250;
const ARM_PAD_DZ = 0.35;   // stick deadzone for the arm — wider than Drive's, a nudge must not jog
const ARM_JOINTS = ["base", "shoulder", "elbow", "wrist", "gripwrist", "gripper"];
// The hold/sag trim is NOT on this pad (removed 2026-09-03, operator's call).
// Everything it drove is still on the board — the armh command,
// armSetHold() and the hold+sag columns in armSv[] — and the bench recorder
// (server/tools/armrec.py) can still send it. The dashboard just has no knob, so the
// browser can no longer put the board out of step with the arm.h table, and
// that table is 0/0 on every row: a released joint free-wheels.

// ---- arm ledger ----
// The tape lives out here, not inside <Arm/>: the pad unmounts every time the
// operator flips to MOTORS or another tab, and Sage's arm cards fire from the
// agent feed with no pad on screen at all. One robot, one ledger.
const armLedger = {
  tape: [],            // pending playback timeouts, killed by the panic key
  tapeTok: 0,          // bumped by every stop — a tape awaiting a spoken line checks it before going on
  tapeOn: false,       // a run is playing: her lines queue behind each other instead of cutting in
};

// The one choke point every arm command goes through — the pad, a tapped move
// and Sage's cards all land here, so there is one place to put anything that
// has to see every arm command.
function armSend(cmd, onCmd) {
  onCmd(cmd);
}

// A queued step firing after the panic key restarts the arm the instant it was
// stopped, so the tape has to die with it. Bound at the app root, next to the
// global stop.
const armStopTape = () => { armLedger.tape.forEach(clearTimeout); armLedger.tape = []; armLedger.tapeTok++; armLedger.tapeOn = false; };

// Recorded on the bench by armrec.py, or assembled by the server from one of
// Sage's arm proposals: a flat list of {ms, cmd} replayed with its original
// gaps. The gaps ARE the take — the board's deadman lives on them — so this is
// timeouts off one clock, never a loop with waits.
function armPlay(steps, onCmd) {
  armStopTape();
  clawClear();
  const last = steps.length ? steps[steps.length - 1].ms : 0;
  armLedger.tape = steps.map((st) => setTimeout(() => armSend(st.cmd, onCmd), st.ms));
  armLedger.tape.push(setTimeout(() => armSend("arm,", onCmd), last + ARM_REPEAT_MS));
  return last + ARM_REPEAT_MS;
}

function armRehome(onCmd) {
  armSend("armz,", onCmd);
}

// ---- claw ----
// The gripper is not a jog like the other five. It has two jaw stops and a job
// (hold the thing), so the arrows on its row are OPEN and CLOSE, not <>. The
// shape is the Uno R4 bench rig's (claw_cmd.ino + claw_web.py, 2026-09-07):
//
//   OPEN  — a one-shot burst that parks itself. THAT is the open limit: a 360
//           has no end stop to find, so the only thing that can stop it opening
//           is a clock. Holding the button longer does not open it further, and
//           it LATCHES OPEN: a second burst just opens further with nothing to
//           catch it, so the button is dead until CLOSE takes the joint back.
//   CLOSE — latches. Full pace into the jaw stop to grab, then it stays latched
//           at CLAW_HOLD so the thing does not drop. Press it again to release.
//
// The latch lives out here with armLedger and NOT in <Arm/>, for the reason the
// ledger does: the pad unmounts on every tab switch, and closing on an object
// and then flipping to MOTORS to drive is the normal case — a latch that died
// with the component would open the claw the moment you went to move.
// IMPORTANT NOTE: a latched claw draws current until it is released. That is
// the trade for a claw that holds; the panic key and STOP are the release.
const CLAW_JOINT = 5;
const CLAW_OPEN_MS = 200;    // one-shot open travel at full pace. 300 on the
                             // bench, trimmed down twice on the real claw.
const CLAW_GRAB_MS = 800;    // bench: full pace long enough to reach the stop
const CLAW_HOLD = 35;        // then hold at this. Pulse width is force here, so
                             // it is enough torque to keep the jaws shut and not
                             // enough to sit stalled flat out. MEASURE IT on the
                             // bench with the actual payload — too low drops it,
                             // too high cooks the servo.
// One PCA9685 frame at ARM_HZ (50Hz) = 20ms, and that is the floor on any burst
// here: the chip only reloads its outputs on a frame boundary, so a burst
// shorter than one frame is a coin flip on whether the servo sees it at all.
// The pulse-width floor is the chip's own 12-bit step, 20000us/4096 = 4.88us —
// but that is NOT the knob to turn. Pulse width is speed AND torque on a 360, so
// a gentler nudge is a weaker one and a loaded claw will not break away at all;
// the nudge runs at FULL power and gets small by being SHORT. (The 360's own
// deadband around neutral is 50-100us wide, tens of chip steps, which is why
// trimming us to make a small move does nothing until suddenly it does.)
// Sitting on top of that: the browser's setTimeout and the ~15ms BLE connection
// interval, so a single frame is about as fine as this link can honestly resolve.
// test/arm.mjs cross-checks CLAW_FRAME_MS against ARM_HZ in arm.h.
const CLAW_FRAME_MS = 20;
const CLAW_NUDGE_MAX = 200;
const CLAW_NUDGE_KEY = "clawNudgeMs";
const clawLatch = { on: "", timer: null, repeat: null };

// Timers only — the caller decides whether a stop command still has to go out.
// The panic key does not need one (the board's `stop` already killed the arm),
// but a leftover interval would restart it a moment later.
function clawClear() {
  clearTimeout(clawLatch.timer); clearInterval(clawLatch.repeat);
  clawLatch.timer = clawLatch.repeat = null;
  clawLatch.on = "";
}

function clawStop(onCmd) {
  clawClear();
  armSend(`arm,${CLAW_JOINT},0`, onCmd);
}

// Everything a panic stop has to kill. A bare `stop` is not one: a queued tape
// or arm step, and the claw's hold repeat, each restart the robot the instant it
// lands. The panic key goes through here.
// also kills a BRAIN: CLAUDE turn mid-task — it may be the one driving
const panicStop = (send) => {
  blkCancel(); armStopTape(); clawClear(); speakFlush(); send("stop");
  fetch("/api/claude/stop", { method: "POST" }).catch(() => {});
};

// One deliberate twitch, for letting go of something without flinging the jaws
// open into their stop. Full power for `ms` and then park — see CLAW_FRAME_MS
// for why this is timed and not throttled. It drops the latch: the claw is now
// somewhere between open and closed and neither button should claim it.
function clawNudge(dir, ms, onCmd) {
  clawClear();
  armSend(`arm,${CLAW_JOINT},${dir < 0 ? -100 : 100}`, onCmd);
  clawLatch.timer = setTimeout(() => armSend(`arm,${CLAW_JOINT},0`, onCmd),
                               Math.max(CLAW_FRAME_MS, ms));
}

// dir < 0 opens, > 0 closes — same sign the rest of the pad uses.
function clawGo(dir, onCmd) {
  const want = dir < 0 ? "open" : "close";
  if (clawLatch.on === want) {
    if (want === "open") return;               // already open: only CLOSE clears it
    return void clawStop(onCmd);               // press the live CLOSE again = let go
  }
  clawClear();
  clawLatch.on = want;
  armSend(`arm,${CLAW_JOINT},${dir < 0 ? -100 : 100}`, onCmd);
  if (dir < 0) {
    // park the joint but keep the latch lit — the claw IS open, and that is what
    // the dead OPEN button is telling the operator
    clawLatch.timer = setTimeout(() => armSend(`arm,${CLAW_JOINT},0`, onCmd), CLAW_OPEN_MS);
    return;
  }
  // grabbed: ease off to the hold and keep it alive against the board's deadman
  clawLatch.timer = setTimeout(() => {
    const hold = () => armSend(`arm,${CLAW_JOINT},${CLAW_HOLD}`, onCmd);
    hold();
    clawLatch.repeat = setInterval(hold, ARM_REPEAT_MS);
  }, CLAW_GRAB_MS);
}

// ---- tapes ----
// A whole manual run written down. sendCmd is the one place every command leaves
// the browser, so recording is a tap there — drive, arm, lights, routines, all of
// it, with the gaps. A step is the arm take's {ms, cmd}, so the player below is
// the arm player with one branch added: a cmd starting with "@" never reaches the
// board, it is one of the things only the PC has (say/analyze/log/led), typed in
// by hand when the tape is edited. English-only on purpose: bench tool.
// `name` rides along because the component unmounts with the drawer — see Tapes().
const tapeRec = { on: false, t0: 0, steps: [], name: "" };
const tapeStart = (name) => { tapeRec.on = true; tapeRec.t0 = Date.now(); tapeRec.steps = []; tapeRec.name = name; };
const tapeWatch = (cmd) => {
  // blk upload chatter is not a move — a workflow is its own file already
  if (tapeRec.on && !cmd.startsWith("blk,")) tapeRec.steps.push({ ms: Date.now() - tapeRec.t0, cmd });
};
// the clock starts at REC, so every take carries the operator's reaction time as
// dead air at the head. Shift to the first step — the GAPS are the take, the head
// is not. Same rule as armrec.py's clean().
const tapeStop = () => {
  tapeRec.on = false;
  const t0 = tapeRec.steps.length ? tapeRec.steps[0].ms : 0;
  const out = tapeRec.steps.map(s => ({ ...s, ms: s.ms - t0 }));
  tapeRec.steps = [];          // a second stop must not save the last take again
  return out;
};

const TAPE_EVENTS = ["sage", "say", "present", "tape", "under", "analyze", "log", "led"];
const TAPE_LINE_MS = 6000;   // she gets this long to answer; after it, the cue
const TAPE_ANALYZE_MS = 25000;  // an @analyze holds the run this long; a failed one never speaks at all

// "@say" is a script — the same words every run, and it sounds like it.
// "@sage" is a CUE: she writes the sentence herself off the cue and whatever the
// rover can read at the time, so a rehearsed run still comes out different every
// time and grounded in the room. The ask goes out when the tape STARTS, not when
// the step fires — waiting two seconds for a model in the middle of a
// presentation is dead air — and whatever hasn't landed by then falls back to
// speaking the cue as written. The venue has no internet, so that fallback is
// the normal case, not the unhappy one: a tape always talks.
function tapeCue(cue) {
  const slot = { line: null };
  fetch("/api/tape-line", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cue, lang: getLang() }), signal: AbortSignal.timeout(TAPE_LINE_MS),
  }).then(r => r.json()).then(d => { slot.line = d.text || null; }).catch(() => {});
  return slot;
}

// "@say.es <texto>" beside "@say <text>": a step may carry a language suffix, and
// the same tape then speaks whichever the dashboard is set to. Split here so the
// cue prefetch and the step both read the name the same way.
const tapeParse = (cmd) => {
  const m = /^@(\w+)(?:\.([a-z]{2}))?\s*([^]*)$/.exec(cmd);
  return { kind: m?.[1], lang: m?.[2] || null, text: (m?.[3] || "").trim() };
};

function tapeStep(cmd, io, cues, sub) {
  if (!cmd.startsWith("@")) return void armSend(cmd, io.onCmd);
  const { kind, text } = tapeParse(cmd);
  if (kind === "sage") {
    // whatever is in hand right now — never a wait, this is live
    const line = cues?.get(text)?.line || text;
    io.onSay?.(line);
    return speakQueued(line);
  }
  else if (kind === "say") { io.onSay?.(text); return speakQueued(text); }
  // The judge greeting: the same camera still an @analyze takes, read against
  // prompts/present.md instead of the cave prompt — she counts the people in
  // front of her, greets that many and compliments them, so the open of a run is
  // never the same words twice. Nothing to prewarm, the line does not exist yet.
  else if (kind === "present") { io.onAnalyze?.("present", text || null); return whenSpoken(TAPE_ANALYZE_MS); }
  // "@tape <name>" plays another recorded run inline. The claw wave a
  // presentation ends on lives in its own file so it can be re-recorded without
  // touching the script around it. ONE level deep: a tape that names itself, or
  // a pair that name each other, would recurse until the browser gave up.
  // "@under <name>" is the same file played UNDERNEATH instead of in place: the
  // run carries straight on to the next step while it moves, so she can talk over
  // a 26s gesture take rather than wave at a silent room and then speak. It is
  // scenery for the sentence, so it is CUT the moment the run's own steps are
  // done: a 26s take under an 8s line otherwise leaves the arm waving at a silent
  // room, which is the same failure at the other end. Only for a take of board
  // commands — a spoken child would talk over the parent's line.
  else if (kind === "tape" || kind === "under") {
    if (!sub) { io.onNote?.(`tape: ${text} is nested too deep to play`); return null; }
    const run = fetch("/api/tapes/" + encodeURIComponent(text))
      .then(r => r.ok ? r.json() : Promise.reject(new Error("404")))
      .then(d => sub(Array.isArray(d) ? d : d.steps || []))
      .catch(() => io.onNote?.(`tape: no recorded run called "${text}"`));
    return kind === "tape" ? run : null;
  }
  else if (kind === "analyze") { io.onAnalyze?.(null, text || null); return whenSpoken(TAPE_ANALYZE_MS); }
  else if (kind === "log") io.onNote?.(text);
  else if (kind === "led") fetch("/api/led", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: +text || 0 }) }).catch(() => {});
  else io.onNote?.(`tape: unknown event ${cmd}`);
}

// THE CLOCK STOPS WHILE SHE TALKS. Steps used to fire off absolute timestamps,
// which is right until a line runs long — and every line runs long: the gaps
// were timed to an operator's finger, not to a sentence, and an "@analyze" waits
// on the model for as long as the model takes. So the gestures ran ahead of the
// words and the arm waved before "and the best part, I have an arm!" was said.
// Now a step's recorded gap is measured from the END of the one before it, and a
// spoken step ends when the speech does. The gaps between two *board* commands
// are untouched, which is what the deadman lives on.
//
// It is still one timeout at a time in armLedger.tape, so the panic key kills a
// tape mid-run exactly as it kills an arm take — plus a token, because a step
// parked on a sentence is not in that array and has to check for itself.
function tapePlay(steps, io) {
  armStopTape();
  clawClear();
  speakFlush();          // a leftover line from the last run must not open this one
  // A suffixed step only ever fires in its own language. The unsuffixed ones are
  // the English original, and they drop out as soon as the tape carries a set for
  // the language on screen — so a half-translated tape speaks what was translated
  // and falls back to English for the rest instead of saying both.
  const lang = getLang();
  const dubbed = steps.some(st => tapeParse(st.cmd).lang === lang);
  steps = steps.filter(st => {
    if (!st.cmd.startsWith("@")) return true;
    const { kind, lang: l } = tapeParse(st.cmd);
    return l ? l === lang : !(dubbed && (kind === "say" || kind === "sage"));
  });
  const cues = new Map();
  for (const st of steps) {
    const p = tapeParse(st.cmd);
    if (!st.cmd.startsWith("@")) continue;
    if (p.kind === "sage" && !cues.has(p.text)) cues.set(p.text, tapeCue(p.text));
    // Every scripted line's audio is asked for now, while the run is still on its
    // first sentence — otherwise each line's synth round trip is silence.
    if (p.kind === "say") ttsPrewarm(p.text);
  }
  const tok = ++armLedger.tapeTok;
  let underOff = false;  // set the moment the run's own steps are done — an "@under"
                         // take is scenery for the sentence and ends with it
  armLedger.tapeOn = true;
  const alive = () => tok === armLedger.tapeTok;
  const wait = (ms) => new Promise((res) => armLedger.tape.push(setTimeout(res, ms)));
  const runSteps = async (list, depth = 0) => {
    let at = 0;
    for (const st of list) {
      await wait(Math.max(0, st.ms - at));
      if (!alive() || (depth && underOff)) return false;
      at = st.ms;
      // a spoken step hands back its sentence; an "@tape" hands back the run it played
      const held = tapeStep(st.cmd, io, cues, depth ? null : (s) => runSteps(s, depth + 1));
      if (held) { await held; if (!alive()) return false; }
    }
    return true;
  };
  return (async () => {
    if (!await runSteps(steps)) return;
    underOff = true;
    await wait(ARM_REPEAT_MS);
    if (!alive()) return;
    armLedger.tapeOn = false;
    io.onCmd("stop");
    armSend("arm,", io.onCmd);
  })();
}

const armJogOf = (steps) => {
  const on = (steps || []).map((st) => /^arm,(\d+),(-?\d+)$/.exec(st.cmd)).filter((m) => m && +m[2] !== 0);
  if (!on.length) return null;
  return on.every((m) => m[1] === on[0][1] && m[2] === on[0][2]) ? [+on[0][1], +on[0][2]] : null;
};

// Three-way jog speed for the arrows. It scales the ±100 the pad sends, so the
// wire command is the same `arm,<j>,<speed>` the firmware always took. Pulse
// width is speed AND torque on a 360, so SLOW is also weak — a gravity-loaded
// joint may not lift at SLOW at all. Floor is armrec.py's SPEED_MIN (20): below
// that the pulse is inside the servo deadband and the joint only buzzes.
// Recorded takes keep their own recorded speed — that is part of the take.
// SLOW is 55, not 40: at 40 the base moved one way and not the other — its
// neutral (1490) sits off-centre in the servo's own deadband, so the same
// magnitude clears it going one way and dies going the other. 55 is above
// break-away both ways. The real fix is trimming that neutral on the bench.
// R2 boost cap. 255 is everything the L298N has; below MANUAL_PWM the boost
// would be slower than no boost at all, which is why the low chip is 140.
const BOOSTS = [["140", 140], ["200", 200], ["255", 255]];
const BOOST_KEY = "boostPwm";
const ARM_SPEEDS = [["SLOW", 55], ["MED", 75], ["FAST", 100]];
const ARM_SPD_KEY = "armPadSpd";

const ARM_LABELS_KEY = "armLabels";
const armLabelsLoad = () => { try { return JSON.parse(localStorage.getItem(ARM_LABELS_KEY)) || {}; } catch { return {}; } };

export { playBlk, blkCancel, armLedger, armSend, armPlay, armRehome, armStopTape, armJogOf, armLabelsLoad,
         ARM_JOINTS, ARM_REPEAT_MS, ARM_MIN_JOG_MS, ARM_PAD_DZ, ARM_SPEEDS, ARM_SPD_KEY, ARM_LABELS_KEY,
         BOOSTS, BOOST_KEY, clawLatch, clawClear, clawGo, clawNudge, CLAW_JOINT, CLAW_FRAME_MS,
         CLAW_NUDGE_MAX, CLAW_NUDGE_KEY, panicStop, tapeRec, tapeStart, tapeWatch, tapeStop, tapePlay, TAPE_EVENTS };
