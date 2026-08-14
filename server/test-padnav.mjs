// gamepad ui roaming + the arcade mix. both are pure maths, so neither needs a
// browser or a board — this is the check that a direction lands where the operator
// looked, and that a stick position turns into the pwm pair the firmware expects.
//   node test-padnav.mjs
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { pickNext, stepCursor } from "./public/js/padnav.mjs";

const box = (x, y, w = 40, h = 20) => ({ x, y, width: w, height: h });

/*  a grid, index by index:      0  1  2
                                 3  4  5   */
const grid = [box(0, 0), box(100, 0), box(200, 0), box(0, 100), box(100, 100), box(200, 100)];
assert.equal(pickNext(grid, 4, "up"), 1, "up from centre");
assert.equal(pickNext(grid, 4, "down"), -1, "nothing below the bottom row");
assert.equal(pickNext(grid, 4, "left"), 3);
assert.equal(pickNext(grid, 4, "right"), 5);
assert.equal(pickNext(grid, 0, "left"), -1, "nothing left of the left edge");

// nothing focused yet (or focus is on something off the list): first press takes the first element
assert.equal(pickNext(grid, -1, "down"), 0, "cold start doesn't land nowhere");
assert.equal(pickNext([], -1, "down"), -1, "empty page");

// straight ahead beats near-but-sideways: a slightly closer element off to one side
// must not steal a downward move. this is the 2:1 weighting.
const skew = [box(0, 0), box(0, 60), box(70, 30)];
assert.equal(pickNext(skew, 0, "down"), 1, "sideways neighbour stole a down move");

// a big element (the cam tile) is picked by its centre, not its near edge
const tall = [box(0, 0), box(0, 40, 40, 400)];
assert.equal(pickNext(tall, 0, "down"), 1);

// cursor mode: it stays inside the viewport, and a push past the top/bottom edge
// becomes a scroll instead of a dead stop against it.
assert.deepEqual(stepCursor(100, 100, 20, -30, 800, 600), { x: 120, y: 70, scroll: 0 });
assert.deepEqual(stepCursor(0, 10, -50, -40, 800, 600), { x: 0, y: 0, scroll: -30 }, "top edge must pan up");
assert.deepEqual(stepCursor(0, 590, 0, 40, 800, 600), { x: 0, y: 600, scroll: 30 }, "bottom edge must pan down");

/* the arcade mix, mirrored from Drive's loop in app.js. duplicated on purpose: the
   loop lives inside a react component and a test can't import it — so if the constants
   below drift from app.js, the greps at the bottom fail. */
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
// pivots match left()/right() in main.ino: sides oppose, and right is the negative side first
assert.deepEqual(mix(1, 0), [-MANUAL_PWM, MANUAL_PWM], "stick right must pivot right");
assert.deepEqual(mix(-1, 0), [MANUAL_PWM, -MANUAL_PWM], "stick left must pivot left");

// the point of the whole change: throttle and steering at once = an arc, not a pivot
// and not a straight line. both sides forward, outside wheel faster.
const [al, ar] = mix(0.6, -1);
assert.ok(al > 0 && ar > 0, `arc must keep both sides forward, got ${al}/${ar}`);
assert.ok(ar > al, "turning right must leave the right side faster than the left");
assert.ok(Math.max(al, ar) <= MANUAL_PWM, "mix overshot the cap instead of scaling back");

// every commanded side clears the stall floor — a wheel told 12 just buzzes
for (const [ax, ay] of [[0.2, -0.2], [0.9, -0.16], [0, -0.155]]) {
  for (const side of mix(ax, ay)) assert.ok(side === 0 || Math.abs(side) >= MIN_PWM, `${side} under MIN_PWM`);
}
// right stick alone spins, and slower than the left stick would at the same throw
assert.ok(Math.abs(mix(0, 0, 1)[0]) < MANUAL_PWM, "right stick spin isn't slower than full");
assert.deepEqual(mix(0, 0, 1).map(Math.sign), [-1, 1], "right stick spins right");

// the firmware has to actually understand what the loop sends
const ino = readFileSync(new URL("../giga-r1/main/main.ino", import.meta.url), "utf8");
assert.ok(/verb == "tank"/.test(ino), 'main.ino has no "tank" verb — drv,tank would halt the motors');
assert.ok(/void tank\(int l, int r\)/.test(ino), "main.ino lost tank()");

const app = readFileSync(new URL("./public/js/app.js", import.meta.url), "utf8");
assert.ok(/drv,tank,\$\{l\},\$\{r\}/.test(app), "app.js stopped sending tank commands");
// aiming the cursor must never also drive: drive's loop bails while it's up
assert.ok(/tourOpen \|\| cursorOn\(\)/.test(app), "drive loop no longer parks for cursor mode");
for (const [name, val] of [["DEADZONE", DEADZONE], ["MIN_PWM", MIN_PWM], ["MANUAL_PWM", MANUAL_PWM], ["SPIN_SCALE", SPIN_SCALE]]) {
  const m = app.match(new RegExp(`${name} = ([0-9.]+)`));
  assert.ok(m, `${name} gone from app.js`);
  assert.equal(+m[1], val, `${name} drifted from app.js — this test's copy of the mix is stale`);
}

console.log("padnav + arcade mix ok");
