// electron pairing test — self-contained: spawns the desktop shell itself with a
// fake ble scan (BLACKOUT_FAKE_BLE=1) and drives the page over cdp on :9334.
// needs a one-time `npm install` in ../electron. run: npm run test:pairing
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ELECTRON_DIR = path.join(HERE, "..", "electron");
const ELECTRON_BIN = path.join(ELECTRON_DIR, "node_modules", ".bin", "electron");
const CDP = "http://localhost:9334";
const PORT = 3111;

let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "  " + extra}`);
  if (!ok) fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// spawn the app; stdout is where the fake scan reports selections
let stdout = "";
const proc = spawn(ELECTRON_BIN, [ELECTRON_DIR, `--remote-debugging-port=9334`], {
  env: { ...process.env, BLACKOUT_FAKE_BLE: "1", PORT: String(PORT) },
});
proc.stdout.on("data", (d) => (stdout += d));
proc.stderr.on("data", () => {});
const waitStdout = async (needle, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (stdout.includes(needle)) return true;
    await sleep(100);
  }
  return false;
};

let ws;
try {
  // wait for the window to load the dashboard
  let tgt = null;
  for (let i = 0; i < 60 && !tgt; i++) {
    await sleep(500);
    tgt = await fetch(CDP + "/json/list")
      .then((r) => r.json())
      .then((l) => l.find((t) => t.url.startsWith(`http://localhost:${PORT}`)))
      .catch(() => null);
  }
  check("electron window loaded dashboard", !!tgt);
  if (!tgt) throw new Error("no page target");

  ws = new WebSocket(tgt.webSocketDebuggerUrl);
  await new Promise((r) => ws.on("open", r));
  let id = 0;
  const pending = new Map();
  ws.on("message", (m) => {
    const d = JSON.parse(m);
    if (pending.has(d.id)) pending.get(d.id)(d);
  });
  const send = (method, params) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true });
    return r.result?.result?.value;
  };

  // tour's inert lock swallows clicks — flag it done, then reload to restart the fake scan
  await evaluate(`localStorage.setItem("tourDone","1"); location.reload(); return 1;`);
  await sleep(1000);

  // 1. device stream reaches the renderer (3 fakes, staged)
  const devs = await evaluate(`
    return await new Promise((res) => {
      const seen = [];
      const un = window.blackout.onBleDevices((l) => { seen.length = 0; seen.push(...l); if (l.length >= 3) { un(); res(seen); } });
      setTimeout(() => { un(); res(seen); }, 6000);
    });`);
  check("3 fake devices reach renderer", devs?.length === 3, JSON.stringify(devs));
  check("device ids stable", devs?.map((d) => d.deviceId).join() === "fake-1,fake-2,fake-3", JSON.stringify(devs));

  // 2. picker opened by itself and never shows identical rows
  const ui = await evaluate(`
    return { open: !!document.querySelector(".ble-picker"),
             rows: [...document.querySelectorAll(".ble-pick .device-name")].map(e => e.textContent.trim()) };`);
  check("picker auto-opened", ui?.open);
  check("3 rows rendered", ui?.rows?.length === 3, JSON.stringify(ui));
  check("duplicate 'arduino' rows render distinct labels", new Set(ui?.rows).size === 3, JSON.stringify(ui?.rows));

  // 3. tapping a row invokes the stored callback with that device id
  await evaluate(`document.querySelectorAll(".ble-pick")[1].click(); return 1;`);
  check("selection reached main-process callback", await waitStdout('FAKE_BLE selected: "fake-2"'));
  await sleep(400);
  check("picker closed after selection", await evaluate(`return !document.querySelector(".ble-picker")`));

  // 4. cancel path: rescan, cancel button → callback("")
  await evaluate(`location.reload(); return 1;`);
  await sleep(3500); // all three fake batches land, picker reopens
  check("picker reopened on rescan", await evaluate(`return !!document.querySelector(".ble-picker")`));
  await evaluate(`document.querySelector(".ble-actions .serial-btn")?.click(); return 1;`);
  check("cancel invokes callback with empty id", await waitStdout('FAKE_BLE selected: ""'));

  // 5. electron window is the mirror-mode host
  const host = await evaluate(`return { conn: !!document.querySelector(".top-conn"), mirror: !!document.querySelector(".top-mirror") }`);
  check("electron page is host (has link controls)", host?.conn && !host?.mirror, JSON.stringify(host));
} catch (e) {
  check("test run completed", false, e.message);
} finally {
  ws?.close();
  // 6. quitting the app must take the forked server down with it
  proc.kill("SIGTERM");
  await sleep(2000);
  const alive = await fetch(`http://localhost:${PORT}/`).then(() => true).catch(() => false);
  check("forked server died with the app", !alive);
}

console.log(fail ? `\n${fail} failed` : "\nall passed");
process.exit(fail ? 1 : 0);
