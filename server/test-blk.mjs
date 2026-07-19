// self-check for the blk parser + interpreter: node test-blk.mjs
import assert from "node:assert";
import { parse, serialize, evalCond, run } from "./public/js/blk.js";

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
assert.equal(program.length, 4);
assert.equal(program[2].op, "forever");
assert.equal(program[2].body[1].op, "if");
assert.equal(program[2].body[1].elseBody.length, 1);
// roundtrip: serialize -> parse -> same tree
assert.deepEqual(parse(serialize(program)).program, program);
// spaceless conditions parse too
assert.deepEqual(parse("if dist<20\nend").errors, []);

/* errors */
assert.ok(parse("jump 3").errors.length === 1);
assert.ok(parse("forever\nforward 100").errors[0].includes("missing 'end'"));
assert.ok(parse("else").errors[0].includes("else without if"));
assert.ok(parse("end").errors[0].includes("end without"));
assert.ok(parse("if banana < 3\nend").errors.length >= 1); // bad cond + its orphaned end
assert.equal(parse("forward 99999").program[0].arg, 10000); // clamps hold

/* evalCond */
assert.equal(evalCond({ s: "dist", c: "<", v: 20 }, { dist: 10 }), true);
assert.equal(evalCond({ s: "dist", c: "<", v: 20 }, { dist: 30 }), false);
assert.equal(evalCond({ s: "dist", c: "<", v: 20 }, null), false); // no telemetry = false

/* interpreter: fake io, instant sleeps */
async function exec(text, { sensors = {}, maxSteps = 200 } = {}) {
  const log = [];
  let steps = 0, stop = false;
  await run(parse(text).program, {
    stopped: () => stop || ++steps > maxSteps,
    sleep: async () => {},
    drive: async (verb, pwm, ms) => log.push(`drv,${verb},${pwm},${ms}`),
    analyze: async () => log.push("analyze"),
    say: (t) => log.push("say:" + t),
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

// say + analyze reach io
assert.deepEqual(await exec("say Hola\nanalyze"), ["say:Hola", "analyze"]);

console.log("blk ok");
