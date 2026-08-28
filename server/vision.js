// sage's eyes: grab one jpeg from the cam's /capture endpoint
// gemini handles image+text in one call. no separate vision provider (the cerebras
// fallback is text-only — a fallback analyse still answers, just blind).
// cam unreachable => returns [] and sage runs blind.
// important: /capture, not /stream. the dashboard <img> holds /stream on :81;
// a second /stream grab starves. /capture on :80 returns one frame immediately.
// cam_url may be a comma-separated list (home ip, hotspot ip).
// each grab tries them in order, starting from whichever answered last.
// the server needs no edit when the cam moves between networks.
const CAM_URLS = (process.env.CAM_URL || "http://192.168.1.111/capture")
  .split(",").map(s => s.trim()).filter(Boolean);
let camIdx = 0; // sticky index of the last url that answered
const sharp = require("sharp");

// node's dns.lookup can't do mdns — .local hostnames timeout.
// ping resolves .local fine but node/curl don't (apple special-cases ping).
// so we resolve .local names here via direct multicast query.
// short cache since dhcp can reassign the cam's ip.
const mdns = require("multicast-dns")();
const mdnsCache = new Map(); // hostname -> { ip, at }
const MDNS_TTL = 60_000;
function resolveMdns(hostname, timeoutMs = 2000) {
  const cached = mdnsCache.get(hostname);
  if (cached && Date.now() - cached.at < MDNS_TTL) return Promise.resolve(cached.ip);
  return new Promise((resolve, reject) => {
    const onResponse = (resp) => {
      const a = resp.answers.find((r) => r.type === "A" && r.name === hostname);
      if (!a) return;
      clearTimeout(timer);
      mdns.removeListener("response", onResponse);
      mdnsCache.set(hostname, { ip: a.data, at: Date.now() });
      resolve(a.data);
    };
    const timer = setTimeout(() => {
      mdns.removeListener("response", onResponse);
      reject(new Error(`mDNS timeout resolving ${hostname}`));
    }, timeoutMs);
    mdns.on("response", onResponse);
    mdns.query({ questions: [{ name: hostname, type: "A" }] });
  });
}
// swap .local hostname in cam url for resolved ip; pass others through untouched.
async function resolveCamUrl(url) {
  const u = new URL(url);
  if (!u.hostname.endsWith(".local")) return url;
  u.hostname = await resolveMdns(u.hostname);
  return u.toString();
}

// cam is mounted rotated 90°. ov2640 can vflip/hmirror but not rotate in-sensor.
// dashboard <img> un-rotates in css (.cam-feed), but sage eats raw /capture bytes
// so we un-rotate here too or the model reads sideways. must match css rotation.
// important: remount cam upright and this whole step goes away — set cam_rotate=0.
const CAM_ROTATE = parseInt(process.env.CAM_ROTATE ?? "270", 10);

// pull first complete jpeg (ffd8..ffd9) from an mjpeg buffer.
// pure function so testable without a live cam — see test-vision.js.
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
function carveJpeg(buf) {
  const start = buf.indexOf(SOI);
  if (start === -1) return null;
  const end = buf.indexOf(EOI, start + 2);
  if (end === -1) return null;
  return buf.subarray(start, end + 2);
}

// rotate a sideways frame upright. falls back to original bytes if sharp chokes.
async function upright(jpeg) {
  if (!CAM_ROTATE) return jpeg;
  try {
    return await sharp(jpeg).rotate(CAM_ROTATE).jpeg().toBuffer();
  } catch (err) {
    console.error("vision rotate failed, using raw frame:", err.message);
    return jpeg;
  }
}

// grab one still from /capture, trying each cam url until one answers.
// important: a cam on the other network hangs (unroutable ip) rather than refusing,
// so a wrong first url costs the full timeout. the sticky camidx means that's paid once.
async function grabFrame(timeoutMs = 8000) {
  let lastErr;
  for (let i = 0; i < CAM_URLS.length; i++) {
    const idx = (camIdx + i) % CAM_URLS.length;
    try {
      const frame = await grabFrameFrom(CAM_URLS[idx], timeoutMs);
      camIdx = idx;
      return frame;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function grabFrameFrom(url, timeoutMs) {
  const resolved = await resolveCamUrl(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(resolved, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`cam HTTP ${resp.status}`);
    const reader = resp.body.getReader();
    let buf = Buffer.alloc(0);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf = Buffer.concat([buf, Buffer.from(value)]);
      const frame = carveJpeg(buf);
      if (frame) { ctrl.abort(); return upright(frame); }
      // bail if a frame never completes — keeps memory bounded.
      if (buf.length > 1024 * 1024) throw new Error("no full frame in 1MB");
    }
    throw new Error("stream ended before a frame");
  } finally {
    clearTimeout(timer);
  }
}

// cheap up/down probe for the oled heartbeat — /control with no query does no
// frame grab, just an instant ack, so this is far lighter than grabFrame().
async function pingCam(timeoutMs = 3000) {
  for (let i = 0; i < CAM_URLS.length; i++) {
    const idx = (camIdx + i) % CAM_URLS.length;
    try {
      const resolved = await resolveCamUrl(CAM_URLS[idx]);
      const u = new URL(resolved);
      u.pathname = "/control";
      u.search = "";
      const resp = await fetch(u, { signal: AbortSignal.timeout(timeoutMs) });
      if (resp.ok) { camIdx = idx; return true; }
    } catch { /* try next url */ }
  }
  return false;
}

// sage's lamp — same host as frame grabs, reuse sticky camidx.
// level is remembered so sage knows what she's already running.
let ledLevel = 0; // matches cam firmware, which writes the lamp off once it's up
// IMPORTANT NOTE: walks the url list like grabFrame/pingCam do, and for the same
// reason — camIdx is 0 until *something else* has answered, so on a fresh server
// a lamp write went to whichever network was listed first and died on its
// timeout. Sage sets the lamp without taking a picture first, so she was
// routinely the thing that ran before anything had made the index sticky.
async function setLed(val) {
  const v = Math.max(0, Math.min(255, Math.round(val)));
  let lastErr;
  for (let i = 0; i < CAM_URLS.length; i++) {
    const idx = (camIdx + i) % CAM_URLS.length;
    try {
      const u = new URL(await resolveCamUrl(CAM_URLS[idx]));
      u.pathname = "/control";
      u.search = `var=led&val=${v}`;
      const resp = await fetch(u, { signal: AbortSignal.timeout(3000) });
      if (!resp.ok) throw new Error(`cam HTTP ${resp.status}`);
      camIdx = idx;
      ledLevel = v;
      return v;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
const getLed = () => ledLevel;

// --- auto headlamp ---------------------------------------------------------
// "can it see?" is answered from the frame itself, not by asking sage: the venue
// has no internet, and an llm round trip per lamp step is seconds spent blind.
// sharp is already here for upright(), so mean luma is one call.
// the bh1750 says *when* to look (it's not pointed where the lens is); the frame
// says whether the lamp is enough.
const LAMP_LO = parseInt(process.env.LAMP_LO || "55", 10);   // mean below this = too dark
const LAMP_HI = parseInt(process.env.LAMP_HI || "165", 10);  // above this = blown out
const LAMP_MIN = parseInt(process.env.LAMP_MIN || "8", 10);  // smaller move than this isn't worth a write
const LAMP_GAP = parseInt(process.env.LAMP_GAP_MS || "4000", 10); // one /capture per gap
const LAMP_FORGET = parseInt(process.env.LAMP_FORGET_MS || "60000", 10);

// pure, so the loop is checkable without a camera. the walk's whole state is the
// lo/hi bracket, passed in and handed back; next === null = leave the lamp alone.
// IMPORTANT NOTE: a bracket, not a fixed +/-STEP. A stepper with no memory blinks
// between two levels forever whenever neither reads in band (black at 0, blown at
// 40) — a headlamp flashing every LAMP_GAP, which is exactly what it did. lo/hi
// only ever narrow, so the walk always ends. Straight halving; if it ever needs to
// be gentler, shrink the range, don't add a PID.
function lampStep(mean, led, lo = 0, hi = 255) {
  if (mean >= LAMP_LO && mean <= LAMP_HI) return { next: null, lo: 0, hi: 255 }; // in band: forget the walk
  if (mean < LAMP_LO) lo = Math.max(lo, led);
  else hi = Math.min(hi, led);
  const next = Math.round((lo + hi) / 2);
  // bounds met: this lamp has no level that reads in band (or we're at the rail),
  // so stop here instead of flapping between the two nearest.
  return { next: hi - lo <= LAMP_MIN || next === led ? null : next, lo, hi };
}

// the announced ramp: dark -> sage says she's turning the lamp on, then it walks
// up to LAMP_MAX instead of snapping there. pure, so the walk is checkable without
// a cam. empty list = already at or above the target, so nothing to write.
const LAMP_MAX = parseInt(process.env.LAMP_MAX || "250", 10);
const LAMP_RAMP_STEP = parseInt(process.env.LAMP_RAMP_STEP || "10", 10);
function rampTo(from, to = LAMP_MAX, step = LAMP_RAMP_STEP) {
  if (from >= to) return [];
  const out = [];
  for (let v = from + step; v < to; v += step) out.push(v);
  out.push(to);
  return out;
}

let lampAt = 0, lampMoved = 0, lampLo = 0, lampHi = 255, lampQuiet = false;
async function autoLamp() {
  // settled? look far less often — /capture and /stream fight over the ai-thinker's
  // ram, and a lamp with nothing to do shouldn't cost a frame every 4s.
  if (Date.now() - lampAt < (lampQuiet ? LAMP_GAP * 5 : LAMP_GAP)) return null;
  lampAt = Date.now();
  // a collapsed bracket is only true for the scene that made it: forget it after a
  // while, or a rover that drives somewhere different stays stuck on the old level.
  if (lampQuiet && lampAt - lampMoved > LAMP_FORGET) { lampLo = 0; lampHi = 255; }
  const jpeg = await grabFrame(4000);
  const mean = (await sharp(jpeg).greyscale().stats()).channels[0].mean;
  const from = ledLevel;
  const { next, lo, hi } = lampStep(mean, from, lampLo, lampHi);
  lampLo = lo; lampHi = hi;
  lampQuiet = next == null;
  if (next != null) { lampMoved = lampAt; await setLed(next); }
  return { mean: Math.round(mean), from, led: ledLevel, changed: next != null };
}

// grab a fresh camera frame as openai image content parts, ready for a user message.
// fresh each turn so sage sees what's in front of the lens now.
// a short cache (~1.5s) avoids double-hitting the flaky ai-thinker board when
// chat turn + auto-analysis fire together (both httpd tasks share limited ram).
// on failure, keep last good frame and throttle retries.
let frameCache = { data: "", at: 0 };
const FRESH_TTL = parseInt(process.env.VISION_FRESH_MS || "1500", 10);
// IMPORTANT NOTE: this has to be longer than a failed grab *costs*, not just longer
// than feels polite. A dark cam is 3 CAM_URLS x the 8s grabFrame timeout (+ the mDNS
// wait on the .local one) = ~19s of measured dead air, and at the old 6s throttle
// every chat turn more than 6s after the last one paid that again — the operator saw
// a 19s Sage, blamed the llm, and the llm had answered in 440ms. 30s means a dark cam
// costs the wait once per half minute; a cam that comes back is noticed that late too.
const FAIL_THROTTLE = parseInt(process.env.VISION_TTL || "30", 10) * 1000;
// max age a cached frame may be served as "live". past this, sage goes blind.
const MAX_FRAME_AGE = parseInt(process.env.VISION_MAX_AGE_MS || "30000", 10);
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
      lastFail = Date.now(); // cam down — hold off regrabbing, reuse last good frame
    }
  }
  if (frameCache.data && Date.now() - frameCache.at >= MAX_FRAME_AGE) {
    frameCache = { data: "", at: 0 }; // too old to pass off as live
  }
  return frameCache.data
    ? [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${frameCache.data}` } }]
    : [];
}

// grab `count` fresh stills spaced `gapms` apart, bypassing cache.
// returns image_url parts, skipping any failed grab. [] if cam is dark.
// cam is fixed forward, so count > 1 only makes sense for watching change over time.
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

module.exports = { carveJpeg, upright, grabFrame, eyeParts, grabFrames, setLed, getLed, pingCam, autoLamp, lampStep, rampTo, LAMP_MAX };
