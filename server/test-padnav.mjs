// the arcade mix and the spatial roaming maths, cross-checked against main.ino

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { pickNext, stepCursor } from "./public/js/padnav.mjs";

const box = (x, y, w = 40, h = 20) => ({ x, y, width: w, height: h });

const grid = [box(0, 0), box(100, 0), box(200, 0), box(0, 100), box(100, 100), box(200, 100)];
assert.equal(pickNext(grid, 4, "up"), 1, "up from centre");
assert.equal(pickNext(grid, 4, "down"), -1, "nothing below the bottom row");
assert.equal(pickNext(grid, 4, "left"), 3);
assert.equal(pickNext(grid, 4, "right"), 5);
assert.equal(pickNext(grid, 0, "left"), -1, "nothing left of the left edge");

assert.equal(pickNext(grid, -1, "down"), 0, "cold start doesn't land nowhere");
assert.equal(pickNext([], -1, "down"), -1, "empty page");

const skew = [box(0, 0), box(0, 60), box(70, 30)];
assert.equal(pickNext(skew, 0, "down"), 1, "sideways neighbour stole a down move");

const tall = [box(0, 0), box(0, 40, 40, 400)];
assert.equal(pickNext(tall, 0, "down"), 1);

assert.deepEqual(stepCursor(100, 100, 20, -30, 800, 600), { x: 120, y: 70, scroll: 0 });
assert.deepEqual(stepCursor(0, 10, -50, -40, 800, 600), { x: 0, y: 0, scroll: -30 }, "top edge must pan up");
assert.deepEqual(stepCursor(0, 590, 0, 40, 800, 600), { x: 0, y: 600, scroll: 30 }, "bottom edge must pan down");

const DEADZONE = 0.15, MIN_PWM = 55, MANUAL_PWM = 110, SPIN_SCALE = 0.45;
const dz = (v) => (Math.abs(v) < DEADZONE ? 0 : (v - Math.sign(v) * DEADZONE) / (1 - DEADZONE));
const duty = (v, cap) => (Math.abs(v) < 0.02 ? 0
  : Math.round(Math.sign(v) * (MIN_PWM + (cap - MIN_PWM) * Math.min(1, Math.abs(v)))));
function mix(ax, ay, rx = 0, cap = MANUAL_PWM) {
  const y = -dz(ay), x = dz(ax);
  let l = y - x, r = y + x;
  l -= dz(rx) * SPIN_SCALE; r += dz(rx) * SPIN_SCALE;
  const peak = Math.max(Math.abs(l), Math.abs(r));
  if (peak > 1) { l /= peak; r /= peak; }
  return [duty(l, cap), duty(r, cap)];
}

assert.deepEqual(mix(0, 0), [0, 0], "sticks at rest must be a full stop");
assert.deepEqual(mix(0.1, -0.1), [0, 0], "deadzone doesn't cover a drifting stick");
assert.deepEqual(mix(0, -1), [MANUAL_PWM, MANUAL_PWM], "full forward isn't full cap");
assert.deepEqual(mix(0, 1), [-MANUAL_PWM, -MANUAL_PWM], "full back");

assert.deepEqual(mix(1, 0), [-MANUAL_PWM, MANUAL_PWM], "stick right must pivot right");
assert.deepEqual(mix(-1, 0), [MANUAL_PWM, -MANUAL_PWM], "stick left must pivot left");

const [al, ar] = mix(0.6, -1);
assert.ok(al > 0 && ar > 0, `arc must keep both sides forward, got ${al}/${ar}`);
assert.ok(ar > al, "turning right must leave the right side faster than the left");
assert.ok(Math.max(al, ar) <= MANUAL_PWM, "mix overshot the cap instead of scaling back");

for (const [ax, ay] of [[0.2, -0.2], [0.9, -0.16], [0, -0.155]]) {
  for (const side of mix(ax, ay)) assert.ok(side === 0 || Math.abs(side) >= MIN_PWM, `${side} under MIN_PWM`);
}

assert.ok(Math.abs(mix(0, 0, 1)[0]) < MANUAL_PWM, "right stick spin isn't slower than full");
assert.deepEqual(mix(0, 0, 1).map(Math.sign), [-1, 1], "right stick spins right");

const ino = readFileSync(new URL("../giga-r1/main/main.ino", import.meta.url), "utf8");
assert.ok(/verb == "tank"/.test(ino), 'main.ino has no "tank" verb — drv,tank would halt the motors');
assert.ok(/void tank\(int l, int r\)/.test(ino), "main.ino lost tank()");

const app = readFileSync(new URL("./public/js/app.js", import.meta.url), "utf8");
assert.ok(/drv,tank,\$\{l\},\$\{r\}/.test(app), "app.js stopped sending tank commands");

assert.ok(/tourOpen \|\| cursorOn\(\)/.test(app), "drive loop no longer parks for cursor mode");
for (const [name, val] of [["DEADZONE", DEADZONE], ["MIN_PWM", MIN_PWM], ["MANUAL_PWM", MANUAL_PWM], ["SPIN_SCALE", SPIN_SCALE]]) {
  const m = app.match(new RegExp(`${name} = ([0-9.]+)`));
  assert.ok(m, `${name} gone from app.js`);
  assert.equal(+m[1], val, `${name} drifted from app.js — this test's copy of the mix is stale`);
}

// the R2 boost chips: a cap over 255 clips silently in the L298N, one under
// MANUAL_PWM makes the boost slower than no boost
const boosts = app.match(/const BOOSTS = \[(.+)\];/);
assert.ok(boosts, "BOOSTS gone from app.js");
for (const [, v] of boosts[1].matchAll(/,\s*(\d+)\]/g)) {
  assert.ok(+v >= MANUAL_PWM && +v <= 255, `boost chip ${v} outside ${MANUAL_PWM}..255`);
}
assert.ok(/turbo \? boostRef\.current/.test(app), "R2 boost no longer reads the operator's setting");

console.log("padnav + arcade mix ok");
