// esp32-cam stills and the headlamp. the cams are mounted on their sides, so
// anything a model looks at goes through upright() first.

// CAM_URL holds one group per camera: `;` between cameras, `,` between the
// addresses one camera answers on (home / hotspot / school). Cam 0 is the front
// eye and owns the headlamp; cam 1 is the arm/gripper view.
const CAM_GROUPS = (process.env.CAM_URL || "http://192.168.1.111/capture")
  .split(";").map(g => g.split(",").map(s => s.trim()).filter(Boolean)).filter(g => g.length);
const camIdx = CAM_GROUPS.map(() => 0);
const camCount = CAM_GROUPS.length;
const sharp = require("sharp");

// try one camera's addresses in turn, sticking to whichever answered last
async function overCam(cam, fn) {
  const c = CAM_GROUPS[cam] ? cam : 0;
  const list = CAM_GROUPS[c];
  let lastErr = new Error("no camera configured");
  for (let i = 0; i < list.length; i++) {
    const idx = (camIdx[c] + i) % list.length;
    try {
      const out = await fn(list[idx]);
      camIdx[c] = idx;
      return out;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// ---- mdns ----
// the cam answers to blackout-cam.local, which node won't resolve on its own
const mdns = require("multicast-dns")();
const mdnsCache = new Map();
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

async function resolveCamUrl(url) {
  const u = new URL(url);
  if (!u.hostname.endsWith(".local")) return url;
  u.hostname = await resolveMdns(u.hostname);
  return u.toString();
}

// ---- frames ----
// The mount angle, clockwise degrees, same number the dashboard's ROTATE button
// holds. Per camera — the two are mounted differently. env is the boot default;
// the button overrides it at runtime so a cam flipped mid-session doesn't leave
// Sage reading sideways stills.
const CAM_ROTATE = CAM_GROUPS.map(() => parseInt(process.env.CAM_ROTATE ?? "270", 10));
const setCamRot = (deg, cam = 0) => {
  CAM_ROTATE[CAM_GROUPS[cam] ? cam : 0] = ((Math.round(deg / 90) * 90 % 360) + 360) % 360;
};

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
function carveJpeg(buf) {
  const start = buf.indexOf(SOI);
  if (start === -1) return null;
  const end = buf.indexOf(EOI, start + 2);
  if (end === -1) return null;
  return buf.subarray(start, end + 2);
}

async function upright(jpeg, cam = 0) {
  const deg = CAM_ROTATE[cam] || 0;
  if (!deg) return jpeg;
  try {
    return await sharp(jpeg).rotate(deg).jpeg().toBuffer();
  } catch (err) {
    console.error("vision rotate failed, using raw frame:", err.message);
    return jpeg;
  }
}

// Sage's stills come off a dashboard's own /stream when one is open. The cam
// serves exactly ONE stream (its handler never returns) and a concurrent /capture
// starves the shared frame buffers, which is what used to blink the feed out every
// time she looked -- the old fix was to tear the feed down first (cam-yield) and
// pay ~12s of "loading" to reopen it. No browser = no stream = no contention, so
// with nothing to borrow from we just fall through to /capture.
let frameSource = null;
const setFrameSource = (fn) => { frameSource = fn; };

const grabFrame = async (cam = 0, timeoutMs = 8000) => {
  if (frameSource) {
    try {
      const b = await frameSource(cam);
      if (b?.length) return upright(b, cam);
    } catch (err) { console.error("borrowed frame:", err.message); }
  }
  return overCam(cam, (url) => grabFrameFrom(url, timeoutMs, cam));
};

async function grabFrameFrom(url, timeoutMs, cam = 0) {
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
      if (frame) { ctrl.abort(); return upright(frame, cam); }

      if (buf.length > 1024 * 1024) throw new Error("no full frame in 1MB");
    }
    throw new Error("stream ended before a frame");
  } finally {
    clearTimeout(timer);
  }
}

async function pingCam(timeoutMs = 3000, cam = 0) {
  try {
    return await overCam(cam, async (url) => {
      const u = new URL(await resolveCamUrl(url));
      u.pathname = "/control";
      u.search = "";
      const resp = await fetch(u, { signal: AbortSignal.timeout(timeoutMs) });
      if (!resp.ok) throw new Error(`cam HTTP ${resp.status}`);
      return true;
    });
  } catch { return false; }
}

// ---- headlamp ----
let ledLevel = 0;

async function setLed(val) {
  const v = Math.max(0, Math.min(255, Math.round(val)));
  // the headlamp is cam 0's — the arm cam has no lamp worth driving
  return overCam(0, async (url) => {
    const u = new URL(await resolveCamUrl(url));
    u.pathname = "/control";
    u.search = `var=led&val=${v}`;
    const resp = await fetch(u, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) throw new Error(`cam HTTP ${resp.status}`);
    ledLevel = v;
    return v;
  });
}
const getLed = () => ledLevel;

// ---- what sage sees ----
const frameCache = CAM_GROUPS.map(() => ({ data: "", at: 0 }));
const FRESH_TTL = parseInt(process.env.VISION_FRESH_MS || "1500", 10);

const FAIL_THROTTLE = parseInt(process.env.VISION_TTL || "30", 10) * 1000;

const MAX_FRAME_AGE = parseInt(process.env.VISION_MAX_AGE_MS || "30000", 10);
const lastFail = CAM_GROUPS.map(() => 0);
async function eyeParts(cam = 0) {
  const c = CAM_GROUPS[cam] ? cam : 0;
  const cache = frameCache[c];
  const stale = Date.now() - cache.at >= FRESH_TTL;
  if (stale && Date.now() - lastFail[c] >= FAIL_THROTTLE) {
    try {
      const f = await grabFrame(c);
      cache.data = f.toString("base64");
      cache.at = Date.now();
      lastFail[c] = 0;
    } catch (err) {
      console.error("vision error:", err.message);
      lastFail[c] = Date.now();
    }
  }
  if (cache.data && Date.now() - cache.at >= MAX_FRAME_AGE) {
    cache.data = ""; cache.at = 0;
  }
  return cache.data
    ? [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${cache.data}` } }]
    : [];
}

async function grabFrames(count = 4, gapMs = 1000, cam = 0) {
  const parts = [];
  for (let i = 0; i < count; i++) {
    if (i) await new Promise((r) => setTimeout(r, gapMs));
    try {
      const f = await grabFrame(cam);
      parts.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${f.toString("base64")}` } });
    } catch (err) {
      console.error("vision grabFrames:", err.message);
    }
  }
  return parts;
}

module.exports = { carveJpeg, upright, setCamRot, setFrameSource, camCount, grabFrame, eyeParts, grabFrames, setLed, getLed, pingCam };
