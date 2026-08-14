// blk workflow editor — blocks view, text view, simulator, debugger, Sage.
// the program tree is the single working copy; .blk text only materialises at
// save/load/import/export/undo and when the text view is showing.
//
// TOUCH FIRST: dragging is built on pointer events, not the html5 drag-and-drop
// api, which never fires on a touchscreen. every destructive action has a target
// you can hit with a finger (select → action bar, or drag to the bin); keyboard
// shortcuts are accelerators on top, never the only way in.
//
// IMPORTANT NOTE: ui-only flags (_collapsed/_bp) live on nodes, so undo (which
// round-trips through text) forgets them. cheap trade, they're one tap back.

import {
  NODE_META, SENSORS, CMPS, FLAGS, LIMITS, DEFAULT_PWM,
  parse, serialize, parseCond, parseExpr, condStr, exprStr,
  clampArg, lint, estimate, fmtMs, run,
} from "./blk.mjs";
import { Sim, LAYOUTS, ARENA } from "./blksim.js";
import { icon, prefixIcon } from "./icons.mjs";

const $ = (id) => document.getElementById(id);
const bc = new BroadcastChannel("blk"); // nudges the console to refresh its list
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

/* ───────────────────────── templates ───────────────────────── */

const TEMPLATES = {
  "Patrol + avoid": `speed 140
say Starting patrol
forever
  if dist < 20
    say Obstacle
    back 400
    right 400
  else
    forward 500
  end
end`,
  "Wall follower": `speed 120
set turns 0
forever
  forward until dist < 25 timeout 6000
  right 400
  change turns 1
  log corner {turns}
end`,
  "Square + report": `speed 150
def leg
  forward 800
  right 400
end
repeat 4
  call leg
end
analyze describe the room you ended up in`,
  "Cave survey": `speed 130
led 180
def sweep
  right 400
  analyze what is on this side
end
forever
  forward until dist < 30 timeout 8000
  say Wall ahead at {dist} centimetres
  call sweep
  find anything painted on the rock
  if found = 1
    say Logging that one
    stop
  end
end`,
  "Ask before advancing": `speed 110
forever
  analyze what is directly ahead
  ask is it safe to keep going
  if answer = 1
    forward 600
  else
    say Holding position
    stop
  end
end`,
  "Heat seeker": `speed 140
set best 0
repeat 8
  right 400
  if temp > best
    set best temp
    log new high {best}
  end
end
say Hottest reading was {best} degrees`,
};

/* ───────────────────────── state ───────────────────────── */

let program = parse(TEMPLATES["Patrol + avoid"]).program;
let selected = null;
let view = "blocks";
let activeCat = "all";
const undoStack = [], redoStack = [];
const nodeEls = new Map(); // node -> element, for run highlighting
const simHits = new Map(); // node -> times the last simulated run entered it
const DRAFT = "blkDraft";

const setStatus = (msg, cls = "", ico = "") => {
  const s = $("status");
  s.textContent = msg;
  if (ico) prefixIcon(s, ico);
  s.className = "blk-status " + cls;
};

/* ───────────────────────── undo / autosave ───────────────────────── */

function snapshot() { return serialize(program); }
// `base` is the text as of the last committed state — commit() runs *after* the
// tree was mutated, so the undo entry has to be the text from before it.
let base = snapshot();

function commit(label) {
  undoStack.push(base);
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  afterChange(label);
}
function afterChange(label) {
  base = snapshot();
  render();
  try { localStorage.setItem(DRAFT, JSON.stringify({ name: $("name").value, text: base, at: Date.now() })); } catch { /* quota */ }
  if (label) setStatus(label);
}
// wholesale swap (load, import, template, Sage, text view) — one undo step
function replaceProgram(next, label) {
  undoStack.push(base);
  redoStack.length = 0;
  program = next;
  selected = null;
  afterChange(label);
}
function undo() {
  if (!undoStack.length) return setStatus("nothing to undo");
  redoStack.push(base);
  program = parse(undoStack.pop()).program;
  selected = null;
  afterChange("undo");
}
function redo() {
  if (!redoStack.length) return setStatus("nothing to redo");
  undoStack.push(base);
  program = parse(redoStack.pop()).program;
  selected = null;
  afterChange("redo");
}

/* ───────────────────────── tree helpers ───────────────────────── */

const subLists = (n) => [n.body, n.elseBody].filter(Boolean);
function findList(list, node) {
  for (const n of list) {
    if (n === node) return list;
    for (const sub of subLists(n)) { const r = findList(sub, node); if (r) return r; }
  }
  return null;
}
function ownsList(node, list) {
  for (const sub of subLists(node)) {
    if (sub === list) return true;
    for (const ch of sub) if (ownsList(ch, list)) return true;
  }
  return false;
}
const clone = (n) => JSON.parse(JSON.stringify(n));

// where a palette tap lands: inside an open container if one is selected,
// else right after the selection, else at the end of the program
function insertNode(node) {
  if (selected?.body && !selected._collapsed && selected !== node) {
    selected.body.push(node);
  } else {
    const list = (selected && findList(program, selected)) || program;
    const at = list === program && !selected ? list.length : list.indexOf(selected) + 1;
    list.splice(at, 0, node);
  }
  selected = node;
  commit();
}

function removeNode(node) {
  const l = findList(program, node);
  if (!l) return;
  l.splice(l.indexOf(node), 1);
  if (selected === node) selected = null;
  commit("deleted " + node.op);
}
function duplicateNode(node) {
  const l = findList(program, node);
  if (!l) return;
  const copy = clone(node);
  l.splice(l.indexOf(node) + 1, 0, copy);
  selected = copy;
  commit("duplicated " + node.op);
}
function moveNode(node, dir) {
  const l = findList(program, node);
  if (!l) return;
  const i = l.indexOf(node), j = i + dir;
  if (j < 0 || j >= l.length) return setStatus("can't move it any further that way");
  l.splice(i, 1);
  l.splice(j, 0, node);
  commit();
}

/* ───────────────────────── pointer drag ─────────────────────────
   one code path for mouse, pen and finger. the block under the finger stays
   put (dimmed) while a ghost follows the pointer; drop targets are hit-tested
   with elementFromPoint, and every block element carries its node + list. */

let drag = null;

function attachDrag(head, opts) {
  // opts: { node, list } for a canvas block, { factory } for a palette one
  head.addEventListener("pointerdown", (e) => {
    if (e.button > 0) return;
    const startX = e.clientX, startY = e.clientY;
    let started = false;
    const move = (ev) => {
      if (!started) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 8) return;
        started = true;
        dragStart(opts, head, ev);
      }
      dragMove(ev);
    };
    const up = (ev) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (started) return dragEnd(ev);
      // no movement = a tap: palette adds a block, canvas selects one
      if (opts.factory) insertNode(opts.factory());
      else { selected = opts.node; render(); }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  });
}

function dragStart({ node, factory }, head, ev) {
  const r = head.getBoundingClientRect();
  const cat = head.parentElement.className.match(/cat-\w+/)?.[0] || "cat-control";
  const ghost = el("div", `blk-node ${cat} ghost`);
  ghost.appendChild(head.cloneNode(true));
  ghost.style.width = r.width + "px";
  document.body.appendChild(ghost);
  drag = { node, factory, ghost, offX: ev.clientX - r.left, offY: ev.clientY - r.top, target: null };
  if (node) head.parentElement.classList.add("is-drag");
  $("trash").hidden = !node; // nothing to bin when the block came from the palette
  dragMove(ev);
}

function clearMarks() {
  for (const n of document.querySelectorAll(".is-before,.is-after")) n.classList.remove("is-before", "is-after");
  for (const n of document.querySelectorAll(".blk-list.is-over")) n.classList.remove("is-over");
  $("trash").classList.remove("is-over");
}

function dragMove(ev) {
  if (!drag) return;
  drag.ghost.style.left = ev.clientX - drag.offX + "px";
  drag.ghost.style.top = ev.clientY - drag.offY + "px";
  clearMarks();
  drag.target = null;

  // keep the canvas scrolling when the finger sits near an edge
  const cv = $("canvas"), cr = cv.getBoundingClientRect();
  if (ev.clientY < cr.top + 70) cv.scrollTop -= 14;
  else if (ev.clientY > cr.bottom - 70) cv.scrollTop += 14;

  const under = document.elementFromPoint(ev.clientX, ev.clientY);
  if (!under) return;

  if (drag.node && under.closest("#trash")) {
    $("trash").classList.add("is-over");
    drag.target = { trash: true };
    return;
  }
  const head = under.closest(".blk-head");
  const wrap = head?.parentElement;
  if (wrap?._node) {
    const r = head.getBoundingClientRect();
    const after = ev.clientY > r.top + r.height / 2;
    wrap.classList.add(after ? "is-after" : "is-before");
    drag.target = { list: wrap._list, index: wrap._list.indexOf(wrap._node) + (after ? 1 : 0) };
    return;
  }
  const listEl = under.closest(".blk-list");
  if (listEl?._list) {
    listEl.classList.add("is-over");
    drag.target = { list: listEl._list, index: listEl._list.length };
  }
}

function dragEnd(ev) {
  const d = drag;
  drag = null;
  d.ghost.remove();
  clearMarks();
  $("trash").hidden = true;
  if (!d.target) return render(); // dropped nowhere — put it back
  if (d.target.trash) return removeNode(d.node);

  const { list } = d.target;
  let { index } = d.target;
  let node;
  if (d.factory) node = d.factory();
  else {
    if (ownsList(d.node, list)) return render(); // can't drop a loop into itself
    if (ev.altKey) node = clone(d.node);          // desktop shortcut: alt-drag copies
    else {
      const src = findList(program, d.node);
      if (!src) return render();
      const si = src.indexOf(d.node);
      src.splice(si, 1);
      if (src === list && si < index) index--;
      node = d.node;
    }
  }
  list.splice(index, 0, node);
  selected = node;
  commit();
}

/* ───────────────────────── inputs ───────────────────────── */

// interactive bits inside a block head must not start a drag
const stopDrag = (n) => {
  n.addEventListener("pointerdown", (e) => e.stopPropagation());
  return n;
};
function inlineBtn(cls, txt, title, fn) {
  const b = stopDrag(el("button", cls, txt));
  b.type = "button";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.onclick = (e) => { e.stopPropagation(); fn(); };
  return b;
}

/* what each condition variable actually is, so the picker can't build nonsense
   like "answer <= 20". unit + range also drive the number field. */
const DEG = { unit: "°", min: -180, max: 360, def: 45 };
const PPM = { unit: "ppm", min: 0, max: 1000, def: 300 };
const VAR_SPEC = {
  dist: { unit: "cm", min: 0, max: 400, def: 20 },
  temp: { unit: "°C", min: -10, max: 90, def: 35 },
  humid: { unit: "%", min: 0, max: 100, def: 60 },
  smoke: PPM, airq: { ...PPM, def: 450 }, co: PPM,
  pressure: { unit: "hPa", min: 800, max: 1100, def: 1000 },
  roll: DEG, pitch: DEG, yaw: DEG,
  time: { unit: "ms", min: 0, max: 600000, def: 5000 },
  step: { unit: "blocks", min: 0, max: 10000, def: 10 },
  speed: { unit: "pwm", min: 60, max: 255, def: 140 },
  answer: { flag: true }, found: { flag: true },
};
const ANY = { unit: "", min: -1000000, max: 1000000, def: 1 };
const varSpec = (name) => VAR_SPEC[name] || ANY;

// variables the operator made with set/change — they belong in the picker too
function userVars() {
  const out = new Set();
  const walk = (list) => {
    for (const n of list) {
      if (n.op === "set" || n.op === "change") out.add(n.name);
      for (const sub of subLists(n)) walk(sub);
    }
  };
  walk(program);
  return [...out].sort();
}

function varOptions(cur) {
  const mine = userVars();
  const group = (label, names) => (names.length
    ? `<optgroup label="${label}">` + names.map(n => `<option${n === cur ? " selected" : ""}>${n}</option>`).join("") + "</optgroup>"
    : "");
  const known = [...SENSORS, "time", "step", "speed", ...FLAGS, ...mine];
  return group("Sensors", SENSORS)
    + group("Robot", ["time", "step", "speed"])
    + group("Sage answers", FLAGS)
    + group("Your variables", mine)
    + (known.includes(cur) ? "" : group("This program", [cur]));
}

// keep the three widgets consistent: swapping the variable fixes up the
// comparator and the value instead of leaving the old ones behind
function coerce(p, prevVar) {
  const spec = varSpec(p.v);
  if (spec.flag) return { v: p.v, cmp: ["=", "!="].includes(p.cmp) ? p.cmp : "=", n: p.n === 0 ? 0 : 1 };
  const cameFromFlag = varSpec(prevVar).flag;
  let n = cameFromFlag ? spec.def : p.n;
  if (n < spec.min || n > spec.max) n = spec.def;
  // a reading is a moving number: "=" almost never fires, so coming off a
  // yes/no flag lands on "<" rather than carrying the flag's "is"
  let cmp = CMPS.includes(p.cmp) ? p.cmp : "<";
  if (cameFromFlag) cmp = "<";
  return { v: p.v, cmp, n };
}

// simple `<sensor|var> <cmp> <number>` conditions get the 3-widget scratch look;
// anything richer (and/or/not, math) — or one the operator forced open with ƒx —
// falls back to an editable text field.
// both shapes read as one row of widgets; for a 1/0 flag, `answer` alone reads
// as "answer is yes"
const simpleParts = (c) => (c.k === "cmp"
  ? { v: c.l.v, cmp: c.c, n: c.r.n }
  : varSpec(c.e.v).flag ? { v: c.e.v, cmp: "=", n: 1 } : { v: c.e.v, cmp: "!=", n: 0 });
// a flag compared to anything but 0/1 (only the text view can write that) stays
// in the text field — the picker never shows something the file doesn't say
const isCoherent = (p) => !varSpec(p.v).flag || (["=", "!="].includes(p.cmp) && (p.n === 0 || p.n === 1));
const isSimpleCond = (c) => !!c && !c._text
  && ((c.k === "cmp" && c.l?.v && c.r?.n != null) || (c.k === "truthy" && c.e?.v))
  && isCoherent(simpleParts(c));

function condInputs(node, key) {
  const frag = document.createDocumentFragment();
  const cond = node[key];
  if (isSimpleCond(cond)) {
    const p = simpleParts(cond);
    const spec = varSpec(p.v);
    // editing any widget writes a plain comparison back, whatever shape it was
    const write = (patch, prevVar) => { const q = coerce(patch, prevVar); node[key] = { k: "cmp", c: q.cmp, l: { v: q.v }, r: { n: q.n } }; commit(); };

    const vs = stopDrag(el("select"));
    vs.innerHTML = varOptions(p.v);
    vs.onchange = () => write({ ...p, v: vs.value }, p.v);
    frag.appendChild(vs);

    const cs = stopDrag(el("select"));
    // a 1/0 answer can only be "is" or "isn't" — the rest would always be true
    const cmps = spec.flag ? ["=", "!="] : CMPS;
    cs.innerHTML = cmps.map(o => `<option value="${o}"${o === p.cmp ? " selected" : ""}>${spec.flag ? (o === "=" ? "is" : "is not") : o}</option>`).join("");
    cs.onchange = () => write({ ...p, cmp: cs.value }, p.v);
    frag.appendChild(cs);

    if (spec.flag) {
      const ys = stopDrag(el("select"));
      ys.innerHTML = `<option value="1"${p.n ? " selected" : ""}>yes</option><option value="0"${p.n ? "" : " selected"}>no</option>`;
      ys.onchange = () => write({ ...p, n: +ys.value }, p.v);
      frag.appendChild(ys);
    } else {
      const num = stopDrag(el("input"));
      num.type = "number";
      num.inputMode = "decimal";
      num.min = spec.min;
      num.max = spec.max;
      num.value = p.n;
      num.onchange = () => write({ ...p, n: Math.max(spec.min, Math.min(spec.max, +num.value || 0)) }, p.v);
      frag.appendChild(num);
      if (spec.unit) frag.appendChild(el("span", "unit", spec.unit));
    }
  } else {
    const txt = stopDrag(el("input", "wide"));
    txt.type = "text";
    txt.value = condStr(cond);
    txt.title = "condition — sensors, vars, and/or/not, math";
    txt.onchange = () => {
      try { node[key] = parseCond(txt.value); commit(); }
      catch (e) { setStatus("bad condition: " + e.message, "is-err"); txt.value = condStr(node[key]); }
    };
    frag.appendChild(txt);
  }
  const simple = isSimpleCond(cond);
  frag.appendChild(inlineBtn("fx", simple ? "ƒx" : "◧",
    simple ? "write it as an expression (and/or/not, math)" : "back to the simple picker",
    () => {
      if (simple) node[key]._text = true;
      else node[key] = parseCond("dist < 20");
      commit();
    }));
  return frag;
}

const STEP = { ms: 50, pwm: 10, count: 1, led: 15 };
const UNIT = { ms: "ms", pwm: "pwm", count: "times", led: "of 255" };

function argInput(node, kind) {
  const frag = document.createDocumentFragment();
  if (typeof node.arg === "number") {
    // −/+ either side of the field: typing a number on a tablet is the slow path
    const box = stopDrag(el("span", "stepper"));
    const num = el("input");
    num.type = "number";
    num.inputMode = "numeric";
    num.min = LIMITS[kind][0];
    num.max = LIMITS[kind][1];
    num.value = node.arg;
    num.onchange = () => { node.arg = clampArg(kind, num.value); commit(); };
    const bump = (d) => {
      const b = el("button", null, d > 0 ? "+" : "−");
      b.type = "button";
      b.onclick = (e) => { e.stopPropagation(); node.arg = clampArg(kind, node.arg + d * STEP[kind]); commit(); };
      return b;
    };
    box.appendChild(bump(-1));
    box.appendChild(num);
    box.appendChild(bump(1));
    frag.appendChild(box);
    frag.appendChild(el("span", "unit", UNIT[kind]));
  } else {
    const txt = stopDrag(el("input", "wide"));
    txt.type = "text";
    txt.value = exprStr(node.arg);
    txt.onchange = () => {
      try { node.arg = parseExpr(txt.value); commit(); }
      catch (e) { setStatus("bad expression: " + e.message, "is-err"); txt.value = exprStr(node.arg); }
    };
    frag.appendChild(txt);
  }
  const lit = typeof node.arg === "number";
  frag.appendChild(inlineBtn("fx", lit ? "ƒx" : "123", "number ↔ expression", () => {
    node.arg = lit ? { n: node.arg } : clampArg(kind, 500);
    commit();
  }));
  return frag;
}

function textInput(node, placeholder, wide = true) {
  const txt = stopDrag(el("input", wide ? "wide" : null));
  txt.type = "text";
  txt.value = node.text || "";
  txt.placeholder = placeholder;
  txt.onchange = () => { node.text = txt.value.trim(); commit(); };
  return txt;
}

function nameInput(node) {
  const txt = stopDrag(el("input"));
  txt.type = "text";
  txt.value = node.name || "";
  txt.size = 8;
  txt.placeholder = "name";
  txt.autocapitalize = "off";
  txt.onchange = () => {
    const v = txt.value.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
    node.name = /^[a-z_]/.test(v) ? v : "v_" + v;
    commit();
  };
  return txt;
}

/* ───────────────────────── block rendering ───────────────────────── */

function renderNode(node, list) {
  const meta = NODE_META[node.op] || { cat: "control", label: node.op };
  const wrap = el("div", `blk-node cat-${meta.cat}`);
  wrap._node = node;
  wrap._list = list;
  if (node.off) wrap.classList.add("is-off");
  if (node === selected) wrap.classList.add("is-sel");
  nodeEls.set(node, wrap);

  const head = el("div", "blk-head");
  head.tabIndex = 0;
  head.setAttribute("role", "button");
  head.setAttribute("aria-label", meta.label);

  if (meta.container) {
    head.appendChild(inlineBtn("chev", node._collapsed ? "▸" : "▾", "collapse or expand",
      () => { node._collapsed = !node._collapsed; render(); }));
  }
  if (node._bp) {
    const dot = el("span", "bpdot");
    dot.title = "breakpoint — the simulator pauses here (clear it from the action bar)";
    head.appendChild(dot);
  }
  head.appendChild(el("span", "lbl", meta.label));

  // how many times the last simulated run went through this block — dead
  // branches show up as the ones with no badge at all
  const hits = simHits.get(node);
  if (hits) head.appendChild(el("span", "hits", "×" + hits));

  if (node.op === "comment") head.appendChild(textInput(node, "note to self"));
  else if (meta.name) head.appendChild(nameInput(node));
  if (meta.expr) {
    const txt = stopDrag(el("input", "wide"));
    txt.type = "text";
    txt.value = exprStr(node.expr);
    txt.placeholder = "expression";
    txt.onchange = () => {
      try { node.expr = parseExpr(txt.value); commit(); }
      catch (e) { setStatus("bad expression: " + e.message, "is-err"); txt.value = exprStr(node.expr); }
    };
    head.appendChild(el("span", "unit", node.op === "change" ? "by" : "to"));
    head.appendChild(txt);
  }
  if (meta.canUntil && node.until) {
    head.appendChild(el("span", "unit", "until"));
    head.appendChild(condInputs(node, "until"));
  } else if (meta.arg) head.appendChild(argInput(node, meta.arg));
  if (meta.cond) head.appendChild(condInputs(node, "cond"));
  if (meta.timeout || (meta.canUntil && node.until)) {
    const t = stopDrag(el("input"));
    t.type = "number";
    t.inputMode = "numeric";
    t.placeholder = "—";
    t.title = "give up after this many ms (blank = never)";
    t.value = node.timeout || "";
    t.onchange = () => { node.timeout = t.value ? clampArg("ms", t.value) : null; commit(); };
    head.appendChild(el("span", "unit", "timeout"));
    head.appendChild(t);
  }
  if (meta.text && node.op !== "comment") {
    head.appendChild(textInput(node, meta.optText ? "(optional) what to look at" : "text"));
  }
  if (meta.canUntil) {
    const fx = inlineBtn("fx", node.until ? "" : "∞",
      node.until ? "switch to a timed burst" : "switch to drive-until-condition",
      () => {
        if (node.until) { delete node.until; delete node.timeout; node.arg = 500; }
        else { delete node.arg; node.until = parseCond("dist < 20"); }
        commit();
      });
    if (node.until) fx.innerHTML = icon("timer");
    head.appendChild(fx);
  }
  wrap.appendChild(head);
  attachDrag(head, { node, list });
  head.onkeydown = (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selected = node; render(); }
  };

  if (meta.container) {
    if (node._collapsed) {
      const n = countNodes(node.body) + (node.elseBody ? countNodes(node.elseBody) : 0);
      const fold = el("div", "blk-fold", `… ${n} block${n === 1 ? "" : "s"} hidden`);
      fold.onclick = () => { node._collapsed = false; render(); };
      wrap.appendChild(fold);
    } else {
      wrap.appendChild(renderList(node.body));
      if (node.op === "if") {
        if (node.elseBody) {
          const bar = el("div", "blk-else", "else");
          bar.appendChild(inlineBtn("x", "✕", "remove the else arm", () => { node.elseBody = null; commit(); }));
          wrap.appendChild(bar);
          wrap.appendChild(renderList(node.elseBody));
        } else {
          const add = el("button", "blk-else is-add", "+ else");
          add.type = "button";
          add.onclick = () => { node.elseBody = []; commit(); };
          wrap.appendChild(add);
        }
      }
      wrap.appendChild(el("div", "blk-cap", "end"));
    }
  }
  return wrap;
}

const countNodes = (list) => list.reduce((a, n) => a + 1 + subLists(n).reduce((b, s) => b + countNodes(s), 0), 0);

function renderList(list, isRoot = false) {
  const wrap = el("div", "blk-body");
  const inner = el("div", "blk-list" + (isRoot ? " blk-list-root" : ""));
  inner._list = list;
  if (isRoot) wrap.style.cssText = "margin:0;padding:0;border:none;min-height:100%";
  for (const n of list) inner.appendChild(renderNode(n, list));
  if (!list.length && !isRoot) inner.style.minHeight = "26px";
  if (!list.length && isRoot) inner.appendChild(el("div", "blk-hint", "empty program — tap a block on the left to add it"));
  wrap.appendChild(inner);
  return wrap;
}

function render() {
  nodeEls.clear();
  const c = $("canvas");
  c.innerHTML = "";
  c.appendChild(renderList(program, true));
  if (view === "text") $("code").value = serialize(program);
  renderActionBar();
  updateMeta();
}

/* the selection's toolbar — this is what replaces "press backspace" */
function renderActionBar() {
  const bar = $("actionbar");
  if (!selected || view !== "blocks") { bar.hidden = true; return; }
  bar.hidden = false;
  $("act-what").textContent = NODE_META[selected.op]?.label || selected.op;
  $("act-off").classList.toggle("is-on", !!selected.off);
  $("act-bp").classList.toggle("is-on", !!selected._bp);
}

/* lint + stats strip under the workspace */
function updateMeta() {
  const warns = lint(program);
  $("meta").textContent = `${countNodes(program)} blocks · ~${fmtMs(estimate(program))} per pass`;
  const box = $("lint");
  box.innerHTML = "";
  for (const w of warns.slice(0, 4)) box.appendChild(prefixIcon(el("div", null, w), "warn"));
  box.hidden = !warns.length;
}

/* ───────────────────────── palette ───────────────────────── */

// one inline glyph per category ring — no icon font, no cdn (comp-day rule).
const ICONS = {
  all:     '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
  motion:  '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M13 6l6 6-6 6"/></svg>',
  control: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 0 1 14-5.3M20 4v5h-5"/><path d="M20 12a8 8 0 0 1-14 5.3M4 20v-5h5"/></svg>',
  data:    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4c-2 0-3 1-3 3v3c0 1-.5 2-2 2 1.5 0 2 1 2 2v3c0 2 1 3 3 3M16 4c2 0 3 1 3 3v3c0 1 .5 2 2 2-1.5 0-2 1-2 2v3c0 2-1 3-3 3"/></svg>',
  proc:    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="14" rx="1"/><path d="M7 5v14M17 5v14"/></svg>',
  looks:   '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h13a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-6l-5 4v-4H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/></svg>',
  ai:      '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="7" width="10" height="10" rx="1"/><path d="M9 3v4M12 3v4M15 3v4M9 17v4M12 17v4M15 17v4M3 9h4M3 12h4M3 15h4M17 9h4M17 12h4M17 15h4"/></svg>',
};

const cond = () => parseCond("dist < 20");
const PALETTE = [
  ["Motion", "motion", [
    () => ({ op: "forward", arg: 500 }),
    () => ({ op: "back", arg: 500 }),
    () => ({ op: "left", arg: 400 }),
    () => ({ op: "right", arg: 400 }),
    () => ({ op: "forward", until: cond() }),
    () => ({ op: "speed", arg: DEFAULT_PWM }),
  ]],
  ["Control", "control", [
    () => ({ op: "wait", arg: 500 }),
    () => ({ op: "wait_until", cond: cond() }),
    () => ({ op: "repeat", arg: 3, body: [] }),
    () => ({ op: "repeat_until", cond: cond(), body: [] }),
    () => ({ op: "repeat_while", cond: cond(), body: [] }),
    () => ({ op: "forever", body: [] }),
    () => ({ op: "if", cond: cond(), body: [], elseBody: null }),
    () => ({ op: "if", cond: cond(), body: [], elseBody: [] }),
    () => ({ op: "break" }),
    () => ({ op: "continue" }),
    () => ({ op: "stop" }),
  ]],
  ["Data", "data", [
    () => ({ op: "set", name: "n", expr: parseExpr("0") }),
    () => ({ op: "change", name: "n", expr: parseExpr("1") }),
  ]],
  ["Routines", "proc", [
    () => ({ op: "def", name: "routine", body: [] }),
    () => ({ op: "call", name: "routine" }),
  ]],
  ["Voice", "looks", [
    () => ({ op: "say", text: "hello" }),
    () => ({ op: "log", text: "checkpoint {step}" }),
    () => ({ op: "led", arg: 180 }),
    () => ({ op: "comment", text: "note" }),
  ]],
  ["AI", "ai", [
    () => ({ op: "analyze", text: "" }),
    () => ({ op: "ask", text: "is it safe to keep going" }),
    () => ({ op: "find", text: "cave painting" }),
  ]],
];

function paletteLabel(sample, meta) {
  return meta.label
    + (sample.until ? " until …" : meta.arg && sample.arg != null ? ` ${exprStr(sample.arg)} ${UNIT[meta.arg] === "of 255" ? "" : UNIT[meta.arg]}` : "")
    + (meta.cond ? " …" : "")
    + (meta.name ? " " + sample.name : "")
    + (sample.op === "if" && sample.elseBody ? " / else" : "")
    + (meta.text && sample.text ? " …" : "");
}

function buildCats() {
  const box = $("cats");
  box.innerHTML = "";
  const add = (key, label, color) => {
    const b = el("button", "cat-btn" + (activeCat === key ? " is-on" : ""));
    b.type = "button";
    const ring = el("span", "ring");
    ring.innerHTML = ICONS[key]; // trusted, hard-coded markup — not user input
    ring.style.background = color;
    b.appendChild(ring);
    b.appendChild(el("span", null, label));
    b.onclick = () => {
      activeCat = key;
      $("search").value = "";
      buildCats();
      buildPalette();
      if (window.matchMedia("(max-width: 900px)").matches) setDrawer("palette", true);
    };
    box.appendChild(b);
  };
  add("all", "All", "var(--ink-3)");
  for (const [title, cat] of PALETTE) add(cat, title, `var(--c-${cat})`);
}

function buildPalette(filter = "") {
  const box = $("palette");
  box.innerHTML = "";
  const f = filter.trim().toLowerCase();
  for (const [title, cat, items] of PALETTE) {
    if (!f && activeCat !== "all" && activeCat !== cat) continue;
    const hits = items.filter(make => {
      if (!f) return true;
      const s = make();
      return (title + " " + s.op + " " + paletteLabel(s, NODE_META[s.op])).toLowerCase().includes(f);
    });
    if (!hits.length) continue;
    box.appendChild(el("h3", null, title));
    for (const make of hits) {
      const sample = make();
      const meta = NODE_META[sample.op];
      const wrap = el("div", `blk-node cat-${meta.cat}`);
      const head = el("div", "blk-head");
      head.appendChild(el("span", "lbl", paletteLabel(sample, meta)));
      head.title = "tap to add it, or drag it onto the canvas";
      wrap.appendChild(head);
      attachDrag(head, { factory: make });
      box.appendChild(wrap);
    }
  }
  if (!box.children.length) box.appendChild(el("div", "blk-hint", "no blocks match"));
}

/* ───────────────────────── panels ───────────────────────── */

const narrow = (px) => window.matchMedia(`(max-width: ${px}px)`).matches;
function setDrawer(which, open) {
  // the run controls live in the rail: closing it while a run is going would
  // leave a simulation nobody can see or stop, so close = stop.
  if (which === "rail" && !open && simRunning) stopSim();
  document.body.classList.toggle(which + "-open", open);
  $(which === "rail" ? "rail-toggle" : "palette-toggle").classList.toggle("is-on", open);
  if (which === "rail" && open) drawSim();
  syncScrim();
}
// hide after the .is-closing animation. reopening clears the class, which makes
// the pending timeout a no-op — no need to track timers.
function fadeOut(el) {
  if (el.hidden || el.classList.contains("is-closing")) return;
  el.classList.add("is-closing");
  setTimeout(() => {
    if (!el.classList.contains("is-closing")) return;
    el.classList.remove("is-closing");
    el.hidden = true;
  }, 180);
}
function show(el) { el.classList.remove("is-closing"); el.hidden = false; }
function syncScrim() {
  const open = (document.body.classList.contains("rail-open") && narrow(1280))
    || (document.body.classList.contains("palette-open") && narrow(900));
  if (open) show($("scrim")); else fadeOut($("scrim"));
}
function openSheet(id) { show($(id)); show($("scrim")); }
function closeSheets() {
  fadeOut($("files-sheet"));
  if (narrow(1280)) setDrawer("rail", false);
  if (narrow(900)) setDrawer("palette", false);
  syncScrim();
}

/* ───────────────────────── views ───────────────────────── */

function setView(v) {
  if (v === view) return;
  if (view === "text" && !syncFromText()) return; // refuse to leave broken text
  view = v;
  $("pane-blocks").hidden = v !== "blocks";
  $("pane-text").hidden = v !== "text";
  $("tab-blocks").classList.toggle("is-on", v === "blocks");
  $("tab-text").classList.toggle("is-on", v === "text");
  if (v === "text") { $("code").value = serialize(program); renderActionBar(); }
  else render();
}

function syncFromText() {
  const { program: p, errors } = parse($("code").value);
  if (errors.length) { setStatus("fix the text first:\n" + errors.join("\n"), "is-err"); return false; }
  replaceProgram(p, "text applied");
  return true;
}

// live lint while typing in the text view (doesn't touch the tree)
let typeTimer;
function onType() {
  clearTimeout(typeTimer);
  typeTimer = setTimeout(() => {
    const { program: p, errors } = parse($("code").value);
    if (errors.length) setStatus(errors.slice(0, 4).join("\n"), "is-err");
    else {
      const w = lint(p);
      setStatus(w.length ? w[0] : `looks good — ${countNodes(p)} blocks, ~${fmtMs(estimate(p))} per pass`, w.length ? "" : "is-ok", w.length ? "warn" : "");
    }
  }, 250);
}

/* ───────────────────────── simulator + debugger ───────────────────────── */

const sim = new Sim("cave");
let simToken = 0, mySimToken = 0, simRunning = false;
let simPaused = false, stepMode = false, simSpeed = 2;
let simResume = null;

// live telemetry: the rover still drives in the sim, but conditions can read the
// real robot instead of the fake arena — handy for tuning thresholds on the bench.
let livePacket = null, liveMode = false;
if (window.io) {
  const sock = window.io();
  sock.on("sensor-data", (d) => {
    livePacket = d;
    $("live-dot").classList.add("on");
    if (liveMode) drawSim();
  });
  sock.on("disconnect", () => { livePacket = null; $("live-dot").classList.remove("on"); });
}
// what the interpreter's conditions read
const sensorSrc = () => (liveMode && livePacket ? livePacket : sim.sensors());

const PAUSE_LABEL = icon("pause") + " Pause";

const simLog = (t, cls, ico) => {
  const box = $("sim-log");
  const row = el("div", "sim-row" + (cls ? " " + cls : ""), t);
  box.appendChild(ico ? prefixIcon(row, ico) : row);
  while (box.children.length > 200) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
};
const realSleep = (ms) => new Promise(r => setTimeout(r, ms));

function drawSim() {
  sim.draw($("sim-canvas"));
  const s = sensorSrc();
  $("sim-tele").textContent =
    `${liveMode && livePacket ? "LIVE " : ""}dist ${Math.round(s.dist)}cm · yaw ${s.yaw}° · temp ${s.temp}°C · smoke ${s.smoke} · bumps ${sim.bumps} · t ${(sim.t / 1000).toFixed(1)}s`;
}

// advance sim time in slices so motion animates and conditions stay live
async function simAdvance(verb, pwm, ms) {
  const SLICE = 40;
  for (let done = 0; done < ms; done += SLICE) {
    if (simToken !== mySimToken) return;
    await waitIfPaused();
    const chunk = Math.min(SLICE, ms - done);
    sim.advance(verb, pwm, chunk);
    drawSim();
    if (simSpeed < 99) await realSleep(chunk / simSpeed);
    else if (done % 400 === 0) await realSleep(0); // let the ui breathe at max speed
  }
}

async function waitIfPaused() {
  while (simPaused && simToken === mySimToken) {
    await new Promise(r => { simResume = r; setTimeout(r, 120); });
  }
}

function setSimRunning(on) {
  simRunning = on;
  $("sim-run").textContent = on ? "■ Stop" : "▶ Run sim";
  $("sim-run").classList.toggle("is-stop", on);
  $("sim-pause").disabled = !on;
  $("sim-step").disabled = !on;
  if (!on) { simPaused = false; $("sim-pause").innerHTML = PAUSE_LABEL; }
}

function highlight(node) {
  for (const n of nodeEls.values()) n.classList.remove("is-live");
  const e = nodeEls.get(node);
  if (e) { e.classList.add("is-live"); e.scrollIntoView({ block: "nearest" }); }
}

function showVars(st) {
  const rows = Object.entries(st.vars).map(([k, v]) => `${k} = ${Math.round(v * 100) / 100}`);
  $("sim-vars").textContent = rows.length ? rows.join("  ·  ") : "no variables set";
}

async function askSageBool(question, telemetry) {
  try {
    const r = await fetch("/api/blk-ask", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, telemetry, sim: true }),
    });
    const d = await r.json();
    simLog(`ask "${question}" → ${d.yes ? "yes" : "no"}${d.text ? " · " + d.text : ""}`, d.yes ? "ok" : "");
    return !!d.yes;
  } catch (e) {
    simLog("ask failed: " + e.message, "err");
    return false;
  }
}

async function startSim() {
  if (simRunning) return;
  if (view === "text" && !syncFromText()) return;
  if (!document.body.classList.contains("rail-open")) setDrawer("rail", true);
  const my = ++simToken;
  mySimToken = my;
  simPaused = false;
  stepMode = false;
  if ($("sim-reset-on-run").checked) { sim.reset(); $("sim-log").innerHTML = ""; }
  simHits.clear();
  drawSim();
  setSimRunning(true);
  setStatus("simulating…");
  const stopped = () => simToken !== my;

  const io = {
    stopped,
    sleep: async (ms) => { await simAdvance("stop", 0, ms); },
    drive: async (verb, pwm, ms) => { await simAdvance(verb, pwm, ms); },
    halt: () => {},
    led: (v) => { sim.led = v; drawSim(); simLog("headlamp " + v); },
    say: (t) => simLog(t, "say", "volume"),
    log: (t) => simLog("• " + t),
    analyze: async (p) => { simLog("analyze" + (p ? ": " + p : "") + " (no camera in sim)", "ai"); await realSleep(300); },
    ask: async (q) => await askSageBool(q, sim.sensors()),
    find: async (t) => { simLog(`find "${t}" → needs the real camera, treating as no`, "ai"); return false; },
    sensors: sensorSrc,
    onStep: (node, n, st) => {
      simHits.set(node, (simHits.get(node) || 0) + 1);
      highlight(node);
      showVars(st);
    },
    gate: async (node) => {
      if (node._bp || stepMode) {
        simPaused = true;
        stepMode = false;
        $("sim-pause").textContent = "▶ Resume";
        simLog(node._bp ? "breakpoint" : "step", "bp");
      }
      await waitIfPaused();
      return stopped() ? "stop" : null;
    },
  };

  try {
    const res = await run(program, io);
    if (!stopped()) { simLog(res === "stopped" ? "program stopped" : "program finished", "ok"); setStatus("simulation " + res, "is-ok"); }
  } catch (e) {
    simLog("sim error: " + e.message, "err");
  } finally {
    if (simToken === my) { simToken++; mySimToken = simToken; }
    setSimRunning(false);
    for (const n of nodeEls.values()) n.classList.remove("is-live");
    render(); // repaint with the hit counts from this run
  }
}

function stopSim() {
  simToken++;
  mySimToken = simToken;
  simPaused = false;
  simResume?.();
  setSimRunning(false);
  simLog("stopped by operator");
}
const toggleSim = () => (simRunning ? stopSim() : startSim());

/* ───────────────────────── save / load ───────────────────────── */

async function refreshSaved(keep) {
  try {
    const { files } = await (await fetch("/api/blk")).json();
    $("saved").innerHTML = '<option value="">— saved —</option>' +
      files.map(f => `<option${f === keep ? " selected" : ""}>${f}</option>`).join("");
  } catch { /* server offline — editor still works */ }
}

async function save() {
  if (view === "text" && !syncFromText()) return null;
  const name = $("name").value.trim();
  if (!name) {
    openSheet("files-sheet");
    setStatus("give the workflow a name first", "is-err");
    $("name").focus();
    return null;
  }
  const r = await fetch("/api/blk/" + encodeURIComponent(name), {
    method: "POST", headers: { "Content-Type": "text/plain" }, body: serialize(program),
  }).catch(() => null);
  if (!r?.ok) { setStatus("save failed — is the server running?", "is-err"); return null; }
  setStatus(`saved "${name}"`, "is-ok");
  setName(name);
  refreshSaved(name);
  bc.postMessage("saved");
  return name;
}

function setName(name) {
  $("name").value = name;
  $("wf-name").textContent = name || "untitled";
}

function loadText(text, name, sourceLabel) {
  const { program: p, errors } = parse(text);
  setName(name);
  replaceProgram(p);
  setStatus(errors.length ? "skipped bad lines:\n" + errors.join("\n") : sourceLabel, errors.length ? "is-err" : "is-ok");
}

/* ───────────────────────── Sage ───────────────────────── */

const sageHist = [];
let sagePending = false;
const CODE_RE = /```(?:blk)?\s*\n([\s\S]*?)```/;

/* saved chats. a chat belongs to the operator, not to a workflow, so it lives in
   localStorage — no server round trip, and it survives a reload or a second tab.
   the live chat rewrites its own entry after every exchange; picking an old one
   restores its history, which is what gets sent back to Sage, so it continues.
   IMPORTANT NOTE: browser-local and capped. move to ./workflows-style files if
   chats ever need to follow the operator to another machine. */
const CHATS = "blk.sage.chats";
const CHAT_MAX = 20;   // chats kept, newest first
const CHAT_MSGS = 40;  // messages kept per chat
let chatId = null;

const readChats = () => { try { return JSON.parse(localStorage.getItem(CHATS)) || []; } catch { return []; } };
const writeChats = (l) => { try { localStorage.setItem(CHATS, JSON.stringify(l.slice(0, CHAT_MAX))); } catch { /* full/private mode — chats just don't persist */ } };

function saveChat() {
  if (!sageHist.length) return;
  chatId ||= String(Date.now());
  const title = sageHist.find(m => m.role === "user")?.content || "chat";
  writeChats([
    { id: chatId, ts: Date.now(), title: title.slice(0, 70), hist: sageHist.slice(-CHAT_MSGS) },
    ...readChats().filter(c => c.id !== chatId),
  ]);
}

function newChat() {
  chatId = null;
  sageHist.length = 0;
  showChats(false);
  $("sage-input").focus();
}

function showChats(on) {
  $("sage-list").hidden = !on;
  $("sage-msgs").hidden = on;
  $("sage-chats").classList.toggle("is-on", on);
  on ? renderChats() : renderSage();
}

function renderChats() {
  const box = $("sage-list");
  box.innerHTML = "";
  const list = readChats();
  if (!list.length) {
    box.appendChild(el("div", "sage-empty", "No saved chats yet — send Sage a message and this conversation saves itself."));
    return;
  }
  for (const c of list) {
    const row = el("div", "sage-row" + (c.id === chatId ? " is-on" : ""));
    const open = el("button", "btn-t sage-open");
    open.type = "button";
    open.appendChild(el("span", "t", c.title));
    open.appendChild(el("span", "when", `${new Date(c.ts).toLocaleString()} · ${c.hist.length} messages`));
    open.onclick = () => {
      chatId = c.id;
      sageHist.length = 0;
      sageHist.push(...c.hist);
      showChats(false);
    };
    const del = el("button", "icon-btn", "✕");
    del.type = "button";
    del.title = "Delete chat";
    del.onclick = () => {
      writeChats(readChats().filter(x => x.id !== c.id));
      if (c.id === chatId) chatId = null;
      renderChats();
    };
    row.append(open, del);
    box.appendChild(row);
  }
}

// crude line diff (common prefix/suffix) — enough to see what Sage changed
function diffLines(a, b) {
  const A = a.split("\n"), B = b.split("\n");
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let e = 0;
  while (e < A.length - s && e < B.length - s && A[A.length - 1 - e] === B[B.length - 1 - e]) e++;
  return [
    ...A.slice(0, s).map(l => [" ", l]),
    ...A.slice(s, A.length - e).map(l => ["-", l]),
    ...B.slice(s, B.length - e).map(l => ["+", l]),
    ...A.slice(A.length - e).map(l => [" ", l]),
  ];
}

function renderSage() {
  const box = $("sage-msgs");
  box.innerHTML = "";
  if (!sageHist.length && !sagePending) {
    box.innerHTML = '<div class="sage-empty">Tell me what the rover should do and I\'ll build the workflow — or switch the mode above to explain, fix, or improve what\'s on the canvas.<br><br>' +
      '"patrol forward and dodge obstacles"<br>"count how many walls you hit and say it"<br>"ask me before entering a hot room"</div>';
    return;
  }
  for (const m of sageHist) {
    const div = el("div", "sage-msg " + (m.role === "user" ? "is-user" : "is-sage"));
    if (m.role === "assistant") {
      const match = m.content.match(CODE_RE);
      const prose = m.content.replace(CODE_RE, "").trim();
      if (prose) div.appendChild(el("div", null, prose));
      if (match) {
        const code = match[1].trim();
        div.appendChild(el("pre", null, code));
        const row = el("div", "sage-actions");
        const act = (label, cls, fn) => {
          const b = el("button", "btn-t " + cls, label);
          b.type = "button";
          b.onclick = fn;
          row.appendChild(b);
        };
        act("Load into editor", "is-primary", () => {
          const { program: p, errors } = parse(code);
          if (errors.length) return setStatus("sage program has errors:\n" + errors.join("\n"), "is-err");
          replaceProgram(p);
          closeSage();
          setStatus("workflow loaded from Sage — tweak the blocks, then save", "is-ok");
        });
        act("Append", "", () => {
          const { program: p, errors } = parse(code);
          if (errors.length) return setStatus("sage program has errors:\n" + errors.join("\n"), "is-err");
          replaceProgram(program.concat(p));
          closeSage();
          setStatus("Sage's blocks appended", "is-ok");
        });
        act("Diff", "", () => {
          const d = el("pre", "sage-diff");
          for (const [sign, line] of diffLines(serialize(program), code)) {
            d.appendChild(el("div", sign === "+" ? "d-add" : sign === "-" ? "d-del" : "d-same", sign + " " + line));
          }
          div.appendChild(d);
        });
        div.appendChild(row);
      }
    } else div.textContent = m.content;
    box.appendChild(div);
  }
  if (sagePending) box.appendChild(el("div", "sage-msg is-sage is-think", "Sage is writing…"));
  box.scrollTop = box.scrollHeight;
}

async function sendSage(text) {
  if (sagePending) return;
  sageHist.push({ role: "user", content: text });
  sagePending = true;
  $("sage-send").disabled = true;
  showChats(false);   // sending from the chat list snaps back to the conversation
  try {
    const r = await fetch("/api/blk-sage", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: sageHist.slice(-20), program: serialize(program) }),
    });
    const d = await r.json();
    sageHist.push({ role: "assistant", content: d.reply || d.error || "No reply." });
  } catch (err) {
    sageHist.push({ role: "assistant", content: "Connection failed: " + err.message });
  }
  sagePending = false;
  $("sage-send").disabled = false;
  saveChat();
  renderSage();
  $("sage-input").focus();
}

function openSage(seed) {
  closeSheets();
  $("sage-modal").hidden = false;
  showChats(false);
  if (seed) sendSage(seed);
  else $("sage-input").focus();
}
function closeSage() {
  const m = $("sage-modal");
  if (m.hidden || m.classList.contains("is-closing")) return;
  m.classList.add("is-closing");
  setTimeout(() => { m.hidden = true; m.classList.remove("is-closing"); }, 200);
}

/* ───────────────────────── clipboard ───────────────────────── */

// blocks travel as .blk text, so a copy pastes into any editor (or a chat
// message) and back. the system clipboard is best-effort — an iframe without
// permission falls back to this in-page one.
let clip = "";
function copy() {
  if (!selected) return;
  clip = serialize([selected]);
  navigator.clipboard?.writeText(clip).catch(() => {});
  setStatus(`copied ${selected.op}`, "is-ok");
}
async function paste() {
  let text = clip;
  try {
    const sys = await navigator.clipboard?.readText();
    if (sys && !parse(sys).errors.length) text = sys;
  } catch { /* no permission — use the in-page clipboard */ }
  if (!text) return setStatus("clipboard is empty");
  const { program: p, errors } = parse(text);
  if (errors.length || !p.length) return setStatus("clipboard isn't blk", "is-err");
  for (const n of p) insertNode(n);
  setStatus(`pasted ${p.length} block${p.length === 1 ? "" : "s"}`, "is-ok");
}

/* ───────────────────────── wiring ───────────────────────── */

$("menu-btn").onclick = () => openSheet("files-sheet");
$("files-close").onclick = closeSheets;
$("scrim").onclick = closeSheets;

$("save").onclick = save;
// hand it straight to the console panel that owns the ble link — it runs it
$("save-run").onclick = async () => {
  const warns = lint(program);
  if (warns.length && !confirm(`Lint says:\n\n${warns.join("\n")}\n\nRun it on the rover anyway?`)) return;
  const name = await save();
  if (!name) return;
  closeSheets();
  if (window.parent === window) return setStatus("open the editor from the console to run on the rover", "is-err");
  window.parent.postMessage({ type: "blk:run", name }, "*");
  setStatus(`handed "${name}" to the console — watch the rover`, "is-ok");
};
$("new").onclick = () => {
  setName("");
  $("saved").value = "";
  replaceProgram([], "new workflow");
  closeSheets();
};
$("delete").onclick = async () => {
  const name = $("saved").value || $("name").value.trim();
  if (!name || !confirm(`Delete workflow "${name}"?`)) return;
  await fetch("/api/blk/" + encodeURIComponent(name), { method: "DELETE" }).catch(() => {});
  setStatus(`deleted "${name}"`, "is-ok");
  refreshSaved();
  bc.postMessage("saved");
};
$("saved").onchange = async () => {
  const name = $("saved").value;
  if (!name) return;
  const r = await fetch("/api/blk/" + encodeURIComponent(name)).catch(() => null);
  if (!r?.ok) return setStatus("load failed", "is-err");
  loadText(await r.text(), name, `loaded "${name}"`);
  closeSheets();
};
$("export").onclick = () => {
  if (view === "text" && !syncFromText()) return;
  // desktop shell: native save sheet. storage stays /api/blk either way.
  if (window.blackout) {
    window.blackout.saveFile({
      defaultName: ($("name").value.trim() || "workflow") + ".blk",
      data: serialize(program),
      filters: [{ name: "BLK workflow", extensions: ["blk"] }],
    });
    return;
  }
  const a = el("a");
  a.href = URL.createObjectURL(new Blob([serialize(program)], { type: "text/plain" }));
  a.download = ($("name").value.trim() || "workflow") + ".blk";
  a.click();
  URL.revokeObjectURL(a.href);
};
$("import").onclick = async () => {
  if (window.blackout) {
    const f = await window.blackout.openFile({ filters: [{ name: "BLK workflow", extensions: ["blk", "txt"] }] });
    if (!f) return;
    loadText(f.text, f.name.replace(/\.(blk|txt)$/i, ""), `imported "${f.name}" — save it to keep it`);
    closeSheets();
    return;
  }
  $("file").click();
};
$("file").onchange = async () => {
  const f = $("file").files[0];
  if (!f) return;
  loadText(await f.text(), f.name.replace(/\.(blk|txt)$/i, ""), `imported "${f.name}" — save it to keep it`);
  $("file").value = "";
  closeSheets();
};
$("name").oninput = () => { $("wf-name").textContent = $("name").value.trim() || "untitled"; };

$("tpl").innerHTML = '<option value="">— templates —</option>' +
  Object.keys(TEMPLATES).map(k => `<option>${k}</option>`).join("");
$("tpl").onchange = () => {
  const t = TEMPLATES[$("tpl").value];
  if (!t) return;
  loadText(t, $("name").value || $("tpl").value.toLowerCase().replace(/\W+/g, "-"), `template "${$("tpl").value}" loaded`);
  $("tpl").value = "";
  closeSheets();
};

$("undo").onclick = undo;
$("redo").onclick = redo;
$("tab-blocks").onclick = () => setView("blocks");
$("tab-text").onclick = () => setView("text");
$("code").oninput = onType;
$("code").onblur = () => { if (view === "text") syncFromText(); };
$("search").oninput = (e) => buildPalette(e.target.value);

/* selection action bar — the touch replacement for delete/duplicate keys */
$("act-up").onclick = () => selected && moveNode(selected, -1);
$("act-down").onclick = () => selected && moveNode(selected, 1);
$("act-dup").onclick = () => selected && duplicateNode(selected);
$("act-off").onclick = () => { if (selected) { selected.off = !selected.off; commit(selected.off ? "block disabled" : "block enabled"); } };
$("act-bp").onclick = () => { if (selected) { selected._bp = !selected._bp; render(); } };
$("act-del").onclick = () => selected && removeNode(selected);
$("act-close").onclick = () => { selected = null; render(); };

$("sim-run").onclick = toggleSim;
$("sim-pause").onclick = () => {
  simPaused = !simPaused;
  $("sim-pause").innerHTML = simPaused ? "▶ Resume" : PAUSE_LABEL;
  if (!simPaused) simResume?.();
};
$("sim-step").onclick = () => {
  stepMode = true;
  simPaused = false;
  $("sim-pause").innerHTML = PAUSE_LABEL;
  simResume?.();
};
$("sim-reset").onclick = () => { sim.reset(); $("sim-log").innerHTML = ""; drawSim(); };
$("sim-speed").onchange = (e) => { simSpeed = +e.target.value; };
$("sim-layout").innerHTML = Object.keys(LAYOUTS).map(k => `<option${k === "cave" ? " selected" : ""}>${k}</option>`).join("");
$("sim-layout").onchange = (e) => { sim.setLayout(e.target.value); drawSim(); };
for (const k of ["temp", "smoke", "airq", "humid"]) {
  const inp = $("env-" + k);
  inp.oninput = () => { sim.env[k] = +inp.value; $("env-" + k + "-v").textContent = inp.value; drawSim(); };
}
$("live-toggle").onchange = (e) => {
  liveMode = e.target.checked;
  setStatus(liveMode
    ? livePacket ? "conditions now read the live rover" : "live mode on — waiting for telemetry"
    : "conditions back on the simulated arena");
  drawSim();
};
// arena editing: tap drops or clears a wall, two-finger (or shift) tap moves the rover
$("sim-canvas").addEventListener("pointerup", (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * ARENA.w;
  const y = ((e.clientY - r.top) / r.height) * ARENA.h;
  if (e.shiftKey || e.isPrimary === false) sim.place(x, y);
  else sim.toggleObstacle(x, y);
  drawSim();
});
$("sim-canvas").onclick = (e) => e.preventDefault();

$("rail-toggle").onclick = () => setDrawer("rail", !document.body.classList.contains("rail-open"));
$("rail-close").onclick = () => setDrawer("rail", false);
$("palette-toggle").onclick = () => setDrawer("palette", !document.body.classList.contains("palette-open"));

$("ask-sage").onclick = () => openSage();
$("sage-close").onclick = closeSage;
$("sage-chats").onclick = () => showChats($("sage-list").hidden);
$("sage-new").onclick = newChat;
$("sage-modal").addEventListener("click", (e) => { if (e.target === $("sage-modal")) closeSage(); });
$("sage-form").onsubmit = (e) => {
  e.preventDefault();
  const q = $("sage-input").value.trim();
  if (!q) return;
  $("sage-input").value = "";
  sendSage(q);
};
$("sage-explain").onclick = () => openSage("Explain what this workflow does, step by step.");
$("sage-fix").onclick = () => openSage("Check this workflow for mistakes and safety problems, then give me a corrected version.");
$("sage-improve").onclick = () => openSage("Improve this workflow — make it smarter and safer without changing what it's for.");

/* keyboard — accelerators only, everything here is reachable by touch too */
window.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  const meta = e.metaKey || e.ctrlKey;
  if (e.key === "Escape") {
    if (!$("sage-modal").hidden) return closeSage();
    if (!$("files-sheet").hidden || !$("scrim").hidden) return closeSheets();
    if (selected) { selected = null; return render(); }
    if (window.parent !== window) window.parent.postMessage("blk:close", "*");
    return;
  }
  if (meta && e.key.toLowerCase() === "s") { e.preventDefault(); return save(); }
  if (meta && e.key.toLowerCase() === "z") { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
  if (meta && e.key.toLowerCase() === "y") { e.preventDefault(); return redo(); }
  if (meta && e.key.toLowerCase() === "e") { e.preventDefault(); return $("export").click(); }
  if (meta && e.key.toLowerCase() === "k") { e.preventDefault(); $("search").focus(); return; }
  if (meta && e.key === "Enter") { e.preventDefault(); return toggleSim(); }
  if (typing) return;
  if (meta && e.key.toLowerCase() === "v") { e.preventDefault(); return paste(); }
  if (!selected) return;
  if (meta && e.key.toLowerCase() === "c") { e.preventDefault(); return copy(); }
  if (meta && e.key.toLowerCase() === "x") { e.preventDefault(); copy(); return removeNode(selected); }
  if (meta && e.key.toLowerCase() === "d") { e.preventDefault(); return duplicateNode(selected); }
  if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); return removeNode(selected); }
  if (e.key === "ArrowUp" && e.altKey) { e.preventDefault(); return moveNode(selected, -1); }
  if (e.key === "ArrowDown" && e.altKey) { e.preventDefault(); return moveNode(selected, 1); }
});

/* boot */
try {
  const d = JSON.parse(localStorage.getItem(DRAFT) || "null");
  if (d?.text && d.text !== serialize(program)) {
    program = parse(d.text).program;
    base = snapshot(); // the restored draft is the starting point, not the template
    setName(d.name || "");
    setStatus("restored your unsaved draft" + (d.name ? ` ("${d.name}")` : ""), "is-ok");
  }
} catch { /* no draft */ }

// panels start open on a desktop-sized console, closed on a tablet
document.body.classList.toggle("palette-open", !narrow(900));
document.body.classList.toggle("rail-open", !narrow(1280));
$("rail-toggle").classList.toggle("is-on", !narrow(1280));
$("palette-toggle").classList.toggle("is-on", !narrow(900));

buildCats();
buildPalette();
render();
refreshSaved();
drawSim();
setSimRunning(false);
window.addEventListener("resize", () => { drawSim(); syncScrim(); });
