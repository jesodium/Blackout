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
const joints = [...h.matchAll(/\{\s*(\d+),\s*(true|false),\s*(\d+),\s*(\w+),\s*(-?\d+),\s*(\w+),\s*"(\w+)"/g)]
  .map(([, ch, cont, neutral, span, hold, limit, name]) =>
    ({ ch: +ch, cont: cont === "true", neutral: +neutral,
       span: span === "ARM_SPAN_US" ? SPAN : +span, hold: +hold,
       limit: limit === "ARM_TRAVEL_MS" ? TRAVEL : +limit, name }));
assert.equal(joints.length, 6, "expected six joints");
assert.ok(joints.every((j) => j.cont), "every joint on this arm is a 360 — an angle sent to one is full speed");
assert.equal(new Set(joints.map((j) => j.ch)).size, 6, "two joints share a channel");
assert.ok(joints.every((j) => j.ch < 16), "channel outside the pca9685's 16");

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
assert.ok(/startsWith\("armh,"\)[^]{0,300}?armSetHold\(/.test(ino),
  "armh, is not wired to armSetHold()");
assert.ok(ino.indexOf('startsWith("armh,")') < ino.indexOf('startsWith("arm,")'),
  "armh, must be tested before arm,");

// the browser has to re-send faster than the deadman expires, or a held button stutters
const app = readFileSync(new URL("public/js/app.js", import.meta.url), "utf8");
const rep = +(app.match(/ARM_REPEAT_MS\s*=\s*(\d+)/) || [])[1];
assert.ok(rep > 0 && rep < JOG, `arm repeat ${rep}ms must be under the ${JOG}ms deadman`);
// the slider's range is the firmware's clamp, or the trim silently stops short
assert.equal(+(app.match(/ARM_HOLD_MAX\s*=\s*(\d+)/) || [])[1], HOLD_MAX,
  "app.js ARM_HOLD_MAX is out of step with arm.h");

// ARM_HOLD_INIT is the browser's copy of the table's hold column — it is where
// the slider starts, so a drift here shows the operator a bias the board is not
// actually running.
const init = Object.fromEntries([...(app.match(/ARM_HOLD_INIT = \{([^}]*)\}/) || [, ""])[1]
  .matchAll(/(\w+)\s*:\s*(-?\d+)/g)].map(([, k, v]) => [k, +v]));
for (const j of joints) {
  if (j.hold) assert.equal(init[j.name], j.hold, `${j.name}: ARM_HOLD_INIT disagrees with armSv[]`);
  else assert.ok(!(j.name in init), `${j.name}: ARM_HOLD_INIT has a hold armSv[] does not`);
}


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
assert.equal(+(app.match(/ARM_TRAVEL_MS\s*=\s*(\d+)/) || [])[1], TRAVEL,
  "app.js ARM_TRAVEL_MS is out of step with arm.h");
const lim = Object.fromEntries([...(app.match(/ARM_LIMIT = \{([^}]*)\}/) || [, ""])[1]
  .matchAll(/(\w+)\s*:\s*(\d+)/g)].map(([, k, v]) => [k, +v]));
for (const j of joints) {
  if (j.limit !== TRAVEL) assert.equal(lim[j.name], j.limit, `${j.name}: ARM_LIMIT disagrees with armSv[]`);
  else assert.ok(!(j.name in lim), `${j.name}: ARM_LIMIT overrides a joint on the default`);
}
// every arm command in the pad goes through send(), or a tapped move spends
// budget the meter never sees
const arm = app.match(/function Arm\(\{[^]*?\n\}/)[0];
assert.equal((arm.match(/onCmd\(`arm,/g) || []).length, 0,
  "the arm pad writes arm, straight to onCmd — it must go through send()");
assert.ok(/const panic = [^]*?stopPlay\(\)/.test(arm),
  "a queued playback step survives the panic key and restarts the arm");

console.log("test-arm ok —", joints.map((j) => `${j.name}:ch${j.ch}@${j.span}us${j.hold ? `/hold${j.hold}` : ""}${j.limit ? `/${j.limit}ms` : ""}`).join(" "));
