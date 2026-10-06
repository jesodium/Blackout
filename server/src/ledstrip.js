// The room's LED strip as the robot's status light.
//
// Steren SHOME-1282, a whitelabel Tuya 3.5 strip on the LAN (see
// ~/led-strip-control.md). It is NOT on the Giga: the three relay channels
// (D26/D28/D30) are the robot's own lights, this one is mains-powered scenery
// the PC talks to over wifi, so it lives here and never touches BLE.
//
// Everything the strip shows is already known server-side — the hud level off
// the sensor thresholds, Sage's own verdict, whether telemetry is arriving —
// so this reads state and pushes frames; nothing else has to remember to
// update a light. The one thing the server can't see is the TTS finishing, so
// the browser sends `speaking` over the socket.
//
// IMPORTANT NOTE: one strip, no addressing, no per-pixel anything. If a second
// light shows up, give ledd.py a device argument, not this file a driver layer.

const { spawn } = require("child_process");
const path = require("path");

const TICK_MS = 220;              // a dps write is 50-250ms; faster just drops frames
const SAGE_TTL = 25000;           // her verdict decays back to the sensor level

// hue + saturation per state. The strip has no white channel, so a colour is
// only these two — brightness is the animation channel and belongs to the
// effect below, not here.
const COLOR = {
  clear:   { h: 34, s: 900 },     // blackout orange. --accent (#e1a95f) is h34/s578,
                                  // and the sat is lifted because a 58% orange with
                                  // no white channel to mix reads as washed-out peach
  caution: { h: 0, s: 1000 },     // the same red as danger, held DARK — depth is what
  danger:  { h: 0, s: 1000 },     // separates them, along with breathe vs blink
  link:    { h: 210, s: 1000 },
  think:   { h: 285, s: 1000 },
};

const state = {
  link: false,
  level: "ok",                    // hud level off the sensor thresholds
  sage: null, sageAt: 0,          // her own clear/caution/danger read
  busy: false,                    // a model call is out
  speaking: false,
  manual: null,                   // /api/strip wins over all of it
  fx: null,                       // a party effect, off by default — see FX below
};

const RANK = { ok: 0, warn: 1, bad: 2, clear: 0, caution: 1, danger: 2 };
const NAME = ["clear", "caution", "danger"];

// square and sine, both 0..1, phase off the wall clock so nothing has to be
// scheduled or reset between states.
const blink = (now, ms) => (now % ms < ms / 2 ? 1 : 0);
const wave = (now, ms) => (1 - Math.cos((now % ms) / ms * 2 * Math.PI)) / 2;
const lerp = (lo, hi, x) => Math.round(lo + (hi - lo) * x);

// Party effects. IMPORTANT NOTE: the strip is ONE zone — no addressing, no
// per-pixel anything — so a matrix/rain effect can only ever be one drop at a
// time in brightness, never a column of them travelling down the strip. That
// is the ceiling; the upgrade path is different hardware (ws2812 off a pin),
// not more code here. Deterministic off the wall clock so frame() stays pure.
const DROP_MS = 420;                              // one drop per slot, ~2.4/s
const hash = (n) => { n = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b); n ^= n >>> 13; return (n >>> 0) % 1000 / 1000; };
const drops = (now, h) => {                       // bright head decaying to a dim floor
  const r = hash(Math.floor(now / DROP_MS)), p = (now % DROP_MS) / DROP_MS;
  return { h, s: 1000, v: r < 0.7 ? Math.min(1000, lerp(1000, 60, p) * (0.5 + r)) : 40 };
};
const FX = {
  matrix: (now) => drops(now, 120),
  rain:   (now) => drops(now, 210),
  // blackout's own weather: a dark blue room, then a strike of two or three
  // cold-white stabs. Reads well on one zone because real lightning IS the
  // whole room at once — the effect nothing is lost to the missing addressing.
  storm:  (now) => {
    // two independent draws: one says WHEN in the slot, one says IF at all —
    // sharing one would make every late strike also a skipped one.
    const slot = Math.floor(now / 2400), t = now % 2400;
    const start = 200 + hash(slot) * 1400, k = Math.floor((t - start) / 70);
    const lit = hash(slot * 7 + 3) < 0.75 && k >= 0 && k < 6 && hash(slot * 31 + k) < 0.5;
    return lit ? { h: 220, s: 120, v: 1000 } : { h: 220, s: 800, v: 40 };
  },
  fire:   (now) => ({ h: lerp(0, 40, wave(now, 900)), s: 1000, v: lerp(250, 1000, wave(now, 370)) }),
};

// The whole light in one pure function: state in, frame out. Colour says what
// is going on, motion and depth say how urgent — so a caution stays red while
// she talks over it instead of the strip forgetting the hazard to animate.
function frame(st, now) {
  if (st.manual) return st.manual;
  if (FX[st.fx]) { const f = FX[st.fx](now); return { ...f, h: Math.round(f.h), v: Math.round(f.v / 25) * 25 }; }
  const fresh = st.sage && now - st.sageAt < SAGE_TTL ? st.sage : null;
  const worst = NAME[Math.max(RANK[st.level] ?? 0, fresh ? RANK[fresh] : 0)];

  let c = COLOR[worst], v;
  if (!st.link) { c = COLOR.link; v = lerp(60, 700, wave(now, 2400)); }        // waiting on the rover
  else if (st.busy) { c = COLOR.think; v = lerp(120, 900, wave(now, 1400)); }  // Sage is thinking
  else if (worst === "danger") v = lerp(450, 1000, blink(now, 640));         // its dimmest is still brighter than
  else if (worst === "caution") v = lerp(80, 400, wave(now, 1800));           // caution's brightest — that gap IS the read
  else v = 320;
  if (st.speaking) v = lerp(200, 1000, blink(now, 460));                      // mouth flap, mood colour kept
  return { h: c.h, s: c.s, v: Math.round(v / 25) * 25 };                      // quantised: fewer needless writes
}

let proc = null, timer = null, last = "";

function push(f) {
  const line = f ? `${f.h} ${f.s} ${f.v}` : "0 0 0";
  if (line === last || !proc) return;
  last = line;
  proc.stdin.write(line + "\n");
}

function start() {
  if (process.env.LED_STRIP === "0" || process.env.LED_STRIP === "off") return;
  proc = spawn("python3", [path.join(__dirname, "ledd.py")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PYTHONWARNINGS: "ignore" },  // tinytuya pulls urllib3, which warns about LibreSSL on every import
  });
  proc.stdout.on("data", (d) => { const s = String(d).trim(); if (s.startsWith("err")) console.error("led strip:", s.slice(4)); });
  proc.stderr.on("data", (d) => console.error("led strip:", String(d).trim()));
  proc.on("error", (e) => { console.error("led strip: no daemon —", e.message); stop(); });
  proc.on("exit", () => { proc = null; clearInterval(timer); });
  proc.stdin.on("error", () => {});
  timer = setInterval(() => push(frame(state, Date.now())), TICK_MS);
  timer.unref?.();
}

function stop() {
  clearInterval(timer);
  if (proc) { push(null); proc.stdin.end(); }
  proc = null;
}

module.exports = {
  frame, state, start, stop,
  link: (ok) => { state.link = !!ok; },
  level: (l) => { if (RANK[l] != null) state.level = l; },
  sage: (s) => { if (RANK[s] != null) { state.sage = s; state.sageAt = Date.now(); } },
  busy: (b) => { state.busy = !!b; },
  speaking: (b) => { state.speaking = !!b; },
  manual: (f) => { state.manual = f; },
  fx: (n) => { state.fx = FX[n] ? n : null; return state.fx; },
  fxNames: Object.keys(FX),
};
