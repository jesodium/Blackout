// The arm as the board believes it is: arm.h's armTick re-run in js off the same
// commands the board gets. No angles come back over BLE, so this is what the
// dash draws. USB `arm <name> @ <deg>` lines snap it back to the truth.
// IMPORTANT NOTE: ARM_J copies armSv[] in firmware/giga/main/arm.h; test/arm.mjs
// fails when they drift.
export const ARM_J = [
  { name: "base", lo: 10, hi: 170, home: 90, dir: -1 },
  { name: "shoulder", lo: 5, hi: 175, home: 90, dir: 1 },
  { name: "elbow", lo: 5, hi: 175, home: 90, dir: 1 },
  { name: "gripper", lo: 60, hi: 110, home: 90, dir: 1 },
];
export const ARM_DEG_S = 90, ARM_JOG_MS = 1000;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function armSim() {
  const s = {
    on: true, live: false,
    j: ARM_J.map((d) => ({ pos: d.home, goal: NaN, spd: 0, last: 0, limp: false, limpGoal: false })),
  };
  const stopAll = () => { s.live = false; s.j.forEach((j) => Object.assign(j, { spd: 0, last: 0, goal: NaN, limpGoal: false })); };
  const liveOn = () => { if (s.on) s.live = true; };

  // one wire command, same parse as handleCmd in commands.h
  s.cmd = (w, now) => {
    const [op, a, b, c] = w.trim().split(",");
    const j = s.j[+a], d = ARM_J[+a];
    if (w === "stop" || w === "arm,") stopAll();
    else if (op === "armen") { s.on = a === "1"; stopAll(); }
    else if (op === "armz") { s.j.forEach((j, i) => Object.assign(j, { spd: 0, last: 0, goal: ARM_J[i].home, limpGoal: false })); liveOn(); }
    else if (op === "armto" && j && b !== undefined) { liveOn(); Object.assign(j, { spd: 0, last: 0, goal: clamp(+b || 0, d.lo, d.hi), limpGoal: c === "1" }); }
    else if (op === "arm" && j && b !== undefined) {
      liveOn();
      const v = +b || 0;
      if (v) { j.goal = NaN; j.limpGoal = false; }
      j.spd = clamp(v, -100, 100) * d.dir;
      j.last = j.spd ? now : 0;
    }
  };

  // armTick. Returns true while anything is still moving.
  s.tick = (now, dt) => {
    if (!s.live) return false;
    const lim = ARM_DEG_S * dt;
    let busy = false;
    s.j.forEach((j, i) => {
      const d = ARM_J[i];
      if (j.last && now - j.last > ARM_JOG_MS) { j.spd = 0; j.last = 0; }
      const step = j.spd ? lim * j.spd / 100 : !isNaN(j.goal) ? clamp(j.goal - j.pos, -lim, lim) : 0;
      if (!step && isNaN(j.goal)) return;
      const was = j.pos;
      j.pos = clamp(j.pos + step, d.lo, d.hi);
      if (j.pos !== was) j.limp = false;
      if (!j.spd && !isNaN(j.goal) && Math.abs(j.pos - j.goal) < 0.01) {
        j.goal = NaN;
        if (j.limpGoal) { j.limpGoal = false; j.limp = true; }
      }
      busy ||= !!j.spd || !isNaN(j.goal);
    });
    return busy;
  };

  // `arm shoulder @ 93` off the usb log
  s.serial = (line) => {
    const m = /^arm (\w+) @ (-?\d+)/.exec(line || "");
    const i = m ? ARM_J.findIndex((d) => d.name === m[1]) : -1;
    if (i >= 0) s.j[i].pos = +m[2];
    return i >= 0;
  };
  return s;
}

// ---- pose for the 3D model ----
// arm.glb is hardware/sim/blackout.xml's MeArm, one node per body (tools/export_arm_glb.py).
// MuJoCo holds the parallelogram together with equality constraints; they are all
// linear, so here they are as plain formulas (the <equality> block, solved for the mimic).
// Servo degrees -> joint radians: [deg, rad] at two points, a straight line between them,
// and nothing drawn past either point (the CAD's ARM_RANGE trims further).
// Both ends are photos of the real arm (2026-11-23), gripper level in both:
//   home (90/90) = full lift: upper arm vertical, forearm ~54deg below level.
//                  Lifting past it only stalls the servos against the frame.
//   full lower (shoulder 175, elbow 5: where ARM_LOWER ends) = upper arm level forward,
//                  forearm still ~50deg down. The forearm hardly moves; the shoulder does it.
// IMPORTANT NOTE: angles eyeballed off phone photos, a few degrees out. Base is 1:1, sign unchecked.
export const ARM_CAL = {
  base: [[0, -Math.PI / 2], [180, Math.PI / 2]],
  shoulder: [[90, 0], [175, -1.57]],
  elbow: [[90, 0.94], [5, 0.87]],
};
const Z = [0, 0, 1];
export const armQ = (j0, j1, j2, jaw) => ({
  column: [Z, j0], arm_0: [Z, j1], arm_1_support_0: [Z, j2],
  arm_0_support: [Z, 1.57 + j1], connector: [Z, -1.57 - j1],
  gripper_support: [Z, -1.57 - j2], gripper: [Z, -1.57 + j2],
  arm_1b: [Z, -1.57 - j1 - j2], arm_1_support_1b: [Z, 1.57 - j1 - j2],
  jaw_A: [[0, 1, 0], jaw], jaw_B: [[0, -1, 0], jaw],
});
// The CAD's mechanical travel per joint (blackout.xml jnt range, radians): nothing is
// drawn past where the arm can physically go.
export const ARM_RANGE = { joint_0: [-0.7853, 0.7853], joint_1: [-1.57, 1], joint_2: [0, 1.57], jaw_A: [-0.035, 0.52] };
const lim = (k, v) => Math.min(ARM_RANGE[k][1], Math.max(ARM_RANGE[k][0], v));
// deg = [base, shoulder, elbow, gripper] in the operator's degrees
export const armJoints = (deg) => {
  const q = (k, v) => { const [[d0, q0], [d1, q1]] = ARM_CAL[k]; return q0 + Math.min(1, Math.max(0, (v - d0) / (d1 - d0))) * (q1 - q0); };
  const g = ARM_J[3];
  return armQ(lim("joint_0", q("base", deg[0])), lim("joint_1", q("shoulder", deg[1])), lim("joint_2", q("elbow", deg[2])),
    lim("jaw_A", 0.52 * (deg[3] - g.lo) / (g.hi - g.lo)));
};
