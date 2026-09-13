// mirrors medianPingCm()'s rolling ring against main.ino. the ring feeds `until dist < N`,
// so a 0-initialised slot reads as a wall at 0cm and stops a blk program on the spot.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const ino = readFileSync(new URL('../giga-r1/main/main.ino', import.meta.url), 'utf8');
const def = (n) => Number(ino.match(new RegExp(`#define ${n}\\s+(\\d+)`))[1]);
const ITER = def('SONAR_ITER');

assert.ok(!/panelDelay\(/.test(ino), 'sonar must not block the loop again');
assert.ok(/sonarRing\[i\] = -1/.test(ino), 'ring must be seeded to -1 in setup()');
assert.ok(!/DIST_ALPHA/.test(ino), 'median already smooths; the EMA on top was pure lag');

const ring = Array(ITER).fill(-1);
let idx = 0;
const push = (v) => {
  ring[idx] = v;
  idx = (idx + 1) % ITER;
  const s = ring.filter((x) => x >= 0).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : -1;
};

assert.equal(push(-1), -1, 'empty ring reads out of range, never 0');
assert.equal(push(20), 20, 'first valid ping is used at once');
push(20);
assert.equal(push(0.5), 20, 'one stray echo is outvoted');
for (let i = 0; i < ITER; i++) push(-1);
assert.equal(push(-1), -1, 'a real dropout still reports out of range');

let d = 20;
for (let i = 0; i < ITER; i++) d = push(4);
assert.equal(d, 4, `a real change lands within ${ITER} samples`);

console.log(`sonar ok (ITER=${ITER})`);
