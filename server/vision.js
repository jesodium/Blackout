// SAGE's eyes: pull one JPEG out of the cam's MJPEG /stream and hand it to the
// model as an image. SAGE runs on Cerebras' multimodal gemma-4-31b, so the same
// model that talks also sees — no separate vision provider, no describe step.
// Cam unreachable => returns [] and SAGE just runs blind.
const CAM_STREAM_URL = process.env.CAM_URL || "http://blackout-cam.local/stream";

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

// Grab one still by reading the MJPEG stream until a whole frame lands.
async function grabFrame(timeoutMs = 3000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(CAM_STREAM_URL, { signal: ctrl.signal });
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
// message. Cached briefly so a burst of turns reuses a single grab; on failure
// it throttles retries by the TTL and keeps the last good frame if any.
let frameCache = { data: "", at: 0 };
const SCENE_TTL = parseInt(process.env.VISION_TTL || "6", 10) * 1000;
async function eyeParts() {
  if (Date.now() - frameCache.at >= SCENE_TTL) {
    try {
      const f = await grabFrame();
      frameCache = { data: f.toString("base64"), at: Date.now() };
    } catch (err) {
      console.error("vision error:", err.message);
      frameCache.at = Date.now(); // throttle retry, keep any stale frame
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
