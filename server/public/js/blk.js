// blk (blackout language) — scratch-style step language for operator workflows.
// text IS the file format (.blk); the block editor is just another view of the
// same tree, so blocks<->text switching is lossless by construction.
//
// grammar (one op per line, "#" comments, case-insensitive except say text):
//   forward/back/left/right <ms> · speed <pwm> · wait <ms> · analyze · stop
//   say <text>
//   wait until <sensor> <cmp> <n>
//   repeat <n> ... end · repeat until <cond> ... end · forever ... end
//   if <cond> ... [else ...] end        conds read live telemetry
//
// program = nested node tree. containers carry body[] (if also elseBody[]|null).

export const DEFAULT_PWM = 140;
export const SENSORS = ["dist", "temp", "humid", "smoke", "airq", "roll", "pitch", "yaw"];
export const CMPS = ["<", ">", "<=", ">=", "=", "!="];
export const LIMITS = { ms: [50, 10000], pwm: [60, 255], count: [1, 100] };

// editor metadata: category drives block color, the rest drives inputs
export const NODE_META = {
  forward:      { cat: "motion",  arg: "ms",    label: "move forward" },
  back:         { cat: "motion",  arg: "ms",    label: "move back" },
  left:         { cat: "motion",  arg: "ms",    label: "turn left" },
  right:        { cat: "motion",  arg: "ms",    label: "turn right" },
  speed:        { cat: "motion",  arg: "pwm",   label: "set speed" },
  wait:         { cat: "control", arg: "ms",    label: "wait" },
  wait_until:   { cat: "control", cond: true,   label: "wait until" },
  repeat:       { cat: "control", arg: "count", label: "repeat", container: true },
  repeat_until: { cat: "control", cond: true,   label: "repeat until", container: true },
  forever:      { cat: "control",               label: "forever", container: true },
  if:           { cat: "control", cond: true,   label: "if", container: true },
  stop:         { cat: "control",               label: "stop all" },
  say:          { cat: "looks",   text: true,   label: "say" },
  analyze:      { cat: "ai",                    label: "AI analyze" },
};

export function clampArg(kind, v) {
  const [lo, hi] = LIMITS[kind];
  return Math.min(hi, Math.max(lo, Math.round(+v) || lo));
}

export function evalCond(c, pkt) {
  const v = pkt?.[c.s];
  if (v == null || isNaN(v)) return false; // no telemetry = condition never true
  switch (c.c) {
    case "<": return v < c.v;  case ">": return v > c.v;
    case "<=": return v <= c.v; case ">=": return v >= c.v;
    case "=": return v == c.v; case "!=": return v != c.v;
  }
  return false;
}

/* text -> { program, errors } */
export function parse(text) {
  const root = [], errors = [];
  const stack = [{ node: null, list: root }];
  const top = () => stack[stack.length - 1];
  const err = (i, m) => { errors.push(`line ${i + 1}: ${m}`); };

  (text || "").split("\n").forEach((rawLine, i) => {
    const raw = rawLine.replace(/#.*/, "").trim();
    if (!raw) return;

    // say keeps original casing of its text
    if (/^say(\s|$)/i.test(raw)) {
      const msg = raw.replace(/^say\s*/i, "");
      if (!msg) return err(i, "say needs text");
      return top().list.push({ op: "say", text: msg });
    }

    // space out comparison operators so "dist<20" also parses
    const tk = raw.toLowerCase().replace(/(<=|>=|!=|=|<|>)/g, " $1 ").trim().split(/\s+/);
    const cond = (t) =>
      t.length === 3 && SENSORS.includes(t[0]) && CMPS.includes(t[1]) && !isNaN(+t[2])
        ? { s: t[0], c: t[1], v: +t[2] } : null;
    const open = (node) => { top().list.push(node); stack.push({ node, list: node.body }); };

    switch (tk[0]) {
      case "forward": case "back": case "left": case "right": case "speed": {
        if (tk.length !== 2 || isNaN(+tk[1])) return err(i, `${tk[0]} needs a number`);
        return top().list.push({ op: tk[0], arg: clampArg(tk[0] === "speed" ? "pwm" : "ms", +tk[1]) });
      }
      case "wait": {
        if (tk[1] === "until") {
          const c = cond(tk.slice(2));
          return c ? top().list.push({ op: "wait_until", cond: c })
            : err(i, "wait until needs: sensor cmp number (e.g. wait until dist < 20)");
        }
        if (tk.length !== 2 || isNaN(+tk[1])) return err(i, "wait needs a number (ms) or 'until'");
        return top().list.push({ op: "wait", arg: clampArg("ms", +tk[1]) });
      }
      case "repeat": {
        if (tk[1] === "until") {
          const c = cond(tk.slice(2));
          return c ? open({ op: "repeat_until", cond: c, body: [] })
            : err(i, "repeat until needs: sensor cmp number");
        }
        if (tk.length !== 2 || isNaN(+tk[1])) return err(i, "repeat needs a count or 'until'");
        return open({ op: "repeat", arg: clampArg("count", +tk[1]), body: [] });
      }
      case "forever": {
        if (tk.length !== 1) return err(i, "forever takes nothing");
        return open({ op: "forever", body: [] });
      }
      case "if": {
        const c = cond(tk.slice(1));
        return c ? open({ op: "if", cond: c, body: [], elseBody: null })
          : err(i, "if needs: sensor cmp number (e.g. if dist < 20)");
      }
      case "else": {
        const f = top();
        if (!f.node || f.node.op !== "if" || f.node.elseBody) return err(i, "else without if");
        f.node.elseBody = []; f.list = f.node.elseBody;
        return;
      }
      case "end": {
        if (stack.length === 1) return err(i, "end without a block to close");
        return void stack.pop();
      }
      case "analyze": case "stop": {
        if (tk.length !== 1) return err(i, `${tk[0]} takes no value`);
        return top().list.push({ op: tk[0] });
      }
      default: return err(i, `can't read "${raw}"`);
    }
  });
  if (stack.length > 1) errors.push(`${stack.length - 1} block(s) missing 'end'`);
  return { program: root, errors };
}

/* program -> text */
export const condStr = (c) => `${c.s} ${c.c} ${c.v}`;
export function serialize(program) {
  const out = [];
  const walk = (list, d) => {
    const pad = "  ".repeat(d);
    for (const n of list) {
      switch (n.op) {
        case "say":          out.push(pad + "say " + n.text); break;
        case "wait_until":   out.push(pad + "wait until " + condStr(n.cond)); break;
        case "repeat":       out.push(pad + "repeat " + n.arg); walk(n.body, d + 1); out.push(pad + "end"); break;
        case "repeat_until": out.push(pad + "repeat until " + condStr(n.cond)); walk(n.body, d + 1); out.push(pad + "end"); break;
        case "forever":      out.push(pad + "forever"); walk(n.body, d + 1); out.push(pad + "end"); break;
        case "if":
          out.push(pad + "if " + condStr(n.cond)); walk(n.body, d + 1);
          if (n.elseBody) { out.push(pad + "else"); walk(n.elseBody, d + 1); }
          out.push(pad + "end"); break;
        default: out.push(pad + n.op + (n.arg != null ? " " + n.arg : ""));
      }
    }
  };
  walk(program, 0);
  return out.join("\n");
}

/* interpreter — walks the tree live so conditions see current telemetry.
   io: { stopped(), sleep(ms), drive(verb,pwm,ms), analyze(), say(text),
         sensors() -> latest packet, halt(), onStep(node, n) }
   loops tick io.sleep(30) per pass so an empty body can't busy-spin. */
export async function run(program, io) {
  const st = { pwm: DEFAULT_PWM, n: 0 };
  await runList(program, io, st);
}
async function runList(list, io, st) {
  for (const node of list) {
    if (io.stopped()) return "stopped";
    st.n++; io.onStep?.(node, st.n);
    switch (node.op) {
      case "speed": st.pwm = node.arg; break;
      case "forward": case "back": case "left": case "right":
        await io.drive(node.op === "forward" ? "fwd" : node.op, st.pwm, node.arg); break;
      case "wait": await io.sleep(node.arg); break;
      case "wait_until":
        while (!io.stopped() && !evalCond(node.cond, io.sensors())) await io.sleep(100);
        break;
      case "analyze": await io.analyze(); break;
      case "say": io.say?.(node.text); break;
      case "stop": io.halt?.(); return "stopped";
      case "repeat":
        for (let k = 0; k < node.arg && !io.stopped(); k++) {
          if (await runList(node.body, io, st)) return "stopped";
          await io.sleep(30);
        }
        break;
      case "repeat_until":
        while (!io.stopped() && !evalCond(node.cond, io.sensors())) {
          if (await runList(node.body, io, st)) return "stopped";
          await io.sleep(30);
        }
        break;
      case "forever":
        while (!io.stopped()) {
          if (await runList(node.body, io, st)) return "stopped";
          await io.sleep(30);
        }
        break;
      case "if": {
        const branch = evalCond(node.cond, io.sensors()) ? node.body : (node.elseBody || []);
        if (await runList(branch, io, st)) return "stopped";
        break;
      }
    }
  }
}
