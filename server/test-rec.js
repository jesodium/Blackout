// recorder self-check: no cam, no server. REC_FPS=0 kills the frame grabber so
// this exercises the part with the logic in it — relative stamps, run.json,
// listing, and that a junk id can't escape the recordings dir.
process.env.REC_FPS = "0";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const rec = require("./recorder");

const started = rec.start("unit test");
assert.ok(started.id.startsWith("unit-test-"), "id is slug + stamp, got " + started.id);
assert.equal(rec.start("again").id, started.id, "second start must not clobber the run");

rec.push({ dist: 10 });
const t = Date.now();
while (Date.now() - t < 20); // busy-wait so the two packets get different stamps
rec.push({ dist: 20 });

rec.mark("finding", "  relic fragment  ");
rec.mark("sage", "x".repeat(400));

const run = rec.stop();
assert.equal(run.events.length, 2);
assert.equal(run.events[0].kind, "finding");
assert.equal(run.events[0].text, "relic fragment", "text is trimmed");
assert.equal(run.events[1].text.length, 200, "long text is capped");
assert.ok(run.events[0].t >= run.packets[0].t, "events share the packet clock");
assert.equal(rec.mark("sage", "after the run"), undefined, "marking with no run is a no-op");
assert.equal(run.packets.length, 2);
assert.equal(run.packets[0].dist, 10);
assert.equal(run.packets[0].t >= 0 && run.packets[1].t > run.packets[0].t, true, "stamps are relative + ordered");
assert.equal(rec.state(), null, "stopped");
assert.equal(rec.stop(), null, "double stop is a no-op");

const onDisk = JSON.parse(fs.readFileSync(path.join(rec.DIR, run.id, "run.json"), "utf8"));
assert.equal(onDisk.packets.length, 2);
assert.deepEqual(rec.read(run.id).packets, run.packets);
assert.ok(rec.list().some(r => r.id === run.id && r.packets === 2 && r.events === 2), "run shows up in the list");

assert.equal(rec.read("../../server"), null, "traversal id reads nothing");
assert.equal(rec.remove("../.."), false, "traversal id deletes nothing");
assert.equal(rec.remove(run.id), true);
assert.equal(rec.read(run.id), null, "gone after delete");

console.log("recorder ok");
process.exit(0); // vision.js holds an mdns socket open
