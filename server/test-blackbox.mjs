// The board's black box: a ring that wraps, and a dump that has to come out
// oldest-first and say how many it dropped. Both are off-by-one country and
// neither is visible until the day something actually disconnects, so they get
// re-run here against the constants in main.ino.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ino = readFileSync(new URL("../giga-r1/main/main.ino", import.meta.url), "utf8");
const LOG_N = +ino.match(/#define LOG_N (\d+)/)[1];
assert.ok(LOG_N > 0, "LOG_N gone from main.ino");

// mirror of logEvt() + dumpLog()'s walk
const box = () => ({ ring: new Array(LOG_N), head: 0, count: 0 });
const log = (b, v) => { b.ring[b.head] = v; b.head = (b.head + 1) % LOG_N; b.count++; };
const dump = (b) => {
  const n = Math.min(b.count, LOG_N);
  let i = b.count < LOG_N ? 0 : b.head;
  const out = [];
  for (let k = 0; k < n; k++, i = (i + 1) % LOG_N) out.push(b.ring[i]);
  return { out, lost: b.count > LOG_N ? b.count - LOG_N : 0 };
};

let b = box();
for (let i = 0; i < 3; i++) log(b, i);
assert.deepEqual(dump(b), { out: [0, 1, 2], lost: 0 }, "a partly-filled ring must dump in order from the start");

b = box();
for (let i = 0; i < LOG_N; i++) log(b, i);
assert.equal(dump(b).lost, 0, "an exactly-full ring lost nothing");
assert.equal(dump(b).out[0], 0, "an exactly-full ring still starts at the oldest");

b = box();
for (let i = 0; i < LOG_N + 5; i++) log(b, i);
const d = dump(b);
assert.equal(d.lost, 5, "a wrapped ring must say how many events fell off");
assert.equal(d.out.length, LOG_N, "a wrapped dump is exactly LOG_N long");
assert.equal(d.out[0], 5, "a wrapped dump starts at the oldest surviving event");
assert.equal(d.out.at(-1), LOG_N + 4, "a wrapped dump ends at the newest");

// the reset flags are the half the ring can never hold, so the boot line must carry them
assert.ok(/resetBits = RCC->RSR/.test(ino), "main.ino no longer reads the reset cause");
assert.ok(/RCC->RSR \|= RCC_RSR_RMVF/.test(ino), "reset flags never cleared — every later boot reports the first one");
assert.ok(/logEvt\(LOG_BOOT, resetBits\)/.test(ino), "boot event lost its reset cause");
for (const c of ["LOG_BOOT", "LOG_BLE_UP", "LOG_BLE_DOWN", "LOG_STALL", "LOG_NOTIFY_FAIL"])
  assert.ok(new RegExp(`case ${c}:`).test(ino), `${c} has no name in logName() — it would dump as "?"`);

const app = readFileSync(new URL("./public/js/app.js", import.meta.url), "utf8");
assert.ok(/startsWith\("E:log"\)/.test(app), "dashboard stopped rendering the black box");
assert.ok(/writeValue\(new TextEncoder\(\)\.encode\("log,"\)\)/.test(app), "dashboard no longer asks for a dump on connect");

console.log("black box ok");
