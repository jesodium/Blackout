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

// the joint table, as the firmware holds it
const joints = [...h.matchAll(/\{\s*(\d+),\s*(true|false),\s*(\d+),\s*"(\w+)"/g)]
  .map(([, ch, cont, neutral, name]) => ({ ch: +ch, cont: cont === "true", neutral: +neutral, name }));
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
const pulse = (j, speed) => j.neutral + Math.trunc((Math.max(-100, Math.min(100, speed)) * SPAN) / 100);
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

// the browser has to re-send faster than the deadman expires, or a held button stutters
const app = readFileSync(new URL("public/js/app.js", import.meta.url), "utf8");
const rep = +(app.match(/ARM_REPEAT_MS\s*=\s*(\d+)/) || [])[1];
assert.ok(rep > 0 && rep < JOG, `arm repeat ${rep}ms must be under the ${JOG}ms deadman`);

console.log("test-arm ok —", joints.map((j) => `${j.name}:ch${j.ch}`).join(" "));
