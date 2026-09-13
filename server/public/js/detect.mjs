// coco-ssd over the camera feed. everything is vendored — the venue has no internet.

const SCRIPTS = ["/vendor/tf.min.js", "/vendor/coco-ssd.min.js"];
export const MODEL_URL = "/models/coco-ssd/model.json";

const script = (src) => new Promise((ok, no) => {
  const el = document.createElement("script");
  el.src = src; el.onload = ok; el.onerror = () => no(new Error("load " + src));
  document.head.appendChild(el);
});

let pending;
export function loadDetector() {
  pending ||= (async () => {
    for (const s of SCRIPTS) await script(s);
    return window.cocoSsd.load({ base: "lite_mobilenet_v2", modelUrl: MODEL_URL });
  })().catch((e) => { pending = null; throw e; });
  return pending;
}

let scratch;

// The mount angle is one fact written in three places -- the css on .cam-feed, the
// frame handed to the model (coco-ssd is not rotation invariant), and the label
// counter-rotation below -- so it is a parameter everywhere, never a literal.
// Clockwise css degrees; 270 is the sideways mount this rover shipped with.
export const ROTS = [0, 90, 180, 270];
export const CAM_ROT_DEFAULT = 270;
export const norm = (rot) => ((Math.round(rot / 90) * 90 % 360) + 360) % 360;

// raw frame -> upright canvas, the transform detectUpright() draws through
const ORIGIN = { 0: (W, H) => [0, 0], 90: (W, H) => [H, 0], 180: (W, H) => [W, H], 270: (W, H) => [0, W] };

// upright box -> raw-frame box, so the overlay's inherited css transform lands the
// box back on the object. The exact inverse of ORIGIN + rotate(rot).
export function rotBox([x, y, bw, bh], W, H, rot = CAM_ROT_DEFAULT) {
  switch (norm(rot)) {
    case 90:  return [y, H - x - bw, bh, bw];
    case 180: return [W - x - bw, H - y - bh, bw, bh];
    case 270: return [W - y - bh, x, bh, bw];
    default:  return [x, y, bw, bh];
  }
}

export async function detectUpright(model, img, maxBoxes, minScore, rot = CAM_ROT_DEFAULT) {
  const W = img.naturalWidth, H = img.naturalHeight;
  const r = norm(rot), quarter = r % 180 !== 0;
  const cw = quarter ? H : W, ch = quarter ? W : H;
  scratch ||= document.createElement("canvas");
  if (scratch.width !== cw || scratch.height !== ch) { scratch.width = cw; scratch.height = ch; }
  const ctx = scratch.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.translate(...ORIGIN[r](W, H));
  ctx.rotate(r * Math.PI / 180);
  ctx.drawImage(img, 0, 0);
  const boxes = await model.detect(scratch, maxBoxes, minScore);
  return boxes.map((b) => ({ ...b, bbox: rotBox(b.bbox, W, H, r) }));
}

const LBL_PAD = 3;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function drawBoxes(ctx, boxes, w, h, rot = CAM_ROT_DEFAULT) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const r = norm(rot), quarter = r % 180 !== 0;
  const lw = Math.max(1.5, w / 400), fs = Math.max(9, w / 50);
  ctx.font = `600 ${fs}px ui-monospace, monospace`;
  ctx.textBaseline = "top";
  const plateH = fs + LBL_PAD * 2;

  for (const b of boxes) {
    const [x, y, bw, bh] = b.bbox;
    ctx.lineWidth = lw;
    ctx.strokeStyle = "#00e5a0";
    ctx.strokeRect(x, y, bw, bh);

    const label = `${b.class} ${Math.round(b.score * 100)}%`;
    const plateW = ctx.measureText(label).width + LBL_PAD * 2;

    // Inheriting the feed's css transform is what keeps the boxes aligned for free,
    // and it is also what turns the text: drawn plainly the label comes out beside
    // the box reading bottom-to-top. Cancel the rotation and screen-up is local -y.
    // The anchor is the box CENTRE because a centre is the one point that doesn't
    // move under rotation -- no per-angle corner table, and a box coco hung off the
    // edge can't fling its plate off-screen the way a corner anchor could.
    ctx.save();
    ctx.translate(clamp(x + bw / 2, 0, w), clamp(y + bh / 2, 0, h));
    ctx.rotate(-r * Math.PI / 180);
    const sh = quarter ? bw : bh;          // the box's height once it is upright
    ctx.fillStyle = "#00e5a0";
    ctx.fillRect(-plateW / 2, -sh / 2, plateW, plateH);
    ctx.fillStyle = "#00120c";
    ctx.fillText(label, -plateW / 2 + LBL_PAD, -sh / 2 + LBL_PAD);
    ctx.restore();
  }
}
