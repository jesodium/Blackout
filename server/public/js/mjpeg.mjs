// multipart/x-mixed-replace splitter for the esp32-cam's /stream.
// kept out of app.js so it can be run against fixtures in node (test-mjpeg.mjs) —
// it's the one part of the camera path with real parsing in it.
//
// why we parse this at all: an <img src=…/stream> hands the job to the browser's own
// multipart decoder, and that decoder stalls — bytes keep arriving, the picture
// stops, and no event fires. Reading it ourselves makes a frozen feed a timestamp
// we can see, and turns each frame into a plain single-jpeg decode.

// find `needle` (bytes) in `hay` from `from`. -1 if it isn't there yet.
export function findBytes(hay, needle, from = 0) {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const CRLF2 = [13, 10, 13, 10];
const dec = new TextDecoder();

// pull every whole frame out of `buf`, returning them plus whatever is left over.
// the firmware always sends Content-Length, so a frame is taken BY LENGTH — never by
// scanning for the next boundary, which would break the moment jpeg payload bytes
// happened to spell the boundary.
export function mjpegSplit(buf) {
  const frames = [];
  for (;;) {
    const head = findBytes(buf, CRLF2);
    if (head < 0) break;
    const m = /content-length:\s*(\d+)/i.exec(dec.decode(buf.subarray(0, head)));
    if (!m) { buf = buf.subarray(head + 4); continue; } // preamble/boundary, not a part header
    const start = head + 4, len = +m[1];
    if (buf.length < start + len) break; // rest of the frame is still in flight
    frames.push(buf.subarray(start, start + len));
    buf = buf.slice(start + len);
  }
  return { frames, rest: buf };
}
