// gamepad: the sticks drive, the d-pad roams the ui

export function pickNext(rects, from, dir) {
  if (!rects.length) return -1;
  if (from < 0 || from >= rects.length) return 0;
  const a = rects[from];
  const ax = a.x + a.width / 2, ay = a.y + a.height / 2;
  const horiz = dir === "left" || dir === "right";
  const sign = dir === "right" || dir === "down" ? 1 : -1;
  let best = -1, bestScore = Infinity;
  rects.forEach((b, i) => {
    if (i === from) return;
    const dx = b.x + b.width / 2 - ax, dy = b.y + b.height / 2 - ay;
    const ahead = (horiz ? dx : dy) * sign;
    const off = Math.abs(horiz ? dy : dx);
    if (ahead <= 2) return;

    const score = ahead + off * 2;
    if (score < bestScore) { bestScore = score; best = i; }
  });
  return best;
}

const FOCUSABLE = "a[href], button, input, select, textarea, [tabindex]";

// ---- cursor mode ----
// VIEW flips to a free pointer for what focus can't reach — charts, the 3d view
const VIEW = 8;
const CURSOR_SPEED = 950;
let cursorEl = null, cx = 0, cy = 0;

export const cursorOn = () => !!cursorEl;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function stepCursor(x, y, dx, dy, w, h) {
  const ny = y + dy;
  return { x: clamp(x + dx, 0, w), y: clamp(ny, 0, h), scroll: ny < 0 ? ny : ny > h ? ny - h : 0 };
}

function setCursor(on) {
  if (!on) { cursorEl?.remove(); cursorEl = null; hover(null); return; }
  if (cursorEl) return;
  cursorEl = document.createElement("div");
  cursorEl.className = "padcursor";
  cursorEl.setAttribute("aria-hidden", "true");
  document.body.append(cursorEl);
  if (!cx && !cy) { cx = innerWidth / 2; cy = innerHeight / 2; }
  cx = clamp(cx, 0, innerWidth); cy = clamp(cy, 0, innerHeight);
  drawCursor();
  requestAnimationFrame(flyCursor);
}

function drawCursor() {
  cursorEl.style.transform = `translate(${cx}px, ${cy}px)`;
  hover(document.elementFromPoint(cx, cy)?.closest(HOVERABLE) || null);
}

const HOVERABLE = FOCUSABLE + ", .zone, .card, .stat, .blk-node";
let hovered = null;
function hover(el) {
  if (el === hovered) return;
  hovered?.classList.remove("padhover");
  hovered = el;
  hovered?.classList.add("padhover");
}

let lastFrame = 0;
function flyCursor(ts) {
  if (!cursorEl) return;
  const dt = Math.min(0.05, lastFrame ? (ts - lastFrame) / 1000 : 0);
  lastFrame = ts;
  const pad = [...navigator.getGamepads()].find(Boolean);
  const dn = (i) => (pad?.buttons[i]?.pressed ? 1 : 0);
  const ax = (v) => (Math.abs(v) < 0.15 ? 0 : Math.sign(v) * ((Math.abs(v) - 0.15) / 0.85) ** 2);
  const step = CURSOR_SPEED * dt;
  const dx = (ax(pad?.axes[0] ?? 0) + dn(15) - dn(14)) * step;
  const dy = (ax(pad?.axes[1] ?? 0) + dn(13) - dn(12)) * step;
  if (dx || dy) {
    const next = stepCursor(cx, cy, dx, dy, innerWidth, innerHeight);
    cx = next.x; cy = next.y;
    if (next.scroll) scrollBy({ top: next.scroll });
    drawCursor();
  }
  requestAnimationFrame(flyCursor);
}

// ---- focus roaming ----
// the dom is re-read on every move, so nothing has to register itself
const topModal = () => [...document.querySelectorAll(".blk-modal:not(.is-closing)")].pop() || null;

function candidates() {
  const root = topModal() || document;
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => {
    if (el.disabled || el.tabIndex < 0 || el.closest("[inert]")) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
  });
}

function move(dir) {
  const els = candidates();
  const i = pickNext(els.map((el) => el.getBoundingClientRect()), els.indexOf(document.activeElement), dir);
  if (i < 0) return;
  els[i].focus({ preventScroll: true });
  els[i].scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
}

function back() {
  const x = topModal()?.querySelector(".blk-modal-x, .warn-actions button")
    || document.querySelector(".drawer:not(.is-closing) .drawer-x");
  x?.click();
}

// ---- polling ----
const REPEAT_DELAY = 340, REPEAT_EVERY = 120;

export function initPadNav({ blocked, onMenu } = {}) {
  const DIRS = { 12: "up", 13: "down", 14: "left", 15: "right" };
  const TICK = 50;
  let was = {}, since = 0, held = null;

  addEventListener("pointermove", () => document.body.classList.remove("padnav"), { passive: true });

  return setInterval(() => {
    const pad = [...navigator.getGamepads()].find(Boolean);
    if (!pad || blocked?.()) { was = {}; held = null; setCursor(false); return; }
    const down = (i) => !!pad.buttons[i]?.pressed;
    const edge = (i) => down(i) && !was[i];

    if (Object.keys(DIRS).some((i) => down(i)) || [0, 1, 8, 9].some((i) => down(i)))
      document.body.classList.add("padnav");

    if (edge(VIEW)) setCursor(!cursorOn());
    if (!cursorOn()) {
      const dir = Object.entries(DIRS).find(([i]) => down(i));
      if (!dir) { held = null; }
      else if (dir[1] !== held) { held = dir[1]; since = performance.now(); move(held); }
      else if (performance.now() - since > REPEAT_DELAY) { since = performance.now() - REPEAT_DELAY + REPEAT_EVERY; move(held); }
    }

    if (edge(0)) (cursorOn() ? document.elementFromPoint(cx, cy) : document.activeElement)?.click?.();
    if (edge(1)) back();
    if (edge(9)) onMenu?.();
    for (const i of [0, 1, 8, 9, 12, 13, 14, 15]) was[i] = down(i);
  }, TICK);
}
