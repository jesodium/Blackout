// tapes: the head-shift on save, the "@" event split, and that a tape dies with
// the panic key. The player itself is pulled out of app.js and run here, so a
// change to it has to keep passing.

import { readFileSync, existsSync } from "node:fs";
import assert from "node:assert";

const app = readFileSync(new URL("public/js/app.js", import.meta.url), "utf8");

// recording is a tap in sendCmd — the one place every command leaves the browser
assert.ok(/tapeWatch\(word\);/.test(app), "sendCmd stopped feeding the tape recorder");
// a queued step must die with the panic key, so a tape uses the arm's ledger
assert.ok(/function tapePlay\([^]*?armStopTape\(\);[^]*?armLedger\.tape\.push\(setTimeout/.test(app),
  "tapePlay does not run on armLedger.tape — the panic key can't kill it");
assert.ok(/function tapePlay\([^]*?const tok = \+\+armLedger\.tapeTok;[^]*?if \(!alive\(\)\) return;/.test(app),
  "a step parked on a sentence is not in armLedger.tape — without the token the panic key can't reach it");

// the drawer unmounts <Tapes/> whenever the console is closed, and closing it is
// how the arm pad gets reached mid-take — so the button and the name box have to
// come back off the module flag, not off a fresh false.
assert.ok(/useState\(tapeRec\.on\)/.test(app), "Tapes' rec state no longer survives the drawer closing");
assert.ok(/useState\(tapeRec\.on \? tapeRec\.name : ""\)/.test(app), "the tape name no longer survives the drawer closing");

const src = app.slice(app.indexOf("// ---- tapes ----"), app.indexOf("function Tapes("));
const sent = [];
const io = {
  onCmd: (c) => sent.push(c),
  onAnalyze: (m, f) => sent.push("ANALYZE:" + (m || f)),   // @present sets the mode, @analyze the focus
  onNote: (n) => sent.push("LOG:" + n),
  onSay: (n) => sent.push("FEED:" + n),
};
let line = null;                 // what the model gives back for a cue, or nothing
let child = null;                // steps of the tape an "@tape" step names, or nothing
const warmed = [];               // lines whose audio was asked for before their turn
let busy = Promise.resolve();    // stands in for a sentence still being spoken
const ledger = { tape: [], tapeTok: 0, tapeOn: false };     // the real one, so a new tape kills the last one's queue
let speakWake = null;     // whoever is parked waiting for the next spoken line
let uiLang = "en";        // the dashboard's language, flipped below
const sandbox = {
  armSend: (c, onCmd) => onCmd(c),
  armStopTape: () => { ledger.tape.forEach(clearTimeout); ledger.tape = []; ledger.tapeTok++; ledger.tapeOn = false; },
  speakFlush: () => { sent.push("FLUSH"); },
  armLedger: ledger,
  ARM_REPEAT_MS: 250,
  clawClear: () => {},   // the claw latch is test-arm's; a tape just has to release it
  ttsPrewarm: (txt) => warmed.push(txt),
  getLang: () => uiLang,
  AbortSignal: { timeout: () => null },
  // the real queue, so a line that runs long is not cut off by the next one
  speakQueued: (txt) => { sent.push("SAY:" + txt); speakWake?.(); busy = busy.then(() => new Promise((r) => setTimeout(r, 20))); return busy; },
  // stands in for the real whenSpoken(): an @analyze has nothing to wait on until
  // the model comes back, so it waits for the next line to be queued, capped.
  whenSpoken: (cap) => new Promise((res) => {
    const to = setTimeout(res, cap);
    speakWake = () => { clearTimeout(to); speakWake = null; res(); };
  }).then(() => busy),
  speakFlush: () => { sent.push("FLUSH"); },
  fetch: (url, o) => {
    const nested = String(url).match(/\/api\/tapes\/(.+)$/);
    if (nested) {
      sent.push("OPEN:" + decodeURIComponent(nested[1]));
      return Promise.resolve(child === null
        ? { ok: false, json: () => Promise.resolve({}) }
        : { ok: true, json: () => Promise.resolve({ steps: child }) });
    }
    if (String(url).includes("tape-line")) {
      sent.push("ASK:" + JSON.parse(o.body).cue);
      return line === null ? Promise.reject(new Error("offline"))
        : Promise.resolve({ json: () => Promise.resolve({ text: line }) });
    }
    sent.push("LED:" + JSON.parse(o.body).value);
    return Promise.resolve();
  },
};
const load = new Function(...Object.keys(sandbox),
  src + "\nreturn { tapeStart, tapeWatch, tapeStop, tapeStep, tapePlay, tapeCue, TAPE_EVENTS };");
const T = load(...Object.values(sandbox));

// ---- the head-shift ----
// the clock starts at REC, so the operator's reaction time is dead air at the
// head. The gaps are the take; the head is not.
T.tapeStart();
const t0 = Date.now();
while (Date.now() - t0 < 30);
T.tapeWatch("drv,tank,120,120,300");
T.tapeWatch("blk,i,0,1");              // upload chatter is not a move
while (Date.now() - t0 < 60);
T.tapeWatch("arm,5,-100");
const steps = T.tapeStop();
assert.deepEqual(steps.map(s => s.cmd), ["drv,tank,120,120,300", "arm,5,-100"], "blk lines got recorded");
assert.equal(steps[0].ms, 0, "the take still starts with the operator's reaction time");
assert.ok(steps[1].ms >= 20, "the gap between steps was lost, and the gaps are the take");
assert.deepEqual(T.tapeStop(), [], "stopping twice keeps replaying the last take");

// ---- "@" steps never reach the board ----
for (const [cmd, ...want] of [
  ["drv,tank,0,0,100", "drv,tank,0,0,100"],
  ["@say hello judges", "FEED:hello judges", "SAY:hello judges"],
  ["@analyze the red block", "ANALYZE:the red block"],
  ["@log halfway", "LOG:halfway"],
  ["@led 200", "LED:200"],
  ["@present", "ANALYZE:present"],
]) { sent.length = 0; T.tapeStep(cmd, io); assert.deepEqual(sent, want, cmd); }
sent.length = 0;
T.tapeStep("@nope", io);
assert.ok(sent[0].startsWith("LOG:tape: unknown"), "an unknown @event went to the board");
assert.deepEqual(T.TAPE_EVENTS, ["sage", "say", "present", "tape", "analyze", "log", "led"],
  "the hint no longer lists the events that work");

// ---- "@sage" is a cue, not a script ----
// The line is asked for when the tape STARTS (dead air mid-presentation is the
// whole reason), and whatever has not landed by the time the step fires falls
// back to speaking the cue as written — the venue has no internet, so that is
// the normal case and a tape must always talk.
const cueTape = [{ ms: 0, cmd: "drv,tank,120,120,300" }, { ms: 30, cmd: "@sage introduce yourself to the judges" }];

line = null;                                  // no answer: offline
sent.length = 0;
await T.tapePlay(cueTape, io);
assert.equal(sent[0], "FLUSH", "a new run no longer drops the last one's queued line");
assert.deepEqual(sent.slice(1), ["ASK:introduce yourself to the judges", "drv,tank,120,120,300",
  "FEED:introduce yourself to the judges", "SAY:introduce yourself to the judges", "stop", "arm,"],
  "an unanswered cue must still speak, as written");
assert.ok(sent.indexOf("ASK:introduce yourself to the judges") === 1,
  "the line is fetched when the step fires, not when the tape starts — that is dead air");

line = "Hi everyone! I'm Sage, and it's twenty-four degrees in here.";
sent.length = 0;
await T.tapePlay(cueTape, io);
assert.ok(sent.includes("SAY:" + line), "her live line was not spoken — got " + JSON.stringify(sent));
// a spoken line is Sage talking: it has to reach the transcript, not only the log
assert.ok(sent.includes("FEED:" + line), "her live line never reached the chat feed");
assert.ok(!sent.some((x) => x.startsWith("LOG:") && x.includes(line)), "a spoken line went to the log instead of the feed");
assert.ok(!sent.includes("SAY:introduce yourself to the judges"), "the cue was read out loud on top of her line");

// one ask per distinct cue, not one per step
sent.length = 0;
T.tapePlay([{ ms: 0, cmd: "@sage same cue" }, { ms: 10, cmd: "@sage same cue" }], io);
assert.equal(sent.filter(x => x.startsWith("ASK:")).length, 1, "the same cue is asked for twice");

// ---- playback parks the robot at the end ----
sent.length = 0;
const t2 = Date.now();
await T.tapePlay([{ ms: 0, cmd: "drv,tank,120,120,300" }, { ms: 40, cmd: "arm,5,-100" }], io);
assert.ok(Date.now() - t2 >= 40 + 250, "the recorded gaps between two board commands were not kept");
assert.deepEqual(sent, ["FLUSH", "drv,tank,120,120,300", "arm,5,-100", "stop", "arm,"],
  "a tape must leave the wheels and the arm stopped");

// ---- she does not talk over herself ----
// Lines fire off a clock, and a clock has no idea how long a sentence takes: two
// steps 10ms apart must come out one after the other, not one cutting the other.
sent.length = 0;
T.tapePlay([{ ms: 0, cmd: "@say one" }, { ms: 10, cmd: "@say two" }], io);
await new Promise(r => setTimeout(r, 300));
assert.deepEqual(sent.filter(x => x.startsWith("SAY:")), ["SAY:one", "SAY:two"], "a spoken line was dropped");
assert.ok(/speakQueued\(/.test(src) && !/[^a-zA-Z]speak\(/.test(src),
  "a tape line calls speak() directly again — that cancels the sentence before it");

// ---- sage names a run, she never writes one ----
const { parseTape, parseSage } = await import("./sage.js");
const tapes = { "Presentation Walk": [{ ms: 0, cmd: "drv,tank,120,120,300" }] };
assert.equal(parseTape("Presentation Walk", tapes).text, "Presentation Walk");
assert.equal(parseTape("presentation walk", tapes).text, "Presentation Walk", "the name is matched case-insensitively");
assert.equal(parseTape("play presentation walk", tapes).text, "Presentation Walk");
assert.equal(parseTape("Some Other Run", tapes), null, "an unknown run name resolved to something");
assert.equal(parseTape("Presentation Walk\nPresentation Walk", tapes), null,
  "two runs chained — a tape is a whole run, and nobody rehearsed that pair");
assert.equal(parseTape("Presentation Walk", {}), null, "a run played with nothing recorded");
assert.equal(parseSage('{"text":"ok","tape":"Presentation Walk"}', {}, tapes).tape.tape.length, 1);
assert.equal(parseSage('{"text":"ok"}', {}, tapes).tape, null);


// ---- the operator's own words play a run, with no model in the way ----
// "present yourself" used to be intercepted as the on-board PRESENTATION
// routine, so the tape never ran and a disconnected board did nothing at all.
const trig = app.match(/const CMD_TRIGGERS = \[[^]*?\n\];/)[0];
assert.ok(!/go,presentation/.test(trig), "present yourself is a board routine again, not the tape");
// The phrase is matched against the REAL regexes off the source, not grepped
// for literally -- a trigger written as an alternation ("about (your|the) arm")
// never appears in the file as the sentence an operator types.
const tapeTrigs = [...trig.matchAll(/re: (\/.+?\/),\s*tape: "([^"]+)"/g)]
  .map(([, re, tape]) => [eval(re), tape]);
for (const [phrase, want] of [["present yourself", "PRESENT YOURSELF"], ["say hello", "SAY HELLO"],
                              ["sage tell me more about your arm", "ABOUT THE ARM"]]) {
  const hit = tapeTrigs.find(([re]) => re.test(phrase));
  assert.equal(hit?.[1], want, `"${phrase}" no longer plays the ${want} tape`);
  assert.ok(existsSync(new URL(`tapes/${want}.json`, import.meta.url)), `tapes/${want}.json is missing`);
}
assert.ok(/if \(trigger\?\.tape\) return void runTape\(trigger\.tape\);/.test(app),
  "the tape trigger is not wired into ask()");

// ---- the clock stops while she talks ----
// The gaps were timed to an operator's finger, not to a sentence, so a line that
// ran long left the gestures running ahead of the words. A step's gap is now
// measured from the END of the one before it.
sent.length = 0;
const talky = [
  { ms: 0, cmd: "@say and the best part, I have an arm" },   // the stand-in takes 20ms to say
  { ms: 5, cmd: "arm,5,35" },                                // recorded 5ms later, must still land AFTER
];
const t1 = Date.now();
await T.tapePlay(talky, io);
assert.ok(Date.now() - t1 >= 20 + 5, "the tape did not wait for the sentence — the arm ran ahead of the words");
assert.deepEqual(sent, ["FLUSH", "FEED:and the best part, I have an arm",
  "SAY:and the best part, I have an arm", "arm,5,35", "stop", "arm,"],
  "a gesture fired before its line was spoken");

// "@analyze" hands off to the model and has nothing to wait on yet — it holds
// the run until the answer is spoken, capped so a failed analysis is not a hang.
assert.ok(/const TAPE_ANALYZE_MS = \d+;/.test(app), "the @analyze wait lost its cap — a dead model hangs the run");
sent.length = 0;
const analyzed = T.tapePlay([{ ms: 0, cmd: "@analyze the people in front of me" }, { ms: 5, cmd: "arm,0,100" }], io);
await new Promise(r => setTimeout(r, 60));
assert.deepEqual(sent, ["FLUSH", "ANALYZE:the people in front of me"], "the run walked past @analyze without waiting");
sandbox.speakQueued("one person on my left, in a grey shirt");   // the model, seconds later
await analyzed;
assert.deepEqual(sent.slice(-4), ["SAY:one person on my left, in a grey shirt", "arm,0,100", "stop", "arm,"],
  "the run did not pick up once she had spoken — got " + JSON.stringify(sent));

// the panic key reaches a step parked on a sentence, not just the timeouts
sent.length = 0;
T.tapePlay([{ ms: 0, cmd: "@say a long one" }, { ms: 5, cmd: "arm,5,35" }], io);
await new Promise(r => setTimeout(r, 5));
sandbox.armStopTape();
await new Promise(r => setTimeout(r, 120));
assert.ok(!sent.includes("arm,5,35") && !sent.includes("stop"),
  "a killed tape carried on after the line it was parked on — got " + JSON.stringify(sent));

// ---- one tape, two languages ----
// "@say.es <texto>" fires only with the dashboard in Spanish, and the plain line
// drops out once the tape carries that language — she must not say both.
const dub = [
  { ms: 0, cmd: "arm,5,-100" },
  { ms: 0, cmd: "@say and the best part, I have an arm" },
  { ms: 0, cmd: "@say.es y lo mejor, tengo un brazo" },
  { ms: 10, cmd: "@log halfway" },
];
sent.length = 0;
T.tapePlay(dub, io);
await new Promise(r => setTimeout(r, 320));
assert.deepEqual(sent, ["FLUSH", "arm,5,-100", "FEED:and the best part, I have an arm",
  "SAY:and the best part, I have an arm", "LOG:halfway", "stop", "arm,"],
  "the spanish line leaked into an english run");

uiLang = "es";
sent.length = 0;
T.tapePlay(dub, io);
await new Promise(r => setTimeout(r, 320));
assert.deepEqual(sent, ["FLUSH", "arm,5,-100", "FEED:y lo mejor, tengo un brazo",
  "SAY:y lo mejor, tengo un brazo", "LOG:halfway", "stop", "arm,"],
  "a dubbed tape said the line twice, or said the wrong one");

// a cue keeps its suffix out of the ask, and an untranslated tape still talks
line = null;
sent.length = 0;
T.tapePlay([{ ms: 0, cmd: "@sage.es preséntate" }], io);
await new Promise(r => setTimeout(r, 320));
assert.ok(sent.includes("ASK:preséntate") && sent.includes("SAY:preséntate"),
  "a suffixed cue lost its text — got " + JSON.stringify(sent));
sent.length = 0;
T.tapePlay([{ ms: 0, cmd: "@say english only" }], io);
await new Promise(r => setTimeout(r, 320));
assert.ok(sent.includes("SAY:english only"), "an untranslated tape went silent in spanish");
uiLang = "en";

// ---- "@present" is the judge greeting, "@tape" is another run played inline ----
// The greeting is the same camera still an @analyze takes, read against
// present.md — so it holds the run until she has spoken, exactly like @analyze.
sent.length = 0;
const greet = T.tapePlay([{ ms: 0, cmd: "@present" }, { ms: 5, cmd: "arm,5,100" }], io);
await new Promise(r => setTimeout(r, 60));
assert.deepEqual(sent, ["FLUSH", "ANALYZE:present"], "the run walked past @present without waiting for her");
sandbox.speakQueued("hi to all three of you!");
await greet;
assert.deepEqual(sent.slice(-4), ["SAY:hi to all three of you!", "arm,5,100", "stop", "arm,"],
  "the run did not pick up once she had greeted them — got " + JSON.stringify(sent));

// the claw wave lives in its own file so it can be re-recorded on its own: its
// steps play inline, with their own gaps, before the run carries on.
child = [{ ms: 0, cmd: "arm,5,100" }, { ms: 30, cmd: "arm,5,0" }];
sent.length = 0;
const t3 = Date.now();
await T.tapePlay([{ ms: 0, cmd: "@tape CLAW" }, { ms: 0, cmd: "@log done" }], io);
assert.deepEqual(sent, ["FLUSH", "OPEN:CLAW", "arm,5,100", "arm,5,0", "LOG:done", "stop", "arm,"],
  "the nested run did not play in place — got " + JSON.stringify(sent));
assert.ok(Date.now() - t3 >= 30, "the nested run's own gaps were dropped");

// one level only: a tape that names itself must not recurse until the tab dies
child = [{ ms: 0, cmd: "@tape LOOP" }];
sent.length = 0;
await T.tapePlay([{ ms: 0, cmd: "@tape LOOP" }], io);
assert.equal(sent.filter(x => x.startsWith("OPEN:")).length, 1, "a self-naming tape recursed");
assert.ok(sent.some(x => x.startsWith("LOG:tape: LOOP is nested")), "a tape nested two deep played anyway");

// a missing file is a note, not a dead run
child = null;
sent.length = 0;
await T.tapePlay([{ ms: 0, cmd: "@tape GONE" }, { ms: 0, cmd: "@log after" }], io);
assert.deepEqual(sent.slice(-3), ["LOG:after", "stop", "arm,"], "a missing nested run stopped the tape");

// ---- the audio is asked for when the run starts, not when the line's turn comes ----
// Otherwise every gap between two lines carries the whole synth round trip as
// silence — which is the whole reason the greeting goes first: the model turn at
// the head of the run pays for the lines behind it.
sent.length = 0; warmed.length = 0;
T.tapePlay([{ ms: 0, cmd: "@present" }, { ms: 0, cmd: "@say and the best part, I have an arm" }], io);
assert.deepEqual(warmed, ["and the best part, I have an arm"],
  "a scripted line's audio is no longer warmed at the start of the run — it is fetched on its turn, as silence");
assert.ok(!sent.some(x => x.startsWith("SAY:")), "the warm-up spoke the line early");
sandbox.armStopTape();
assert.ok(/const ttsWarm = new Map\(\)/.test(app) && /ttsWarm\.get\(u\)/.test(app),
  "speak() no longer takes the warmed audio, so warming it does nothing");
assert.ok(/speakFlush = \(\) => \{[^}]*ttsWarm\.clear\(\)/.test(app),
  "the panic key leaves a run's worth of warmed audio behind");


console.log("test-tape ok —", steps.length, "steps,", T.TAPE_EVENTS.length, "pc-side events");
