// demo mode: the fill only ever covers a sensor that isn't reading, never the sonar,
// and it stays inside the ranges the tiles colour on. Pulled out of app.js so a change
// to it has to keep passing.

import { readFileSync } from "node:fs";
import assert from "node:assert";

const app = readFileSync(new URL("public/js/app.js", import.meta.url), "utf8");
const src = app.slice(app.indexOf("const SENSORS = ["), app.indexOf("const PKT_STALE_MS"));
const { SENSORS, DEMO_RANGE, demoVal, demoFill } =
  new Function(src + "return { SENSORS, DEMO_RANGE, demoVal, demoFill };")();

// the sonar is what the rover steers on — a faked wall is worse than a blank tile
assert.ok(!("dist" in DEMO_RANGE), "demo mode is faking distance");
for (const k of Object.keys(DEMO_RANGE))
  assert.ok(SENSORS.some(s => s.key === k), `demo range for unknown sensor ${k}`);

// every key wanders inside its own range, and two keys never wander in lockstep
for (const k of Object.keys(DEMO_RANGE)) {
  const [lo, hi] = DEMO_RANGE[k];
  const vals = Array.from({ length: 400 }, (_, i) => demoVal(k, i * 500));
  assert.ok(vals.every(v => v >= lo && v <= hi), `${k} left its range`);
  assert.ok(Math.max(...vals) - Math.min(...vals) > (hi - lo) * 0.9, `${k} barely moves`);
}
assert.notStrictEqual(demoVal("temp", 0), demoVal("humid", 0) - (60 - 28), "keys wander in lockstep");

// a live reading is never overwritten, a dead one always is, and 0 stands for the
// sensors that can really read it
const filled = demoFill({ temp: 41.5, humid: 0, alt: 0, pressure: 0, lux: 0, dist: 0 }, 1234);
assert.strictEqual(filled.temp, 41.5, "demo mode overwrote a live reading");
assert.strictEqual(filled.dist, 0, "demo mode touched distance");
assert.strictEqual(filled.alt, 0, "alt reads 0 for real — demo mode should leave it");
assert.strictEqual(filled.lux, 0, "lux 0 is a dark room — demo mode should leave it");
assert.ok(filled.humid >= 60 && filled.humid <= 70, "dead humidity not filled");
assert.ok(filled.pressure > 999, "dead pressure not filled");

// a stale/absent packet is the whole point: everything but distance comes back
const blank = demoFill({}, 1234);
assert.strictEqual(blank.dist, undefined, "distance faked on a dead link");
for (const k of Object.keys(DEMO_RANGE))
  assert.ok(blank[k] >= DEMO_RANGE[k][0] && blank[k] <= DEMO_RANGE[k][1], `${k} missing on a dead link`);

// the console toggle and its label have to exist, or the mode can't be turned off mid-run
assert.ok(/drawer-demo/.test(app), "no DEMO DATA button in the console drawer");
assert.ok(/localStorage\.setItem\("demoMode"/.test(app), "demo mode isn't kept per rig");
const i18n = readFileSync(new URL("public/js/i18n.js", import.meta.url), "utf8");
for (const k of ["drawer.demo", "drawer.demoTitle"])
  assert.strictEqual((i18n.match(new RegExp(`"${k}":`, "g")) || []).length, 2, `${k} missing a language`);

console.log("demo mode ok");
