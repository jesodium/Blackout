// SAGE's eyes: grab one JPEG from the cam's single-shot /capture and hand it to the
// model as an image. SAGE runs on Cerebras' multimodal gemma-4-31b, so the same
// model that talks also sees — no separate vision provider, no describe step.
// Cam unreachable => returns [] and SAGE just runs blind.
// IMPORTANT NOTE: /capture, NOT /stream. The cam serves the infinite MJPEG /stream on
// its own httpd task (:81); while the dashboard <img> holds it, a second /stream grab
// starves. /capture is a separate task on :80 that returns one frame immediately.
const CAM_CAPTURE_URL = process.env.CAM_URL || "http://blackout-cam.local/capture";

// Pull the first complete JPEG (FFD8..FFD9) out of an MJPEG buffer. Pure so the
// scan logic is testable without a live cam — see test-vision.js.
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
function carveJpeg(buf) {
  const start = buf.indexOf(SOI);
  if (start === -1) return null;
  const end = buf.indexOf(EOI, start + 2);
  if (end === -1) return null;
  return buf.subarray(start, end + 2);
}

// Grab one still from /capture. Timeout is generous because cold mDNS (.local)
// resolution can take ~5s on some networks; the frameCache means we rarely pay it.
// IMPORTANT NOTE: set CAM_URL to the cam's raw IP in .env to skip mDNS entirely if
// grabs feel slow — faster, but breaks on a DHCP lease change.
async function grabFrame(timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(CAM_CAPTURE_URL, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`cam HTTP ${resp.status}`);
    const reader = resp.body.getReader();
    let buf = Buffer.alloc(0);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf = Buffer.concat([buf, Buffer.from(value)]);
      const frame = carveJpeg(buf);
      if (frame) { ctrl.abort(); return frame; }
      // IMPORTANT NOTE: bail if a frame never completes; keeps memory bounded.
      if (buf.length > 1024 * 1024) throw new Error("no full frame in 1MB");
    }
    throw new Error("stream ended before a frame");
  } finally {
    clearTimeout(timer);
  }
}

// One camera frame as OpenAI image content parts, ready to append to a user
// message. Grabs fresh with a SHORT freshness window so each turn sees what's in
// front of the lens now — a 6s cache made Sage keep describing whatever it saw ~6s
// ago. The window is small enough you can't out-swap it interactively, but a chat
// turn + auto-analysis firing together reuse one grab instead of double-hitting the
// flaky AI-Thinker board (both httpd tasks share limited RAM). On a grab failure we
// keep the last good frame and throttle retries so a dead cam doesn't stall turns.
let frameCache = { data: "", at: 0 };
const FRESH_TTL = parseInt(process.env.VISION_FRESH_MS || "1500", 10);
const FAIL_THROTTLE = parseInt(process.env.VISION_TTL || "6", 10) * 1000;
let lastFail = 0;
async function eyeParts() {
  const stale = Date.now() - frameCache.at >= FRESH_TTL;
  if (stale && Date.now() - lastFail >= FAIL_THROTTLE) {
    try {
      const f = await grabFrame();
      frameCache = { data: f.toString("base64"), at: Date.now() };
      lastFail = 0;
    } catch (err) {
      console.error("vision error:", err.message);
      lastFail = Date.now(); // cam down — hold off re-grabbing, reuse last good frame
    }
  }
  return frameCache.data
    ? [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${frameCache.data}` } }]
    : [];
}

// Grab `count` fresh stills spaced `gapMs` apart, bypassing the frameCache so each
// lands at a different servo angle during a slow pan. Returns image_url parts (same
// shape eyeParts uses), skipping any grab that fails; [] if the cam is fully dark.
// IMPORTANT NOTE: loose sync — caller fires the BLE "scan" and this back-to-back, so
// count*gapMs should roughly match the firmware slow-sweep duration. No handshake.
async function grabFrames(count = 4, gapMs = 1000) {
  const parts = [];
  for (let i = 0; i < count; i++) {
    if (i) await new Promise((r) => setTimeout(r, gapMs));
    try {
      const f = await grabFrame();
      parts.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${f.toString("base64")}` } });
    } catch (err) {
      console.error("vision grabFrames:", err.message);
    }
  }
  return parts;
}

module.exports = { carveJpeg, grabFrame, eyeParts, grabFrames };
