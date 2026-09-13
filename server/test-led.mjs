// the strip's state machine, off-device: colour says what, motion says how urgent

import assert from "node:assert";
import { createRequire } from "node:module";
const { frame } = createRequire(import.meta.url)("./ledstrip.js");

const HUE = { clear: 34, caution: 0, danger: 0, link: 210, think: 285 };
const peak = (s) => { let m = 0; for (let t = 0; t < 3000; t += 20) m = Math.max(m, frame(s, t).v); return m; };
const floor = (s) => { let m = 1e9; for (let t = 0; t < 3000; t += 20) m = Math.min(m, frame(s, t).v); return m; };
const base = { link: true, level: "ok", sage: null, sageAt: 0, busy: false, speaking: false, manual: null };
const st = (o) => ({ ...base, ...o });
// v over a couple of seconds — an effect that moves has a spread, a solid does not
const span = (s) => {
  const vs = [];
  for (let t = 0; t < 3000; t += 20) vs.push(frame(s, t).v);
  return Math.max(...vs) - Math.min(...vs);
};

// no telemetry wins over everything but a manual hold
assert.equal(frame(st({ link: false, level: "bad" }), 0).h, HUE.link);
assert.ok(span(st({ link: false })) > 300, "waiting should breathe");

// sensor level drives the colour
assert.equal(frame(st({ level: "ok" }), 0).h, HUE.clear);
assert.equal(frame(st({ level: "warn" }), 0).h, HUE.caution);
assert.equal(frame(st({ level: "bad" }), 0).h, HUE.danger);
assert.equal(span(st({ level: "ok" })), 0, "clear is solid");
assert.ok(span(st({ level: "warn" })) > 200 && span(st({ level: "bad" })) > 300);
// caution and danger are the SAME red — depth is what separates them, so a
// caution must never get as bright as danger's dimmest point
assert.ok(peak(st({ level: "warn" })) < floor(st({ level: "bad" })),
  "caution's brightest must stay under danger's dimmest — depth is the only thing telling the two reds apart");

// her verdict raises the level but never lowers it, and it decays
const now = Date.now();
assert.equal(frame(st({ sage: "danger", sageAt: now }), now).h, HUE.danger);
assert.ok(peak(st({ level: "bad", sage: "clear", sageAt: now })) > 900, "her clear never lowers the level");
assert.equal(frame(st({ sage: "danger", sageAt: now - 60000 }), now).h, HUE.clear, "stale verdict decays");
assert.equal(frame(st({}), 0).s, 900, "clear is the brand orange, not full sat");

// thinking colours the whole strip, speaking only flaps it — the hazard colour holds
assert.equal(frame(st({ busy: true, level: "bad" }), 0).h, HUE.think);
assert.equal(frame(st({ speaking: true, level: "warn" }), 0).h, HUE.caution);
assert.ok(span(st({ speaking: true, level: "ok" })) > 500, "speaking must move");
assert.equal(frame(st({ speaking: true, busy: true, level: "ok" }), 0).h, HUE.think);

// manual hold beats the lot
const m = { h: 300, s: 500, v: 40 };
assert.deepEqual(frame(st({ manual: m, link: false, speaking: true }), 0), m);

// quantised, and inside the wire ranges the daemon formats as %04x
for (const s of [st({}), st({ link: false }), st({ level: "bad" }), st({ speaking: true }), st({ busy: true })])
  for (let t = 0; t < 3000; t += 20) {
    const f = frame(s, t);
    assert.ok(f.h >= 0 && f.h <= 359 && f.s <= 1000 && f.v >= 0 && f.v <= 1000, "out of range");
    assert.equal(f.v % 25, 0, "unquantised v spams the strip");
  }

// party effects: whole-strip only, but they must actually move and stay legal.
// 12s, not 3: storm is deliberately sparse — a quiet gap is the effect, so a
// 3s window can legitimately catch nothing.
const { fxNames } = createRequire(import.meta.url)("./ledstrip.js");
const fxSpan = (s) => {
  const vs = [];
  for (let t = 0; t < 12000; t += 20) vs.push(frame(s, t).v);
  return Math.max(...vs) - Math.min(...vs);
};
for (const n of fxNames) {
  const s = st({ fx: n });
  assert.ok(fxSpan(s) > 300, n + " must move");
  for (let t = 0; t < 12000; t += 20) {
    const f = frame(s, t);
    assert.ok(f.h >= 0 && f.h <= 359 && f.s <= 1000 && f.v >= 0 && f.v <= 1000, n + " out of range");
    assert.equal(f.v % 25, 0, n + " unquantised");
  }
}
assert.deepEqual(frame(st({ fx: "matrix", manual: m }), 0), m, "manual beats an effect");
assert.equal(frame(st({ fx: "nope", level: "bad" }), 0).h, HUE.danger, "unknown effect falls back to the status light");

console.log("led strip ok");
