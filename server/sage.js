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

function parseFinding(v) {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, 140) : null;
}

const wantsTool = (sage, step, max) => !!(sage && sage.tool) && step < max - 1;

function parseSage(raw) {
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
      };
    } catch {  }
  }
  return { text: s, status: null, action: null, tool: null, toolArg: null, led: null, finding: null, snapshot: null, move: null };
}

module.exports = { parseSage, snapSummary, wantsTool, SAGE_TOOLS };
