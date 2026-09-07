// two esp32-cams. the boards sort themselves into CAM_CHIPS off their eFuse MAC,
// so nothing here is checked by looking at a cable — and the two things that can
// still go wrong are silent: an id claimed with its bytes the wrong way round
// (the board never matches its own slot) and a slot octet that drifts from the
// host the dashboard dials.

import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

const app = readFileSync("public/js/app.js", "utf8");
const ino = readFileSync("../esp32-cam/main/main.ino", "utf8");
const sh = readFileSync("../cmds/flash.sh", "utf8");

// ---- the table ----
const table = ino.match(/CAM_CHIPS\[\] = \{([^}]*)\}/)[1];
const ids = [...table.matchAll(/0x([0-9a-fA-F]+)ULL/g)].map(m => m[1].toLowerCase().replace(/^0+/, ""));
assert.equal(ids.length, 2, "CAM_CHIPS should hold one slot per camera");
const claimed = ids.filter(Boolean);                    // 0 = slot not filled in yet
assert.equal(new Set(claimed).size, claimed.length,
  "two slots in CAM_CHIPS carry the same chip id — both boards would be the same camera");

// ---- slot -> host, sketch vs dashboard ----
const base = Number(ino.match(/#define CAM_OCTET_BASE (\d+)/)[1]);
const front = app.match(/const CAM_HOSTS = \["([\d.]+)"/)[1];
// CAM_DEFAULTS[0] is CAM_HOST_DEFAULT (= CAM_HOSTS[0]); the rest are literals
const rest = [...app.match(/const CAM_DEFAULTS = \[([^\]]*)\]/)[1].matchAll(/"([\d.]+)"/g)].map(m => m[1]);
const hosts = [front, ...rest];
for (let slot = 1; slot <= 2; slot++)
  assert.equal(hosts[slot - 1], `172.20.10.${base + slot}`,
    `slot ${slot} boots on 172.20.10.${base + slot}, the dashboard looks for ${hosts[slot - 1]}`);

// ---- sage's own CAM_URL: one group per camera ----
// ";" separates cameras, "," separates one camera's networks. A comma where the
// semicolon belongs makes cam 2 a silent FALLBACK for cam 1 -- "armcam" then
// answers with the front view and nothing anywhere errors.
if (existsSync(".env")) {
  const line = (readFileSync(".env", "utf8").match(/^CAM_URL=(.*)$/m) || [])[1];
  if (line) {
    const groups = line.split(";");
    assert.equal(groups.length, 2, "CAM_URL should hold one group per camera, ';' between them");
    assert.ok(groups[1].includes(`172.20.10.${base + 2}`),
      `cam 2's group in CAM_URL doesn't dial 172.20.10.${base + 2}`);
  }
}

// ---- claim_cam: the eFuse id is the MAC's bytes REVERSED ----
// esp_efuse_mac_get_default() fills mac[0..5] MSB-first and getEfuseMac() reads
// that buffer back as a little-endian uint64, so a1:b2:..:f6 lands as 0xf6..a1.
const dir = mkdtempSync(`${tmpdir()}/camtest-`);
try {
  mkdirSync(`${dir}/esp32-cam/main`, { recursive: true });
  // blank the table in the COPY: the real one fills up the moment the cams are
  // claimed on the bench, and a fixture that reads live repo state turns "both
  // cams are claimed" into a red test.
  writeFileSync(`${dir}/esp32-cam/main/main.ino`,
    ino.replace(/CAM_CHIPS\[\] = \{[\s\S]*?\}/,
      (t) => t.replace(/0x[0-9A-Fa-f]{12}ULL/g, "0x000000000000ULL")));
  const fn = sh.match(/^claim_cam\(\) \{[\s\S]*?^\}/m)[0];
  const driver = `
set -uo pipefail
ROOT=${dir}
INO="$ROOT/esp32-cam/main/main.ino"
log=$(mktemp)
${fn}
echo "MAC: a1:b2:c3:d4:e5:f6" > "$log"; claim_cam; claim_cam
echo "MAC: 11:22:33:44:55:66" > "$log"; claim_cam
echo "MAC: aa:bb:cc:dd:ee:ff" > "$log"; claim_cam
CAM_CLAIM=0 claim_cam || echo "off"
`;
  const out = execFileSync("bash", ["-c", driver], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(out, [
    "claimed|1|f6e5d4c3b2a1",   // first cam takes slot 1 -- bytes reversed
    "known|1|f6e5d4c3b2a1",     // and is recognised on the next flash
    "claimed|2|665544332211",   // second cam takes the other slot
    "full||ffeeddccbbaa",       // a third has nowhere to go, and says so
    "off",                      // CAM_CLAIM=0 leaves the table alone
  ], "claim_cam mis-sorts the boards");

  const after = readFileSync(`${dir}/esp32-cam/main/main.ino`, "utf8").match(/CAM_CHIPS\[\] = \{([^}]*)\}/)[1];
  assert.match(after, /0xF6E5D4C3B2A1ULL,\s*\/\/ slot 1/, "slot 1 lost its id or its comment");
  assert.match(after, /0x665544332211ULL,\s*\/\/ slot 2/, "slot 2 lost its id or its comment");
} finally { rmSync(dir, { recursive: true, force: true }); }

// ---- the plumbing that makes two boards two boards ----
assert.doesNotMatch(sh, /if d in seen:/, "flash.sh de-dupes by sketch dir again — only one cam gets flashed");
assert.match(sh, /record "\$dir\$\{chip:\+@\$chip\}"/, "flash.sh must key .last-flash by chip, or one cam marks both current");
const server = readFileSync("server.js", "utf8");
assert.match(server, /k\.startsWith\(p\.dir \+ "@"\)/, "flash status ignores the per-chip keys flash.sh writes");
assert.match(server, /found\[hit\.key\]\+\+/, "flash status counts boards as flags again, so a second cam is invisible");

// ---- the borrowed frame ----
// The cam serves ONE /stream, so Sage's still comes off the dashboard's own feed.
// Two ways that goes silently wrong: the browser lends a frozen frame from a dead
// feed (she then reports on a picture of the past), or the server stops preferring
// the borrow and goes back to /capture, which kills the feed it competes with.
const vision = readFileSync("vision.js", "utf8");
assert.match(vision, /if \(frameSource\) \{[\s\S]*?return upright\(b, cam\);/,
  "grabFrame no longer tries the borrowed frame first — every look reopens /capture");
assert.match(vision, /return overCam\(cam, \(url\) => grabFrameFrom/,
  "grabFrame lost its /capture fallback — a headless run now has no vision at all");
assert.doesNotMatch(server + app, /cam-yield|cam-resume/,
  "the yield handshake is back: the feed is being torn down for a still again");

// the freshness rule, run off app.js's own source
const lend = app.match(/socket\.on\("cam-frame", \(cam, ack\) => \{([\s\S]*?)\n    \}\);/)[1];
const LEND = Number(app.match(/const FRAME_LEND_MS = (\d+)/)[1]);
assert.ok(LEND <= STALL_MS_OF(app), "a frame may be lent for longer than the feed's own stall watchdog");
const answer = new Function("camFrames", "FRAME_LEND_MS", "cam", "ack", `const Date = { now: () => 1000 };${lend}`);
const ask = (frames, cam = 0) => { let got; answer(frames, LEND, cam, (v) => { got = v; }); return got; };
assert.equal(ask([{ bytes: "fresh", at: 1000 - LEND + 1 }]), "fresh", "a live frame isn't being lent");
assert.equal(ask([{ bytes: "old", at: 1000 - LEND }]), null, "a stale frame is lent as if it were live");
assert.equal(ask([]), null, "an unmounted feed answers with something");
assert.equal(ask([null, { bytes: "arm", at: 1000 }], 1), "arm", "the arm cam's frame is looked up on the wrong index");
function STALL_MS_OF(src) { return Number(src.match(/const STALL_MS = (\d+)/)[1]); }

console.log("cam ok — chip table, slot hosts, claim_cam byte order, two-board plumbing, borrowed frames");
