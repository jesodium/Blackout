// re-runs arm.h's pulse maths and deadman in js against the constants read out
// of the header — a scale or sign error here is a 360 that runs away, and the
// board has no end stop to catch it.

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const h = readFileSync(new URL("../giga-r1/main/arm.h", import.meta.url), "utf8");
const def = (name) => {
  const m = h.match(new RegExp(`^#define ${name} (.+?)\\s*(?://.*)?$`, "m"));
  assert.ok(m, `${name} missing from arm.h`);
  return Function(`"use strict";return(${m[1].trim()})`)();
};

const HZ = def("ARM_HZ"), SPAN = def("ARM_SPAN_US"), JOG = def("ARM_JOG_MS");
const HOLD_MAX = def("ARM_HOLD_MAX");
// how far out the sag trim is still expected to hold, in ms at full speed.
// No travel budget to read it off any more — 5s is past the mechanical end
// of every joint on this arm.
const SAG_REACH = 5000;

// the joint table, as the firmware holds it
const joints = [...h.matchAll(/\{\s*(\d+),\s*(true|false),\s*(\d+),\s*(\w+),\s*(-?\d+),\s*(-?\d+),\s*"(\w+)"/g)]
  .map(([, ch, cont, neutral, span, hold, sag, name]) =>
    ({ ch: +ch, cont: cont === "true", neutral: +neutral,
       span: span === "ARM_SPAN_US" ? SPAN : +span, hold: +hold, sag: +sag, name }));
assert.equal(joints.length, 6, "expected six joints");
assert.ok(joints.every((j) => j.cont), "every joint on this arm is a 360 — an angle sent to one is full speed");
assert.equal(new Set(joints.map((j) => j.ch)).size, 6, "two joints share a channel");
assert.ok(joints.every((j) => j.ch < 16), "channel outside the pca9685's 16");

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// armSetUs: us -> 12-bit off-tick
const ticks = (us) => Math.trunc((us * 4096) / (1000000 / HZ));
assert.equal(ticks(0), 0);
assert.equal(ticks(20000), 4096);                  // full period
assert.ok(ticks(1500) > 300 && ticks(1500) < 312); // ~307
for (const us of [500, 1500, 2500]) assert.ok(ticks(us) <= 4095, `${us}us overflows 12 bits`);

// armJog: speed -> pulse. must stay inside what a servo will take, both ways.
const pulse = (j, speed) => j.neutral + Math.trunc((Math.max(-100, Math.min(100, speed)) * j.span) / 100);
for (const j of joints) {
  assert.equal(pulse(j, 0), j.neutral, `${j.name}: 0 must be neutral`);
  assert.ok(pulse(j, 100) > j.neutral && pulse(j, -100) < j.neutral, `${j.name}: sign flipped`);
  assert.ok(pulse(j, 999) === pulse(j, 100), `${j.name}: speed not clamped`);
  for (const s of [-100, -1, 1, 100]) {
    const p = pulse(j, s);
    assert.ok(p >= 500 && p <= 2500, `${j.name} at ${s} -> ${p}us, outside 500-2500`);
    assert.ok(ticks(p) <= 4095, `${j.name} at ${s} overflows 12 bits`);
  }
  // the deadband on a 360 is 100us+, so a full-scale command has to clear it
  assert.ok(Math.abs(pulse(j, 100) - j.neutral) > 100, `${j.name}: swing swallowed by the deadband`);

  // armPark: a held joint keeps driving with nobody on the button, so the bias
  // has to be small enough to be a hold and not a slow runaway into the frame.
  assert.ok(Math.abs(j.hold) <= HOLD_MAX, `${j.name}: hold ${j.hold} is a jog, not a hold`);
  const p = pulse(j, j.hold);
  assert.ok(p >= 500 && p <= 2500, `${j.name} holding -> ${p}us, outside 500-2500`);
  // the hold leans on travel, so the number that matters is the one at the far
  // end of the budget, not the one in the table — and it is the clamp, not the
  // table, that has to keep it a hold. armHoldAt() mirrored off arm.h.
  // the board clamps, so this is not about safety — it is about the table being
  // honest. A sag steep enough to saturate inside the joint's own travel budget
  // means the trim goes dead partway out and the operator is turning a knob that
  // stopped doing anything, which is worse than a flat hold.
  const lean = (travel) => j.hold + Math.trunc((j.sag * travel) / 1000);
  for (const far of [SAG_REACH, -SAG_REACH]) {
    assert.ok(Math.abs(lean(far)) <= HOLD_MAX,
      `${j.name}: hold leans to ${lean(far)} at ${far}ms — it saturates inside its own travel`);
    const hp = pulse(j, clamp(lean(far), -HOLD_MAX, HOLD_MAX));
    assert.ok(hp >= 500 && hp <= 2500, `${j.name} holding at ${far}ms -> ${hp}us, outside 500-2500`);
  }
}

// armTick: a joint stops JOG_MS after its last command, and stays stopped
let last = 1000;
const expired = (now) => last !== 0 && now - last > JOG;
assert.equal(expired(1000 + JOG), false, "stopped one tick early");
assert.equal(expired(1000 + JOG + 1), true, "deadman never fires");
last = 0;
assert.equal(expired(9e9), false, "an idle joint must not be re-stopped");

// the arm moves only while an operator holds a button: one call site, inside the
// ble arm, command, and nowhere near a routine or the blk vm.
const ino = readFileSync(new URL("../giga-r1/main/main.ino", import.meta.url), "utf8");
assert.ok(/^\s*armBegin\(\);/m.test(ino), "armBegin() not called from setup()");
assert.ok(/^\s*armTick\(\);/m.test(ino), "armTick() not called from loop() — deadman is dead");
assert.equal((ino.match(/armJog\(/g) || []).length, 1, "armJog() has more than one call site");
assert.ok(/startsWith\("arm,"\)[^]{0,300}?armJog\(/.test(ino),
  "armJog() is not called from the arm, command — an unheld 360 winds into the frame");
assert.ok(/void stopRoutine\(\)[^\n]*armStopAll\(\)/.test(ino), "panic stop does not stop the arm");

// a panic stop is a true kill: armStopAll() must never park a joint on its hold
// bias, or space leaves six servos still driving.
const stopAll = h.match(/void armStopAll\(\)\s*\{[^]*?\n\}/)[0].replace(/\/\/.*/g, "");
assert.ok(!/armPark\(/.test(stopAll), "armStopAll() parks on the hold bias instead of killing");
assert.ok(/armOutputs\(false\)/.test(stopAll) && /armOff\(c\)/.test(stopAll),
  "armStopAll() must drop OE and write full-off to all 16");
// and the deadman still has to fire — parking is what it does, not nothing
assert.ok(/ARM_JOG_MS\) \{ armPark\(i\)/.test(h), "deadman no longer parks the joint");

// the live hold trim is clamped on the board, not just in the slider: armh, comes
// off ble and a bad value is a joint that climbs with nobody holding it.
assert.ok(/armSv\[i\]\.hold = constrain\(v, -ARM_HOLD_MAX, ARM_HOLD_MAX\)/.test(h),
  "armSetHold() does not clamp to ARM_HOLD_MAX");
assert.ok(/armSv\[i\]\.sag = constrain\(sag, -ARM_HOLD_MAX, ARM_HOLD_MAX\)/.test(h),
  "armSetHold() does not clamp the sag slope");
// the whole point of the slope: what reaches the servo is clamped AFTER the
// lean is added, or a joint far enough from home parks on a jog
assert.ok(/constrain\(armSv\[i\]\.hold \+[^]*?sag[^]*?armTravel\[i\][^]*?-ARM_HOLD_MAX, ARM_HOLD_MAX\)/.test(h),
  "armHoldAt() does not clamp the leaned hold");
assert.ok(/int hold = armHoldAt\(i\);/.test(h), "armPark() is back on the flat table hold");
assert.ok(/startsWith\("armh,"\)[^]{0,600}?armSetHold\(/.test(ino),
  "armh, is not wired to armSetHold()");
assert.ok(ino.indexOf('startsWith("armh,")') < ino.indexOf('startsWith("arm,")'),
  "armh, must be tested before arm,");

// the browser has to re-send faster than the deadman expires, or a held button stutters
const app = readFileSync(new URL("public/js/app.js", import.meta.url), "utf8");
const rep = +(app.match(/ARM_REPEAT_MS\s*=\s*(\d+)/) || [])[1];
assert.ok(rep > 0 && rep < JOG, `arm repeat ${rep}ms must be under the ${JOG}ms deadman`);
// A tap shorter than this is a burst nobody can see, so release holds the stop
// back to it. It has to stay under the deadman: past that the board stops the
// joint on its own and the delay would be a lie.
const minJog = +(app.match(/ARM_MIN_JOG_MS\s*=\s*(\d+)/) || [])[1];
assert.ok(minJog > 0 && minJog < JOG, `arm min jog ${minJog}ms must be under the ${JOG}ms deadman`);
assert.ok(/ARM_MIN_JOG_MS - \(Date\.now\(\) - downRef\.current\)/.test(app),
  "release() no longer holds the stop back to ARM_MIN_JOG_MS — a tap is a burst too short to see");
// The hold/sag trim came off the dashboard pad: no armh, from the browser, so
// there is no second copy of the table left to drift. The firmware half still
// has to work (armSetHold + its clamp, checked above) — the bench recorder is
// what sends it now — and the table it boots with must stay limp, or a joint
// the operator can no longer trim is left driving with no knob to stop it.
assert.ok(!/`armh,/.test(app), "the dashboard must not send armh, — the trim was removed");
for (const j of joints)
  assert.ok(!j.hold && !j.sag,
    `${j.name}: armSv[] has a hold/sag but nothing on the dashboard can trim it`);


// ---- travel integral ----
// Not a stop any more (the budget was removed 2026-09-05) — it is the sag trim's
// only estimate of pose, so a sign or scale error here is a hold bias leaning the
// wrong way as the joint moves out.
const accum = (travel, speed, dt) => travel + (speed * dt) / 100;
assert.equal(accum(0, 100, 1000), 1000, "full speed for a second must be 1000ms of budget");
assert.equal(accum(0, -100, 1000), -1000, "the budget is signed");
assert.equal(accum(0, 50, 1000), 500, "half speed must spend half the budget");
assert.equal(accum(0, 0, 9e9), 0, "an idle joint must not move the estimate");

// the firmware has to actually do all of that
assert.ok(/armAccum\(i, now\)/.test(h) && /armTravel\[i\] \+= \(long\)armSpeed\[i\]/.test(h),
  "arm.h no longer integrates travel");
assert.ok(/void armTick[^]*?armAccum\(i, now\)/.test(h),
  "armTick() does not keep the integral live — the sag bias goes stale mid-hold");
// a hold is a joint standing still against gravity; counting it drains the whole
// budget off a parked arm
assert.ok(/static void armPark[^]*?armSpeed\[i\] = 0;/.test(h),
  "armPark() leaves the joint integrating — the hold bias would eat the budget");
assert.ok(/void armZero\(int i\)/.test(h), "no way to re-home a dead-reckoned count");
assert.ok(/^\s*armZero\(-1\);/m.test(h), "armBegin() does not zero the travel clock");
assert.ok(/startsWith\("armz,"\)[^]{0,300}?armZero\(/.test(ino), "armz, is not wired to armZero()");
// The travel budget is GONE (2026-09-05, operator request): no limit column, no
// armLimits flag, no arml, command, and nothing on the dashboard turning it off.
// armTravel[] stays — the sag trim reads it as its only estimate of pose.
for (const bad of ["armLimits", "ARM_TRAVEL_MS", "arml,"])
  assert.ok(!ino.includes(bad) && !h.includes(bad),
    `the travel budget is back on the board (${bad})`);
assert.ok(!app.includes("arml,"), "the dashboard still sends arml,");
assert.ok(/long armTravel\[ARM_N\]/.test(h) && /armZero/.test(ino),
  "armTravel/armz went with the budget — the sag trim needs both");
for (const c of ["armz,"])
  assert.ok(ino.indexOf(`startsWith("${c}")`) < ino.indexOf('startsWith("arm,")'),
    `${c} must be tested before arm,`);

// every arm command goes through armSend() — one place for anything that has to
// see every arm command
const arm = app.match(/function Arm\(\{[^]*?\n\}/)[0];
assert.equal((arm.match(/onCmd\(`arm,/g) || []).length, 0,
  "the arm pad writes arm, straight to onCmd — it must go through armSend()");
// the ledger lives outside <Arm/> on purpose: the pad unmounts on every tab
// switch, and a component that unmounts forgets the travel count
assert.ok(/^const armLedger = \{/m.test(app), "the arm travel ledger is back inside a component");
assert.ok(!/function Arm\([^]*?useState\(\(\) => ARM_JOINTS\.map\(\(\) => 0\)\)/.test(arm),
  "<Arm/> keeps its own travel state — it resets every time the pad unmounts");
assert.ok(/armStopTape\(\);\s*\/\/ a queued arm step/.test(app),
  "a queued playback step survives the panic key and restarts the arm");

// ---- the claw ----
// OPEN is a one-shot burst that parks itself and CLOSE latches. On a 360 with no
// end stop the clock IS the open limit, so run the latch off the real constants.
const num = (k) => +app.match(new RegExp(`^const ${k} = (-?\\d+)`, "m"))[1];
const CLAW = { j: num("CLAW_JOINT"), open: num("CLAW_OPEN_MS"), grab: num("CLAW_GRAB_MS"), hold: num("CLAW_HOLD") };
assert.equal(joints[CLAW.j].name, "gripper", "CLAW_JOINT no longer points at the gripper");
assert.ok(CLAW.grab < JOG, `the grab (${CLAW.grab}ms) outlives the ${JOG}ms deadman — it would park mid-close`);
assert.ok(CLAW.hold > 0 && CLAW.hold <= 50, "the hold must be a gentle CLOSING push, not a stall or a release");
assert.ok(pulse(joints[CLAW.j], CLAW.hold) !== joints[CLAW.j].neutral,
  "the hold rounds away to neutral — the claw would free-wheel open");

// the nudge floor is one PCA9685 frame — the chip only reloads on a frame
// boundary, so anything shorter is a coin flip on whether the servo sees it
assert.equal(num("CLAW_FRAME_MS"), 1000 / HZ,
  `CLAW_FRAME_MS is not one ${HZ}Hz frame — a shorter nudge may not reach the servo at all`);
// pulse width is speed AND torque on a 360, so a nudge gets small by being SHORT,
// never by being gentle — a throttled nudge on a loaded claw does not break away
assert.ok(/function clawNudge[^]*?\$\{dir < 0 \? -100 : 100\}/.test(app),
  "clawNudge() throttles instead of shortening — a weak pulse will not move a loaded claw");

// replay the latch off app.js's own source, on a fake clock
const REPEAT = num("ARM_REPEAT_MS");
const src = app.match(/^const CLAW_JOINT[^]*?^function clawGo[^]*?\n\}/m)[0];
let now = 0; const timers = []; const sent = [];
const fake = {
  setTimeout: (fn, ms) => (timers.push({ at: now + ms, fn, every: 0 }), timers.length),
  setInterval: (fn, ms) => (timers.push({ at: now + ms, fn, every: ms }), timers.length),
  clearTimeout: (id) => id && (timers[id - 1] = { at: Infinity, fn: () => {}, every: 0 }),
};
fake.clearInterval = fake.clearTimeout;
const { clawGo, clawStop, clawClear, latch } = new Function("armSend", "ARM_REPEAT_MS",
  "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  `${src}; return { clawGo, clawStop, clawClear, latch: clawLatch };`
)((cmd) => sent.push({ t: now, cmd }), REPEAT,
  fake.setTimeout, fake.setInterval, fake.clearTimeout, fake.clearInterval);
const tick = (to) => { for (; now <= to; now++) for (const w of timers) if (w.at === now) { w.at = w.every ? now + w.every : Infinity; w.fn(); } };

clawGo(-100);                       // OPEN
tick(CLAW.open + 5);
assert.deepEqual(sent, [{ t: 0, cmd: `arm,${CLAW.j},-100` }, { t: CLAW.open, cmd: `arm,${CLAW.j},0` }],
  "OPEN is not one burst that parks itself — that burst IS the open limit");
tick(JOG * 2);
assert.equal(sent.length, 2, "OPEN kept driving — it must never sit against the jaw stop");
// it stays LIT after it parks: a second burst opens further with no end stop to
// catch it, so OPEN is dead until CLOSE takes the joint back
assert.equal(latch.on, "open", "OPEN did not stay latched — the button would re-fire");
clawGo(-100); clawGo(-100); tick(now + JOG);
assert.equal(sent.length, 2, "a second OPEN fired — each burst opens further with nothing to stop it");
clawGo(100);
assert.equal(latch.on, "close", "CLOSE did not take the joint back off a latched-open claw");
clawStop(); clawClear();

sent.length = 0; timers.length = 0; now = 0; clawClear();
clawGo(100);                        // CLOSE: grab, then hold, forever
tick(CLAW.grab + REPEAT * 3);
assert.equal(sent[0].cmd, `arm,${CLAW.j},100`, "CLOSE does not grab at full pace");
assert.ok(sent.slice(1).every((x) => x.cmd === `arm,${CLAW.j},${CLAW.hold}`),
  "CLOSE does not ease off to the hold once it has the thing");
assert.ok(sent.length >= 4, "the hold is not re-sent — the board's deadman would drop the payload");
for (let i = 2; i < sent.length; i++)
  assert.ok(sent[i].t - sent[i - 1].t <= JOG, "a gap in the hold repeat is longer than the deadman");
assert.equal(latch.on, "close", "CLOSE did not latch");

const n = sent.length;
clawGo(100);                        // pressing the live one again releases
assert.equal(sent.at(-1).cmd, `arm,${CLAW.j},0`, "pressing CLOSE again does not release");
tick(now + JOG * 2);
assert.equal(sent.length, n + 1, "the hold repeat outlived the release");
assert.equal(latch.on, "");

// ---- sage's arm proposals ----
// She does not drive the arm — she names a take the crew recorded on the bench
// and the operator presses YES. Every arm move she can ask for is one somebody
// already ran and kept, which is the whole reason the recorder exists.
const { parseArm, armMovesFor, ARM_REPEAT_MS } = await import("./sage.js");
assert.ok(ARM_REPEAT_MS > 0 && ARM_REPEAT_MS < JOG,
  `the gap between chained takes (${ARM_REPEAT_MS}ms) must be under the ${JOG}ms deadman`);

const take = {
  "Rotate Base [LEFT]": [{ ms: 0, cmd: "arm,0,-100" }, { ms: 500, cmd: "arm,0,0" }],
  Close: [{ ms: 100, cmd: "arm,5,-100" }, { ms: 400, cmd: "arm,5,0" }],
};
// a take replays with its original gaps — the gaps ARE the take
assert.deepEqual(parseArm("Close", take).tape, take.Close, "a recorded take was rewritten");
assert.equal(parseArm("rotate base [left]", take).text, "Rotate Base [LEFT]",
  "the name is not matched case-insensitively, or is not echoed as recorded");
assert.equal(parseArm("play Close", take).text, "Close", "a leading play is not tolerated");
// chained takes queue, never overlap
const two = parseArm("Close\nRotate Base [LEFT]", take);
assert.equal(two.tape.at(-1).ms, 400 + ARM_REPEAT_MS + 500, "chained takes overlap instead of queueing");
assert.equal(two.text, "Close\nRotate Base [LEFT]");
// there is deliberately NO joint jog: a freeform burst on a 360 with no encoder
// is exactly what the recorder exists to keep out of her hands
for (const bad of ["", "base left 600", "arm,0,-100", "Wave", "Close\nWave"])
  assert.equal(parseArm(bad, take), null, `parseArm accepted ${JSON.stringify(bad)}`);
// the count cap came off 2026-09-05 (operator request) — a long chain is still
// one YES press, and every take in it is one somebody recorded on the bench
assert.equal(parseArm("Close\n".repeat(8), take).tape.length, 8 * take.Close.length,
  "chained takes are still capped");
assert.ok(!/left|right/i.test(readFileSync(new URL("sage.js", import.meta.url), "utf8")
  .match(/function parseArm[^]*?\n\}/)[0]), "parseArm still knows how to jog a joint");

// ---- per-take flags ----
// The bench fills up with debug takes. A bare list is a take from before the
// flags existed and stays usable everywhere; anything else is opt-out per flag,
// and the two consumers must not share a switch.
const shaped = {
  legacy: [{ ms: 0, cmd: "arm,0,100" }],
  both: { steps: [{ ms: 0, cmd: "arm,1,100" }], sage_can_use: true, show_in_app: true },
  appOnly: { steps: [{ ms: 0, cmd: "arm,2,100" }], sage_can_use: false, show_in_app: true },
  sageOnly: { steps: [{ ms: 0, cmd: "arm,3,100" }], sage_can_use: true, show_in_app: false },
  empty: { steps: [], sage_can_use: true, show_in_app: true },
};
assert.deepEqual(Object.keys(armMovesFor(shaped, "sage_can_use")), ["legacy", "both", "sageOnly"]);
assert.deepEqual(Object.keys(armMovesFor(shaped, "show_in_app")), ["legacy", "both", "appOnly"]);
assert.deepEqual(armMovesFor(shaped, "sage_can_use").legacy, shaped.legacy,
  "a pre-flags take must come back as its bare step list");
// a take Sage may not use must not even be namable to her
assert.equal(parseArm("appOnly", armMovesFor(shaped, "sage_can_use")), null,
  "sage can name a take she is not allowed to use");
const rec = readFileSync(new URL("armrec.py", import.meta.url), "utf8");
const srv0 = readFileSync(new URL("server.js", import.meta.url), "utf8");
assert.ok(/FLAGS = \("sage_can_use", "show_in_app"\)/.test(rec),
  "armrec.py's flag names are out of step with the server's");
assert.ok(/save_move\(name, wrap\(clean\(REC\["steps"\]\), flags_of\(load_moves\(\)\.get\(name, \{\}\)\)\)\)/.test(rec),
  "re-recording a take resets its flags");
// One file per take, filename = name, on BOTH sides — an index file here and a
// folder there is how the dashboard ends up showing takes that no longer exist.
assert.ok(/MOVES_D = os\.path\.join\(HERE, "arm_moves"\)/.test(rec) && !/arm_moves\.json/.test(rec),
  "armrec.py still keeps takes in one index file");
// (one reader now — a tape in tapes/ is the same file in another folder)
assert.ok(/readTakes\(ARM_DIR\)/.test(srv0) && /readdirSync\(dir\)/.test(srv0) && !/arm_moves\.json/.test(srv0),
  "the server reads takes from an index file, not the arm_moves/ folder");

// the names come from the folder, so recording a take is all it takes to give
// her one — nothing to edit in the prompt
assert.ok(/function armLine\(\)[^]*?readArmMoves\(\)/.test(srv0),
  "the recorded names are not fed into sage's prompt from arm_moves/");
assert.ok(!/Go down|Grab Open/.test(readFileSync(new URL("prompts/chat.md", import.meta.url), "utf8")),
  "chat.md hardcodes take names — they go stale the moment one is recorded");

// she may only ever propose: nothing in the browser runs an arm tape without a
// press, and the drive lock takes the arm with it
assert.ok(/kind: "arm"[^]*?state: "pending"/.test(app), "an arm proposal runs without a card");
assert.ok(/if \(sage && sage\.arm && movesRef\.current\)/.test(app),
  "an arm proposal ignores the SAGE MOVES lock");
assert.ok(/reply\.move = null; reply\.arm = null;/.test(srv0), "the move lock does not clear arm");
assert.ok(/armMovesFor\(readArmMoves\(\), "sage_can_use"\)/.test(srv0) &&
          /armMovesFor\(readArmMoves\(\), "show_in_app"\)/.test(srv0),
  "the dashboard and sage do not read their own flag");
// a browser that never answers the confirm gate reads as NO, never as go-ahead
assert.ok(/setTimeout\(\(\) => done\(false\), CONFIRM_MS\)/.test(srv0),
  "an unanswered tool confirmation does not default to no");

console.log("test-arm ok —", joints.map((j) => `${j.name}:ch${j.ch}@${j.span}us${j.hold ? `/hold${j.hold}` : ""}`).join(" "));
