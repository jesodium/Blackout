// The esp32-cam over its own USB cable, for when there is no wifi to put it on.
// The board answers "f" with one jpeg (see serialTick() in esp32-cam/main/main.ino)
// and server.js re-serves those as the same /stream, /capture and /control the
// wifi cam answers on -- so the browser and vision.js learn one more HOST and
// nothing anywhere learns a second shape.
//
// IMPORTANT NOTE: one serial port, so this is cam 0 only. A second cam on usb
// would need a port per cam, and the rig has never run two cables.
const { SerialPort } = require("serialport");
const fs = require("fs");

// Must match CAM_BAUD in the sketch. 921600 is ~4fps on an svga frame; 115200
// is one frame every two seconds, which is a still, not a feed.
const CAM_BAUD = parseInt(process.env.CAM_BAUD || "921600", 10);
const FRAME_MS = parseInt(process.env.CAM_USB_TIMEOUT_MS || "4000", 10);

// The Giga is /dev/cu.usbmodem* (CDC) and never answers "f" -- skipping it keeps
// the probe short and keeps us off the board that is mid-flash.
const CAM_PORT_RE = /^cu\.(usbserial|wchusbserial|SLAB|usbmodem\w*[-_]?cam)/i;

const MARK = Buffer.from("#JPG ");

// Frames are taken by LENGTH, never by scanning for the next marker: jpeg payload
// can spell anything. Everything before a marker is the board's own chatter.
function takeFrame(buf) {
  const i = buf.indexOf(MARK);
  if (i === -1) return { rest: buf.subarray(Math.max(0, buf.length - MARK.length + 1)) };
  const nl = buf.indexOf(10, i + MARK.length);
  if (nl === -1) return { rest: buf.subarray(i) };
  const len = parseInt(buf.subarray(i + MARK.length, nl).toString(), 10);
  if (!(len > 0) || len > 1024 * 1024) return { rest: buf.subarray(nl + 1) };  // junk header, drop it
  if (buf.length < nl + 1 + len) return { rest: buf.subarray(i) };             // still arriving
  return { frame: buf.subarray(nl + 1, nl + 1 + len), rest: buf.subarray(nl + 1 + len) };
}

let port = null, opening = null, buf = Buffer.alloc(0), waiting = [];

function attach(p) {
  port = p;
  buf = Buffer.alloc(0);
  p.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const cut = takeFrame(buf);
      buf = cut.rest;
      if (!cut.frame) break;
      const w = waiting.shift();
      if (w) { clearTimeout(w.timer); w.resolve(cut.frame); }
    }
  });
  const drop = () => {
    if (port === p) port = null;
    for (const w of waiting.splice(0)) { clearTimeout(w.timer); w.reject(new Error("usb cam went away")); }
  };
  p.on("close", drop);
  p.on("error", drop);
}

function ask(timeoutMs = FRAME_MS) {
  return new Promise((resolve, reject) => {
    const w = { resolve, reject };
    w.timer = setTimeout(() => {
      waiting = waiting.filter((x) => x !== w);
      reject(new Error("usb cam timeout"));
    }, timeoutMs);
    waiting.push(w);
    port.write("f\n");
  });
}

async function open() {
  if (port?.isOpen) return port;
  if (opening) return opening;
  opening = (async () => {
    const paths = process.env.CAM_SERIAL
      ? [process.env.CAM_SERIAL]
      : (await fs.promises.readdir("/dev")).filter((n) => CAM_PORT_RE.test(n)).map((n) => "/dev/" + n);
    for (const path of paths) {
      try {
        const p = await new Promise((res, rej) => {
          const sp = new SerialPort({ path, baudRate: CAM_BAUD }, (e) => (e ? rej(e) : res(sp)));
        });
        attach(p);
        await ask(FRAME_MS);   // a port only counts if it hands over a picture
        console.log("cam over usb:", path);
        return p;
      } catch (e) {
        port?.close?.(() => {});
        port = null;
      }
    }
    throw new Error("no cam on usb");
  })();
  try { return await opening; } finally { opening = null; }
}

const frame = async () => { await open(); return ask(); };
const set = async (v, val) => { await open(); port.write(`v ${v} ${Math.round(val)}\n`); return val; };
const isOpen = () => !!port?.isOpen;
// flash.sh wants the same cable: a port we are still holding is a flash that dies
// on "resource busy" and reads as a dead board. The next frame request reopens it.
const close = () => { port?.close?.(() => {}); port = null; };

module.exports = { frame, set, isOpen, close, takeFrame };

// ---- selftest ----
if (require.main === module && process.argv.includes("--selftest")) {
  const assert = require("assert");
  const jpg = Buffer.from([0xff, 0xd8, 10, 0x23, 0x4a, 0xff, 0xd9]);   // payload spelling "\n#J"
  const wire = Buffer.concat([Buffer.from("wifi dropped\n\n#JPG 7\n"), jpg, Buffer.from("net up\n")]);

  let b = Buffer.alloc(0), got = [];
  for (const byte of wire) {                    // one byte at a time: a frame spans chunks
    b = Buffer.concat([b, Buffer.from([byte])]);
    for (;;) { const c = takeFrame(b); b = c.rest; if (!c.frame) break; got.push(c.frame); }
  }
  assert.equal(got.length, 1, "one frame");
  assert.deepEqual(got[0], jpg, "payload survived, marker in it and all");

  assert.ok(!takeFrame(Buffer.from("#JPG 99\nab")).frame, "a half-arrived frame waits");
  assert.ok(!takeFrame(Buffer.from("#JPG 0\nxx")).frame, "a junk length is dropped, not trusted");
  assert.ok(!CAM_PORT_RE.test("cu.usbmodem1101"), "the giga's port must not be probed");

  // the sketch and this file are two halves of one wire format
  const ino = fs.readFileSync(__dirname + "/../esp32-cam/main/main.ino", "utf8");
  assert.equal(+ino.match(/#define CAM_BAUD (\d+)/)[1], CAM_BAUD, "the two CAM_BAUDs must match");
  // The preprocessor cannot see an enum: as enum values, `#if CAM_NETWORK !=
  // NET_NONE` reads 0 != 0 and quietly compiles the radio out of every build.
  assert.match(ino, /^#define NET_NONE\s+\d+$/m, "NET_* must be #defines, not an enum");
  assert.ok(CAM_PORT_RE.test("cu.wchusbserial110"), "a ch340 adapter is a cam port");
  console.log("camserial ok");
}
