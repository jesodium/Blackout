// the camera path's only real parsing: splitting the esp32-cam's
// multipart/x-mixed-replace stream into whole jpegs. a frame handed over short or
// long is a corrupt picture, and the network hands the bytes over in arbitrary chunks.
import assert from "assert";
import { mjpegSplit, findBytes } from "./public/js/mjpeg.mjs";

const BOUND = "\r\n--123456789000000000000987654321\r\n";
const enc = new TextEncoder();
const cat = (...as) => { const n = new Uint8Array(as.reduce((s, a) => s + a.length, 0));
  let o = 0; for (const a of as) { n.set(a, o); o += a.length; } return n; };
// a frame whose payload contains the boundary text — taking parts by length must not
// care, taking them by scanning for the next boundary would split this in half.
const jpeg = (n) => cat(new Uint8Array([0xff, 0xd8]), enc.encode(BOUND.trim()), new Uint8Array(n).fill(n & 0xff));
const part = (body) => cat(enc.encode(BOUND), enc.encode(`Content-Type: image/jpeg\r\nContent-Length: ${body.length}\r\n\r\n`), body);

const a = jpeg(40), b = jpeg(17);
const wire = cat(part(a), part(b));

// whole stream at once
let out = mjpegSplit(wire);
assert.strictEqual(out.frames.length, 2);
assert.deepStrictEqual([...out.frames[0]], [...a]);
assert.deepStrictEqual([...out.frames[1]], [...b]);
assert.strictEqual(out.rest.length, 0);

// same bytes, delivered one at a time: same frames, no duplicates, no shorts
for (const chunk of [1, 3, 7, 64]) {
  let buf = new Uint8Array(0), got = [];
  for (let i = 0; i < wire.length; i += chunk) {
    buf = cat(buf, wire.subarray(i, i + chunk));
    const cut = mjpegSplit(buf);
    got.push(...cut.frames.map((f) => [...f]));
    buf = cut.rest;
  }
  assert.strictEqual(got.length, 2, `chunk ${chunk}: got ${got.length} frames`);
  assert.deepStrictEqual(got[0], [...a], `chunk ${chunk}`);
  assert.deepStrictEqual(got[1], [...b], `chunk ${chunk}`);
}

// a half-arrived frame is held, not emitted short
out = mjpegSplit(wire.subarray(0, wire.length - 5));
assert.strictEqual(out.frames.length, 1);
assert.ok(out.rest.length > 0);

assert.strictEqual(findBytes(new Uint8Array([1, 2, 3, 4]), [3, 4]), 2);
assert.strictEqual(findBytes(new Uint8Array([1, 2]), [3]), -1);

console.log("test-mjpeg: ok");
