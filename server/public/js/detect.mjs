// object detection over the cam feed — coco-ssd (ssdlite mobilenet v2) on tfjs.
//
// why not opencv+yolo: the same 80 coco classes come out of `model.detect(img)` in
// one call, with the NMS and the class table already done. A yolo .onnx needs
// letterboxing, sigmoid decode and NMS written by hand, and opencv.js is a 10MB wasm
// on top of it — same boxes, ten times the code.
//
// everything is vendored (`/vendor/tf.min.js`, `/models/coco-ssd/`) because the venue
// has no internet: the default cocoSsd.load() fetches its weights from storage.googleapis.
// The 18MB of weights is why the model loads on the first toggle, not at boot.
//
// IMPORTANT NOTE: canvas is fine HERE even though the cam is another origin — what
// we read is the <img>'s blob: url, which is same-origin, so the frame isn't tainted.
// Pointing this at an <img src="http://cam/stream"> would taint it and throw.

const SCRIPTS = ["/vendor/tf.min.js", "/vendor/coco-ssd.min.js"];
export const MODEL_URL = "/models/coco-ssd/model.json";

const script = (src) => new Promise((ok, no) => {
  const el = document.createElement("script");
  el.src = src; el.onload = ok; el.onerror = () => no(new Error("load " + src));
  document.head.appendChild(el);
});

let pending; // one load per page, however many CamViews ask
export function loadDetector() {
  pending ||= (async () => {
    for (const s of SCRIPTS) await script(s);
    return window.cocoSsd.load({ base: "lite_mobilenet_v2", modelUrl: MODEL_URL });
  })().catch((e) => { pending = null; throw e; }); // a failed load must be retryable
  return pending;
}

// The cam is mounted on its side, so the raw jpeg is a sideways picture of the world —
// the operator only ever sees it upright because .cam-feed rotates it in css. coco-ssd
// gets the raw frame, and it is not rotation invariant: a standing person lying across
// the frame is a shape it was never trained on. So un-rotate into a scratch canvas
// FIRST, detect on that, and map the boxes back to raw-frame coords for drawing.
// IMPORTANT NOTE: this -90 must match the rotate() on .cam-feed in style.css. Remount
// the cam upright and both go, together — they are the same fact written twice.
// made on first use, not at import: the pure half of this file (rotBox) has to be
// importable in node, where there is no document — see test-detect.mjs.
let scratch;

// rotated-frame box -> raw-frame box. w is the RAW frame width. The canvas rotation
// below sends raw (x,y) to (y, w-x), so a corner pair inverts to this.
export const rotBox = ([x, y, bw, bh], w) => [w - y - bh, x, bh, bw];

export async function detectUpright(model, img, maxBoxes, minScore) {
  const w = img.naturalWidth, h = img.naturalHeight;
  scratch ||= document.createElement("canvas");
  if (scratch.width !== h) { scratch.width = h; scratch.height = w; }
  const ctx = scratch.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.translate(0, w);
  ctx.rotate(-Math.PI / 2);
  ctx.drawImage(img, 0, 0);
  const boxes = await model.detect(scratch, maxBoxes, minScore);
  return boxes.map((b) => ({ ...b, bbox: rotBox(b.bbox, w) }));
}

// boxes come back in image pixel coords, so the overlay canvas is sized to the frame's
// natural size and CSS scales/rotates it exactly like the <img> — no mapping maths, and
// it stays right through fpv's zoom levels and the -90deg mount rotation.
//
// That same css rotation is why the label is drawn through a transform instead of
// straight: css turns the whole canvas -90deg, so a label drawn plainly above a box
// comes out beside it, reading bottom-to-top. Counter-rotating +90 cancels it, and in
// that local frame +x is screen-right and +y is screen-down again — so screen-up is
// canvas +x, which is where the plate goes.
const LBL_PAD = 3;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function drawBoxes(ctx, boxes, w, h) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  // deliberately thin and small: the box is the readout, the label only says which box.
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
    // screen-top of the box is canvas x+bw; the plate sits just past it, unless that
    // would run off the frame — then it tucks inside the box, the usual fallback.
    // coco hands back boxes that overhang the edge, so the plate is clamped into the
    // frame on both axes or the label comes out with its first letters cut off.
    const top = x + bw;
    const at = top + plateH > w ? top - plateH : top;
    ctx.save();
    ctx.translate(clamp(at, 0, w - plateH), clamp(y, 0, h - plateW));
    ctx.rotate(Math.PI / 2);
    ctx.fillStyle = "#00e5a0";
    ctx.fillRect(0, 0, plateW, plateH);
    ctx.fillStyle = "#00120c";
    ctx.fillText(label, LBL_PAD, LBL_PAD);
    ctx.restore();
  }
}
