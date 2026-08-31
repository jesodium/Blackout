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

const LBL_PAD = 3;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function drawBoxes(ctx, boxes, w, h) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);

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
