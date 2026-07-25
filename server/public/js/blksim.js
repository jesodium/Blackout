// blksim — toy rover physics so a .blk program can be run (and watched) without
// the robot. open-loop like the real thing: timed bursts, no odometry, plus a
// raycast "ultrasonic" so `dist` conditions actually mean something on screen.
// IMPORTANT NOTE: kinematics are a guess (30 cm/s, 180 °/s at full pwm) — tune
// SPEED_CMS/TURN_DPS against the bench once the real rover is measured.

export const ARENA = { w: 300, h: 220 }; // cm
export const SPEED_CMS = 30;   // forward speed at pwm 255
export const TURN_DPS = 180;   // spin rate at pwm 255
export const MAX_RANGE = 200;  // ultrasonic ceiling, cm

export const LAYOUTS = {
  corridor: [
    { x: 90, y: 0, w: 16, h: 90 },
    { x: 90, y: 130, w: 16, h: 90 },
    { x: 200, y: 60, w: 16, h: 160 },
  ],
  cave: [
    { x: 120, y: 40, w: 50, h: 40 },
    { x: 60, y: 140, w: 70, h: 26 },
    { x: 210, y: 90, w: 30, h: 90 },
    { x: 170, y: 175, w: 90, h: 20 },
  ],
  open: [{ x: 150, y: 95, w: 30, h: 30 }],
};

const inRect = (x, y, r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

export class Sim {
  constructor(layout = "cave") {
    this.layout = layout;
    this.reset();
  }
  reset() {
    // copy: the arena gets edited by clicking, the layout constant must not
    this.obs = (LAYOUTS[this.layout] || LAYOUTS.cave).map(r => ({ ...r }));
    this.x = 40; this.y = 110; this.th = 0; // th: degrees, 0 = +x
    this.trail = [[this.x, this.y]];
    this.bumps = 0;
    this.t = 0; // sim ms elapsed
    this.env = { temp: 22, humid: 45, smoke: 0, airq: 120, co: 0, pressure: 1008 };
    this.led = 0;
  }
  setLayout(name) { this.layout = name; this.reset(); }

  // click-to-edit arena: drop a 24 cm block, or clear the one under the pointer
  toggleObstacle(x, y) {
    const hit = this.obs.findIndex(r => inRect(x, y, r));
    if (hit >= 0) this.obs.splice(hit, 1);
    else this.obs.push({ x: x - 12, y: y - 12, w: 24, h: 24 });
  }
  // drop the rover somewhere else (shift-click), keeping its heading
  place(x, y) {
    this.x = Math.max(6, Math.min(ARENA.w - 6, x));
    this.y = Math.max(6, Math.min(ARENA.h - 6, y));
    this.trail = [[this.x, this.y]];
  }

  blocked(x, y) {
    if (x < 4 || y < 4 || x > ARENA.w - 4 || y > ARENA.h - 4) return true;
    return this.obs.some(r => inRect(x, y, r));
  }

  // distance straight ahead, cm (marched, 2 cm resolution — plenty for `dist < 20`)
  range() {
    const rad = (this.th * Math.PI) / 180;
    for (let d = 2; d <= MAX_RANGE; d += 2) {
      if (this.blocked(this.x + Math.cos(rad) * d, this.y + Math.sin(rad) * d)) return d;
    }
    return MAX_RANGE;
  }

  // advance `ms` of driving. verb: fwd|back|left|right|stop
  advance(verb, pwm, ms) {
    const k = Math.max(0, Math.min(255, pwm)) / 255;
    const dt = ms / 1000;
    this.t += ms;
    if (verb === "left" || verb === "right") {
      this.th = (this.th + (verb === "left" ? -1 : 1) * TURN_DPS * k * dt + 360) % 360;
      return;
    }
    if (verb !== "fwd" && verb !== "back") return;
    const dir = verb === "fwd" ? 1 : -1;
    const rad = (this.th * Math.PI) / 180;
    const d = SPEED_CMS * k * dt * dir;
    const nx = this.x + Math.cos(rad) * d, ny = this.y + Math.sin(rad) * d;
    if (this.blocked(nx, ny)) { this.bumps++; return; } // wall stops it dead
    this.x = nx; this.y = ny;
    const last = this.trail[this.trail.length - 1];
    if (Math.hypot(nx - last[0], ny - last[1]) > 1.5) this.trail.push([nx, ny]);
    if (this.trail.length > 4000) this.trail.shift();
  }

  // telemetry packet shaped exactly like the real one, so conditions behave the same
  sensors() {
    const jitter = (v, a) => +(v + (Math.random() - 0.5) * a).toFixed(1);
    return {
      dist: this.range(),
      temp: jitter(this.env.temp, 0.4),
      humid: jitter(this.env.humid, 1),
      smoke: this.env.smoke,
      airq: this.env.airq,
      co: this.env.co,
      pressure: this.env.pressure,
      roll: 0, pitch: 0, yaw: Math.round(this.th),
      timestamp: Date.now(),
    };
  }

  draw(cv) {
    const ctx = cv.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth, H = Math.round((W * ARENA.h) / ARENA.w);
    if (cv.width !== W * dpr || cv.height !== H * dpr) {
      cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + "px";
    }
    const s = (W * dpr) / ARENA.w;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.clearRect(0, 0, ARENA.w, ARENA.h);

    ctx.fillStyle = "#0d0d0f";
    ctx.fillRect(0, 0, ARENA.w, ARENA.h);
    ctx.lineWidth = 0.4;
    ctx.strokeStyle = "rgba(236,229,214,0.07)";
    for (let x = 20; x < ARENA.w; x += 20) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ARENA.h); ctx.stroke(); }
    for (let y = 20; y < ARENA.h; y += 20) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(ARENA.w, y); ctx.stroke(); }

    ctx.fillStyle = "#2a2622";
    ctx.strokeStyle = "#4a443c";
    for (const r of this.obs) { ctx.fillRect(r.x, r.y, r.w, r.h); ctx.strokeRect(r.x, r.y, r.w, r.h); }
    ctx.strokeStyle = "#4a443c";
    ctx.lineWidth = 1;
    ctx.strokeRect(2, 2, ARENA.w - 4, ARENA.h - 4);

    if (this.trail.length > 1) {
      ctx.strokeStyle = "rgba(76,151,255,0.75)";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(this.trail[0][0], this.trail[0][1]);
      for (const [x, y] of this.trail) ctx.lineTo(x, y);
      ctx.stroke();
    }

    const rad = (this.th * Math.PI) / 180;
    const d = this.range();
    ctx.strokeStyle = d < 20 ? "#ff4d3d" : "rgba(255,171,25,0.6)";
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(this.x, this.y);
    ctx.lineTo(this.x + Math.cos(rad) * d, this.y + Math.sin(rad) * d);
    ctx.stroke();
    ctx.setLineDash([]);

    if (this.led > 0) { // headlamp cone
      const g = ctx.createRadialGradient(this.x, this.y, 2, this.x, this.y, 60);
      g.addColorStop(0, `rgba(255,240,190,${(this.led / 255) * 0.35})`);
      g.addColorStop(1, "rgba(255,240,190,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(this.x, this.y, 60, rad - 0.6, rad + 0.6);
      ctx.lineTo(this.x, this.y);
      ctx.fill();
    }

    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(rad);
    ctx.fillStyle = "#ecE5d6";
    ctx.beginPath();
    ctx.moveTo(7, 0); ctx.lineTo(-5, 5); ctx.lineTo(-5, -5); ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}
