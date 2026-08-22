/* matrix rain self-check. the rain lives on the board (see "Matrix rain" in CLAUDE.md),
   so there's nothing in the browser to drive — what can actually break is the geometry
   and the indexing: a drop that walks off mtxCell[][] is a silent out-of-bounds write on
   a board with no memory protection, and a column that doesn't fit the panel just gets
   clipped. panel size comes from OLED_W/OLED_H in main.ino, so a re-mount (portrait <->
   landscape) is caught here rather than on the bench. both are pure arithmetic, so read the constants straight out of main.ino and
   run the same loops here. */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const ino = readFileSync(new URL("../giga-r1/main/main.ino", import.meta.url), "utf8");
const def = (name) => {
  const m = ino.match(new RegExp(`^#define ${name} (.+?)\\s*(?://.*)?$`, "m"));
  assert.ok(m, `${name} missing from main.ino`);
  return m[1].trim();
};
// the derived ones are written in terms of the others (`(OLED_W / MTX_CW)`), so evaluate
// them with the already-read constants in scope rather than duplicating the numbers here.
const num = (name, env = {}) =>
  Function(...Object.keys(env), `"use strict";return(${def(name)})`)(...Object.values(env));

const W = num("OLED_W"), H = num("OLED_H");
const CW = num("MTX_CW"), CH = num("MTX_CH");
const COLS = Math.floor(W / CW), ROWS = Math.floor(H / CH);
// Math.floor: the defines are C integer division, js isn't
assert.equal(COLS, Math.floor(num("MTX_COLS", { MTX_CW: CW, OLED_W: W })));
assert.equal(ROWS, Math.floor(num("MTX_ROWS", { MTX_CH: CH, OLED_H: H })));

// the head cell is drawn one pixel left of the glyph and MTX_CW wide.
const X0 = 1; // matches drawMatrix()
assert.ok(X0 - 1 >= 0 && X0 + (COLS - 1) * CW - 1 + CW <= W, `columns overflow the ${W}px panel`);
assert.equal(ROWS * CH, H, "rows must tile the panel exactly");

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
      assert.ok(r * CH + CH <= H, "glyph drawn past the bottom of the panel");
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

/* the other savers are the same class of bug in miniature: a bounce that pins itself to
   an edge or wraps its int, a star that indexes past ST_N or never comes back. */
const N = num("ST_N");
const stY = [], stZ = [];
const stRespawn = (i, anywhere) => { stY[i] = anywhere ? rnd(H) : 0; stZ[i] = rnd(1, 4); };
for (let i = 0; i < N; i++) stRespawn(i, true);

const BN_W = 8 * 5; // BOARD_NAME in u8g2_font_5x8_tr, 5px advance per char
let bnX = 10, bnY = 40, bnDX = 1, bnDY = 1, bounces = 0, respawns = 0;
for (let f = 0; f < 20000; f++) {
  bnX += bnDX; bnY += bnDY;
  if (bnX <= 0 || bnX + BN_W >= W) { bnDX = -bnDX; bounces++; }
  if (bnY <= 8 || bnY >= H) { bnDY = -bnDY; bounces++; }
  assert.ok(bnX >= -1 && bnX + BN_W <= W, `bounce ran off x: ${bnX}`);
  assert.ok(bnY >= 7 && bnY <= H, `bounce ran off y: ${bnY}`);  // y is the baseline
  assert.ok(bnY < 32768, "bounce y must not wrap its int");
  for (let i = 0; i < N; i++) {
    if (stY[i] + stZ[i] >= H) { stRespawn(i, false); respawns++; continue; }
    stY[i] += stZ[i];
    assert.ok(stY[i] >= 0 && stY[i] < H, `star ${i} off panel at y=${stY[i]}`);
    assert.ok(stZ[i] >= 1 && stZ[i] <= 3, `star ${i} bad depth ${stZ[i]}`);
  }
}
assert.ok(bounces > 100 && respawns > 1000, "bounce/stars never cycled");

/* tetris plays itself on the board, so the bugs that matter are the ones that write
   outside the well or leave it in a state it can never get out of: a piece merged past
   the right wall, a line clear that loses a row, a stack that tops out and never wipes.
   the piece table is read out of main.ino rather than copied, so the two can't drift. */
const TC = num("TET_COLS"), TR = num("TET_ROWS"), TCELL = num("TET_CELL");
const TX0 = num("TET_X0", { OLED_W: W, TET_COLS: TC, TET_CELL: TCELL });
const TY0 = num("TET_Y0", { OLED_H: H, TET_ROWS: TR, TET_CELL: TCELL });
// the well is centred, not panel-filling, so its box has to actually land on the glass
assert.ok(TX0 - 2 >= 0 && TX0 + TC * TCELL + 1 <= W, `tetris well overflows x: ${TX0}`);
assert.ok(TY0 - 1 >= 0 && TY0 + TR * TCELL + 1 <= H, `tetris well overflows y: ${TY0}`);
assert.ok(TC <= 8, "a well row is one byte (0xFF = full) — widen tetWell before widening the well");
const PIECES = [...ino.matchAll(/\{ (0x[0-9A-Fa-f]{4}(?:, 0x[0-9A-Fa-f]{4}){3}) \}, \/\/ ./g)]
  .map((m) => m[1].split(", ").map((h) => parseInt(h, 16)));
assert.equal(PIECES.length, 7, "expected 7 tetrominoes in TET_PIECES");
for (const rots of PIECES)
  for (const m of rots)
    assert.equal([...m.toString(2)].filter((b) => b === "1").length, 4, `piece 0x${m.toString(16)} is not 4 cells`);

const well = new Array(TR).fill(0);
const nib = (m, r) => (m >> (r * 4)) & 0xf;
const hit = (m, px, py) => {
  for (let r = 0; r < 4; r++) {
    const bits = nib(m, r); if (!bits) continue;
    const y = py + r;
    if (y < 0) continue;
    if (y >= TR) return true;
    const row = bits << px;
    if (row > 0xff) return true;
    if (well[y] & row) return true;
  }
  return false;
};
let m = 0, px = 0, py = -3, wipes = 0, clears = 0, landed = 0;
const spawn = () => {
  m = PIECES[rnd(7)][rnd(4)]; py = -3;
  let w = 0;
  for (let b = 0; b < 16; b++) if ((m >> b) & 1 && (b % 4) + 1 > w) w = (b % 4) + 1;
  let bestY = -100; px = 0;
  for (let x = 0; x + w <= TC; x++) {
    let y = -3;
    while (!hit(m, x, y + 1)) y++;
    if (y > bestY || (y === bestY && rnd(2))) { bestY = y; px = x; }
  }
};
spawn();
for (let f = 0; f < 200000; f++) {
  if (!hit(m, px, py + 1)) { py++; continue; }
  landed++;
  for (let r = 0; r < 4; r++) {
    const bits = nib(m, r), y = py + r;
    if (bits && y >= 0 && y < TR) well[y] |= bits << px;
  }
  for (let y = TR - 1; y >= 0; y--)
    while (well[y] === 0xff) { for (let k = y; k > 0; k--) well[k] = well[k - 1]; well[0] = 0; clears++; }
  if (well[0]) { well.fill(0); wipes++; }
  for (let y = 0; y < TR; y++) assert.ok(well[y] >= 0 && well[y] <= 0xff, `row ${y} outside the well: ${well[y]}`);
  assert.equal(well[0], 0, "a full top row must wipe the well, or it can never come back");
  spawn();
  for (let r = 0; r < 4; r++) assert.ok((nib(m, r) << px) <= 0xff, `spawn column ${px} hangs the piece off the edge`);
}
assert.ok(landed > 1000 && clears > 0 && wipes > 0, `tetris never cycled: ${landed}/${clears}/${wipes}`);

console.log(`✔ tetris: ${TC}x${TR} well at (${TX0},${TY0}), ${landed} pieces, ${clears} lines cleared, ${wipes} wipes, all in range`);

console.log(`✔ ${W}x${H} panel · matrix rain: ${COLS}x${ROWS} cells, ${heads} heads / ${dims} dimmed glyphs, all in range`);
console.log(`✔ bounce: ${bounces} edge hits · stars: ${N} dots, ${respawns} respawns, all in range`);
