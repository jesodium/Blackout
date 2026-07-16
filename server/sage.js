// Sage answers in JSON: { text, status, action, led, finding }. parseSage is tolerant — strips
// ```json fences, grabs the outer {...}, and on any failure just voices the raw
// string so a malformed turn still talks. Kept standalone so it's testable without
// booting the server (see test-vision.js).
// IMPORTANT NOTE: prompt-instructed JSON, not response_format:json_object — gemma-on-
// Cerebras support is unconfirmed and a rejected param errors the whole call. Switch
// to response_format once the model is known to honor it.
const SAGE_STATUS = new Set(["clear", "caution", "danger"]);

// Lamp level, 0-255. A model that answers "bright" or 999 shouldn't reach the cam,
// so anything not a real in-band number reads as "leave it alone".
function parseLed(v) {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.max(0, Math.min(255, Math.round(n))) : null;
}

// A discovery worth keeping: "DRAWING DETECTED: looks like a bison". Null on nearly
// every turn. Capped because it's a panel row, not a second report — a model that
// answers with a whole paragraph gets trimmed, not obeyed.
function parseFinding(v) {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, 140) : null;
}

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
        led: parseLed(o.led),
        finding: parseFinding(o.finding),
      };
    } catch { /* fall through to raw */ }
  }
  return { text: s, status: null, action: null, led: null, finding: null };
}

module.exports = { parseSage };
