// Tests that check the code's own text (a guard still in place, two copies of a
// constant still agreeing) read whole subsystems through here, so moving a
// function between files never breaks a test that only cares that it exists.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".js") ? [path.join(dir, e.name)] : []);

// server.js plus every module under src/
const serverSrc = () => [read("server.js"), ...walk("src").sort().map(read)].join("\n");
// the dashboard: app.js, its ui/ components, and the control + speech modules
const appSrc = () => ["public/js/app.js", ...walk("public/js/ui").sort(), "public/js/control.js", "public/js/speech.js"]
  .map(read).join("\n");

// the giga sketch as the compiler sees it: main.ino with its own "x.h" includes
// expanded in place (arm.h, blkvm.h, panel.h, ...), so a test reads one file
const FW = path.join(ROOT, "..", "firmware", "giga", "main");
const firmwareSrc = () => fs.readFileSync(path.join(FW, "main.ino"), "utf8")
  .replace(/^#include "(\w+\.h)"$/gm, (_, f) => fs.readFileSync(path.join(FW, f), "utf8"));

module.exports = { serverSrc, appSrc, firmwareSrc };
