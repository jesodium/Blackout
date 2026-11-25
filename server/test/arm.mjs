// the dash's 3D arm is armsim.mjs re-running arm.h's armTick. If the joint table
// or the glide/deadman constants drift, the picture lies about where the arm is.

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { ARM_J, ARM_DEG_S, ARM_JOG_MS, ARM_RANGE, armSim, armQ, armJoints } from "../public/js/armsim.mjs";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Vector3 } from "three";
import { poseArm } from "../web/arm3d.mjs";

const h = readFileSync(new URL("../../firmware/giga/main/arm.h", import.meta.url), "utf8");
const def = (name) => +h.match(new RegExp(`^#define ${name} (\\d+)`, "m"))[1];
assert.equal(ARM_DEG_S, def("ARM_DEG_S"), "ARM_DEG_S drifted from arm.h");
assert.equal(ARM_JOG_MS, def("ARM_JOG_MS"), "ARM_JOG_MS drifted from arm.h");

const fw = [...h.matchAll(/\{\s*\d+,\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*-?\d+,\s*(-?\d+),\s*"(\w+)"/g)]
  .map(([, lo, hi, home, dir, name]) => ({ name, lo: +lo, hi: +hi, home: +home, dir: +dir }));
assert.deepEqual(ARM_J, fw, "armsim.mjs ARM_J drifted from armSv[] in arm.h");

const run = (s, from, ms) => { for (let t = from; t < from + ms; t += 10) s.tick(t, 0.01); };

// glide: 90deg/s, clamped to lo/hi, stops on the goal
let s = armSim();
s.cmd("armto,1,135", 0); run(s, 0, 250);
assert.ok(Math.abs(s.j[1].pos - 112.5) < 1, `glide rate off: ${s.j[1].pos}`);
run(s, 250, 1000);
assert.equal(s.j[1].pos, 135); assert.ok(isNaN(s.j[1].goal));
s.cmd("armto,3,0", 0); run(s, 0, 2000);
assert.equal(s.j[3].pos, 60, "gripper glided past lo");

// jog: dir flips it, deadman stops it after ARM_JOG_MS
s = armSim();
s.cmd("arm,0,50", 1000); run(s, 1000, 500);
assert.ok(s.j[0].pos < 90, "base dir -1 not applied");
run(s, 1500, 3000);
assert.ok(Math.abs(s.j[0].pos - 45) < 1 && s.j[0].spd === 0, `deadman never fired: ${s.j[0].pos}`);

// limp on arrival, stop kills everything, locked arm ignores moves
s = armSim();
s.cmd("armto,3,60,1", 0); run(s, 0, 1000);
assert.ok(s.j[3].limp && s.live, "reg close didn't go limp");
s.cmd("arm,2,100", 0); s.cmd("stop", 0); run(s, 0, 500);
assert.equal(s.j[2].pos, 90, "stop left a joint moving");
s.cmd("armen,0", 0); s.cmd("armz,", 0); assert.equal(s.live, false, "locked arm went live");

// usb readout snaps the model
assert.ok(s.serial("arm elbow @ 42") && s.j[2].pos === 42);
assert.ok(!s.serial("PCA9685 ok"));
// the 3D model: arm.glb posed by armQ lands the tool and jaw where MuJoCo puts them
// (tools/export_arm_glb.py writes arm-fk.json). A wrong mimic formula is an arm that
// comes apart at the elbow on screen.
const glb = readFileSync(new URL("../public/models/arm.glb", import.meta.url));
const gltf = await new GLTFLoader().parseAsync(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength), "");
const root = gltf.scene, base = root.getObjectByName("mearm");
assert.ok(base, "arm.glb has no mearm node");
const fk = JSON.parse(readFileSync(new URL("./arm-fk.json", import.meta.url), "utf8"));
assert.deepEqual(ARM_RANGE, fk.range, "ARM_RANGE drifted from blackout.xml — rerun tools/export_arm_glb.py and copy it");
for (const { q, tool, jaw_A } of fk.poses) {
  poseArm(root, armQ(...q));
  root.updateMatrixWorld(true);
  for (const [name, want] of [["tool", tool], ["jaw_A", jaw_A]]) {
    const got = base.worldToLocal(root.getObjectByName(name).getWorldPosition(new Vector3())).toArray();
    const err = Math.hypot(...got.map((v, i) => v - want[i]));
    assert.ok(err < 1e-3, `${name} at q=${q} is ${(err * 1000).toFixed(1)}mm off MuJoCo`);
  }
}
// the two photos: home is full lift (upper arm vertical, forearm ~54deg down), full lower
// is upper arm level forward with the forearm ~50deg down. Past either end nothing moves.
const pose = (sh, el) => { const j = armJoints([90, sh, el, 60]); return [j.arm_0[1], j.arm_1_support_0[1]].map((v) => +v.toFixed(4)); };
assert.deepEqual(pose(90, 90), [0, 0.94], "home no longer draws the full-lift photo");
assert.deepEqual(pose(5, 175), [0, 0.94], "lift past home drew the arm past its stops");
assert.deepEqual(pose(175, 5), [-1.57, 0.87], "full lower no longer draws the lowered photo");
const [m1, m2] = pose(132.5, 47.5);
assert.ok(m1 === -0.785 && m2 > 0.87 && m2 < 0.94, `halfway down isn't between the photos: ${[m1, m2]}`);
assert.equal(armJoints([90, 90, 90, 60]).column[1], 0, "base not straight at 90");
console.log("arm ok");
