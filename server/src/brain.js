// The model behind Sage. Cerebras only, PAID (PayGo credit since 2026-09-29 — its
// free tier ended 2026-08-17). Still a list, so chat()'s retry pass is unchanged
// and a second brain is one row if it is ever wanted.
const OpenAI = require("openai");

// qwen puts a paragraph of thinking in front of every reply unless this is off.
const CEREBRAS_TUNE = (process.env.CEREBRAS_MODEL || "qwen").startsWith("qwen") ? { reasoning_effort: "none" } : {};
const BRAINS = [
  ["cerebras", process.env.CEREBRAS_API_KEY, "https://api.cerebras.ai/v1", process.env.CEREBRAS_MODEL || "qwen-3.8-27b", CEREBRAS_TUNE],
].filter(([, key]) => key).map(([name, key, baseURL, model, tune]) => ({ name, model, tune, baseURL, client: new OpenAI({ baseURL, apiKey: key, maxRetries: 0 }) }));
const hasAI = BRAINS.length > 0;

const BRAIN_DEAD = new Set([401, 402, 403, 404]);

async function chat(params) {
  // Cerebras 400s ("System message must be at the beginning") on the SECOND system
  // message, which is exactly what langMsg() adds when the dashboard is in Spanish —
  // so every es turn died with a bodyless 400. Fold them into one, here rather than at
  // the four call sites, so a new prompt can't reintroduce it.
  const sys = params.messages.filter((m) => m.role === "system");
  if (sys.length > 1) params = { ...params, messages: [
    { role: "system", content: sys.map((m) => m.content).join("\n\n") },
    ...params.messages.filter((m) => m.role !== "system"),
  ] };
  let last;
  for (let pass = 0; pass < 2; pass++) {
    for (const b of BRAINS) {
      // A brain dropped on an earlier call leaves nothing to throw, and the
      // caller then reported "AI key not set" for a key that was set fine — a
      // wrong model name read as a missing key for a whole session. Carry
      // the reason it died.
      if (b.dead) { last = last || b.deadErr; continue; }
      if (pass && b.cooled) continue;
      try { return await b.client.chat.completions.create({ model: b.model, ...b.tune, ...params }); }
      catch (e) {
        last = e;

        if (e.status === 429) { b.cooled = true; console.error(`${b.name} rate-limited — skipping the retry pass`); continue; }
        if (BRAIN_DEAD.has(e.status)) { b.dead = e.status; b.deadErr = new Error(`${b.name} (${b.model}) is out for this session: ${e.status} ${e.message}`); }
        console.error(`${b.name} (${b.model}) failed:`, e.status || "", e.message, b.dead ? "— dropping it for this session" : "");
      }
    }
    if (BRAINS.every((b) => b.dead)) break;
    await new Promise((r) => setTimeout(r, 800));
  }
  throw last || new Error("AI key not set");
}

module.exports = { BRAINS, hasAI, chat };
