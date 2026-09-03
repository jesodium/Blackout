// parsing for sage's json replies — the tool call rides in the json, not in a
// provider function-calling api, because the three brains spell that three ways.

const SAGE_STATUS = new Set(["clear", "caution", "danger"]);

const SAGE_TOOLS = new Set(["camera", "sensors"]);

function parseTool(o) {
  const raw = typeof o.tool === "string" ? o.tool.trim() : "";
  const [head, ...rest] = raw.split(":");
  const name = head.trim().toLowerCase();
  if (SAGE_TOOLS.has(name)) return { tool: name, toolArg: rest.join(":").trim().slice(0, 40) || null };
  return { tool: o.action === "analyze" ? "camera" : null, toolArg: null };
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
                             // ARM_JOG_MS (800) in arm.h so nothing stutters
const ARM_MAX_TAKES = 3;     // she asks for a move, not a routine

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

// One recorded take per line, by name, into the flat {ms, cmd} tape the pad
// already replays. An unknown name throws the whole thing out — a half-run arm
// proposal is a joint turning for a reason nobody wrote down.
function parseArm(v, moves = {}) {
  const lines = String(v || "").split("\n").map((s) => s.trim()).filter(Boolean);
  if (!lines.length || lines.length > ARM_MAX_TAKES) return null;
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
  return { text: names.join("\n"), tape };
}

function parseFinding(v) {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, 140) : null;
}

const wantsTool = (sage, step, max) => !!(sage && sage.tool) && step < max - 1;

function parseSage(raw, armMoves) {
  const s = String(raw || "").trim();
  const start = s.indexOf("{"), end = s.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const o = JSON.parse(s.slice(start, end + 1));
      return {
        text: String(o.text || "").trim() || s,
        status: SAGE_STATUS.has(o.status) ? o.status : null,
        action: o.action === "analyze" ? "analyze" : null,
        ...parseTool(o),
        led: parseLed(o.led),
        finding: parseFinding(o.finding),
        snapshot: parseSnapshot(o.snapshot),
        move: parseMove(o.move),
        arm: parseArm(o.arm, armMoves),
      };
    } catch {  }
  }
  return { text: s, status: null, action: null, tool: null, toolArg: null, led: null, finding: null, snapshot: null, move: null, arm: null };
}

module.exports = { parseSage, snapSummary, wantsTool, SAGE_TOOLS, parseArm, armMovesFor, ARM_REPEAT_MS, ARM_MAX_TAKES };
