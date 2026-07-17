// sage answers in json. parseSage is tolerant
// strips json fences, grabs outer {...}, voices raw string on failure
// kept standalone so it's testable without booting server
// important: prompt-instructed json, not response_format:json_object
// gemma-on-cerebras might not support it. switch to response_format once confirmed.
const SAGE_STATUS = new Set(["clear", "caution", "danger"]);

// lamp level 0-255. non-number or out-of-range -> null ("leave it alone")
function parseLed(v) {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.max(0, Math.min(255, Math.round(n))) : null;
}

// a discovery worth keeping, e.g. "drawing detected: looks like a bison". null most turns.
// capped at 140 chars for one panel row.
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
