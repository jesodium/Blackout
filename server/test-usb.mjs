// The usb cable as a second command transport. The board already read commands
// off Serial (`Serial.readStringUntil('\n')` in loop()); everything here is the
// PC half, and all of it is one fact spread over three files.
import assert from "assert";
import { readFileSync } from "fs";

const srv = readFileSync(new URL("./server.js", import.meta.url), "utf8");
const app = readFileSync(new URL("./public/js/app.js", import.meta.url), "utf8");
const ino = readFileSync(new URL("../giga-r1/main/main.ino", import.meta.url), "utf8");

// 1. the board blocks in readStringUntil('\n') -- a write with no terminator is a
//    command that is never read, the same trap armrec.py's wire() documents.
assert.match(ino, /Serial\.readStringUntil\('\\n'\)/, "the sketch still reads commands off usb");
const uw = srv.match(/const usbWrite = [^\n]+/)[0];
assert.ok(uw.includes('w + "\\n"'), "usbWrite must terminate the line");

// 2. baud is one number in two places
assert.equal(+ino.match(/Serial\.begin\((\d+)\)/)[1],
  +srv.match(/SERIAL_BAUD \|\| "(\d+)"/)[1], "the sketch's and the server's baud must match");

// 3. the giga is cu.usbmodem*; usbserial is the esp32-cam's cable, which
//    camserial.js holds and which answers no drive command.
const filt = new RegExp(srv.match(/ports\.filter\(p => (\/[^/]+\/)\.test\(p\)\)/)[1].slice(1, -1));
assert.ok(filt.test("/dev/cu.usbmodem1101"), "the giga's port is pickable");
assert.ok(!filt.test("/dev/cu.wchusbserial110"), "the cam's port is not");

// 4. over usb the SERVER owns the link, so the board's E: lines come back to the
//    browser on `serial-line` -- having reached it THROUGH /api/mega/sensor. Posting
//    them again is an infinite loop, which is what the `false` turns off.
const h = app.match(/socket\.on\("serial-line", d => \{[\s\S]*?\n    \}\);/)[0];
assert.match(h, /startsWith\("E:"\).*onBoardLineRef\.current\?\.\(d\.line, false\)/,
  "a usb E: line must not be forwarded back");
assert.match(app, /const onBoardLine = useCallback\(\(line, forward = true\)/, "one handler, both transports");
assert.match(app, /if \(!forward\) return;\n\s*fetch\("\/api\/mega\/sensor"/, "forward gates the post, nothing else");

console.log("usb ok");
