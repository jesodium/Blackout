// self-check for the blk parser + interpreter: node test-blk.mjs
import assert from "node:assert";
import { parse, serialize, evalCond, evalExpr, parseExpr, parseCond, condStr, exprStr, interp, lint, estimate, run } from "./public/js/blk.mjs";

/* parse + roundtrip */
const src = `# demo
speed 200
say Hello Operator!
forever
  forward 500
  if dist < 20
    back 400
    right 400
  else
    wait 100
  end
  repeat until smoke > 300
    left 400
  end
  wait until temp >= 30
end
analyze`;

const { program, errors } = parse(src);
assert.deepEqual(errors, []);
assert.equal(program.length, 5); // comment node is kept
assert.equal(program[0].op, "comment");
assert.equal(program[3].op, "forever");
assert.equal(program[3].body[1].op, "if");
assert.equal(program[3].body[1].elseBody.length, 1);
// roundtrip: serialize -> parse -> same tree
assert.deepEqual(parse(serialize(program)).program, program);
// spaceless conditions parse too
assert.deepEqual(parse("if dist<20\nend").errors, []);
assert.equal(parse("forward 99999").program[0].arg, 10000); // clamps hold

/* v2 syntax roundtrips */
const src2 = `set n 0
def sweep
  right 400
  change n 1
end
forever
  ~forward 600
  if dist < 20 and (temp > 35 or smoke > 300)
    call sweep
    analyze what is blocking the way
    ask should I keep going
    if not answer
      break
    end
  end
  find bison drawing
  led 200
  log pass {n} dist {dist}
  repeat while n < 3
    set n n + 1
  end
  forward until dist < 25 timeout 4000
  wait until temp > 20 timeout 3000
end`;
const p2 = parse(src2);
assert.deepEqual(p2.errors, []);
assert.deepEqual(parse(serialize(p2.program)).program, p2.program, "v2 roundtrip");
assert.equal(p2.program[2].body[0].off, true, "~ disables a block");
assert.equal(p2.program[1].op, "def");

/* errors */
assert.ok(parse("jump 3").errors.length === 1);
assert.ok(parse("forever\nforward 100").errors[0].includes("missing 'end'"));
assert.ok(parse("else").errors[0].includes("else without if"));
assert.ok(parse("end").errors[0].includes("end without"));
assert.ok(parse("set dist 3").errors[0].includes("reserved"));
assert.ok(parse("forward 100 200").errors[0].includes("unexpected"));
assert.ok(parse("call").errors.length === 1);
assert.ok(parse("forever\n  def x\n  end\nend").errors[0].includes("top level"));

/* expressions */
const ev = (s, vars = {}, sensors = {}) =>
  evalExpr(parseExpr(s), { st: { vars, pwm: 140, n: 0, t0: Date.now() }, sensors: () => sensors });
assert.equal(ev("2 + 3 * 4"), 14);
assert.equal(ev("(2 + 3) * 4"), 20);
assert.equal(ev("10 % 4"), 2);
assert.equal(ev("min(3, 9) + max(1, 2)"), 5);
assert.equal(ev("clamp(99, 0, 60)"), 60);
assert.equal(ev("abs(0 - 7)"), 7);
assert.equal(ev("n * 2", { n: 4 }), 8);
assert.equal(ev("dist / 2", {}, { dist: 50 }), 25);
assert.equal(ev("speed"), 140);
assert.ok(isNaN(ev("nope + 1")));
// operator precedence survives a print/parse cycle
for (const s of ["2 + 3 * 4", "(2 + 3) * 4", "1 - (2 - 3)", "min(1, 2 * 3)", "-n + 1"])
  assert.equal(exprStr(parseExpr(s)), s, "exprStr roundtrip: " + s);

/* conditions */
const ec = (s, sensors = {}, vars = {}) =>
  evalCond(parseCond(s), { st: { vars, pwm: 140, n: 0, t0: Date.now() }, sensors: () => sensors });
assert.equal(ec("dist < 20", { dist: 10 }), true);
assert.equal(ec("dist < 20", { dist: 30 }), false);
assert.equal(ec("dist < 20 and temp > 35", { dist: 10, temp: 40 }), true);
assert.equal(ec("dist < 20 and temp > 35", { dist: 10, temp: 20 }), false);
assert.equal(ec("dist < 20 or temp > 35", { dist: 99, temp: 40 }), true);
assert.equal(ec("not dist < 20", { dist: 99 }), true);
assert.equal(ec("(dist < 20 or temp > 35) and humid > 50", { dist: 10, humid: 60 }), true);
assert.equal(ec("(dist + 5) < 20", { dist: 10 }), true, "parenthesised expr on the left");
assert.equal(ec("flag", {}, { flag: 1 }), true);
assert.equal(ec("flag", {}, { flag: 0 }), false);
assert.equal(evalCond({ s: "dist", c: "<", v: 20 }, { dist: 10 }), true); // legacy shape
assert.equal(evalCond(parseCond("dist < 20"), null), false); // no telemetry = false
for (const s of ["dist < 20 and temp > 35", "(dist < 20 or temp > 35) and humid > 50", "not dist < 20", "dist + 1 < 20"])
  assert.equal(condStr(parseCond(s)), s, "condStr roundtrip: " + s);

/* interpolation, lint, estimate */
assert.equal(interp("d={dist} n={n * 2}", { st: { vars: { n: 3 } }, sensors: () => ({ dist: 12.34 }) }), "d=12.3 n=6");
assert.ok(lint(parse("call ghost").program)[0].includes("no \"def ghost\""));
assert.ok(lint(parse("if q > 1\nend").program)[0].includes("never set"));
assert.ok(lint(parse("break").program)[0].includes("outside a loop"));
assert.deepEqual(lint(parse("set q 1\nrepeat 2\n  if q > 1\n    break\n  end\nend").program), []);
assert.equal(estimate(parse("wait 1000\nwait 500").program), 1500);
assert.equal(estimate(parse("forever\nend").program), Infinity);

/* interpreter: fake io, instant sleeps */
async function exec(text, { sensors = {}, maxSteps = 200, ai = {} } = {}) {
  const log = [];
  let steps = 0;
  const { program, errors } = parse(text);
  assert.deepEqual(errors, [], "exec source should parse: " + errors[0]);
  await run(program, {
    stopped: () => ++steps > maxSteps,
    // real but tiny sleeps: wall-clock still advances, so timeouts can trip
    sleep: async (ms) => { await new Promise(r => setTimeout(r, Math.min(ms, 5))); },
    drive: async (verb, pwm, ms) => log.push(`drv,${verb},${pwm},${ms}`),
    analyze: async (p) => log.push("analyze" + (p ? ":" + p : "")),
    say: (t) => log.push("say:" + t),
    log: (t) => log.push("log:" + t),
    led: (v) => log.push("led:" + v),
    ask: async (q) => { log.push("ask:" + q); return ai.ask ?? false; },
    find: async (t) => { log.push("find:" + t); return ai.find ?? false; },
    sensors: () => (typeof sensors === "function" ? sensors() : sensors),
    halt: () => log.push("halt"),
  });
  return log;
}

// speed folds into drives; repeat expands
assert.deepEqual(await exec("speed 90\nrepeat 2\n  forward 100\nend"),
  ["drv,fwd,90,100", "drv,fwd,90,100"]);

// if/else picks branch off live sensor
assert.deepEqual(await exec("if dist < 20\n  back 100\nelse\n  forward 100\nend", { sensors: { dist: 5 } }),
  ["drv,back,140,100"]);
assert.deepEqual(await exec("if dist < 20\n  back 100\nelse\n  forward 100\nend", { sensors: { dist: 50 } }),
  ["drv,fwd,140,100"]);

// repeat until stops when the sensor crosses
let d = 100;
const log1 = await exec("repeat until dist < 20\n  forward 100\nend", { sensors: () => ({ dist: (d -= 30) }) });
assert.ok(log1.length >= 2 && log1.length <= 4);

// forever runs until externally stopped (fake stop via step budget), body kept looping
const log2 = await exec("forever\n  forward 100\nend", { maxSteps: 10 });
assert.ok(log2.length >= 4);

// stop op halts motors and ends program — trailing blocks never run
assert.deepEqual(await exec("forward 100\nstop\nforward 100"),
  ["drv,fwd,140,100", "halt"]);

// say + analyze reach io, disabled + comment lines don't
assert.deepEqual(await exec("say Hola\n# nope\n~say skipped\nanalyze the far wall"),
  ["say:Hola", "analyze:the far wall"]);

/* v2 behaviour */
// vars, math, interpolation
assert.deepEqual(await exec("set n 2\nchange n 3\nsay count {n}\nforward n * 100"),
  ["say:count 5", "drv,fwd,140,500"]);
// speed is readable as a var
assert.deepEqual(await exec("speed 200\nsay {speed}"), ["say:200"]);
// procedures
assert.deepEqual(await exec("def turn\n  right 400\nend\ncall turn\ncall turn"),
  ["drv,right,140,400", "drv,right,140,400"]);
// break / continue
assert.deepEqual(await exec("repeat 5\n  forward 100\n  break\nend"), ["drv,fwd,140,100"]);
assert.deepEqual(await exec("set n 0\nrepeat 3\n  change n 1\n  if n = 2\n    continue\n  end\n  say {n}\nend"),
  ["say:1", "say:3"]);
// repeat while
assert.deepEqual(await exec("set n 0\nrepeat while n < 3\n  change n 1\nend\nsay {n}"), ["say:3"]);
// ai ops set answer/found and can be branched on
assert.deepEqual(await exec("ask is it clear\nif answer\n  forward 100\nend", { ai: { ask: true } }),
  ["ask:is it clear", "drv,fwd,140,100"]);
assert.deepEqual(await exec("find bison\nif not found\n  say nothing\nend", { ai: { find: false } }),
  ["find:bison", "say:nothing"]);
// led + log
assert.deepEqual(await exec("led 999\nlog level {step}"), ["led:255", "log:level 2"]);
// drive-until bursts then halts
let dd = 100;
const log3 = await exec("forward until dist < 30", { sensors: () => ({ dist: (dd -= 25) }) });
assert.ok(log3.filter(l => l.startsWith("drv")).length >= 2 && log3.at(-1) === "halt");
// wait until with a timeout gives up instead of hanging
assert.deepEqual(await exec("wait until dist < 1 timeout 50\nsay done", { sensors: { dist: 99 } }), ["say:done"]);

console.log("blk ok");
