// Sage answers in JSON: { text, status, action }. parseSage is tolerant — strips
// ```json fences, grabs the outer {...}, and on any failure just voices the raw
// string so a malformed turn still talks. Kept standalone so it's testable without
// booting the server (see test-vision.js).
// IMPORTANT NOTE: prompt-instructed JSON, not response_format:json_object — gemma-on-
// Cerebras support is unconfirmed and a rejected param errors the whole call. Switch
// to response_format once the model is known to honor it.
const SAGE_STATUS = new Set(["clear", "caution", "danger"]);

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
      };
    } catch { /* fall through to raw */ }
  }
  return { text: s, status: null, action: null };
}

module.exports = { parseSage };
