// sage answers in json. parseSage is tolerant
// strips json fences, grabs outer {...}, voices raw string on failure
// kept standalone so it's testable without booting server
// important: prompt-instructed json, not response_format:json_object
// not every provider on the fallback list supports it. switch once both do.
const SAGE_STATUS = new Set(["clear", "caution", "danger"]);

// tools sage can reach for on her own turn. the loop in server.js runs the one she
// names, hands her the result and asks again — that is the whole agent loop.
// "camera" is the old action:"analyze" under a name that reads like a tool; the
// other prompts still say action, so that spelling keeps working.
const SAGE_TOOLS = new Set(["camera", "sensors"]);
// "sensors:temperature" — the part after the colon is what she went looking for,
// in her own words and her own language, so the transcript can say "Sage used
// temperature readings" instead of the generic tool name.
function parseTool(o) {
  const raw = typeof o.tool === "string" ? o.tool.trim() : "";
  const [head, ...rest] = raw.split(":");
  const name = head.trim().toLowerCase();
  if (SAGE_TOOLS.has(name)) return { tool: name, toolArg: rest.join(":").trim().slice(0, 40) || null };
  return { tool: o.action === "analyze" ? "camera" : null, toolArg: null };
}

// lamp level 0-255. non-number or out-of-range -> null ("leave it alone")
function parseLed(v) {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.max(0, Math.min(255, Math.round(n))) : null;
}

// a reason to keep the last 10 seconds of telemetry, e.g. "readings are jumping and
// I can't tell why". null nearly every turn.
const parseSnapshot = (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 140) : null);

// one line describing a window of telemetry: what moved, and between what. this is
// what the operator actually reads — the raw packets stay in the json on disk.
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

// a discovery worth keeping, e.g. "drawing detected: looks like a bison". null most turns.
// capped at 140 chars for one panel row.
function parseFinding(v) {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, 140) : null;
}

// the agent loop is bounded on purpose: every extra pass is another paid round
// trip the operator sits through, and a model that keeps asking for the camera
// would never answer. the last pass always answers instead of reaching again.
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
      };
    } catch { /* fall through to raw */ }
  }
  return { text: s, status: null, action: null, tool: null, toolArg: null, led: null, finding: null, snapshot: null };
}

module.exports = { parseSage, snapSummary, wantsTool, SAGE_TOOLS };
