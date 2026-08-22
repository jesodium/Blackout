/* padnav — the dashboard as a console app: the d-pad roams focus over whatever is
   on screen, ✕ presses it, ○ backs out, VIEW/SHARE flips to a free cursor, OPTIONS
   opens the menu. Driving is
   the sticks' job (see Drive in app.js), so the d-pad is free for the ui and there
   is no mode to toggle between the two.

   No focus list is maintained: candidates are re-read from the dom every move, so
   a modal that just mounted or a button that just enabled is navigable with no
   registration step. When a modal is up, roaming is trapped inside it. */

/* pure half — which element a direction lands on, given everything's box.
   `rects` are viewport rects, `from` the index focus is on (-1 = nowhere yet),
   and the answer is an index, or -1 when there's nothing that way. */
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
    const ahead = (horiz ? dx : dy) * sign; // distance along the travel axis
    const off = Math.abs(horiz ? dy : dx);  // ...and how far off the line it sits
    if (ahead <= 2) return;                 // level or behind — not in this direction
    // IMPORTANT NOTE: straight-ahead beats near-but-sideways at 2:1. tune that ratio
    // if a dense row starts feeling like it grabs focus from the row below.
    const score = ahead + off * 2;
    if (score < bestScore) { bestScore = score; best = i; }
  });
  return best;
}

const FOCUSABLE = "a[href], button, input, select, textarea, [tabindex]";

/* ---- cursor mode ----
   VIEW (the two-rectangles button on an xbox pad, SHARE on a ds4) flips the pad from
   roaming boxes to flying a pointer: the left stick (or the d-pad) moves it, ✕ clicks
   whatever is under it, VIEW again puts it away. It reaches what focus can't — a chart,
   the 3d view, anything that isn't a focusable element. While it's up the sticks are
   aiming, not driving: `cursorOn()` parks Drive's loop in app.js so a stick flick can't
   move the robot by accident. ○/B stays back-out. */
const VIEW = 8;           // view/share — standard mapping's "select" slot
const CURSOR_SPEED = 950; // px/s at full stick throw
let cursorEl = null, cx = 0, cy = 0; // 0,0 until the first show centres it

export const cursorOn = () => !!cursorEl;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// pure: where the cursor lands, and how much of the move the page has to absorb by
// scrolling — pushing past the top/bottom edge pans instead of stalling there.
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
  requestAnimationFrame(flyCursor); // its own frame loop — the button poll is far too coarse to aim with
}

function drawCursor() {
  cursorEl.style.transform = `translate(${cx}px, ${cy}px)`;
  hover(document.elementFromPoint(cx, cy)?.closest(HOVERABLE) || null);
}

/* what the cursor is over gets the same ring roaming gives focus, so "this is what ✕
   will press" reads the same in both modes. Zones and cards are in the list too: they
   aren't pressable, but lighting the box up is how you know the cursor is on it. */
const HOVERABLE = FOCUSABLE + ", .zone, .card, .stat, .blk-node";
let hovered = null;
function hover(el) {
  if (el === hovered) return;
  hovered?.classList.remove("padhover");
  hovered = el;
  hovered?.classList.add("padhover");
}

/* Frame-paced so the cursor glides instead of stepping: dt comes from the clock, not
   the tick, and stick throw is squared — full deflection still flies, but the first
   half of the travel is fine aim. */
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

// the modal on top owns the pad, so roaming can't wander onto the cockpit behind it.
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
  if (i < 0) return; // nothing that way: keep what's focused rather than jumping across the page
  els[i].focus({ preventScroll: true });
  els[i].scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
}

/* back = whatever the operator would have clicked to get out: the top modal's ✕,
   else the console drawer's. Driven off the dom so a new modal needs no wiring
   here — it just needs a close button. Nothing open, nothing happens. */
function back() {
  const x = topModal()?.querySelector(".blk-modal-x, .warn-actions button")
    || document.querySelector(".drawer:not(.is-closing) .drawer-x");
  x?.click();
}

const REPEAT_DELAY = 340, REPEAT_EVERY = 120; // hold-to-scroll, same feel as a key repeat

/* `blocked` is fpv + the first-run tour: they own the pad while they're up.
   `onMenu` is the app's — OPTIONS opens the console, which is state, not a dom click. */
export function initPadNav({ blocked, onMenu } = {}) {
  const DIRS = { 12: "up", 13: "down", 14: "left", 15: "right" };
  const TICK = 50;
  let was = {}, since = 0, held = null;
  // pointer means the mouse is back in charge — drop the focus ring until the pad speaks again.
  addEventListener("pointermove", () => document.body.classList.remove("padnav"), { passive: true });

  return setInterval(() => {
    const pad = [...navigator.getGamepads()].find(Boolean);
    if (!pad || blocked?.()) { was = {}; held = null; setCursor(false); return; }
    const down = (i) => !!pad.buttons[i]?.pressed;
    const edge = (i) => down(i) && !was[i];

    if (Object.keys(DIRS).some((i) => down(i)) || [0, 1, 8, 9].some((i) => down(i)))
      document.body.classList.add("padnav");

    if (edge(VIEW)) setCursor(!cursorOn());          // VIEW / SHARE — cursor mode on/off
    if (!cursorOn()) {                               // roaming is off while the cursor flies (its own rAF loop)
      const dir = Object.entries(DIRS).find(([i]) => down(i));
      if (!dir) { held = null; }
      else if (dir[1] !== held) { held = dir[1]; since = performance.now(); move(held); }
      else if (performance.now() - since > REPEAT_DELAY) { since = performance.now() - REPEAT_DELAY + REPEAT_EVERY; move(held); }
    }

    // ✕ / A — press: what's under the cursor, or what's focused
    if (edge(0)) (cursorOn() ? document.elementFromPoint(cx, cy) : document.activeElement)?.click?.();
    if (edge(1)) back();                             // ○ / B — back out one layer
    if (edge(9)) onMenu?.();                         // MENU / OPTIONS — the app menu
    for (const i of [0, 1, 8, 9, 12, 13, 14, 15]) was[i] = down(i);
  }, TICK);
}
