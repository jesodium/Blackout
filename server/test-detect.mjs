// the model and its weights are vendored, and the rotate/unrotate box mapping is a
// sign error waiting to happen, so it is checked off-browser

import { readFileSync, existsSync, statSync } from "node:fs";
import assert from "node:assert/strict";
import { drawBoxes, rotBox, MODEL_URL } from "./public/js/detect.mjs";

const P = "public";
const model = MODEL_URL.replace(/^\//, P + "/");
assert.ok(existsSync(model), "missing " + model);
const man = JSON.parse(readFileSync(model, "utf8")).weightsManifest;
const dir = model.replace(/\/[^/]+$/, "");
for (const path of man.flatMap(g => g.paths)) {
  const f = `${dir}/${path}`;
  assert.ok(existsSync(f) && statSync(f).size > 0, "missing weight shard " + f);
}
for (const v of ["tf.min.js", "coco-ssd.min.js"])
  assert.ok(existsSync(`${P}/vendor/${v}`), "missing vendor/" + v);

const app = readFileSync(`${P}/js/app.js`, "utf8");
assert.match(app, /cam-feed cam-boxes/, "overlay canvas lost its classes");
assert.match(readFileSync(`${P}/css/style.css`, "utf8"), /\.cam-boxes\s*{/, "no .cam-boxes rule");
const i18n = readFileSync(`${P}/js/i18n.js`, "utf8");
for (const k of ["cam.detect", "cam.detect.loading", "cam.detect.failed"])
  assert.equal((i18n.match(new RegExp(`"${k.replace(/\./g, "\\.")}":`, "g")) || []).length, 2, `${k} not in both languages`);

{
  const W = 800;

  assert.deepEqual(rotBox([0, 0, 60, 40], W), [W - 40, 0, 40, 60]);

  assert.deepEqual(rotBox([0, 0, 600, 800], W), [0, 0, 800, 600]);

  const [x, y, bw, bh] = rotBox([120, 300, 90, 150], W);
  assert.ok(x >= 0 && y >= 0 && x + bw <= W && y + bh <= 600, "box left the frame");
}

const calls = [];
const ctx = new Proxy({}, {
  get: (_, k) => (k === "measureText" ? (s) => ({ width: s.length * 8 })
    : (...a) => calls.push([k, ...a])),
  set: (o, k, v) => (calls.push(["=" + k, v]), true),
});
drawBoxes(ctx, [{ bbox: [10, 40, 100, 80], class: "person", score: 0.912 }], 800, 600);
assert.ok(calls.some(c => c[0] === "clearRect"), "canvas not cleared");
assert.ok(calls.some(c => c[0] === "strokeRect" && c.slice(1).join() === "10,40,100,80"), "box not in frame coords");
assert.ok(calls.some(c => c[0] === "fillText" && /person 91%/.test(c[1])), "label missing rounded score");

assert.ok(calls.some(c => c[0] === "rotate" && Math.abs(c[1] - Math.PI / 2) < 1e-9),
  "label not counter-rotated against the css transform");

const at = calls.find(c => c[0] === "translate");
assert.ok(at && at[1] >= 110, `label anchored at ${at?.[1]}, want >= 110 (above the box)`);

calls.length = 0;
drawBoxes(ctx, [{ bbox: [-30, -20, 60, 50], class: "tv", score: 0.5 }], 800, 600);
const [, tx, ty] = calls.find(c => c[0] === "translate");
assert.ok(tx >= 0 && ty >= 0, `label anchor ${tx},${ty} escaped the frame`);

console.log("detect ok — model, vendor, wiring, rotBox, drawBoxes");
