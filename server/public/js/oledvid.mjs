/* oled video — the pure half: turn a canvas frame into the 1-bit XBM bitmap the
   giga's u8g2 draws (see vidChar in giga-r1/main/main.ino).

   the browser already decodes video, so there is no ffmpeg and no upload: app.js
   plays the file into a 64x128 canvas and hands each frame here. the flash-time
   twin of this file is giga-r1/oled_video_test/pack_xbm.py, which does the same
   thing with ffmpeg for the bench sketch — same bit order, same panel geometry. */

export const VID_W = 64;
export const VID_H = 128;
export const VID_BYTES = (VID_W / 8) * VID_H; // 1024

/* upload chunk size. must stay under the board's att mtu (~240 — ArduinoBLE takes it
   from the controller's ACL packet length) or the central splits every write into
   prepare-write PDUs of (mtu - 5) bytes, each its own round trip plus an execute. that
   is what made the old 512-byte chunks cost ~4 round trips instead of 1. it does NOT
   have to divide into VID_BYTES: the board appends one flat byte stream.
   keep in sync with VID_CHUNK / VID_MAX_FRAMES in giga-r1/main/main.ino. */
export const VID_CHUNK = 224;
export const VID_MAX_FRAMES = 6000; // 6MB of the giga's 8MB sdram — 200s at 30fps

// bayer 4x4 ordered dither. ordered, not error-diffusion (which is what the ffmpeg
// packer uses): error diffusion needs the whole frame in flight and crawls with noise
// between frames on a panel this small — a fixed matrix stays put, so a still shot
// looks still.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/* how far the dither pushes the threshold around, per pixel. on a 1-bit panel this
   *is* the contrast knob: a hard threshold after a contrast curve is the same maths as
   a narrower dither, so there's no separate gain to turn. 2 => ±15, which keeps
   gradients from banding into one flat block but reads as black-and-white from across
   the room instead of grey mush. was 8 (±60), which was a nice photo and unreadable.
   now 0 — a plain hard threshold, the hardest black-and-white this panel can show. at
   64x128 the dither texture was never resolvable across a room anyway, it just greyed
   the whole shot down. put it back to 1-2 if a gradient-heavy clip blobs up. */
const DITHER = 0;

/* rgba (Uint8ClampedArray from getImageData) -> packed bitmap, LSB-first per byte,
   which is what XBM (and so u8g2's drawXBM) wants. `threshold` is the one knob worth
   turning per clip: lower it for a dark source, raise it for a washed-out one. */
export function packXbm(rgba, w = VID_W, h = VID_H, threshold = 128) {
  const stride = w / 8;
  const out = new Uint8Array(stride * h);
  const n = w * h;
  const lum = new Float32Array(n);
  let lo = 255, hi = 0;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const l = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    lum[p] = l;
    if (l < lo) lo = l;
    if (l > hi) hi = l;
  }
  /* auto-level: stretch the frame's own range to 0..255 before thresholding, so a dark
     or washed-out clip still lands as real blacks and whites and the slider always
     means "the middle of this shot". gain is capped so a nearly flat frame (fade to
     black, blank titles) gets amplified into noise instead of staying flat.
     IMPORTANT NOTE: per-frame, so a hard cut can shift the level a touch — fine on a
     64x128 panel; do it over a rolling window only if that pumping is ever visible. */
  const span = hi - lo;
  const gain = span > 16 ? Math.min(8, 255 / span) : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const v = gain ? Math.min(255, (lum[p] - lo) * gain) : lum[p];
      const t = threshold + (BAYER[(y & 3) * 4 + (x & 3)] - 7.5) * DITHER;
      if (v > t) out[y * stride + (x >> 3)] |= 1 << (x & 7);
    }
  }
  return out;
}

/* center-crop source rect so the frame fills the panel without stretching. the panel
   is portrait and most clips aren't, so without this a landscape video lands as a
   3px-tall letterbox. */
export function coverRect(vw, vh, w = VID_W, h = VID_H) {
  let sw = vw, sh = vh;
  if (vw / vh > w / h) sw = vh * (w / h);
  else sh = vw / (w / h);
  return { sx: (vw - sw) / 2, sy: (vh - sh) / 2, sw, sh };
}
