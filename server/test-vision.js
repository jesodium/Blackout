// jpeg carving out of a multipart body

const assert = require("assert");
const { carveJpeg, upright } = require("./vision");
const { parseSage } = require("./sage");
const sharp = require("sharp");

const J = (n) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(n, 0x41), Buffer.from([0xff, 0xd9])]);

assert.deepStrictEqual(carveJpeg(J(4)), J(4));

const withHdr = Buffer.concat([Buffer.from("--frame\r\nContent-Type: image/jpeg\r\n\r\n"), J(3)]);
assert.deepStrictEqual(carveJpeg(withHdr), J(3));

const twoFrames = Buffer.concat([J(2), Buffer.from("--frame\r\n"), J(9)]);
assert.deepStrictEqual(carveJpeg(twoFrames), J(2));

assert.strictEqual(carveJpeg(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(5, 0x41)])), null);

assert.strictEqual(carveJpeg(Buffer.from("garbage")), null);

console.log("ok — carveJpeg passes");

(async () => {
  const landscape = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#444" } })
    .jpeg().toBuffer();
  const turned = await sharp(await upright(landscape)).metadata();
  assert.strictEqual(turned.width, 600);
  assert.strictEqual(turned.height, 800);

  const junk = Buffer.from([0xff, 0xd8, 0x41, 0xff, 0xd9]);
  assert.deepStrictEqual(await upright(junk), junk);

  console.log("ok — upright passes");
})();

assert.deepStrictEqual(
  parseSage('{"text":"air is thick","status":"danger","action":null}'),
  { text: "air is thick", status: "danger", action: null, led: null, finding: null });

assert.deepStrictEqual(
  parseSage('Sure!\n```json\n{"text":"clear ahead","status":"clear","action":"analyze"}\n```'),
  { text: "clear ahead", status: "clear", action: "analyze", led: null, finding: null });

assert.deepStrictEqual(
  parseSage("just talking, no json here"),
  { text: "just talking, no json here", status: null, action: null, led: null, finding: null });

assert.deepStrictEqual(
  parseSage('{"text":"hmm","status":"spicy","action":"launch_missiles"}'),
  { text: "hmm", status: null, action: null, led: null, finding: null });

assert.strictEqual(parseSage('{"text":"lighting up","led":200}').led, 200);
assert.strictEqual(parseSage('{"text":"lighting up","led":"200"}').led, 200);
assert.strictEqual(parseSage('{"text":"off","led":0}').led, 0);

assert.strictEqual(parseSage('{"text":"blast it","led":999}').led, 255);
assert.strictEqual(parseSage('{"text":"neg","led":-40}').led, 0);

assert.strictEqual(parseSage('{"text":"hmm","led":"bright"}').led, null);
assert.strictEqual(parseSage('{"text":"hmm","led":null}').led, null);
assert.strictEqual(parseSage('{"text":"hmm"}').led, null);

assert.strictEqual(
  parseSage('{"text":"look at that!","finding":"DRAWING DETECTED: looks like a bison"}').finding,
  "DRAWING DETECTED: looks like a bison");

assert.strictEqual(parseSage('{"text":"all quiet"}').finding, null);
assert.strictEqual(parseSage('{"text":"all quiet","finding":null}').finding, null);
assert.strictEqual(parseSage('{"text":"all quiet","finding":""}').finding, null);
assert.strictEqual(parseSage('{"text":"all quiet","finding":"   "}').finding, null);

assert.strictEqual(parseSage('{"text":"hmm","finding":{"tag":"DRAWING"}}').finding, null);
assert.strictEqual(parseSage('{"text":"hmm","finding":true}').finding, null);

assert.strictEqual(parseSage(`{"text":"hi","finding":"${"A".repeat(300)}"}`).finding.length, 140);

assert.strictEqual(parseSage('{"status":"clear"}').text, '{"status":"clear"}');

console.log("ok — parseSage passes");
