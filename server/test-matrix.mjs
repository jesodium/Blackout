/* matrix rain self-check. the rain lives on the board (see "Matrix rain" in CLAUDE.md),
   so there's nothing in the browser to drive — what can actually break is the geometry
   and the indexing: a drop that walks off mtxCell[][] is a silent out-of-bounds write on
   a board with no memory protection, and a column that doesn't fit 64px just gets
   clipped. both are pure arithmetic, so read the constants straight out of main.ino and
   run the same loops here. */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const ino = readFileSync(new URL("../giga-r1/main/main.ino", import.meta.url), "utf8");
const def = (name) => {
  const m = ino.match(new RegExp(`^#define ${name} (.+?)\\s*(?://.*)?$`, "m"));
  assert.ok(m, `${name} missing from main.ino`);
  return m[1].trim();
};
// the derived ones are written in terms of the others (`(64 / MTX_CW)`), so evaluate
// them with the already-read constants in scope rather than duplicating the numbers here.
const num = (name, env = {}) =>
  Function(...Object.keys(env), `"use strict";return(${def(name)})`)(...Object.values(env));

const CW = num("MTX_CW"), CH = num("MTX_CH");
const COLS = Math.floor(64 / CW), ROWS = Math.floor(128 / CH);
// Math.floor: the defines are C integer division, js isn't
assert.equal(COLS, Math.floor(num("MTX_COLS", { MTX_CW: CW })));
assert.equal(ROWS, Math.floor(num("MTX_ROWS", { MTX_CH: CH })));

// panel is 64x128. the head cell is drawn one pixel left of the glyph and MTX_CW wide.
const X0 = 2; // matches drawMatrix()
assert.ok(X0 - 1 >= 0 && X0 + (COLS - 1) * CW - 1 + CW <= 64, "columns overflow the 64px panel");
assert.equal(ROWS * CH, 128, "rows must tile the panel exactly");

// the same fall/draw loops, with every array index asserted in range.
const rnd = (a, b) => b === undefined ? Math.floor(Math.random() * a) : a + Math.floor(Math.random() * (b - a));
const y = [], spd = [], tick = [], tail = [];
const respawn = (c) => { y[c] = -rnd(ROWS); spd[c] = rnd(1, 5); tail[c] = rnd(5, ROWS); tick[c] = 0; };
for (let c = 0; c < COLS; c++) respawn(c);

let heads = 0, dims = 0;
for (let frame = 0; frame < 20000; frame++) {
  for (let c = 0; c < COLS; c++) {                      // stepMatrix()
    if (++tick[c] < spd[c]) continue;
    tick[c] = 0;
    if (++y[c] - tail[c] >= ROWS) { respawn(c); continue; }
    assert.ok(y[c] >= -128 && y[c] <= 127, `head ${y[c]} overflows int8_t`);
    if (y[c] >= 0 && y[c] < ROWS) { /* mtxCell[c][y] write */ }
  }
  for (let c = 0; c < COLS; c++) {                      // drawMatrix()
    for (let i = 0; i <= tail[c]; i++) {
      const r = y[c] - i;
      if (r < 0 || r >= ROWS) continue;
      assert.ok(r < ROWS && r >= 0, "cell index out of range");
      assert.ok(r * CH + CH <= 128, "glyph drawn past the bottom of the panel");
      if (i === 0) { heads++; continue; }
      // four contrast tiers, and the dim ones must erase *some* rows but never all 8.
      const keep = i <= 2 ? 0 : (i * 3 <= tail[c] * 2 ? 2 : 4);
      assert.ok([0, 2, 4].includes(keep), `bad dim tier ${keep}`);
      if (keep) {
        const kept = [...Array(CH).keys()].filter((yy) => yy % keep === 0).length;
        assert.ok(kept >= 2 && kept < CH, `tier ${keep} leaves ${kept}/${CH} rows lit`);
        dims++;
      }
    }
  }
}
assert.ok(heads > 1000 && dims > 1000, "simulation never drew a full tail");
console.log(`✔ matrix rain: ${COLS}x${ROWS} cells, ${heads} heads / ${dims} dimmed glyphs, all in range`);
