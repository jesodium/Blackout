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
const HOLD_MAX = def("ARM_HOLD_MAX"), TRAVEL = def("ARM_TRAVEL_MS");

// the joint table, as the firmware holds it
const joints = [...h.matchAll(/\{\s*(\d+),\s*(true|false),\s*(\d+),\s*(\w+),\s*(-?\d+),\s*(-?\d+),\s*(\w+),\s*"(\w+)"/g)]
  .map(([, ch, cont, neutral, span, hold, sag, limit, name]) =>
    ({ ch: +ch, cont: cont === "true", neutral: +neutral,
       span: span === "ARM_SPAN_US" ? SPAN : +span, hold: +hold, sag: +sag,
       limit: limit === "ARM_TRAVEL_MS" ? TRAVEL : +limit, name }));
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
  for (const far of [j.limit || 5000, -(j.limit || 5000)]) {
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
// The hold/sag trim came off the dashboard pad: no armh, from the browser, so
// there is no second copy of the table left to drift. The firmware half still
// has to work (armSetHold + its clamp, checked above) — the bench recorder is
// what sends it now — and the table it boots with must stay limp, or a joint
// the operator can no longer trim is left driving with no knob to stop it.
assert.ok(!/`armh,/.test(app), "the dashboard must not send armh, — the trim was removed");
for (const j of joints)
  assert.ok(!j.hold && !j.sag,
    `${j.name}: armSv[] has a hold/sag but nothing on the dashboard can trim it`);


// ---- travel budget ----
// The only stop a 360 can have: no encoder anywhere on this arm, so the limit is
// integrated run-time and a sign or scale error here is a joint that either
// never stops or refuses to move at all.
for (const j of joints) assert.ok(j.limit >= 0, `${j.name}: negative travel budget`);
const accum = (travel, speed, dt) => travel + (speed * dt) / 100;
assert.equal(accum(0, 100, 1000), 1000, "full speed for a second must be 1000ms of budget");
assert.equal(accum(0, -100, 1000), -1000, "the budget is signed");
assert.equal(accum(0, 50, 1000), 500, "half speed must spend half the budget");
assert.equal(accum(0, 0, 9e9), 0, "an idle joint must not spend budget");
// the stop is one-directional: the way back is always open, or the arm traps
// itself at its own limit with nothing that can retrieve it
const blocked = (j, travel, speed) =>
  !!j.limit && speed !== 0 && (speed > 0 ? travel >= j.limit : travel <= -j.limit);
for (const j of joints.filter((x) => x.limit)) {
  assert.equal(blocked(j, j.limit, 100), true, `${j.name}: runs past its stop`);
  assert.equal(blocked(j, j.limit, -100), false, `${j.name}: trapped at its own stop`);
  assert.equal(blocked(j, -j.limit, -100), true, `${j.name}: runs past its stop the other way`);
  assert.equal(blocked(j, 0, 100), false, `${j.name}: cannot move from home`);
  assert.equal(blocked(j, j.limit, 0), false, "a stop is never blocked");
}

// the firmware has to actually do all of that
assert.ok(/armAccum\(i, now\)/.test(h) && /armTravel\[i\] \+= \(long\)armSpeed\[i\]/.test(h),
  "arm.h no longer integrates travel");
assert.ok(/void armJog[^]*?armLimits && armSv\[i\]\.limit[^]*?speed = 0;/.test(h),
  "armJog() does not check the travel budget");
assert.ok(/void armTick[^]*?armAccum\(i, now\)/.test(h),
  "armTick() does not keep the integral live — a held button never reaches its stop");
// a hold is a joint standing still against gravity; counting it drains the whole
// budget off a parked arm
assert.ok(/static void armPark[^]*?armSpeed\[i\] = 0;/.test(h),
  "armPark() leaves the joint integrating — the hold bias would eat the budget");
assert.ok(/void armZero\(int i\)/.test(h), "no way to re-home a dead-reckoned count");
assert.ok(/^\s*armZero\(-1\);/m.test(h), "armBegin() does not zero the travel clock");
assert.ok(/startsWith\("armz,"\)[^]{0,300}?armZero\(/.test(ino), "armz, is not wired to armZero()");
assert.ok(/startsWith\("arml,"\)[^]{0,200}?armLimits =/.test(ino), "arml, does not toggle the stops");
for (const c of ["armz,", "arml,"])
  assert.ok(ino.indexOf(`startsWith("${c}")`) < ino.indexOf('startsWith("arm,")'),
    `${c} must be tested before arm,`);

// and the browser's mirror has to agree with the table, or the meter shows the
// operator a stop the board is not holding
// the dashboard no longer keeps its own copy of the travel budget: it pushes
// arml,0 on every connect and the arm runs unstopped, which is what the operator
// asked for. The firmware still HAS the budget (checked above) — that is the way
// back if it is ever wanted, and RE-HOME still clears the board's count.
assert.ok(!/ARM_TRAVEL_MS/.test(app), "app.js is keeping a travel budget again");
assert.ok(/onCmd\("arml,0"\)/.test(app), "the pad does not turn the board's travel stops off");

// every arm command goes through armSend(), or a tapped move — or one of Sage's
// cards — spends budget the meter never sees
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

// ---- sage's arm proposals ----
// She does not drive the arm — she names a take the crew recorded on the bench
// and the operator presses YES. Every arm move she can ask for is one somebody
// already ran and kept, which is the whole reason the recorder exists.
const { parseArm, armMovesFor, ARM_REPEAT_MS, ARM_MAX_TAKES } = await import("./sage.js");
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
for (const bad of ["", "base left 600", "arm,0,-100", "Wave", "Close\nWave",
                   "Close\n".repeat(ARM_MAX_TAKES + 1)])
  assert.equal(parseArm(bad, take), null, `parseArm accepted ${JSON.stringify(bad)}`);
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
assert.ok(/readdirSync\(ARM_DIR\)/.test(srv0) && !/arm_moves\.json/.test(srv0),
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

console.log("test-arm ok —", joints.map((j) => `${j.name}:ch${j.ch}@${j.span}us${j.hold ? `/hold${j.hold}` : ""}${j.limit ? `/${j.limit}ms` : ""}`).join(" "));
