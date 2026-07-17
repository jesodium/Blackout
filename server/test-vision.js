// run: node test-vision.js — tests mjpeg frame carver + sage json parse, no cam needed.
const assert = require("assert");
const { carveJpeg, upright } = require("./vision");
const { parseSage } = require("./sage");
const sharp = require("sharp");

const J = (n) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(n, 0x41), Buffer.from([0xff, 0xd9])]);

// clean single frame comes back byte-for-byte
assert.deepStrictEqual(carveJpeg(J(4)), J(4));

// leading multipart headers before soi are stripped
const withHdr = Buffer.concat([Buffer.from("--frame\r\nContent-Type: image/jpeg\r\n\r\n"), J(3)]);
assert.deepStrictEqual(carveJpeg(withHdr), J(3));

// stops at first eoi even if more bytes (next frame) trail
const twoFrames = Buffer.concat([J(2), Buffer.from("--frame\r\n"), J(9)]);
assert.deepStrictEqual(carveJpeg(twoFrames), J(2));

// incomplete frame (soi but no eoi yet) => null, caller keeps reading
assert.strictEqual(carveJpeg(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(5, 0x41)])), null);

// no soi at all => null
assert.strictEqual(carveJpeg(Buffer.from("garbage")), null);

console.log("ok — carveJpeg passes");

// --- upright: the 90°-mounted cam's frames come back turned ---
// cam sends landscape svga; un-rotating a 90° mount must yield portrait.
// async, so run it last and let the process end on the promise.
(async () => {
  const landscape = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#444" } })
    .jpeg().toBuffer();
  const turned = await sharp(await upright(landscape)).metadata();
  assert.strictEqual(turned.width, 600);
  assert.strictEqual(turned.height, 800);

  // a frame sharp can't decode still comes back as-is — bad rotate must not blind sage
  const junk = Buffer.from([0xff, 0xd8, 0x41, 0xff, 0xd9]);
  assert.deepStrictEqual(await upright(junk), junk);

  console.log("ok — upright passes");
})();

// --- parseSage: tolerant json parse for sage's replies ---
// clean object parses through
assert.deepStrictEqual(
  parseSage('{"text":"air is thick","status":"danger","action":null}'),
  { text: "air is thick", status: "danger", action: null, led: null, finding: null });

// json fences + surrounding prose still extract the {...}
assert.deepStrictEqual(
  parseSage('Sure!\n```json\n{"text":"clear ahead","status":"clear","action":"analyze"}\n```'),
  { text: "clear ahead", status: "clear", action: "analyze", led: null, finding: null });

// garbage / non-json falls back to voicing the raw string
assert.deepStrictEqual(
  parseSage("just talking, no json here"),
  { text: "just talking, no json here", status: null, action: null, led: null, finding: null });

// out-of-range status and action get clamped to null
assert.deepStrictEqual(
  parseSage('{"text":"hmm","status":"spicy","action":"launch_missiles"}'),
  { text: "hmm", status: null, action: null, led: null, finding: null });

// led: in-band number passes; string number is coerced (models quote things)
assert.strictEqual(parseSage('{"text":"lighting up","led":200}').led, 200);
assert.strictEqual(parseSage('{"text":"lighting up","led":"200"}').led, 200);
assert.strictEqual(parseSage('{"text":"off","led":0}').led, 0);

// led: out of range clamps into 0-255 rather than reaching the cam raw
assert.strictEqual(parseSage('{"text":"blast it","led":999}').led, 255);
assert.strictEqual(parseSage('{"text":"neg","led":-40}').led, 0);

// led: anything not a real number means "leave the lamp alone"
assert.strictEqual(parseSage('{"text":"hmm","led":"bright"}').led, null);
assert.strictEqual(parseSage('{"text":"hmm","led":null}').led, null);
assert.strictEqual(parseSage('{"text":"hmm"}').led, null);

// finding: a real discovery survives to the analysis panel verbatim
assert.strictEqual(
  parseSage('{"text":"look at that!","finding":"DRAWING DETECTED: looks like a bison"}').finding,
  "DRAWING DETECTED: looks like a bison");

// finding: absent/null/empty/blank means nothing to log — the common case
assert.strictEqual(parseSage('{"text":"all quiet"}').finding, null);
assert.strictEqual(parseSage('{"text":"all quiet","finding":null}').finding, null);
assert.strictEqual(parseSage('{"text":"all quiet","finding":""}').finding, null);
assert.strictEqual(parseSage('{"text":"all quiet","finding":"   "}').finding, null);

// finding: a non-string doesn't reach the panel as "[object object]"/"true"
assert.strictEqual(parseSage('{"text":"hmm","finding":{"tag":"DRAWING"}}').finding, null);
assert.strictEqual(parseSage('{"text":"hmm","finding":true}').finding, null);

// finding: a model that answers with a paragraph gets trimmed to a panel row
assert.strictEqual(parseSage(`{"text":"hi","finding":"${"A".repeat(300)}"}`).finding.length, 140);

// empty/missing text falls back to the raw payload so something always speaks
assert.strictEqual(parseSage('{"status":"clear"}').text, '{"status":"clear"}');

console.log("ok — parseSage passes");
