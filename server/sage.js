// parsing for sage's json replies — the tool call rides in the json, not in a
// provider function-calling api, because the three brains spell that three ways.

const SAGE_STATUS = new Set(["clear", "caution", "danger"]);

// The language instruction tells her to answer in Spanish and she translates the
// json KEYS along with the prose: {"texto", "estado":"claro", "herramienta":null}
// parsed as an all-null reply, so a Spanish dashboard lost every tool, card and
// status she asked for while the text still read fine. The prompts say the keys
// stay English; this is the belt, at the one place the json is read. Any word
// that is already an English key or value maps to itself, so this is a no-op on
// an English reply.
const ES = {
  texto: "text", estado: "status", accion: "action", "acci\u00f3n": "action",
  herramienta: "tool", hallazgo: "finding", captura: "snapshot",
  mover: "move", movimiento: "move", brazo: "arm", cinta: "tape", luz: "led",
  claro: "clear", despejado: "clear", precaucion: "caution",
  "precauci\u00f3n": "caution", peligro: "danger",
  camara: "camera", "c\u00e1mara": "camera", sensores: "sensors",
  analizar: "analyze",
};
const deEs = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [ES[k.toLowerCase()] || k, v]));

const SAGE_TOOLS = new Set(["camera", "armcam", "sensors"]);

function parseTool(o) {
  const raw = typeof o.tool === "string" ? o.tool.trim() : "";
  const [head, ...rest] = raw.split(":");
  const name = ES[head.trim().toLowerCase()] || head.trim().toLowerCase();
  if (SAGE_TOOLS.has(name)) return { tool: name, toolArg: rest.join(":").trim().slice(0, 40) || null };
  return { tool: (ES[String(o.action).toLowerCase()] || o.action) === "analyze" ? "camera" : null, toolArg: null };
}

function parseLed(v) {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.max(0, Math.min(255, Math.round(n))) : null;
}

const parseSnapshot = (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 140) : null);

const SNAP_FIELDS = [["temp", "\u00b0C"], ["humid", "%"], ["dist", "cm"], ["lux", "lx"], ["alt", "m"]];
function snapSummary(packets) {
  if (!packets.length) return "no readings";
  const r = (n) => Math.round(n * 10) / 10;
  const bits = [];
  for (const [k, unit] of SNAP_FIELDS) {
    const vs = packets.map((p) => p[k]).filter((v) => typeof v === "number" && !isNaN(v));
    if (!vs.length) continue;
    const lo = Math.min(...vs), hi = Math.max(...vs);
    bits.push(lo === hi ? `${k} ${r(lo)}${unit}` : `${k} ${r(lo)}-${r(hi)}${unit}`);
  }
  const span = (packets[packets.length - 1].timestamp - packets[0].timestamp) / 1000;
  return `${packets.length} readings over ${span.toFixed(1)}s \u00b7 ${bits.join(", ")}`;
}

const parseMove = (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 400) : null);

// ---- arm ----
// Sage does NOT drive the arm. She picks one of the takes recorded on the bench
// with arm-configurator.sh, by name, and the operator presses YES — so every arm
// move she can ask for is one somebody already ran on the bench and kept.
// There is deliberately no "jog joint N for 600ms": a freeform burst is how a
// 360 with no encoder winds itself into the frame, and vetting each move once,
// off-line, is the whole point of the recorder.
const ARM_REPEAT_MS = 300;   // gap left between chained takes; must stay under
                             // ARM_JOG_MS in arm.h so nothing stutters

// A take in arm_moves/<name>.json is either a bare list of steps — everything
// before the flags existed, and those count as usable everywhere — or
// {steps, sage_can_use, show_in_app}. The bench fills up with debug takes, and a
// debug take is exactly what should not be one tap away on comp day or in Sage's
// hands, so the flags are per take and set in the configurator. `which` is the
// flag that gates this caller; the bench itself plays anything regardless.
function armMovesFor(all, which) {
  const out = {};
  for (const [name, v] of Object.entries(all || {})) {
    const steps = Array.isArray(v) ? v : v?.steps;
    const on = Array.isArray(v) ? true : v?.[which] !== false;
    if (on && Array.isArray(steps) && steps.length) out[name] = steps;
  }
  return out;
}

// The third flag, and the only one that is not about hiding a take:
// `sage_ask_permission_for_this` false means this take needs no YES — a spoken
// hello is not a thing to ask permission for, and a card in front of it is the
// pause that makes a greeting land wrong. Missing = true, like the other two, so
// anything that moves the rover keeps its card until somebody says otherwise.
// It does NOT ride in the map above: that map's values are steps arrays all the
// way down (/api/arm-moves hands them to the browser), so the flag is read off
// the raw take here and returned as its own field on the proposal.
const askFor = (all, name) => {
  const v = all?.[name];
  return Array.isArray(v) ? true : v?.sage_ask_permission_for_this !== false;
};

// One recorded take per line, by name, into the flat {ms, cmd} tape the pad
// already replays. An unknown name throws the whole thing out — a half-run arm
// proposal is a joint turning for a reason nobody wrote down.
function parseArm(v, moves = {}, raw = null) {
  const lines = String(v || "").split("\n").map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return null;
  const names = [], tape = [];
  let at = 0;
  for (const line of lines) {
    const want = line.replace(/^play\s+/i, "").trim().toLowerCase();
    const key = Object.keys(moves).find((k) => k.toLowerCase() === want);
    const steps = key && Array.isArray(moves[key]) ? moves[key] : null;
    if (!steps || !steps.length) return null;
    for (const st of steps) tape.push({ ms: at + st.ms, cmd: st.cmd });
    at += steps[steps.length - 1].ms + ARM_REPEAT_MS;
    names.push(key);
  }
  return { text: names.join("\n"), tape, ask: names.some((n) => askFor(raw || moves, n)) };
}

// ---- tapes ----
// A whole run the crew drove by hand and kept (server/tapes/). She names ONE,
// exactly as written, and the operator presses YES — same gate as an arm take,
// and for the same reason: the driving was vetted once, when it was recorded.
// One at a time on purpose — a tape is a whole run, so chaining two is a routine
// nobody has rehearsed.
function parseTape(v, tapes = {}, raw = null) {
  const want = String(v || "").trim().replace(/^play\s+/i, "").toLowerCase();
  if (!want || want.includes("\n")) return null;
  const key = Object.keys(tapes).find((k) => k.toLowerCase() === want);
  const steps = key && Array.isArray(tapes[key]) ? tapes[key] : null;
  return steps && steps.length ? { text: key, tape: steps, ask: askFor(raw || tapes, key) } : null;
}

function parseFinding(v) {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, 140) : null;
}

// A reply whose json never closed — she runs out of max_tokens mid-string, and
// Spanish runs ~25% longer than English for the same sentence, so it is the
// Spanish dashboard that hits it — used to fall through to `text: s` and the
// operator got the raw braces read out loud. Pull the text field out by hand
// instead: a sentence cut short still reads as a sentence.
function salvage(s) {
  const m = s.match(/"(?:text|texto)"\s*:\s*"((?:\\.|[^"\\])*)/);
  if (!m) return s;
  try { return JSON.parse('"' + m[1].replace(/\\+$/, "") + '"').trim() || s; } catch { return m[1]; }
}

const wantsTool = (sage, step, max) => !!(sage && sage.tool) && step < max - 1;

// armMoves/tapes are the RAW folders (readTakes), not a filtered map: the
// flags are read here so `sage_can_use` and `sage_ask_permission_for_this` come
// off the same take. A map that has already been filtered still works — every
// value is then a bare steps array, which reads as "usable, and it asks".
function parseSage(raw, armMoves, tapes) {
  const s = String(raw || "").trim();
  const start = s.indexOf("{"), end = s.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const o = deEs(JSON.parse(s.slice(start, end + 1)));
      const status = ES[String(o.status).toLowerCase()] || o.status;
      return {
        text: String(o.text || "").trim() || s,
        status: SAGE_STATUS.has(status) ? status : null,
        action: (ES[String(o.action).toLowerCase()] || o.action) === "analyze" ? "analyze" : null,
        ...parseTool(o),
        led: parseLed(o.led),
        finding: parseFinding(o.finding),
        snapshot: parseSnapshot(o.snapshot),
        move: parseMove(o.move),
        arm: parseArm(o.arm, armMovesFor(armMoves, "sage_can_use"), armMoves),
        tape: parseTape(o.tape, armMovesFor(tapes, "sage_can_use"), tapes),
      };
    } catch { console.warn("sage: reply is not valid json (cut off?) — salvaging text"); }
  }
  return { text: start !== -1 ? salvage(s) : s, status: null, action: null, tool: null, toolArg: null, led: null, finding: null, snapshot: null, move: null, arm: null, tape: null };
}

module.exports = { parseSage, snapSummary, askFor, wantsTool, SAGE_TOOLS, parseArm, parseTape, armMovesFor, ARM_REPEAT_MS };
