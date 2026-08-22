// icons self-check: an icon is three things that have to line up — the name in
// icons.mjs, the drawing in public/icons/<name>.svg, and the `.icn-<name>` mask
// rule in the css. miss one and the icon renders as an empty box, silently.
// also fails if an emoji creeps back into the ui.
//   node test-icons.mjs   (npm run test:icons)
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ICON_NAMES } from "./public/js/icons.mjs";

const ROOT = "public";
const SKIP = new Set(["vendor", "audio", "models", "onboard", "findings", "icons"]);

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (!SKIP.has(e)) walk(p); }
    else if (/\.(html|js|mjs|css)$/.test(e)) files.push(p);
  }
})(ROOT);

let bad = 0;
const fail = (msg) => { console.error("FAIL " + msg); bad++; };

// every css that styles icons needs the whole set — the dashboard and the blk
// editor have separate stylesheets, and a rule missing from one is invisible
// until someone opens that page.
const SHEETS = ["public/css/style.css", "public/blk.html"];

for (const n of ICON_NAMES) {
  const svg = `public/icons/${n}.svg`;
  if (!existsSync(svg)) { fail(`${svg} missing — icons.mjs names it`); continue; }
  const d = readFileSync(svg, "utf8");
  if (!/<(path|circle|rect)/.test(d)) fail(`${svg} draws nothing`);
  for (const sheet of SHEETS) {
    if (!readFileSync(sheet, "utf8").includes(`.icn-${n} {`)) fail(`${sheet}: no .icn-${n} rule`);
  }
}

// a drawing nobody names is dead weight
for (const f of readdirSync("public/icons")) {
  if (!ICON_NAMES.includes(f.replace(/\.svg$/, ""))) fail(`public/icons/${f} — not in ICON_NAMES`);
}

// emoji = Extended_Pictographic (⚠ ⚙ ⏸ 🗑 🔊 … — half of them go colour only
// with a VS16, which is exactly the per-machine lottery we're avoiding), minus
// the terminal glyphs the ui keeps on purpose. ✕ ● ○ △ ■ etc. aren't
// pictographic at all, so they never trip this.
const KEEP = "▶◀✔↔";
const EMOJI = /\p{Extended_Pictographic}️?/gu;

for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/\bicon\(\s*["']([^"']+)["']/g)) {
    if (!ICON_NAMES.includes(m[1])) fail(`${f}: icon("${m[1]}") — not in icons.mjs`);
  }
  for (const m of src.matchAll(/\bicn-([a-z]+)/g)) {
    if (!ICON_NAMES.includes(m[1]) && !f.endsWith(".css") && !f.endsWith(".html")) {
      fail(`${f}: .icn-${m[1]} — not in icons.mjs`);
    }
  }
  for (const m of src.matchAll(EMOJI)) {
    if (KEEP.includes(m[0])) continue;
    fail(`${f}: emoji ${JSON.stringify(m[0])} — use an icon from js/icons.mjs`);
  }
}

console.log(bad ? `\n${bad} problem(s)` : `ok — ${ICON_NAMES.length} icons, ${files.length} files clean`);
process.exit(bad ? 1 : 0);
