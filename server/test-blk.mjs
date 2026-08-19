// self-check for the blk parser + interpreter: node test-blk.mjs
import assert from "node:assert";
import fs from "node:fs";
import { parse, serialize, evalCond, evalExpr, parseExpr, parseCond, condStr, exprStr, interp, lint, estimate, run,
         compile, insLine, BOPS, BLK_MAX, SENSORS, CMPS, VERBS, clampArg, Unsupported } from "./public/js/blk.mjs";

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

/* ───────── on-board compiler + vm ─────────
   compile() hands the giga a flat instruction list it plays by itself. simVm below
   mirrors blkEnter()/tickBlk() in giga-r1/main/main.ino instruction for instruction —
   if the two ever drift, an "until" that walks past its jump target is a rover that
   doesn't stop, so the semantics are checked here rather than on the field.
   time is faked as 100ms ticks (the board's sensor cadence). */
function simVm(text, { sensors = {}, ai = {}, maxTicks = 4000 } = {}) {
  const { program, errors } = parse(text);
  assert.deepEqual(errors, [], "simVm source should parse: " + errors[0]);
  const { code, nodes, slots } = compile(program);
  const log = [], vars = new Array(8).fill(0);
  let pc = 0, pwm = 140, ticks = 0, guard = 0; // guard: blkenter() yields after 64 straight instructions
  const pkt = () => (typeof sensors === "function" ? sensors() : sensors);
  const read = (lhs) => lhs >= 100 ? vars[(lhs - 100) % 8] : lhs === 50 ? pwm : (+pkt()[SENSORS[lhs]] || 0);
  const test = (i) => {
    const l = read(i.lhs), r = i.rhs;
    return [l < r, l > r, l <= r, l >= r, l === r, l !== r][i.cmp];
  };
  // one poll of an "until" instruction = one 100ms tick, the rate distcm refreshes at
  const untilTicks = (i) => (i.c ? Math.ceil(i.c / 100) : 300);
  const ctx = (n) => ({ st: { vars: Object.fromEntries(Object.entries(slots).map(([k, v]) => [k, vars[v]])) }, sensors: pkt });
  while (pc >= 0 && pc < code.length && ticks++ < maxTicks) {
    const i = code[pc];
    switch (i.op) {
      case BOPS.end: pc = -1; break;
      case BOPS.stop: log.push("halt"); pc = -1; break;
      case BOPS.move: log.push(`drv,${VERBS[["forward", "back", "left", "right"][i.a]]},${pwm},${i.c}`); pc++; break;
      case BOPS.moveu: case BOPS.waitu: {
        const cap = untilTicks(i);
        for (let k = 0; k < cap && !test(i); k++) {
          if (i.op === BOPS.moveu) log.push(`drv,${VERBS[["forward", "back", "left", "right"][i.a]]},${pwm},until`);
          ticks++;
        }
        pc++;
        break;
      }
      case BOPS.wait: pc++; break;
      case BOPS.speed: pwm = i.b; pc++; break;
      case BOPS.set: vars[i.a % 8] = i.rhs; pc++; break;
      case BOPS.add: vars[i.a % 8] += i.rhs; pc++; break;
      case BOPS.jmp: pc = i.c; break;
      case BOPS.jmpf: pc = test(i) ? pc + 1 : i.c; break;
      case BOPS.evt: {
        const n = nodes[i.b], c = ctx();
        if (n.op === "led") log.push("led:" + clampArg("led", evalExpr(n.arg, c) || 0));
        else log.push(n.op + ":" + interp(n.text, c));
        // the browser answers every evt the board parks on (kind 1 and 2) with "blk,res,<v>",
        // but only ask/find asked for a value — kind 1's 0 must not land in a variable slot
        const slot = i.a === 2 ? i.c % 8 : 0xFF;
        if (i.a >= 1 && slot < 8) vars[slot] = (n.op === "ask" ? ai.ask : ai.find) ? 1 : 0;
        pc++;
        break;
      }
      default: throw new Error("simVm: unknown op " + i.op);
    }
    guard = [BOPS.move, BOPS.moveu, BOPS.wait, BOPS.waitu, BOPS.evt].includes(i.op) ? 0 : guard + 1;
    if (guard >= 64) { guard = 0; ticks++; } // yields to loop(), resumes at pc — no instruction skipped
  }
  return log;
}

// the board must do what the browser interpreter does — same source, same trace
for (const [src, opts] of [
  ["speed 90\nrepeat 2\n  forward 100\nend", {}],
  ["if dist < 20\n  back 100\nelse\n  forward 100\nend", { sensors: { dist: 5 } }],
  ["if dist < 20\n  back 100\nelse\n  forward 100\nend", { sensors: { dist: 50 } }],
  ["set n 0\nrepeat 3\n  change n 1\n  if n = 2\n    continue\n  end\n  say {n}\nend", {}],
  ["set n 0\nrepeat while n < 3\n  change n 1\nend\nsay {n}", {}],
  ["repeat 5\n  forward 100\n  break\nend", {}],
  ["def turn\n  right 400\nend\ncall turn\ncall turn", {}],
  ["forward 100\nstop\nforward 100", {}],
  ["led 999\nsay hi\n# nope\n~say skipped", {}],
  ["ask is it clear\nif answer\n  forward 100\nend", { ai: { ask: true } }],
  ["find bison\nif not found\n  say nothing\nend", { ai: { find: false } }],
  ["set n 5\nanalyze the wall\nsay {n}", {}],                    // an evt answer must not clobber slot 0
  ["set n 0\nrepeat 60\n  change n 1\nend\nsay {n}", {}],        // long enough to trip blkenter()'s guard
]) assert.deepEqual(simVm(src, opts), await exec(src, opts), "board vs browser: " + src.split("\n")[0]);

// "until" polls on board until the condition trips, then moves on
let sd = 100;
const su = simVm("forward until dist < 30\nsay clear", { sensors: () => ({ dist: (sd -= 25) }) });
assert.deepEqual(su.at(-1), "say:clear");
assert.equal(su.filter(l => l.startsWith("drv")).length, 2); // 100 -> 75 -> 50, tripped at 25
// and gives up on its timeout rather than driving forever
assert.equal(simVm("forward until dist < 1 timeout 500", { sensors: { dist: 99 } }).length, 5);
// a condition already true never moves at all
assert.deepEqual(simVm("forward until dist < 30", { sensors: { dist: 5 } }), []);

// every jump lands inside the program, for the real workflows as well as these
for (const src of ["forever\n  forward 100\n  if dist < 5\n    break\n  end\nend",
                   fs.readFileSync(new URL("./workflows/BLK Full Test.blk", import.meta.url), "utf8")]) {
  const { code } = compile(parse(src).program);
  assert.ok(code.length <= BLK_MAX);
  assert.equal(code.at(-1).op, BOPS.end);
  for (const i of code) if (i.op === BOPS.jmp || i.op === BOPS.jmpf) assert.ok(i.c >= 0 && i.c < code.length, "jump target out of range");
  for (let n = 0; n < code.length; n++) assert.ok(insLine(n, code[n]).length <= 64, "upload line must fit cmdchar");
}

// what the board can't express is refused by name, so the browser runs it instead
for (const [src, bit] of [
  ["forward n * 100", "live value"],
  ["if dist < 20 and temp > 5\nend", "and/or"],
  ["if dist < temp\nend", "two live values"],
  ["wait until time > 500\nend", "browser"],
  ["set a 1\nset b 1\nset c 1\nset d 1\nset e 1\nset f 1\nset g 1\nset h 1\nset i 1", "variables"],
  ["call nope", "not defined"],
]) assert.throws(() => compile(parse(src).program), (e) => e instanceof Unsupported && e.message.includes(bit), src);

console.log("blk ok");
