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
// the dashboard's own modules
const appSrc = () => ["app", "control", "speech"].map((n) => read(`public/js/${n}.js`)).join("\n");

module.exports = { serverSrc, appSrc };
