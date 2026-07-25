// blk (blackout language) — scratch-style step language for operator workflows.
// text IS the file format (.blk); the block editor is just another view of the
// same tree, so blocks<->text switching is lossless by construction (comments
// and disabled blocks included).
//
// grammar (one op per line, case-insensitive except say/log/ask text):
//   motion   forward|back|left|right <expr>            ms burst
//            forward|back|left|right until <cond> [timeout <ms>]
//            speed <expr>                              pwm for later moves
//   control  wait <expr> · wait until <cond> [timeout <ms>] · stop
//            repeat <expr> … end · repeat until <cond> … end
//            repeat while <cond> … end · forever … end
//            if <cond> … [else …] end · break · continue
//   data     set <var> <expr> · change <var> <expr>
//   proc     def <name> … end · call <name>
//   looks    say <text> · log <text> · led <expr>
//   ai       analyze [<what to look at>] · ask <question> · find <thing>
//   misc     # comment          (kept as a node, survives roundtrip)
//            ~<any op>          (disabled: kept, skipped at run)
//
// exprs:  numbers, sensors, vars, + - * / %, parens, min/max/abs/round/random/clamp
// conds:  <expr> <cmp> <expr>, and/or/not, parens, or a bare expr (non-zero = true)
//
// program = nested node tree. containers carry body[] (if also elseBody[]|null).

export const DEFAULT_PWM = 140;
export const SENSORS = ["dist", "temp", "humid", "smoke", "airq", "co", "pressure", "roll", "pitch", "yaw"];
// read-only values the interpreter injects alongside sensors + user vars
export const BUILTINS = ["time", "step", "speed", "answer", "found"];
export const CMPS = ["<", ">", "<=", ">=", "=", "!="];
// 1/0 answers written by `ask` and `find` — only ever worth comparing to 0 or 1
export const FLAGS = ["answer", "found"];
export const FUNCS = { random: 2, min: 2, max: 2, abs: 1, round: 1, clamp: 3 };
export const LIMITS = { ms: [50, 10000], pwm: [60, 255], count: [1, 1000], led: [0, 255] };
export const RESERVED = new Set([...SENSORS, ...BUILTINS, ...Object.keys(FUNCS), "and", "or", "not", "until", "while", "timeout", "end", "else"]);

// editor metadata: category drives block color, the rest drives inputs
export const NODE_META = {
  forward:      { cat: "motion",  arg: "ms",  label: "move forward", canUntil: true },
  back:         { cat: "motion",  arg: "ms",  label: "move back",    canUntil: true },
  left:         { cat: "motion",  arg: "ms",  label: "turn left",    canUntil: true },
  right:        { cat: "motion",  arg: "ms",  label: "turn right",   canUntil: true },
  speed:        { cat: "motion",  arg: "pwm", label: "set speed" },
  wait:         { cat: "control", arg: "ms",  label: "wait" },
  wait_until:   { cat: "control", cond: true, label: "wait until", timeout: true },
  repeat:       { cat: "control", arg: "count", label: "repeat", container: true },
  repeat_until: { cat: "control", cond: true, label: "repeat until", container: true },
  repeat_while: { cat: "control", cond: true, label: "repeat while", container: true },
  forever:      { cat: "control", label: "forever", container: true },
  if:           { cat: "control", cond: true, label: "if", container: true },
  break:        { cat: "control", label: "break loop" },
  continue:     { cat: "control", label: "next loop pass" },
  stop:         { cat: "control", label: "stop all" },
  set:          { cat: "data",    name: true, expr: true, label: "set" },
  change:       { cat: "data",    name: true, expr: true, label: "change" },
  def:          { cat: "proc",    name: true, label: "define", container: true },
  call:         { cat: "proc",    name: true, label: "run" },
  say:          { cat: "looks",   text: true, label: "say" },
  log:          { cat: "looks",   text: true, label: "log" },
  led:          { cat: "looks",   arg: "led", label: "headlamp" },
  analyze:      { cat: "ai",      text: true, optText: true, label: "AI analyze" },
  ask:          { cat: "ai",      text: true, label: "ask Sage" },
  find:         { cat: "ai",      text: true, label: "look for" },
  comment:      { cat: "comment", text: true, label: "#" },
};

export const CATS = ["motion", "control", "data", "proc", "looks", "ai", "comment"];

export function clampArg(kind, v) {
  const [lo, hi] = LIMITS[kind] || LIMITS.ms;
  return Math.min(hi, Math.max(lo, Math.round(+v) || lo));
}

/* ───────────────────────── lexer ───────────────────────── */

class BlkErr extends Error {}
const RE_TOK = /^(?:(<=|>=|!=|=|<|>|\(|\)|,|\+|-|\*|\/|%)|([A-Za-z_][A-Za-z0-9_]*)|(\d+(?:\.\d+)?))/;

// IMPORTANT NOTE: O(n²) on line length via slice — blk lines are short, fine.
function lex(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i])) { i++; continue; }
    const m = RE_TOK.exec(s.slice(i));
    if (!m) throw new BlkErr(`unexpected character "${s[i]}"`);
    out.push(m[0]);
    i += m[0].length;
  }
  return out;
}

/* ───────────────── expression + condition parser ─────────────────
   expr AST : {n} number | {v} name | {b,l,r} binary | {u,e} negate | {f,a[]} call
   cond AST : {k:"cmp",c,l,r} | {k:"and"|"or",l,r} | {k:"not",e} | {k:"truthy",e}
*/

function reader(toks) {
  let i = 0;
  return {
    peek: () => toks[i],
    next: () => toks[i++],
    at: (w) => String(toks[i]).toLowerCase() === w,
    eat(w) { if (this.at(w)) { i++; return true; } return false; },
    save: () => i,
    back: (p) => { i = p; },
    done: () => i >= toks.length,
    expect(w) { if (!this.eat(w)) throw new BlkErr(`expected "${w}"`); },
  };
}

function pExpr(r) { return pAdd(r); }
function pAdd(r) {
  let l = pMul(r);
  for (;;) {
    if (r.eat("+")) l = { b: "+", l, r: pMul(r) };
    else if (r.eat("-")) l = { b: "-", l, r: pMul(r) };
    else return l;
  }
}
function pMul(r) {
  let l = pUnary(r);
  for (;;) {
    if (r.eat("*")) l = { b: "*", l, r: pUnary(r) };
    else if (r.eat("/")) l = { b: "/", l, r: pUnary(r) };
    else if (r.eat("%")) l = { b: "%", l, r: pUnary(r) };
    else return l;
  }
}
function pUnary(r) {
  if (r.eat("-")) return { u: "-", e: pUnary(r) };
  return pAtom(r);
}
function pAtom(r) {
  const t = r.next();
  if (t === undefined) throw new BlkErr("expression ended early");
  if (t === "(") { const e = pExpr(r); r.expect(")"); return e; }
  if (/^\d/.test(t)) return { n: +t };
  const name = t.toLowerCase();
  if (FUNCS[name]) {
    r.expect("(");
    const a = [pExpr(r)];
    while (r.eat(",")) a.push(pExpr(r));
    r.expect(")");
    if (a.length !== FUNCS[name]) throw new BlkErr(`${name}() takes ${FUNCS[name]} value(s)`);
    return { f: name, a };
  }
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new BlkErr(`can't read "${t}"`);
  return { v: name };
}

function pCond(r) {
  let l = pAnd(r);
  while (r.eat("or")) l = { k: "or", l, r: pAnd(r) };
  return l;
}
function pAnd(r) {
  let l = pNot(r);
  while (r.eat("and")) l = { k: "and", l, r: pNot(r) };
  return l;
}
function pNot(r) {
  if (r.eat("not")) return { k: "not", e: pNot(r) };
  // "(" may open either a grouped condition or a parenthesised expression —
  // try the condition first and rewind if it doesn't fit.
  if (r.at("(")) {
    const p = r.save();
    try {
      r.next();
      const c = pCond(r);
      r.expect(")");
      // "(a + b) < 3" is a parenthesised *expression*, not a grouped condition —
      // an operator right after the ")" gives it away, so rewind and re-read it.
      const nxt = String(r.peek() || "").toLowerCase();
      if (c.k !== "truthy" && !CMPS.includes(nxt) && !PREC[nxt]) return c;
    } catch { /* not a condition */ }
    r.back(p);
  }
  const l = pExpr(r);
  const c = String(r.peek() || "").toLowerCase();
  if (CMPS.includes(c)) { r.next(); return { k: "cmp", c, l, r: pExpr(r) }; }
  return { k: "truthy", e: l };
}

function parseAll(toks, fn) {
  const r = reader(toks);
  const out = fn(r);
  if (!r.done()) throw new BlkErr(`unexpected "${r.peek()}"`);
  return out;
}
export const parseExpr = (s) => parseAll(lex(s), pExpr);
export const parseCond = (s) => parseAll(lex(s), pCond);

/* ───────────────────────── writers ───────────────────────── */

const PREC = { "+": 1, "-": 1, "*": 2, "/": 2, "%": 2 };
export function exprStr(e, outer = 0) {
  if (e == null) return "";
  if (typeof e === "number") return String(e);
  if (e.n != null) return String(e.n);
  if (e.v) return e.v;
  if (e.u) return "-" + exprStr(e.e, 3);
  if (e.f) return `${e.f}(${e.a.map(x => exprStr(x)).join(", ")})`;
  const p = PREC[e.b];
  const s = `${exprStr(e.l, p)} ${e.b} ${exprStr(e.r, p + 1)}`;
  return p < outer ? `(${s})` : s;
}
export function condStr(c, outer = 0) {
  if (!c) return "";
  if (c.s && c.c) return `${c.s} ${c.c} ${c.v}`; // legacy {s,c,v}
  switch (c.k) {
    case "cmp": return wrap(`${exprStr(c.l)} ${c.c} ${exprStr(c.r)}`, 2, outer);
    case "and": return wrap(`${condStr(c.l, 1)} and ${condStr(c.r, 2)}`, 1, outer);
    case "or": return wrap(`${condStr(c.l, 0)} or ${condStr(c.r, 1)}`, 0, outer);
    case "not": return `not ${condStr(c.e, 2)}`; // 2 = only comparisons stay bare
    case "truthy": return exprStr(c.e);
  }
  return "";
}
const wrap = (s, p, outer) => (p < outer ? `(${s})` : s);

/* ───────────────────────── line parser ───────────────────────── */

const TEXT_OPS = new Set(["say", "log", "ask", "find", "analyze"]);
const isName = (s) => /^[a-z_][a-z0-9_]*$/.test(s || "");

/* text -> { program, errors } */
export function parse(text) {
  const root = [], errors = [];
  const stack = [{ node: null, list: root }];
  const top = () => stack[stack.length - 1];
  const err = (i, m) => { errors.push(`line ${i + 1}: ${m}`); };

  (text || "").split("\n").forEach((rawLine, i) => {
    let raw = rawLine.trim();
    if (!raw) return;

    // whole-line comment kept as a node so it survives a blocks roundtrip
    if (raw.startsWith("#")) return void top().list.push({ op: "comment", text: raw.slice(1).trim() });

    // "~" disables a block: it still parses (and keeps its body) but never runs
    let off = false;
    if (raw.startsWith("~")) { off = true; raw = raw.slice(1).trim(); }

    const push = (n) => { if (off) n.off = true; top().list.push(n); return n; };
    const open = (n) => { push(n); stack.push({ node: n, list: n.body }); };

    const head = (raw.match(/^[A-Za-z_]+/) || [""])[0].toLowerCase();

    try {
      // ops whose payload is free text (keep original casing, strip trailing comment)
      if (TEXT_OPS.has(head)) {
        const msg = raw.slice(head.length).replace(/\s+#.*$/, "").trim();
        if (!msg && head !== "analyze") throw new BlkErr(`${head} needs text`);
        return void push({ op: head, text: msg });
      }

      const body = raw.replace(/\s+#.*$/, "").trim();
      const toks = lex(body);
      const r = reader(toks);
      r.next(); // consume the head keyword

      // trailing "timeout <n>" on until-style lines
      let timeout = null;
      const takeTimeout = () => {
        const p = r.save();
        if (r.eat("timeout")) {
          const t = r.next();
          if (isNaN(+t)) { r.back(p); return; }
          timeout = clampArg("ms", +t);
        }
      };
      const finish = () => { if (!r.done()) throw new BlkErr(`unexpected "${r.peek()}"`); };
      const condTail = () => { const c = pCond(r); takeTimeout(); finish(); return c; };
      const argTail = (kind) => {
        const e = pExpr(r);
        finish();
        return e.n != null ? clampArg(kind, e.n) : e;
      };

      switch (head) {
        case "forward": case "back": case "left": case "right": {
          if (r.eat("until")) {
            const n = { op: head, until: condTail() };
            if (timeout) n.timeout = timeout;
            return void push(n);
          }
          return void push({ op: head, arg: argTail("ms") });
        }
        case "speed": return void push({ op: head, arg: argTail("pwm") });
        case "led": return void push({ op: head, arg: argTail("led") });
        case "wait": {
          if (r.eat("until")) {
            const n = { op: "wait_until", cond: condTail() };
            if (timeout) n.timeout = timeout;
            return void push(n);
          }
          return void push({ op: "wait", arg: argTail("ms") });
        }
        case "repeat": {
          if (r.eat("until")) return open({ op: "repeat_until", cond: condTail(), body: [] });
          if (r.eat("while")) return open({ op: "repeat_while", cond: condTail(), body: [] });
          return open({ op: "repeat", arg: argTail("count"), body: [] });
        }
        case "forever": finish(); return open({ op: "forever", body: [] });
        case "if": return open({ op: "if", cond: condTail(), body: [], elseBody: null });
        case "while": return open({ op: "repeat_while", cond: condTail(), body: [] }); // alias
        case "set": case "change": {
          const name = String(r.next() || "").toLowerCase();
          if (!isName(name)) throw new BlkErr(`${head} needs a variable name`);
          if (RESERVED.has(name)) throw new BlkErr(`"${name}" is a reserved name`);
          const e = pExpr(r);
          finish();
          return void push({ op: head, name, expr: e });
        }
        case "def": case "call": {
          const name = String(r.next() || "").toLowerCase();
          if (!isName(name)) throw new BlkErr(`${head} needs a name`);
          finish();
          if (head === "call") return void push({ op: "call", name });
          if (stack.length > 1) throw new BlkErr("def must be at the top level");
          return open({ op: "def", name, body: [] });
        }
        case "else": {
          const f = top();
          if (!f.node || f.node.op !== "if" || f.node.elseBody) throw new BlkErr("else without if");
          f.node.elseBody = [];
          f.list = f.node.elseBody;
          return;
        }
        case "end": {
          if (stack.length === 1) throw new BlkErr("end without a block to close");
          return void stack.pop();
        }
        case "stop": case "break": case "continue": finish(); return void push({ op: head });
        default: throw new BlkErr(`can't read "${raw}"`);
      }
    } catch (e) {
      if (e instanceof BlkErr) return err(i, e.message);
      throw e;
    }
  });

  if (stack.length > 1) errors.push(`${stack.length - 1} block(s) missing 'end'`);
  return { program: root, errors };
}

/* ───────────────────────── serializer ───────────────────────── */

const argStr = (a) => (typeof a === "number" ? String(a) : exprStr(a));

export function serialize(program) {
  const out = [];
  const walk = (list, d) => {
    const pad = "  ".repeat(d);
    for (const n of list) {
      const p = pad + (n.off ? "~" : "");
      const close = () => out.push(pad + "end");
      switch (n.op) {
        case "comment": out.push(pad + "# " + n.text); break;
        case "say": case "log": case "ask": case "find":
          out.push(p + n.op + " " + n.text); break;
        case "analyze": out.push(p + "analyze" + (n.text ? " " + n.text : "")); break;
        case "set": case "change": out.push(`${p}${n.op} ${n.name} ${exprStr(n.expr)}`); break;
        case "call": out.push(p + "call " + n.name); break;
        case "def": out.push(p + "def " + n.name); walk(n.body, d + 1); close(); break;
        case "wait_until":
          out.push(p + "wait until " + condStr(n.cond) + (n.timeout ? ` timeout ${n.timeout}` : "")); break;
        case "repeat": out.push(p + "repeat " + argStr(n.arg)); walk(n.body, d + 1); close(); break;
        case "repeat_until": out.push(p + "repeat until " + condStr(n.cond)); walk(n.body, d + 1); close(); break;
        case "repeat_while": out.push(p + "repeat while " + condStr(n.cond)); walk(n.body, d + 1); close(); break;
        case "forever": out.push(p + "forever"); walk(n.body, d + 1); close(); break;
        case "if":
          out.push(p + "if " + condStr(n.cond));
          walk(n.body, d + 1);
          if (n.elseBody) { out.push(pad + "else"); walk(n.elseBody, d + 1); }
          close();
          break;
        default:
          if (n.until) out.push(p + n.op + " until " + condStr(n.until) + (n.timeout ? ` timeout ${n.timeout}` : ""));
          else out.push(p + n.op + (n.arg != null ? " " + argStr(n.arg) : ""));
      }
    }
  };
  walk(program, 0);
  return out.join("\n");
}

/* ───────────────────────── evaluation ───────────────────────── */

const num = (v) => (typeof v === "number" && !isNaN(v) ? v : NaN);

export function evalExpr(e, ctx) {
  if (e == null) return NaN;
  if (typeof e === "number") return e;
  if (e.n != null) return e.n;
  if (e.v) return num(lookup(e.v, ctx));
  if (e.u) return -evalExpr(e.e, ctx);
  if (e.f) {
    const a = e.a.map(x => evalExpr(x, ctx));
    switch (e.f) {
      case "random": return a[0] + Math.random() * (a[1] - a[0]);
      case "min": return Math.min(a[0], a[1]);
      case "max": return Math.max(a[0], a[1]);
      case "abs": return Math.abs(a[0]);
      case "round": return Math.round(a[0]);
      case "clamp": return Math.min(a[2], Math.max(a[1], a[0]));
    }
    return NaN;
  }
  const l = evalExpr(e.l, ctx), r = evalExpr(e.r, ctx);
  switch (e.b) {
    case "+": return l + r;
    case "-": return l - r;
    case "*": return l * r;
    case "/": return r === 0 ? NaN : l / r;
    case "%": return r === 0 ? NaN : l % r;
  }
  return NaN;
}

// vars shadow nothing: sensors win, then builtins, then user vars
function lookup(name, ctx) {
  const st = ctx?.st;
  if (SENSORS.includes(name)) {
    const v = ctx?.sensors?.()?.[name];
    return v == null || isNaN(v) ? NaN : +v;
  }
  switch (name) {
    case "time": return Date.now() - (st?.t0 ?? Date.now());
    case "step": return st?.n ?? 0;
    case "speed": return st?.pwm ?? DEFAULT_PWM;
    case "true": return 1;
    case "false": return 0;
  }
  const v = st?.vars?.[name];
  return v == null ? NaN : +v;
}

export function evalCond(c, ctxOrPkt) {
  if (!c) return false;
  // callers may pass a raw telemetry packet (old signature) or a full context
  const ctx = ctxOrPkt && typeof ctxOrPkt.sensors === "function"
    ? ctxOrPkt
    : { sensors: () => ctxOrPkt, st: { vars: {} } };
  if (c.s && c.c) return evalCond({ k: "cmp", c: c.c, l: { v: c.s }, r: { n: c.v } }, ctx); // legacy
  switch (c.k) {
    case "and": return evalCond(c.l, ctx) && evalCond(c.r, ctx);
    case "or": return evalCond(c.l, ctx) || evalCond(c.r, ctx);
    case "not": return !evalCond(c.e, ctx);
    case "truthy": { const v = evalExpr(c.e, ctx); return !isNaN(v) && v !== 0; }
    case "cmp": {
      const l = evalExpr(c.l, ctx), r = evalExpr(c.r, ctx);
      if (isNaN(l) || isNaN(r)) return false; // missing telemetry = never true
      switch (c.c) {
        case "<": return l < r;
        case ">": return l > r;
        case "<=": return l <= r;
        case ">=": return l >= r;
        case "=": return l === r;
        case "!=": return l !== r;
      }
    }
  }
  return false;
}

/* text interpolation: "dist is {dist} cm" -> live values, 1 decimal */
export function interp(text, ctx) {
  return String(text || "").replace(/\{([^{}]+)\}/g, (m, src) => {
    try {
      const v = evalExpr(parseExpr(src), ctx);
      return isNaN(v) ? "?" : String(Math.round(v * 10) / 10);
    } catch { return m; }
  });
}

/* ───────────────────────── static checks ───────────────────────── */

// lint pass over a parsed tree: things the line parser can't see on its own.
export function lint(program) {
  const warns = [];
  const defs = new Set(), calls = [], sets = new Set(), reads = [], flagWarns = [];
  const checkFlags = (c) => {
    if (!c || typeof c !== "object") return;
    if (c.k === "cmp" && FLAGS.includes(c.l?.v) && c.r?.n != null && c.r.n !== 0 && c.r.n !== 1)
      flagWarns.push(`${c.l.v} is only ever 0 or 1 — "${condStr(c)}" doesn't test what you mean`);
    // a live reading is a moving number; it rarely lands exactly on one
    if (c.k === "cmp" && (c.c === "=" || c.c === "!=") && SENSORS.includes(c.l?.v) && c.r?.n != null)
      flagWarns.push(`"${condStr(c)}" — a reading almost never hits a number exactly, use < or >`);
    for (const k of ["l", "r", "e"]) checkFlags(c[k]);
  };
  const walk = (list, loopDepth, inDef) => {
    for (const n of list) {
      if (n.op === "def") { defs.add(n.name); walk(n.body, 0, true); continue; }
      if (n.op === "call") calls.push(n.name);
      if (n.op === "set" || n.op === "change") sets.add(n.name);
      for (const e of [n.expr, typeof n.arg === "object" ? n.arg : null]) collectVars(e, reads);
      for (const c of [n.cond, n.until]) { collectCondVars(c, reads); checkFlags(c); }
      if ((n.op === "break" || n.op === "continue") && !loopDepth) warns.push(`${n.op} outside a loop does nothing`);
      if (n.op === "forever" && !n.body.length) warns.push("empty forever loop spins forever");
      const deeper = ["repeat", "repeat_until", "repeat_while", "forever"].includes(n.op);
      for (const sub of [n.body, n.elseBody]) if (sub) walk(sub, deeper ? loopDepth + 1 : loopDepth, inDef);
    }
  };
  walk(program, 0, false);
  for (const w of flagWarns) warns.push(w);
  for (const c of new Set(calls)) if (!defs.has(c)) warns.push(`call ${c} — no "def ${c}" in this program`);
  for (const v of new Set(reads)) {
    if (SENSORS.includes(v) || BUILTINS.includes(v) || v === "true" || v === "false") continue;
    if (!sets.has(v)) warns.push(`"${v}" is read but never set — it reads as nothing`);
  }
  return warns;
}
function collectVars(e, out) {
  if (!e || typeof e !== "object") return;
  if (e.v) out.push(e.v);
  for (const k of ["l", "r", "e"]) collectVars(e[k], out);
  if (e.a) e.a.forEach(x => collectVars(x, out));
}
function collectCondVars(c, out) {
  if (!c || typeof c !== "object") return;
  if (c.s) { out.push(c.s); return; }
  if (c.k === "cmp" || c.k === "truthy") { collectVars(c.l, out); collectVars(c.r, out); collectVars(c.e, out); return; }
  for (const k of ["l", "r", "e"]) collectCondVars(c[k], out);
}

/* rough runtime estimate in ms (Infinity for unbounded loops) — editor only */
export function estimate(program) {
  const val = (a, d) => (typeof a === "number" ? a : d);
  const walk = (list) => {
    let ms = 0;
    for (const n of list) {
      if (n.off || n.op === "def" || n.op === "comment") continue;
      switch (n.op) {
        case "forward": case "back": case "left": case "right":
          ms += n.until ? 2000 : val(n.arg, 500) + 150; break;
        case "wait": ms += val(n.arg, 500); break;
        case "wait_until": ms += n.timeout || 2000; break;
        case "analyze": ms += 6000; break;
        case "ask": case "find": ms += 4000; break;
        case "say": ms += 1200; break;
        case "repeat": ms += walk(n.body) * val(n.arg, 3); break;
        case "repeat_until": case "repeat_while": ms += walk(n.body) * 4; break;
        case "forever": return Infinity;
        case "if": ms += Math.max(walk(n.body), n.elseBody ? walk(n.elseBody) : 0); break;
      }
    }
    return ms;
  };
  return walk(program);
}

export function fmtMs(ms) {
  if (!isFinite(ms)) return "∞";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

/* ───────────────────────── interpreter ─────────────────────────
   walks the tree live so conditions see current telemetry.
   io: { stopped(), sleep(ms), drive(verb,pwm,ms), analyze(prompt), say(text),
         log(text), led(v), ask(q)->bool, find(thing)->bool,
         sensors() -> latest packet, halt(), onStep(node, n, st), gate(node, st) }
   loops tick io.sleep(30) per pass so an empty body can't busy-spin. */
export const VERBS = { forward: "fwd", back: "back", left: "left", right: "right" };
const UNTIL_BURST = 250;      // drive-until moves in short bursts, re-checking between
const UNTIL_CAP = 30000;      // and never runs longer than this without a timeout
const CALL_DEPTH = 20;

export async function run(program, io) {
  const st = { pwm: DEFAULT_PWM, n: 0, vars: {}, t0: Date.now(), depth: 0, defs: {} };
  const ctx = { st, sensors: () => io.sensors?.() };
  collectDefs(program, st.defs);
  const r = await runList(program, io, st, ctx);
  return r === "stopped" ? "stopped" : "done";
}
function collectDefs(list, defs) {
  for (const n of list) {
    if (n.op === "def") defs[n.name] = n.body;
    for (const sub of [n.body, n.elseBody]) if (sub) collectDefs(sub, defs);
  }
}

// returns undefined | "stopped" | "break" | "continue"
async function runList(list, io, st, ctx) {
  for (const node of list) {
    if (io.stopped()) return "stopped";
    if (node.off || node.op === "comment" || node.op === "def") continue;
    st.n++;
    io.onStep?.(node, st.n, st);
    if (io.gate) { const g = await io.gate(node, st); if (g === "stop") return "stopped"; }
    const argv = (d) => {
      const v = typeof node.arg === "number" ? node.arg : Math.round(evalExpr(node.arg, ctx));
      return isNaN(v) ? d : v;
    };
    switch (node.op) {
      case "speed": st.pwm = clampArg("pwm", argv(DEFAULT_PWM)); break;
      case "led": io.led?.(clampArg("led", argv(0))); break;
      case "forward": case "back": case "left": case "right": {
        const verb = VERBS[node.op];
        if (!node.until) { await io.drive(verb, st.pwm, clampArg("ms", argv(500))); break; }
        const cap = node.timeout || UNTIL_CAP;
        const t0 = Date.now();
        while (!io.stopped() && !evalCond(node.until, ctx) && Date.now() - t0 < cap) {
          await io.drive(verb, st.pwm, UNTIL_BURST);
        }
        io.halt?.();
        break;
      }
      case "wait": await io.sleep(clampArg("ms", argv(500))); break;
      case "wait_until": {
        const cap = node.timeout || Infinity;
        const t0 = Date.now();
        while (!io.stopped() && !evalCond(node.cond, ctx) && Date.now() - t0 < cap) await io.sleep(100);
        break;
      }
      case "analyze": await io.analyze?.(interp(node.text, ctx)); break;
      case "ask": st.vars.answer = (await io.ask?.(interp(node.text, ctx))) ? 1 : 0; break;
      case "find": st.vars.found = (await io.find?.(interp(node.text, ctx))) ? 1 : 0; break;
      case "say": io.say?.(interp(node.text, ctx)); break;
      case "log": io.log?.(interp(node.text, ctx)); break;
      case "set": st.vars[node.name] = evalExpr(node.expr, ctx); break;
      case "change": st.vars[node.name] = (st.vars[node.name] || 0) + (evalExpr(node.expr, ctx) || 0); break;
      case "call": {
        const body = st.defs[node.name];
        if (!body) { io.log?.(`call ${node.name}: not defined`); break; }
        if (st.depth >= CALL_DEPTH) { io.log?.(`call ${node.name}: too deep, skipped`); break; }
        st.depth++;
        const r = await runList(body, io, st, ctx);
        st.depth--;
        if (r) return r;
        break;
      }
      case "stop": io.halt?.(); return "stopped";
      case "break": return "break";
      case "continue": return "continue";
      case "repeat": {
        const times = clampArg("count", argv(1));
        for (let k = 0; k < times && !io.stopped(); k++) {
          const r = await runList(node.body, io, st, ctx);
          if (r === "stopped" || r === "break") { if (r === "stopped") return r; break; }
          await io.sleep(30);
        }
        break;
      }
      case "repeat_until": case "repeat_while": {
        const want = node.op === "repeat_while";
        while (!io.stopped() && evalCond(node.cond, ctx) === want) {
          const r = await runList(node.body, io, st, ctx);
          if (r === "stopped") return r;
          if (r === "break") break;
          await io.sleep(30);
        }
        break;
      }
      case "forever":
        while (!io.stopped()) {
          const r = await runList(node.body, io, st, ctx);
          if (r === "stopped") return r;
          if (r === "break") break;
          await io.sleep(30);
        }
        break;
      case "if": {
        const branch = evalCond(node.cond, ctx) ? node.body : (node.elseBody || []);
        const r = await runList(branch, io, st, ctx);
        if (r) return r;
        break;
      }
    }
  }
}
