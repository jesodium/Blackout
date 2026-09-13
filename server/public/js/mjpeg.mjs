// splits an mjpeg stream into frames by content-length. never by scanning for the
// next boundary: jpeg payload can spell it.

export function findBytes(hay, needle, from = 0) {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const CRLF2 = [13, 10, 13, 10];
const dec = new TextDecoder();

export function mjpegSplit(buf) {
  const frames = [];
  for (;;) {
    const head = findBytes(buf, CRLF2);
    if (head < 0) break;
    const m = /content-length:\s*(\d+)/i.exec(dec.decode(buf.subarray(0, head)));
    if (!m) { buf = buf.subarray(head + 4); continue; }
    const start = head + 4, len = +m[1];
    if (buf.length < start + len) break;
    frames.push(buf.subarray(start, start + len));
    buf = buf.slice(start + len);
  }
  return { frames, rest: buf };
}
