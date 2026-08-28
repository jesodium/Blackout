// checks the two autonomy bits that have branches: the headlamp's step decision
// and the 10s snapshot summary. no camera, no server, no llm.
const assert = require("assert");
const { lampStep, rampTo, LAMP_MAX } = require("./vision");
const { parseSage, snapSummary, wantsTool } = require("./sage");

// too dark -> halve upward, blown out -> halve down, in band -> leave it alone
assert.strictEqual(lampStep(10, 15).next, 135);
assert.strictEqual(lampStep(100, 15).next, null);
assert.strictEqual(lampStep(220, 240).next, 120);
// at the rail with nowhere to go: null, not a pointless re-write of the same level
assert.strictEqual(lampStep(10, 255).next, null);
assert.strictEqual(lampStep(250, 0).next, null);
// in band forgets the bracket, so the next scene starts a fresh walk
assert.deepStrictEqual(lampStep(100, 80, 64, 96), { next: null, lo: 0, hi: 255 });

// the announced ramp: every step lands, it ends exactly on the target, and it
// never walks backwards (that would dim a lamp sage just said she was raising).
const ramp = rampTo(0);
assert.strictEqual(ramp[ramp.length - 1], LAMP_MAX);
assert.ok(ramp.length > 1, "a ramp is more than one write");
assert.ok(ramp.every((v, i) => i === 0 || v > ramp[i - 1]), "ramp must only go up");
assert.deepStrictEqual(rampTo(LAMP_MAX), []);
assert.deepStrictEqual(rampTo(0, 30, 10), [10, 20, 30]);
assert.deepStrictEqual(rampTo(0, 25, 10), [10, 20, 25]); // ends on the target, not past it

// it must converge, not hunt. `walk` runs the loop the way autoLamp does, against
// whatever lamp->frame response is handed in, and returns the level it settles on.
function walk(frameFor, led = 0) {
  let lo = 0, hi = 255;
  for (let i = 0; i < 20; i++) {
    const r = lampStep(frameFor(led), led, lo, hi);
    lo = r.lo; hi = r.hi;
    if (r.next == null) return { led, steps: i };
    led = r.next;
  }
  throw new Error(`lamp hunted, still moving at ${led}`);
}
const lin = walk((led) => Math.min(255, led * 0.8)); // roughly linear lamp
assert.ok(lin.led > 0, `settled at ${lin.led}`);
assert.strictEqual(lampStep(lin.led * 0.8, lin.led).next, null, "settled outside the band");
// the flap that started this: a close wall, black with the lamp off and blown out
// the moment it is on. no level reads in band, so the only right answer is to stop.
const cliff = walk((led) => (led < 20 ? 5 : 250));
assert.ok(cliff.steps < 20, "lamp never settled on a scene with no in-band level");

// sage's snapshot request survives the json parse; everything else stays null
assert.strictEqual(parseSage('{"text":"hm","snapshot":"readings jumping"}').snapshot, "readings jumping");
assert.strictEqual(parseSage('{"text":"all good"}').snapshot, null);
assert.strictEqual(parseSage("not json at all").snapshot, null);

// summary reads the window, skips fields that never arrived (no smoke sensor here)
const s = snapSummary([{ timestamp: 0, temp: 20, lux: 3 }, { timestamp: 9000, temp: 24.4, lux: 9 }]);
assert.ok(s.includes("2 readings over 9.0s"), s);
assert.ok(s.includes("temp 20-24.4"), s);
assert.ok(!s.includes("dist"), s);
assert.strictEqual(snapSummary([]), "no readings");

// tools sage reaches for on her own: the name she writes, the old action spelling
// the other prompts still use, and anything else parsed away to null.
assert.strictEqual(parseSage('{"text":"let me look","tool":"camera"}').tool, "camera");
assert.strictEqual(parseSage('{"text":"checking","tool":"SENSORS"}').tool, "sensors");
assert.strictEqual(parseSage('{"text":"hm","action":"analyze"}').tool, "camera");
assert.strictEqual(parseSage('{"text":"hm","tool":"drive"}').tool, null);
assert.strictEqual(parseSage('{"text":"hm"}').tool, null);

// a move she proposes rides in the same json. text only, capped, null when absent —
// the card is built from this string, so a number or an object must never reach it.
assert.strictEqual(parseSage('{"text":"want me to?","move":"forward 500"}').move, "forward 500");
assert.strictEqual(parseSage('{"text":"holding"}').move, null);
assert.strictEqual(parseSage('{"text":"hm","move":"   "}').move, null);
assert.strictEqual(parseSage('{"text":"hm","move":42}').move, null);
assert.ok(parseSage(JSON.stringify({ text: "x", move: "forward 500\n".repeat(60) })).move.length <= 400);

// and the loop that runs them terminates: three passes means at most two tools,
// because the last pass has to answer.
const sage = { tool: "camera" };
assert.ok(wantsTool(sage, 0, 3) && wantsTool(sage, 1, 3));
assert.ok(!wantsTool(sage, 2, 3), "loop would reach for a tool it can never use");
assert.ok(!wantsTool({ tool: null }, 0, 3));
assert.ok(!wantsTool(sage, 0, 1), "a one-pass budget is answer-only");

console.log("test-auto: ok");
process.exit(0); // vision.js holds an mdns socket open
