// The lidar on its own USB cable, to bench-test it before it lives on the robot.
// Plug it in and it's found by what it says, not by its port name: the sim has an
// RPLIDAR C1, the hub is labelled LD19, and both sit behind the same usb adapters.
//
// IMPORTANT NOTE: usb only. On the hub the lidar talks to the Giga's Serial3, and
// no firmware reads it yet. Standard scan only on the C1, not its denser modes.
const { SerialPort } = require("serialport");
const fs = require("fs");
const { io } = require("./http");

const LD19_BAUD = 230400, C1_BAUD = 460800;
const LD19_LEN = 47;
const C1_STOP = Buffer.from([0xa5, 0x25]);
const C1_INFO = Buffer.from([0xa5, 0x50]);
const C1_SCAN = Buffer.from([0xa5, 0x20]);
const C1_INFO_DESC = Buffer.from([0xa5, 0x5a, 0x14, 0x00, 0x00, 0x00, 0x04]);
const C1_SCAN_DESC = Buffer.from([0xa5, 0x5a, 0x05, 0x00, 0x00, 0x40, 0x81]);

// Opening a port wiggles DTR/RTS, which can reset an ESP32, so the cam's CH340 is
// never probed, and neither is the Giga. A lidar on a CH340 adapter needs LIDAR_PORT.
const SKIP_VIDS = new Set(["2341", "1a86"]);   // arduino, wch ch34x
const PROBE_TRIES = 3;    // it may still be booting the first time round
const TICK_MS = 2000;
const SILENT_MS = 3000;   // no samples for this long and it counts as gone
const BIN_STALE_MS = 600; // a bin the beam hasn't refreshed is not a wall any more
const SCAN_MS = 200;

function crc8(buf) {
  let c = 0;
  for (const b of buf) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = c & 0x80 ? ((c << 1) ^ 0x4d) & 0xff : (c << 1) & 0xff;
  }
  return c;
}

// LD19: 0x54 0x2c, speed, start angle, 12 x {mm u16, confidence u8}, end angle,
// timestamp, crc. Returns the bytes still waiting and how many frames were good.
function takeLd19(buf, put) {
  let i = 0, frames = 0;
  while (buf.length - i >= LD19_LEN) {
    if (buf[i] !== 0x54 || buf[i + 1] !== 0x2c || crc8(buf.subarray(i, i + LD19_LEN - 1)) !== buf[i + LD19_LEN - 1]) { i++; continue; }
    const start = buf.readUInt16LE(i + 4) / 100;
    const span = (buf.readUInt16LE(i + 42) / 100 - start + 360) % 360;   // crosses 0 once a turn
    for (let k = 0; k < 12; k++) put((start + span * k / 11) % 360, buf.readUInt16LE(i + 6 + k * 3));
    i += LD19_LEN; frames++;
  }
  return { rest: buf.subarray(i), frames };
}

// C1 standard scan node: quality + S + !S, angle_q6 + check bit, distance_q2.
function takeC1(buf, put) {
  let i = 0;
  while (buf.length - i >= 5) {
    const b0 = buf[i], b1 = buf[i + 1];
    if ((b0 & 1) === ((b0 >> 1) & 1) || !(b1 & 1)) { i++; continue; }
    const deg = (((buf[i + 2] << 8) | b1) >> 1) / 64;
    if (deg < 360) put(deg, ((buf[i + 4] << 8) | buf[i + 3]) / 4);
    i += 5;
  }
  return { rest: buf.subarray(i) };
}

// ---- one scan, a slot per degree ----
const dist = new Uint16Array(360), seen = new Float64Array(360);
let lastSample = 0;
function put(deg, mm) {
  if (!(mm > 0)) return;   // 0 is "no return", not a wall touching the lens
  const bin = Math.floor(deg) % 360;
  lastSample = seen[bin] = Date.now();
  dist[bin] = Math.min(mm, 65535);
}
function scan(now = Date.now()) {
  return Array.from(dist, (mm, i) => (now - seen[i] > BIN_STALE_MS ? 0 : mm));
}

// ---- status ----
let status = { state: "none", model: null, port: null };
function setStatus(state, model = null, port = null) {
  if (state === status.state && model === status.model && port === status.port) return;
  status = { state, model, port };
  console.log("lidar:", state, model || "", port || "");
  io.emit("lidar", status);
}
io.on("connection", (socket) => socket.emit("lidar", status));

// ---- probing ----
const openPort = (Port, path, baudRate) => new Promise((res, rej) => {
  const p = new Port({ path, baudRate }, (e) => (e ? rej(e) : res(p)));
  p.on("error", () => {});   // an unplug must not take the server down with it
});
const closePort = (p) => new Promise((r) => (p.isOpen ? p.close(() => r()) : r()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Feed `check` everything that arrives until it answers or the time is up.
function listen(p, ms, check) {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const finish = (v) => { clearTimeout(timer); p.off("data", onData); resolve(v); };
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const v = check(buf);
      if (v) finish(v);
    };
    const timer = setTimeout(() => finish(null), ms);
    p.on("data", onData);
  });
}

// null: opened fine and nothing answered. Throws when it couldn't even open it
// (usually someone else holds the port), which doesn't count as a try.
async function probe(path, Port = SerialPort) {
  // ld19 first: it streams unasked, so this only listens
  let p = await openPort(Port, path, LD19_BAUD);
  const ld19 = await listen(p, 500, (b) => takeLd19(b, () => {}).frames > 0);
  if (ld19) return { port: p, model: "LD19", take: takeLd19 };
  await closePort(p);

  p = await openPort(Port, path, C1_BAUD);
  p.write(C1_STOP);      // a scan left running by a crashed server would bury the reply
  await sleep(30);
  await new Promise((r) => p.flush(() => r()));
  const reply = listen(p, 700, (b) => {
    const i = b.indexOf(C1_INFO_DESC);
    return i !== -1 && b.length >= i + C1_INFO_DESC.length + 20 ? b.subarray(i + C1_INFO_DESC.length) : null;
  });
  p.write(C1_INFO);
  const info = await reply;
  if (!info) { await closePort(p); return null; }
  console.log(`lidar: rplidar model 0x${info[0].toString(16)} fw ${info[2]}.${info[1]}`);
  return { port: p, model: "RPLIDAR", take: takeC1, skip: C1_SCAN_DESC, start: C1_SCAN };
}

// ---- holding it ----
let held = null;
const tried = new Map();

function hold({ port, model, take, skip, start }) {
  held = { port, model };
  lastSample = Date.now();    // the silence clock starts now
  let buf = Buffer.alloc(0), synced = !skip, live = false;
  port.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (!synced) {
      const i = buf.indexOf(skip);
      if (i === -1) return;
      buf = buf.subarray(i + skip.length);
      synced = true;
    }
    buf = take(buf, (deg, mm) => {
      put(deg, mm);
      if (!live) { live = true; tried.delete(port.path); setStatus("live", model, port.path); }
    }).rest;
  });
  port.on("close", () => {
    if (held?.port === port) held = null;
    dist.fill(0);
    tick();   // says "none" now instead of up to a tick later
  });
  if (start) port.write(start);
}

const heldPort = () => held?.port.path || null;

async function candidates() {
  if (process.env.LIDAR_PORT) return fs.existsSync(process.env.LIDAR_PORT) ? [process.env.LIDAR_PORT] : [];
  const ports = await SerialPort.list();
  return ports
    .filter((p) => p.vendorId && !SKIP_VIDS.has(p.vendorId.toLowerCase()))   // no vid: bluetooth, debug console
    .map((p) => p.path.replace("/dev/tty.", "/dev/cu."));   // tty.* blocks on carrier detect
}

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    if (held) {
      if (Date.now() - lastSample > SILENT_MS) await closePort(held.port);
      return;
    }
    const found = await candidates();
    for (const path of tried.keys()) if (!found.includes(path)) tried.delete(path);   // unplugged: fresh start
    const next = found.find((path) => (tried.get(path) || 0) < PROBE_TRIES);
    if (!next) { setStatus(found.length ? "silent" : "none", null, found[0] || null); return; }
    setStatus("probing", null, next);
    try {
      tried.set(next, (tried.get(next) || 0) + 1);
      const got = await probe(next);
      if (got) hold(got);
    } catch { tried.set(next, tried.get(next) - 1); }
  } catch (e) {
    console.error("lidar:", e.message);
  } finally { busy = false; }
}

function startLidar() {
  setInterval(tick, TICK_MS);
  // volatile: a tablet that falls behind skips a sweep instead of queueing them
  setInterval(() => { if (status.state === "live") io.volatile.emit("lidar-scan", scan()); }, SCAN_MS);
  tick();
}

module.exports = { startLidar, heldPort };

// ---- selftest ----
if (require.main === module && process.argv.includes("--selftest")) {
  const assert = require("assert");
  const { SerialPortMock } = require("serialport");

  // the crc catalogue value for this poly, so a typo in the poly can't pass by
  // agreeing with itself the way a frame built with crc8() would
  assert.equal(crc8(Buffer.from([0x01])), 0x4d, "ld19 crc table starts 00 4d 9a d7");
  assert.equal(crc8(Buffer.from([0x02])), 0x9a);
  assert.equal(crc8(Buffer.from([0x03])), 0xd7);

  const ld19Frame = (startDeg, endDeg, mm) => {
    const f = Buffer.alloc(LD19_LEN);
    f[0] = 0x54; f[1] = 0x2c; f.writeUInt16LE(3600, 2); f.writeUInt16LE(startDeg * 100, 4);
    for (let k = 0; k < 12; k++) { f.writeUInt16LE(mm, 6 + k * 3); f[8 + k * 3] = 200; }
    f.writeUInt16LE(endDeg * 100, 42);
    f[46] = crc8(f.subarray(0, 46));
    return f;
  };
  const c1Node = (deg, mm, q = 40) => {
    const a = (Math.round(deg * 64) << 1) | 1, d = mm * 4;
    return Buffer.from([(q << 2) | 2, a & 0xff, a >> 8, d & 0xff, d >> 8]);
  };
  const collect = () => { const out = []; return { out, f: (deg, mm) => out.push([+deg.toFixed(2), mm]) }; };

  // ld19: junk before it, one split across chunks, angles across the 0 line
  let c = collect();
  let r = takeLd19(Buffer.concat([Buffer.from("junk\x54"), ld19Frame(355, 5, 1200)]), c.f);
  assert.equal(r.frames, 1, "finds a frame after junk");
  assert.equal(c.out.length, 12);
  assert.deepEqual(c.out[0], [355, 1200]);
  assert.deepEqual(c.out[11], [5, 1200], "span crosses 0 instead of going backwards 350 degrees");

  const whole = ld19Frame(10, 20, 500);
  c = collect();
  r = takeLd19(whole.subarray(0, 20), c.f);
  assert.equal(r.frames, 0, "half a frame waits");
  assert.equal(r.rest.length, 20);
  r = takeLd19(Buffer.concat([r.rest, whole.subarray(20)]), c.f);
  assert.equal(r.frames, 1, "and completes across chunks");

  const bad = Buffer.from(whole); bad[10] ^= 1;
  assert.equal(takeLd19(bad, () => assert.fail("a bad crc must not plot")).frames, 0);

  // c1: exact angle and distance, an invalid first byte skipped, half a node kept
  c = collect();
  r = takeC1(Buffer.concat([Buffer.from([0x00]), c1Node(90, 1500), c1Node(359.5, 250).subarray(0, 3)]), c.f);
  assert.deepEqual(c.out, [[90, 1500]]);
  assert.equal(r.rest.length, 3);

  // the bins: no-return ignored, stale dropped, wrap at 360 stays in range
  put(359.99, 800); put(10, 0);
  const now = Date.now();
  assert.equal(scan(now)[359], 800);
  assert.equal(scan(now)[10], 0, "0 mm is no return");
  assert.equal(scan(now + BIN_STALE_MS + 1)[359], 0, "a stale bin reads empty");
  assert.equal(scan(now).length, 360);

  // the handshakes, against a fake port that answers like each lidar
  const fake = (onOpen, onWrite) => class extends SerialPortMock {
    constructor(o, cb) { super(o, cb); this.once("open", () => onOpen?.(this)); }
    write(b, ...a) { const ret = super.write(b, ...a); onWrite?.(this, Buffer.from(b)); return ret; }
  };
  (async () => {
    SerialPortMock.binding.createPort("/dev/LD");
    let baudsSeen = [];
    const Ld = fake((p) => { baudsSeen.push(p.baudRate); if (p.baudRate === LD19_BAUD) p.port.emitData(ld19Frame(0, 10, 900)); });
    const a = await probe("/dev/LD", Ld);
    assert.equal(a.model, "LD19");
    assert.deepEqual(baudsSeen, [LD19_BAUD], "an ld19 never gets written to");
    await closePort(a.port);

    SerialPortMock.binding.createPort("/dev/C1");
    const writes = [];
    const info = Buffer.concat([C1_INFO_DESC, Buffer.alloc(20, 0x41)]);
    const C1 = fake(null, (p, b) => { writes.push(p.baudRate + ":" + b.toString("hex")); if (b.equals(C1_INFO)) setTimeout(() => p.port.emitData(info), 5); });
    const b = await probe("/dev/C1", C1);
    assert.equal(b.model, "RPLIDAR");
    assert.deepEqual(writes, [`${C1_BAUD}:a525`, `${C1_BAUD}:a550`], "stop, then ask");
    assert.equal(b.start.toString("hex"), "a520");
    await closePort(b.port);

    SerialPortMock.binding.createPort("/dev/QUIET");
    assert.equal(await probe("/dev/QUIET", fake()), null, "a port that says nothing isn't a lidar");

    await assert.rejects(probe("/dev/NOPE", fake()), "a port that won't open throws, so it isn't counted as a try");

    console.log("lidar selftest ok");
    process.exit(0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
