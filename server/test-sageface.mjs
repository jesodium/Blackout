// sage's face is pure css: a mood app.js can reach but style.css never styles
// renders a blank/wrong face with no error anywhere. this is that check.
//   node test-sageface.mjs
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const face = read("./public/js/sageface.js");
const css = read("./public/css/style.css");
const app = read("./public/js/app.js");

const moods = face.match(/export const MOODS = \[([^\]]+)\]/)[1].match(/"(\w+)"/g).map(s => s.slice(1, -1));
const fail = [];

// 1. every mood is styled (or is the default cast — say so out loud, don't assume)
for (const m of moods) {
  if (!css.includes(`.sage-face.is-${m}`)) fail.push(`mood "${m}" has no .sage-face.is-${m} rule in style.css`);
}
// 2. every shape the svg draws is styled
for (const [, cls] of face.matchAll(/class="(sf-[\w-]+)/g)) {
  if (!css.includes("." + cls)) fail.push(`shape .${cls} is drawn but never styled`);
}
// 3. every mood app.js can pass is a real mood
const intents = [...app.match(/const INTENTS = \{[\s\S]+?\n\};/)[0].matchAll(/^ {2}(\w+):/gm)].map(m => m[1]);
const flash = [...app.match(/const FLASH_MOOD = \{[^}]+\}/)[0].matchAll(/"(\w+)"/g)].map(m => m[1]);
const literal = [...app.matchAll(/<\$\{SageFace} mood="(\w+)"/g)].map(m => m[1]);
for (const m of [...intents, ...flash, ...literal]) {
  if (!moods.includes(m)) fail.push(`app.js passes mood "${m}" — not in MOODS`);
}

console.log(`${moods.length} moods · ${intents.length} intents · ${fail.length} problems`);
if (fail.length) { for (const f of fail) console.error("  ✗ " + f); process.exit(1); }
console.log("✔ sage face wired");
