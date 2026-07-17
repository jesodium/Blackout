// sage's eyes: grab one jpeg from the cam's /capture endpoint
// gemma-4-31b on cerebras handles image+text in one call. no separate vision provider.
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

// sage's lamp — same host as frame grabs, reuse sticky camidx.
// level is remembered so sage knows what she's already running.
let ledLevel = 15; // matches cam firmware's boot default
async function setLed(val) {
  const v = Math.max(0, Math.min(255, Math.round(val)));
  const u = new URL(await resolveCamUrl(CAM_URLS[camIdx]));
  u.pathname = "/control";
  u.search = `var=led&val=${v}`;
  const resp = await fetch(u, { signal: AbortSignal.timeout(3000) });
  if (!resp.ok) throw new Error(`cam HTTP ${resp.status}`);
  ledLevel = v;
  return v;
}
const getLed = () => ledLevel;

// grab a fresh camera frame as openai image content parts, ready for a user message.
// fresh each turn so sage sees what's in front of the lens now.
// a short cache (~1.5s) avoids double-hitting the flaky ai-thinker board when
// chat turn + auto-analysis fire together (both httpd tasks share limited ram).
// on failure, keep last good frame and throttle retries.
let frameCache = { data: "", at: 0 };
const FRESH_TTL = parseInt(process.env.VISION_FRESH_MS || "1500", 10);
const FAIL_THROTTLE = parseInt(process.env.VISION_TTL || "6", 10) * 1000;
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

module.exports = { carveJpeg, upright, grabFrame, eyeParts, grabFrames, setLed, getLed };
