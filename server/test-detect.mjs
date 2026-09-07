// the model and its weights are vendored, and the rotate/unrotate box mapping is a
// sign error waiting to happen, so it is checked off-browser

import { readFileSync, existsSync, statSync } from "node:fs";
import assert from "node:assert/strict";
import { drawBoxes, rotBox, ROTS, norm, MODEL_URL } from "./public/js/detect.mjs";

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
const camKey = (base, cam) => base + (cam || "");
assert.match(app, /const camKey = \(base, cam\) => base \+ \(cam \|\| ""\);/, "camKey drifted from its mirror here");
assert.match(app, /cam-feed cam-boxes/, "overlay canvas lost its classes");
assert.match(readFileSync(`${P}/css/style.css`, "utf8"), /\.cam-boxes\s*{/, "no .cam-boxes rule");
// the rotate button is only correct if all three copies of the angle move together
assert.match(readFileSync(`${P}/css/style.css`, "utf8"), /rotate\(var\(--cam-rot/, "cam-feed rotation is not driven by --cam-rot");
assert.match(app, /detectUpright\(model, img, 20, DET_MIN_SCORE, rot\)/, "detector not given the mount angle");
assert.match(app, /drawBoxes\(cv\.getContext\("2d"\), boxes, cv\.width, cv\.height, rot\)/, "drawBoxes not given the mount angle");
assert.match(app, /"\/api\/cam-rot"/, "rotation never reaches the server, so Sage keeps the old angle");
assert.match(readFileSync("vision.js", "utf8"), /setCamRot/, "vision.js has no runtime rotation setter");

// two cams, and Sage can ask for either -- so both angles go to the server, each
// tagged with its cam. An untagged post is how her stills quietly go sideways again.
assert.match(app, /fetch\("\/api\/cam-rot", \{[\s\S]*?JSON\.stringify\(\{ value: v, cam \}\)/,
  "ROTATE posts no cam index, so one cam's angle would be applied to the other");
assert.match(readFileSync("vision.js", "utf8"), /setCamRot = \(deg, cam = 0\)/,
  "vision.js keeps one rotation for both cams");
// cam 0 keeps the unsuffixed keys, or every rig loses its saved host and angle
assert.equal(camKey("camHost", 0), "camHost", "cam 0 must keep the old localStorage key");
assert.equal(camKey("camRot", 1), "camRot1", "cam 1 needs its own angle, its mount differs");
assert.match(app, /const canDetect = detect && !pip;/, "detector must not run on the pip feed");

const i18n = readFileSync(`${P}/js/i18n.js`, "utf8");
for (const k of ["cam.detect", "cam.detect.loading", "cam.detect.failed", "cam.rotate"])
  assert.equal((i18n.match(new RegExp(`"${k.replace(/\./g, "\\.")}":`, "g")) || []).length, 2, `${k} not in both languages`);

{
  const W = 800, H = 600;

  // 270 is the sideways mount this rover shipped with -- the pre-rotation numbers
  assert.deepEqual(rotBox([0, 0, 60, 40], W, H, 270), [W - 40, 0, 40, 60]);
  assert.deepEqual(rotBox([0, 0, 600, 800], W, H, 270), [0, 0, 800, 600]);

  const [x, y, bw, bh] = rotBox([120, 300, 90, 150], W, H, 270);
  assert.ok(x >= 0 && y >= 0 && x + bw <= W && y + bh <= H, "box left the frame");

  assert.deepEqual(rotBox([10, 20, 30, 40], W, H, 0), [10, 20, 30, 40], "0deg must be identity");

  // rotBox is the inverse of the transform detectUpright draws through, so composing
  // it with that forward map has to come back to the same box for every angle. A sign
  // error in one case is the whole bug this file exists for.
  const fwd = ([x, y, bw, bh], W, H, r) => ({
    0:   [x, y, bw, bh],
    90:  [H - y - bh, x, bh, bw],
    180: [W - x - bw, H - y - bh, bw, bh],
    270: [y, W - x - bw, bh, bw],
  }[r]);
  for (const r of ROTS) {
    const raw = [120, 300, 90, 150];
    const [uw, uh] = r % 180 ? [H, W] : [W, H];
    const up = fwd(raw, W, H, r);
    assert.ok(up[0] >= 0 && up[1] >= 0 && up[0] + up[2] <= uw && up[1] + up[3] <= uh,
      `${r}deg: upright box left the rotated frame`);
    assert.deepEqual(rotBox(up, W, H, r), raw, `${r}deg: rotBox is not the inverse`);
  }

  assert.equal(norm(-90), 270);
  assert.equal(norm(360), 0);
}

const calls = [];
const ctx = new Proxy({}, {
  get: (_, k) => (k === "measureText" ? (s) => ({ width: s.length * 8 })
    : (...a) => calls.push([k, ...a])),
  set: (o, k, v) => (calls.push(["=" + k, v]), true),
});
drawBoxes(ctx, [{ bbox: [10, 40, 100, 80], class: "person", score: 0.912 }], 800, 600, 270);
assert.ok(calls.some(c => c[0] === "clearRect"), "canvas not cleared");
assert.ok(calls.some(c => c[0] === "strokeRect" && c.slice(1).join() === "10,40,100,80"), "box not in frame coords");
assert.ok(calls.some(c => c[0] === "fillText" && /person 91%/.test(c[1])), "label missing rounded score");

// the label has to cancel whatever the css did, at every angle -- otherwise it comes
// out beside the box reading bottom-to-top, which is the bug the counter-rotation fixes
for (const r of ROTS) {
  calls.length = 0;
  drawBoxes(ctx, [{ bbox: [10, 40, 100, 80], class: "tv", score: 0.5 }], 800, 600, r);
  const rot = calls.filter(c => c[0] === "rotate").map(c => c[1]);
  assert.ok(rot.some(a => Math.abs(a + r * Math.PI / 180) < 1e-9),
    `${r}deg: label not counter-rotated against the css transform`);
  const at = calls.find(c => c[0] === "translate");
  assert.deepEqual(at.slice(1), [60, 80], `${r}deg: label not anchored on the box centre`);
}

// coco hands back boxes that overhang the edge; the anchor must stay in the frame
calls.length = 0;
drawBoxes(ctx, [{ bbox: [-300, -200, 60, 50], class: "tv", score: 0.5 }], 800, 600, 270);
const [, tx, ty] = calls.find(c => c[0] === "translate");
assert.ok(tx >= 0 && ty >= 0, `label anchor ${tx},${ty} escaped the frame`);

console.log("detect ok — model, vendor, wiring, rotBox at " + ROTS.join("/") + ", drawBoxes");
