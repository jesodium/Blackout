// oled video packer: rgba frame -> 1-bit XBM the giga's u8g2 draws. no browser and
// no board needed — the packing is pure, so this is the check that the bit order
// (LSB-first) and the crop maths stay right.
//   node test-oledvid.mjs
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { packXbm, coverRect, VID_W, VID_H, VID_BYTES, VID_CHUNK, VID_MAX_FRAMES } from "./public/js/oledvid.mjs";

const fill = (v, w = VID_W, h = VID_H) => new Uint8ClampedArray(w * h * 4).fill(v);

// solid black / solid white must be flat, whatever the dither matrix says
assert.equal(packXbm(fill(0)).length, VID_BYTES);
assert.ok(packXbm(fill(0)).every((b) => b === 0), "black frame lit pixels");
assert.ok(packXbm(fill(255)).every((b) => b === 0xff), "white frame dark pixels");

// DITHER is 0 now, so a *flat* frame has nothing to break up whatever its level: it
// packs solid, and which way it falls is the threshold's call. featureless in, flat out.
assert.ok(packXbm(fill(128), VID_W, VID_H, 129).every((b) => b === 0), "flat gray not solid");
assert.ok(packXbm(fill(128), VID_W, VID_H, 127).every((b) => b === 0xff), "flat gray not solid");

// bit order: pixel (3,0) white on a black frame => byte 0, bit 3 (LSB-first, XBM)
const one = fill(0);
one[3 * 4] = one[3 * 4 + 1] = one[3 * 4 + 2] = 255;
const packed = packXbm(one);
assert.equal(packed[0], 0x08, `LSB-first packing, got 0x${packed[0].toString(16)}`);
assert.ok(packed.slice(1).every((b) => b === 0), "one white pixel lit more than one bit");

// threshold is the per-clip knob: raising it past a flat source blanks it
assert.ok(packXbm(fill(120), VID_W, VID_H, 255).every((b) => b === 0), "threshold 255 still lit");
assert.ok(packXbm(fill(120), VID_W, VID_H, 0).every((b) => b === 0xff), "threshold 0 still dark");

// auto-level: a dark, low-contrast frame (a 60..90 luma ramp) must come out as real
// black *and* white, not one flat block — that's the whole point of the stretch.
const dark = fill(0);
for (let p = 0; p < VID_W * VID_H; p++) {
  const v = 60 + Math.round((p % VID_W) * (30 / VID_W));
  dark[p * 4] = dark[p * 4 + 1] = dark[p * 4 + 2] = v;
}
const levelled = packXbm(dark);
assert.ok(levelled.some((b) => b === 0) && levelled.some((b) => b === 0xff),
  "dark ramp didn't auto-level to both black and white");

// contrast: with DITHER 0 a ramp is a hard black/white split — *every* byte solid, no
// mixed band at all. guards against a wide dither spread coming back and greying it out.
const ramp = fill(0);
for (let p = 0; p < VID_W * VID_H; p++) {
  const v = Math.round((p % VID_W) * (255 / VID_W));
  ramp[p * 4] = ramp[p * 4 + 1] = ramp[p * 4 + 2] = v;
}
const solid = packXbm(ramp).filter((b) => b === 0 || b === 0xff).length;
assert.equal(solid, VID_BYTES, `only ${solid}/${VID_BYTES} bytes solid — dither too wide`);

// crop: landscape source keeps full height, portrait keeps full width, both centered
const land = coverRect(1920, 1080);
assert.equal(land.sh, 1080);
assert.equal(Math.round(land.sw), 540); // 1080 * (64/128)
assert.equal(Math.round(land.sx), 690);
const port = coverRect(720, 1280); // 9:16 is still wider than the panel's 1:2 — sides crop
assert.equal(port.sw, 640);
assert.equal(port.sh, 1280);
assert.equal(port.sx, 40);
assert.equal(coverRect(640, 1280).sy, 0); // exact panel aspect = no crop at all

/* the upload constants live in two files that can't import each other. this is the only
   thing standing between "someone bumped VID_CHUNK in the firmware" and a clip that
   uploads as garbage, so check them against the sketch text directly. */
const ino = readFileSync(new URL("../giga-r1/main/main.ino", import.meta.url), "utf8");
const def = (name) => {
  const m = ino.match(new RegExp(`^#define ${name} (\\d+)`, "m"));
  assert.ok(m, `${name} not #defined in main.ino`);
  return +m[1];
};
assert.equal(def("VID_W"), VID_W, "VID_W drifted from the firmware");
assert.equal(def("VID_H"), VID_H, "VID_H drifted from the firmware");
assert.equal(def("VID_CHUNK"), VID_CHUNK, "VID_CHUNK drifted from the firmware");
assert.equal(def("VID_MAX_FRAMES"), VID_MAX_FRAMES, "VID_MAX_FRAMES drifted from the firmware");
// a chunk over the board's ~240-byte att mtu turns every write into a multi-round-trip
// long write — that regression is invisible except as "the upload got slow again".
assert.ok(VID_CHUNK <= 237, `VID_CHUNK ${VID_CHUNK} exceeds att mtu - 3, writes will split`);

console.log("oled video packer ok");
