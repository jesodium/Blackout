// lamp ramp and snapshot summary

const assert = require("assert");
const { lampStep, rampTo, LAMP_MAX } = require("./vision");
const { parseSage, snapSummary, wantsTool } = require("./sage");

assert.strictEqual(lampStep(10, 15).next, 135);
assert.strictEqual(lampStep(100, 15).next, null);
assert.strictEqual(lampStep(220, 240).next, 120);

assert.strictEqual(lampStep(10, 255).next, null);
assert.strictEqual(lampStep(250, 0).next, null);

assert.deepStrictEqual(lampStep(100, 80, 64, 96), { next: null, lo: 0, hi: 255 });

const ramp = rampTo(0);
assert.strictEqual(ramp[ramp.length - 1], LAMP_MAX);
assert.ok(ramp.length > 1, "a ramp is more than one write");
assert.ok(ramp.every((v, i) => i === 0 || v > ramp[i - 1]), "ramp must only go up");
assert.deepStrictEqual(rampTo(LAMP_MAX), []);
assert.deepStrictEqual(rampTo(0, 30, 10), [10, 20, 30]);
assert.deepStrictEqual(rampTo(0, 25, 10), [10, 20, 25]);

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
const lin = walk((led) => Math.min(255, led * 0.8));
assert.ok(lin.led > 0, `settled at ${lin.led}`);
assert.strictEqual(lampStep(lin.led * 0.8, lin.led).next, null, "settled outside the band");

const cliff = walk((led) => (led < 20 ? 5 : 250));
assert.ok(cliff.steps < 20, "lamp never settled on a scene with no in-band level");

assert.strictEqual(parseSage('{"text":"hm","snapshot":"readings jumping"}').snapshot, "readings jumping");
assert.strictEqual(parseSage('{"text":"all good"}').snapshot, null);
assert.strictEqual(parseSage("not json at all").snapshot, null);

const s = snapSummary([{ timestamp: 0, temp: 20, lux: 3 }, { timestamp: 9000, temp: 24.4, lux: 9 }]);
assert.ok(s.includes("2 readings over 9.0s"), s);
assert.ok(s.includes("temp 20-24.4"), s);
assert.ok(!s.includes("dist"), s);
assert.strictEqual(snapSummary([]), "no readings");

assert.strictEqual(parseSage('{"text":"let me look","tool":"camera"}').tool, "camera");
assert.strictEqual(parseSage('{"text":"checking","tool":"SENSORS"}').tool, "sensors");
assert.strictEqual(parseSage('{"text":"hm","action":"analyze"}').tool, "camera");
assert.strictEqual(parseSage('{"text":"hm","tool":"drive"}').tool, null);
assert.strictEqual(parseSage('{"text":"hm"}').tool, null);

assert.strictEqual(parseSage('{"text":"want me to?","move":"forward 500"}').move, "forward 500");
assert.strictEqual(parseSage('{"text":"holding"}').move, null);
assert.strictEqual(parseSage('{"text":"hm","move":"   "}').move, null);
assert.strictEqual(parseSage('{"text":"hm","move":42}').move, null);
assert.ok(parseSage(JSON.stringify({ text: "x", move: "forward 500\n".repeat(60) })).move.length <= 400);

const sage = { tool: "camera" };
assert.ok(wantsTool(sage, 0, 3) && wantsTool(sage, 1, 3));
assert.ok(!wantsTool(sage, 2, 3), "loop would reach for a tool it can never use");
assert.ok(!wantsTool({ tool: null }, 0, 3));
assert.ok(!wantsTool(sage, 0, 1), "a one-pass budget is answer-only");

// ASK FIRST covers every tool she reaches for, not just the loop's two: the
// lamp, a finding and a snapshot fire as side effects inside askSage.
const src = require("fs").readFileSync(require("path").join(__dirname, "server.js"), "utf8");
const askBody = src.slice(src.indexOf("async function askSage"), src.indexOf("const MAX_TOOL_STEPS"));
for (const [name, field] of [["lamp", "sage.led"], ["finding", "sage.finding"], ["snapshot", "sage.snapshot"]]) {
  const line = askBody.split("\n").find((l) => l.trim().startsWith("if (") && l.includes(field));
  assert.ok(line && line.includes(`allow("${name}"`), `${name} fires without the confirm gate`);
}
assert.ok(/askSage\(msgs, \{ maxTokens, confirm \}\)/.test(src), "agentLoop must hand askSage the confirm flag");

console.log("test-auto: ok");
process.exit(0);
