// SAGE's eyes: grab one JPEG from the cam's single-shot /capture and hand it to the
// model as an image. SAGE runs on Cerebras' multimodal gemma-4-31b, so the same
// model that talks also sees — no separate vision provider, no describe step.
// Cam unreachable => returns [] and SAGE just runs blind.
// IMPORTANT NOTE: /capture, NOT /stream. The cam serves the infinite MJPEG /stream on
// its own httpd task (:81); while the dashboard <img> holds it, a second /stream grab
// starves. /capture is a separate task on :80 that returns one frame immediately.
// CAM_URL may be a comma-separated list (home IP, hotspot IP) — each grab tries
// them in order, starting from whichever answered last, so the server needs no
// edit when the cam moves between networks.
const CAM_URLS = (process.env.CAM_URL || "http://192.168.1.111/capture")
  .split(",").map(s => s.trim()).filter(Boolean);
let camIdx = 0; // sticky index of the last URL that answered
const sharp = require("sharp");

// Node's own resolver (dns.lookup / undici fetch) can't do mDNS — getaddrinfo()
// on .local names just times out, confirmed live (ping resolves .local fine,
// node/curl don't; Apple special-cases ping, not getaddrinfo). So a .local
// CAM_URL entry is resolved by hand here via a direct multicast query, with a
// short cache since a DHCP network can reassign the cam's IP.
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
// Swap a .local hostname in a cam URL for its resolved IP; passes other URLs through untouched.
async function resolveCamUrl(url) {
  const u = new URL(url);
  if (!u.hostname.endsWith(".local")) return url;
  u.hostname = await resolveMdns(u.hostname);
  return u.toString();
}

// Cam is mounted rotated 90°, and the OV2640 can only vflip/hmirror in-sensor — never
// rotate. The dashboard <img> un-rotates in CSS (.cam-feed), but Sage eats the raw
// /capture bytes, so it has to be un-rotated here too or the model reads the scene
// sideways. Must match the CSS rotation. IMPORTANT NOTE: remount the cam upright and
// this whole step goes away — set CAM_ROTATE=0.
const CAM_ROTATE = parseInt(process.env.CAM_ROTATE ?? "270", 10);

// Pull the first complete JPEG (FFD8..FFD9) out of an MJPEG buffer. Pure so the
// frame-grab logic is testable without a live cam — see test-vision.js.
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
function carveJpeg(buf) {
  const start = buf.indexOf(SOI);
  if (start === -1) return null;
  const end = buf.indexOf(EOI, start + 2);
  if (end === -1) return null;
  return buf.subarray(start, end + 2);
}

// Turn a sideways frame upright. Falls back to the original bytes if sharp chokes —
// a rotation failure should cost Sage its bearings, not its eyes.
async function upright(jpeg) {
  if (!CAM_ROTATE) return jpeg;
  try {
    return await sharp(jpeg).rotate(CAM_ROTATE).jpeg().toBuffer();
  } catch (err) {
    console.error("vision rotate failed, using raw frame:", err.message);
    return jpeg;
  }
}

// Grab one still from /capture, trying each known cam URL until one answers.
// IMPORTANT NOTE: a cam on the *other* network hangs (unroutable IP) rather than
// refusing, so a wrong first URL costs the full per-try timeout before the right
// one is hit — the sticky camIdx means that's paid once, not per grab.
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
      // IMPORTANT NOTE: bail if a frame never completes; keeps memory bounded.
      if (buf.length > 1024 * 1024) throw new Error("no full frame in 1MB");
    }
    throw new Error("stream ended before a frame");
  } finally {
    clearTimeout(timer);
  }
}

// Sage's lamp. Same host as the frame grabs, so reuse the sticky camIdx — whichever
// URL last answered is the network the cam is actually on. Level is remembered so
// Sage can be told what she's already running instead of guessing blind.
let ledLevel = 15; // matches the cam firmware's boot default
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
// Hard ceiling on how old a cached frame may be served as "live". A cam that
// died shouldn't leave Sage confidently narrating a stale scene — past this
// age Sage goes blind instead.
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
      lastFail = Date.now(); // cam down — hold off re-grabbing, reuse last good frame
    }
  }
  if (frameCache.data && Date.now() - frameCache.at >= MAX_FRAME_AGE) {
    frameCache = { data: "", at: 0 }; // too old to pass off as live
  }
  return frameCache.data
    ? [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${frameCache.data}` } }]
    : [];
}

// Grab `count` fresh stills spaced `gapMs` apart, bypassing the frameCache so a
// caller that wants a guaranteed-fresh view isn't served a cached one. Returns
// image_url parts (same shape eyeParts uses), skipping any grab that fails; [] if
// the cam is fully dark. The camera is fixed forward, so count > 1 only makes sense
// for watching something change over time — not for covering more ground.
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
