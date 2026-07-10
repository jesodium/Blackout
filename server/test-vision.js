// Run: node test-vision.js  — checks the MJPEG frame carver + Sage JSON parse, no cam needed.
const assert = require("assert");
const { carveJpeg } = require("./vision");
const { parseSage } = require("./sage");

const J = (n) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(n, 0x41), Buffer.from([0xff, 0xd9])]);

// clean single frame comes back byte-for-byte
assert.deepStrictEqual(carveJpeg(J(4)), J(4));

// leading multipart headers/boundary before SOI are stripped
const withHdr = Buffer.concat([Buffer.from("--frame\r\nContent-Type: image/jpeg\r\n\r\n"), J(3)]);
assert.deepStrictEqual(carveJpeg(withHdr), J(3));

// stops at the FIRST EOI even if more bytes (next frame) trail
const twoFrames = Buffer.concat([J(2), Buffer.from("--frame\r\n"), J(9)]);
assert.deepStrictEqual(carveJpeg(twoFrames), J(2));

// incomplete frame (SOI but no EOI yet) => null, caller keeps reading
assert.strictEqual(carveJpeg(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(5, 0x41)])), null);

// no SOI at all => null
assert.strictEqual(carveJpeg(Buffer.from("garbage")), null);

console.log("ok — carveJpeg passes");

// --- parseSage: tolerant JSON parse for Sage's replies ---
// clean object parses through
assert.deepStrictEqual(
  parseSage('{"text":"air is thick","status":"danger","action":null}'),
  { text: "air is thick", status: "danger", action: null });

// ```json fences + surrounding prose still extract the {...}
assert.deepStrictEqual(
  parseSage('Sure!\n```json\n{"text":"clear ahead","status":"clear","action":"sweep"}\n```'),
  { text: "clear ahead", status: "clear", action: "sweep" });

// garbage / non-JSON falls back to voicing the raw string
assert.deepStrictEqual(
  parseSage("just talking, no json here"),
  { text: "just talking, no json here", status: null, action: null });

// out-of-range status and action get clamped to null
assert.deepStrictEqual(
  parseSage('{"text":"hmm","status":"spicy","action":"launch_missiles"}'),
  { text: "hmm", status: null, action: null });

// empty/missing text falls back to the raw payload so something always speaks
assert.strictEqual(parseSage('{"status":"clear"}').text, '{"status":"clear"}');

console.log("ok — parseSage passes");
