// every mood the face can take has its css, every glyph it draws is styled, and every
// mood sage.jsx asks for exists — a mood with no rule renders blank, not an error

import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL("../web/" + p, import.meta.url), "utf8");
const face = read("SageFace.jsx");
const css = read("SageFace.css");
const app = read("sage.jsx");

const moods = face.match(/export const MOODS = \[([^\]]+)\]/)[1].match(/'(\w+)'/g).map(s => s.slice(1, -1));
const fail = [];

for (const m of moods) {
  if (!css.includes(`.sage-face.is-${m}`)) fail.push(`mood "${m}" has no .sage-face.is-${m} rule in SageFace.css`);
}
for (const [, cls] of face.matchAll(/className="(sf-[\w-]+)/g)) {
  if (!css.includes("." + cls)) fail.push(`shape .${cls} is drawn but never styled`);
}
for (const [, m] of app.matchAll(/<SageFace mood="(\w+)"/g)) {
  if (!moods.includes(m)) fail.push(`sage.jsx passes mood "${m}" — not in MOODS`);
}

console.log(`${moods.length} moods · ${fail.length} problems`);
if (fail.length) { for (const f of fail) console.error("  ✗ " + f); process.exit(1); }
console.log("✔ sage face wired");
