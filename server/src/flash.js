// The dashboard's firmware updater: which boards are plugged in, whether what
// they run is HEAD, and scripts/flash.sh streamed into the modal.
const fs = require("fs");
const path = require("path");
const { execFile, execFileSync, spawn } = require("child_process");
const { app, io } = require("./http");
const { disconnectSerial } = require("./link");
const { closeUsbCam } = require("./cam");

const ROOT_DIR = path.join(__dirname, "..", "..");
let flashing = false;

const V2_REF = "829924d";

const BOARD_PROFILES = [
  { key: "giga",     fqbnPrefix: "arduino:mbed_giga:",   ports: ["usbmodem"], dir: "firmware/giga/main" },
  { key: "unor4",    fqbnPrefix: "arduino:renesas_uno:", ports: [],           dir: "arduino-uno-r4/main", ref: V2_REF },
  { key: "esp32cam", fqbnPrefix: "esp32:esp32:esp32cam", ports: ["usbserial", "wchusbserial"], dir: "firmware/esp32-cam/main" },
];

const lastFlash = () => {
  try {
    return Object.fromEntries(fs.readFileSync(path.join(ROOT_DIR, ".last-flash"), "utf8")
      .split("\n").filter(Boolean).map(l => l.split("|")));
  } catch { return {}; }
};
const headRef = () => {
  try { return execFileSync("git", ["-C", ROOT_DIR, "rev-parse", "--short", "HEAD"]).toString().trim(); }
  catch { return null; }
};

app.get("/api/flash/boards", (req, res) => {
  execFile("arduino-cli", ["board", "list", "--format", "json"], { timeout: 5000 }, (err, stdout) => {
    // counts, not flags: two esp32-cams are two boards, and "is one plugged in"
    // can't tell you the second one was never flashed.
    const found = { giga: 0, esp32cam: 0, unor4: 0 };
    let ports = [];
    if (!err) {
      try {
        ports = (JSON.parse(stdout).detected_ports || []).map(p => ({
          addr: p.port?.address || "",
          fqbns: (p.matching_boards || []).map(b => b.fqbn),
        }));
      } catch {  }
    }

    for (const { addr, fqbns } of ports) {
      const hit = BOARD_PROFILES.find(p => fqbns.length
        ? fqbns.some(f => f.startsWith(p.fqbnPrefix))
        : p.ports.some(pat => addr.includes(pat)));
      if (hit) found[hit.key]++;
    }

    const flashed = lastFlash();
    const head = headRef();
    const live = BOARD_PROFILES.filter(p => found[p.key]);
    // flash.sh keys the cams by chip id (dir@chip) so one flashed cam can't mark
    // the other current — fewer entries than live boards means one is unaccounted for
    const refs = (p) => Object.entries(flashed)
      .filter(([k]) => k === p.dir || k.startsWith(p.dir + "@")).map(([, v]) => v);
    const status = live.length === 0 ? "none"
      : live.some(p => refs(p).length < found[p.key]) ? "unknown"
      : live.some(p => refs(p).some(r => r !== (p.ref || head))) ? "stale"
      : "current";
    res.json({ ...found, status, head });
  });
});

app.post("/api/flash/start", (req, res) => {
  if (flashing) return res.status(409).json({ error: "flash already running" });
  disconnectSerial();
  closeUsbCam();   // the cam's own cable is the one flash.sh writes down
  flashing = true;
  const proc = spawn(path.join(ROOT_DIR, "scripts/flash.sh"), { cwd: ROOT_DIR });
  const strip = (buf) => buf.toString().replace(/\x1b\[[0-9;]*m/g, "");
  proc.stdout.on("data", (d) => io.emit("flash-log", { chunk: strip(d) }));
  proc.stderr.on("data", (d) => io.emit("flash-log", { chunk: strip(d) }));
  proc.on("close", (code) => { flashing = false; io.emit("flash-done", { code }); });
  proc.on("error", (err) => { flashing = false; io.emit("flash-done", { code: -1, error: err.message }); });
  res.json({ ok: true });
});
