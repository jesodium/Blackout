// Sage's system prompts (prompts/*.md) and the language lines stacked on them.
const fs = require("fs");
const path = require("path");
const state = require("../state");

const loadPrompt = (name) => fs.readFileSync(path.join(__dirname, "..", "..", "prompts", name), "utf8").trim();
const AI_SYSTEM = loadPrompt("analysis.md");
// robot.md is the fact sheet: what she answers "what sensors do you have" from.
const CHAT_SYSTEM = loadPrompt("chat.md") + "\n\n" + loadPrompt("robot.md");
const BLK_SYSTEM = loadPrompt("blk.md");

const PRESENT_SYSTEM = loadPrompt("present.md");
// CONSOLE -> DEMO: interview/stand mode, stacked on every CHAT_SYSTEM and on
// the analysis. Last value any client sent wins, same as lampAllowed.
const DEMO_SYSTEM = loadPrompt("demo.md");
const demoLine = () => state.demoMode ? [{ role: "system", content: DEMO_SYSTEM }] : [];

// ---- language ----
const LANG_INSTRUCT = {
  es: "IMPORTANTE: Responde SIEMPRE en español natural y fluido, sin importar el idioma de las lecturas, etiquetas o del mensaje del operador. Mantén tu personaje y tono. Las CLAVES y los VALORES fijos del JSON (text, status, tool, led, finding, snapshot, move, arm, tape; clear/caution/danger; camera/armcam/sensors) se escriben SIEMPRE en inglés: solo el texto que se lee en voz alta va en español.",
};
const langMsg = (lang) => (LANG_INSTRUCT[lang] ? [{ role: "system", content: LANG_INSTRUCT[lang] }] : []);

// The same instruction again, short, to be appended AFTER the picture. Recency
// is the only lever: with an image in the turn, a language line sitting up in
// the system block loses to the image and she answers in English -- measured on
// this cam's own stills, 1 reply in 8 came back Spanish that way against 7 in 8
// with the line moved below the image. Text-only turns hold either way.
const LANG_TAIL = {
  es: 'RECUERDA: el valor de "text" del JSON va en ESPAÑOL. Nada de inglés en "text".',
};
const langOf = (msgs) => Object.keys(LANG_INSTRUCT).find(
  (l) => msgs.some((m) => m.role === "system" && m.content === LANG_INSTRUCT[l]));

// Append that reminder to the last user turn, past any image parts.
function langLast(msgs) {
  const tail = LANG_TAIL[langOf(msgs)];
  const i = msgs.map((m) => m.role).lastIndexOf("user");
  if (!tail || i < 0) return msgs;
  const c = msgs[i].content, out = msgs.slice();
  out[i] = { ...msgs[i], content: Array.isArray(c) ? [...c, { type: "text", text: tail }] : `${c}\n\n${tail}` };
  return out;
}

module.exports = { AI_SYSTEM, CHAT_SYSTEM, BLK_SYSTEM, PRESENT_SYSTEM, demoLine, LANG_INSTRUCT, langMsg, langLast };
