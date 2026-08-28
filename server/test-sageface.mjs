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
// 2. every part the face renders is styled
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

// 4. the panel draws the same ascii (FACE_G in main.ino). two copies of a face
// that drift apart is a robot and a dashboard wearing different masks.
const ino = read("../giga-r1/main/main.ino");
const order = ino.match(/enum \{ (FACE_\w+(?:, FACE_\w+)*), FACE_N \}/)[1]
  .split(",").map(s => s.trim().slice(5).toLowerCase());
const rows = [...ino.match(/FACE_G\[FACE_N\]\[3\] = \{([\s\S]+?)\n\};/)[1].matchAll(/\{([^}]+)\}/g)]
  .map(m => m[1].split(",").map(c => (c.trim() === "0" ? "" : c.trim().slice(1, -1))));
const jsFaces = Object.fromEntries([...face.matchAll(/^ {2}(\w+): *\[(.+?)\],/gm)]
  .map(([, k, v]) => [k, [...v.matchAll(/"(.*?)"/g)].map(m => m[1])]));
if (order.length !== rows.length) fail.push(`FACE_G has ${rows.length} rows for ${order.length} moods`);
order.forEach((m, i) => {
  if (!moods.includes(m)) return fail.push(`main.ino draws FACE_${m.toUpperCase()} — not in MOODS`);
  const js = jsFaces[m], ino = rows[i];
  if (!ino || js.join("") !== ino.join(""))
    fail.push(`face "${m}": js draws ${js.join("")}, the panel draws ${(ino || []).join("")}`);
});

// 5. the panel's motion maths, re-run off the sketch's own constants. tri() is
// integer division on the draw path — an amp it overshoots is a face that walks out
// of its column, and a jump bigger than a pixel is the stutter this replaced.
const CYCLE = +ino.match(/#define FACE_CYCLE (\d+)/)[1];
const tri = (p, period, amp) => { const x = Math.trunc(p * 4 * amp / period); return x <= 2 * amp ? x - amp : 3 * amp - x; };
for (const amp of [1, 2, 3, 6]) {
  let prev = tri(0, CYCLE, amp), worst = 0, seen = new Set();
  for (let p = 0; p < CYCLE; p++) {
    const v = tri(p, CYCLE, amp);
    if (v < -amp || v > amp) fail.push(`tri(amp ${amp}) left the column at ${p}ms: ${v}px`);
    worst = Math.max(worst, Math.abs(v - prev)); prev = v; seen.add(v);
  }
  if (worst > 1) fail.push(`tri(amp ${amp}) jumps ${worst}px between milliseconds — not a sweep`);
  if (tri(0, CYCLE, amp) !== -amp || tri(CYCLE / 2, CYCLE, amp) !== amp) fail.push(`tri(amp ${amp}) doesn't span -amp..amp`);
  if (seen.size < 2 * amp + 1) fail.push(`tri(amp ${amp}) only ever lands on ${seen.size} positions`);
}
// two positions is a cut between two stills, not motion — whatever the frame rate.
for (const g of ino.matchAll(/mood == FACE_(\w+)\)[^\n]*?(?:tri|arc)\([^)]+?, (\d+)\)/g))
  if (+g[2] < 2) fail.push(`FACE_${g[1]} travels ${g[2]}px — that reads as two stills, not motion`);
// the panel and the browser keep the same clock, or the same face moves at two speeds
// on two screens in the same room.
const secs = (n) => Math.round(+css.match(new RegExp(n + " ([\\d.]+)s"))[1] * 1000);
if (CYCLE !== secs("sf-bob")) fail.push(`face cycle is ${CYCLE}ms on the panel, ${secs("sf-bob")}ms in css`);
const shake = +ino.match(/FACE_ALERT\) dx = tri\(ms % (\d+),/)[1];
if (shake !== secs("sf-shake")) fail.push(`alert shakes every ${shake}ms on the panel, ${secs("sf-shake")}ms in css`);
// the freeze this all hinged on: the sonar's ring-down wait has to draw through.
const median = ino.match(/float medianPingCm\(\)[\s\S]+?\n\}/)[0];
if (/(?<!panel)delay\(/.test(median))
  fail.push("medianPingCm() waits on a bare delay() — the panel freezes ~180ms a send");

console.log(`${moods.length} moods · ${order.length} on the panel · ${intents.length} intents · ${fail.length} problems`);
if (fail.length) { for (const f of fail) console.error("  ✗ " + f); process.exit(1); }
console.log("✔ sage face wired");
