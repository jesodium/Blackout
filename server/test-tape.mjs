// tapes: the head-shift on save, the "@" event split, and that a tape dies with
// the panic key. The player itself is pulled out of app.js and run here, so a
// change to it has to keep passing.

import { readFileSync } from "node:fs";
import assert from "node:assert";

const app = readFileSync(new URL("public/js/app.js", import.meta.url), "utf8");

// recording is a tap in sendCmd — the one place every command leaves the browser
assert.ok(/tapeWatch\(word\);/.test(app), "sendCmd stopped feeding the tape recorder");
// a queued step must die with the panic key, so a tape uses the arm's ledger
assert.ok(/function tapePlay\([^]*?armStopTape\(\);[^]*?armLedger\.tape =/.test(app),
  "tapePlay does not run on armLedger.tape — the panic key can't kill it");

// the drawer unmounts <Tapes/> whenever the console is closed, and closing it is
// how the arm pad gets reached mid-take — so the button and the name box have to
// come back off the module flag, not off a fresh false.
assert.ok(/useState\(tapeRec\.on\)/.test(app), "Tapes' rec state no longer survives the drawer closing");
assert.ok(/useState\(tapeRec\.on \? tapeRec\.name : ""\)/.test(app), "the tape name no longer survives the drawer closing");

const src = app.slice(app.indexOf("// ---- tapes ----"), app.indexOf("function Tapes("));
const sent = [];
const io = { onCmd: (c) => sent.push(c), onAnalyze: (_, f) => sent.push("ANALYZE:" + f), onNote: (n) => sent.push("LOG:" + n) };
let line = null;                 // what the model gives back for a cue, or nothing
const ledger = { tape: [] };     // the real one, so a new tape kills the last one's queue
const sandbox = {
  armSend: (c, onCmd) => onCmd(c),
  armStopTape: () => { ledger.tape.forEach(clearTimeout); ledger.tape = []; },
  armLedger: ledger,
  ARM_REPEAT_MS: 250,
  getLang: () => "en",
  AbortSignal: { timeout: () => null },
  speak: (txt) => sent.push("SAY:" + txt),
  fetch: (url, o) => {
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
for (const [cmd, want] of [
  ["drv,tank,0,0,100", "drv,tank,0,0,100"],
  ["@say hello judges", "SAY:hello judges"],
  ["@analyze the red block", "ANALYZE:the red block"],
  ["@log halfway", "LOG:halfway"],
  ["@led 200", "LED:200"],
]) { sent.length = 0; T.tapeStep(cmd, io); assert.deepEqual(sent, [want], cmd); }
sent.length = 0;
T.tapeStep("@nope", io);
assert.ok(sent[0].startsWith("LOG:tape: unknown"), "an unknown @event went to the board");
assert.deepEqual(T.TAPE_EVENTS, ["sage", "say", "analyze", "log", "led"], "the hint no longer lists the events that work");

// ---- "@sage" is a cue, not a script ----
// The line is asked for when the tape STARTS (dead air mid-presentation is the
// whole reason), and whatever has not landed by the time the step fires falls
// back to speaking the cue as written — the venue has no internet, so that is
// the normal case and a tape must always talk.
const cueTape = [{ ms: 0, cmd: "drv,tank,120,120,300" }, { ms: 30, cmd: "@sage introduce yourself to the judges" }];

line = null;                                  // no answer: offline
sent.length = 0;
await new Promise(r => setTimeout(r, T.tapePlay(cueTape, io) + 60));
assert.deepEqual(sent, ["ASK:introduce yourself to the judges", "drv,tank,120,120,300",
  "LOG:introduce yourself to the judges", "SAY:introduce yourself to the judges", "stop", "arm,"],
  "an unanswered cue must still speak, as written");
assert.ok(sent.indexOf("ASK:introduce yourself to the judges") === 0,
  "the line is fetched when the step fires, not when the tape starts — that is dead air");

line = "Hi everyone! I'm Sage, and it's twenty-four degrees in here.";
sent.length = 0;
await new Promise(r => setTimeout(r, T.tapePlay(cueTape, io) + 60));
assert.ok(sent.includes("SAY:" + line), "her live line was not spoken — got " + JSON.stringify(sent));
assert.ok(!sent.includes("SAY:introduce yourself to the judges"), "the cue was read out loud on top of her line");

// one ask per distinct cue, not one per step
sent.length = 0;
T.tapePlay([{ ms: 0, cmd: "@sage same cue" }, { ms: 10, cmd: "@sage same cue" }], io);
assert.equal(sent.filter(x => x.startsWith("ASK:")).length, 1, "the same cue is asked for twice");

// ---- playback parks the robot at the end ----
sent.length = 0;
const dur = T.tapePlay([{ ms: 0, cmd: "drv,tank,120,120,300" }, { ms: 40, cmd: "arm,5,-100" }], io);
assert.equal(dur, 40 + 250);
await new Promise(r => setTimeout(r, dur + 60));
assert.deepEqual(sent, ["drv,tank,120,120,300", "arm,5,-100", "stop", "arm,"],
  "a tape must leave the wheels and the arm stopped");

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

console.log("test-tape ok —", steps.length, "steps,", T.TAPE_EVENTS.length, "pc-side events");
