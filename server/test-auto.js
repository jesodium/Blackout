// snapshot summary, tool parse and the tool-loop bound
// (the lamp ramp and the bracket walk are gone: nothing adjusts the lamp but
//  Sage looking at the picture -- see lampLine() in server.js)

const assert = require("assert");
const { parseSage, snapSummary, wantsTool } = require("./sage");

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

// a spanish dashboard makes her translate the KEYS too — every field read null
const es = parseSage('{"texto":"Recibido","estado":"claro","herramienta":"c\u00e1mara","hallazgo":"grieta","mover":null,"brazo":null,"cinta":null}');
assert.strictEqual(es.text, "Recibido");
assert.strictEqual(es.status, "clear");
assert.strictEqual(es.tool, "camera");
assert.strictEqual(es.finding, "grieta");
assert.strictEqual(parseSage('{"texto":"hm","accion":"analizar"}').tool, "camera");
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
for (const [name, field] of [["finding", "sage.finding"], ["snapshot", "sage.snapshot"]]) {
  const line = askBody.split("\n").find((l) => l.trim().startsWith("if (") && l.includes(field));
  assert.ok(line && line.includes(`allow("${name}"`), `${name} fires without the confirm gate`);
}
assert.ok(/askSage\(msgs, \{ maxTokens, confirm, lamp \}\)/.test(src), "agentLoop must hand askSage the confirm and lamp flags");

// She writes the headlamp only when CONSOLE -> SAGE LAMP is on or the operator
// asked for it in words — otherwise the level the crew set is theirs.
const ledLine = askBody.split("\n").find((l) => l.includes("sage.led != null"));
assert.ok(ledLine.includes("lamp &&"), "Sage's led write lost its SAGE LAMP gate");
// and the card is unconditional — BYPASS does not hand her the lamp
assert.ok(/askConfirm\("lamp", String\(sage\.led\)\)/.test(askBody), "the lamp must always ask, not via allow()");
assert.ok(!/await allow\("lamp"/.test(askBody), "the lamp is back behind the ASK-only gate");
const LAMP_ASKED = eval(src.match(/const LAMP_ASKED = (\/.*\/i);/)[1]);
for (const said of ["SAGE, turn the lamp up", "brighten it a little", "kill the light", "sube la luz"])
  assert.ok(LAMP_ASKED.test(said), `"${said}" should unlock the lamp`);
for (const said of ["how hot is it in there?", "what do you see ahead?"])
  assert.ok(!LAMP_ASKED.test(said), `"${said}" should not unlock the lamp`);

console.log("test-auto: ok");
process.exit(0);
