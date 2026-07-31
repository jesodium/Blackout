// Blackout desktop shell. Forks the existing server (one frontend copy — the
// window just loads http://localhost:<port>), replaces Chrome's BLE chooser
// with an in-app picker, adds native dialogs / menu / window state.
const { app, BrowserWindow, utilityProcess, dialog, ipcMain, Menu, screen } = require("electron");
const path = require("path");
const http = require("http");
const fs = require("fs");

// venue-tunable knobs — real BLE stacks and venue networks need adjusting here,
// not by hunting through the file. Renderer-side BLE consts live near
// server/public/js/app.js:2071 (service/char UUIDs).
const TUNING = {
  SERVER_READY_TIMEOUT_MS: 15000,
  SERVER_POLL_MS: 250,
  BLE_FAKE_BATCH_MS: 700, // gap between fake device discoveries (BLACKOUT_FAKE_BLE=1)
};

const PORT = Number(process.env.PORT || 3000);
const APP_URL = `http://localhost:${PORT}`;
const SERVER_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "server")
  : path.join(__dirname, "..", "server");

let win = null;
let serverProc = null;
let quitting = false;

/* ---------- operator settings (API keys) ----------------------------------
   The packaged app ships no .env. Keys live in <userData>/blackout.env, an
   env-format file written by the in-app Settings modal (Blackout menu /
   Cmd+,); it's merged into the forked server's environment. Relaunch applies
   changes. */
const SETTINGS_FILE = () => path.join(app.getPath("userData"), "blackout.env");
const SETTINGS_KEYS = ["CEREBRAS_API_KEY", "DEEPGRAM_API_KEY", "CEREBRAS_MODEL", "TTS_VOICE"];

function loadUserEnv() {
  try {
    const env = {};
    for (const line of fs.readFileSync(SETTINGS_FILE(), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && m[2]) env[m[1]] = m[2];
    }
    return env;
  } catch {
    return {};
  }
}

function readSettings() {
  const env = loadUserEnv();
  return Object.fromEntries(SETTINGS_KEYS.map((k) => [k, env[k] || ""]));
}

function writeSettings(values) {
  const lines = ["# Blackout settings — same keys as server/.env. Written by the Settings modal."];
  for (const k of SETTINGS_KEYS) {
    const v = String(values[k] || "").trim();
    lines.push(v ? `${k}=${v}` : `# ${k}=`);
  }
  fs.writeFileSync(SETTINGS_FILE(), lines.join("\n") + "\n");
}

/* ---------- server lifecycle ---------------------------------------------- */

function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 1000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

async function startServer() {
  if (await probe(PORT)) return; // dev `npm start` already on the port — attach, don't fork
  serverProc = utilityProcess.fork(path.join(SERVER_DIR, "server.js"), [], {
    cwd: SERVER_DIR, // dotenv + express.static("public") are cwd-relative in server.js
    stdio: "pipe",
    env: {
      ...process.env,
      ...loadUserEnv(),
      PORT: String(PORT),
      // IMPORTANT NOTE: GUI-launched apps get a minimal PATH; the server spawns
      // git/arduino-cli/flash.sh and needs the usual homebrew dirs.
      PATH: `${process.env.PATH || ""}:/opt/homebrew/bin:/usr/local/bin`,
    },
  });
  serverProc.on("spawn", () => console.log(`[shell] server child spawned (pid ${serverProc.pid})`));
  serverProc.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
  serverProc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  serverProc.on("exit", (code) => {
    serverProc = null;
    if (quitting) return;
    dialog
      .showMessageBox({
        type: "error",
        message: "Blackout server stopped",
        detail: `The dashboard server exited unexpectedly (code ${code}).`,
        buttons: ["Relaunch", "Quit"],
        defaultId: 0,
      })
      .then(({ response }) => {
        if (response === 0) app.relaunch();
        app.exit(1);
      });
  });
  const deadline = Date.now() + TUNING.SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probe(PORT)) return;
    if (!serverProc) return; // exit handler already took over
    await new Promise((r) => setTimeout(r, TUNING.SERVER_POLL_MS));
  }
  dialog.showErrorBox("Blackout", `Server didn't come up on port ${PORT} within ${TUNING.SERVER_READY_TIMEOUT_MS / 1000}s.`);
  app.exit(1);
}

/* ---------- window state --------------------------------------------------- */

const STATE_FILE = () => path.join(app.getPath("userData"), "window-state.json");

function loadWinState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE(), "utf8"));
    if (s.width >= 400 && s.height >= 300) {
      // don't strand the window on an unplugged monitor
      const d = screen.getDisplayMatching(s).workArea;
      if (s.x < d.x + d.width && s.x + s.width > d.x && s.y < d.y + d.height && s.y + s.height > d.y) return s;
    }
  } catch { /* first run / corrupt file */ }
  return { width: 1440, height: 900 };
}

function saveWinState() {
  try {
    if (win && !win.isMinimized() && !win.isFullScreen()) fs.writeFileSync(STATE_FILE(), JSON.stringify(win.getBounds()));
  } catch { /* not worth surfacing */ }
}

/* ---------- custom BLE chooser -------------------------------------------- */
// select-bluetooth-device fires repeatedly as Chromium discovers devices; we
// accumulate them, stream the list to the renderer, and only invoke the stored
// callback when the operator picks a row ("" cancels the scan).

let bleCallback = null;
const bleDevices = new Map(); // deviceId -> deviceName

function storeBleCallback(cb) {
  if (cb !== bleCallback) bleDevices.clear(); // new requestDevice() call = new scan
  bleCallback = cb;
}

function publishBleDevices() {
  if (!win) return;
  win.webContents.send("ble:devices", [...bleDevices].map(([deviceId, deviceName]) => ({ deviceId, deviceName })));
}

function wireBle(contents) {
  contents.on("select-bluetooth-device", (event, list, callback) => {
    event.preventDefault();
    storeBleCallback(callback);
    for (const d of list) bleDevices.set(d.deviceId, d.deviceName);
    publishBleDevices();
  });
}

ipcMain.on("ble:select", (_e, deviceId) => {
  const cb = bleCallback;
  bleCallback = null;
  bleDevices.clear();
  cb?.(String(deviceId)); // "" rejects requestDevice with NotFoundError — app.js already catches it
  if (win) win.webContents.send("ble:closed");
});

// Fake scan for tests / UI work with no board: feeds staged devices through the
// exact production path (storeBleCallback + publish), minus the Chromium event.
function startFakeBle() {
  const FAKES = [
    { deviceId: "fake-1", deviceName: "arduino" },
    { deviceId: "fake-2", deviceName: "arduino" }, // duplicate name on purpose — exercises the dedupe display
    { deviceId: "fake-3", deviceName: "" },
  ];
  storeBleCallback((id) => console.log("FAKE_BLE selected:", JSON.stringify(id)));
  FAKES.forEach((d, i) => {
    setTimeout(() => {
      if (!bleCallback) return; // operator already picked/cancelled
      bleDevices.set(d.deviceId, d.deviceName);
      publishBleDevices();
    }, TUNING.BLE_FAKE_BATCH_MS * (i + 1));
  });
}

/* ---------- native dialogs -------------------------------------------------
   Only the picker is native; storage stays with the existing server-side /api/blk
   and the report's JSON — no second storage path. */

ipcMain.handle("dialog:save", async (_e, { defaultName, data, filters }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters });
  if (canceled || !filePath) return false;
  await fs.promises.writeFile(filePath, data);
  return true;
});

ipcMain.handle("dialog:open", async (_e, { filters }) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, { filters, properties: ["openFile"] });
  if (canceled || !filePaths[0]) return null;
  return { name: path.basename(filePaths[0]), text: await fs.promises.readFile(filePaths[0], "utf8") };
});

ipcMain.handle("settings:get", () => readSettings());
ipcMain.handle("settings:save", (_e, values) => { writeSettings(values); return true; });
ipcMain.handle("app:relaunch", () => { app.relaunch(); app.exit(0); });

/* ---------- window / menu / app -------------------------------------------- */

function createWindow() {
  win = new BrowserWindow({
    ...loadWinState(),
    minWidth: 720,
    minHeight: 520,
    titleBarStyle: "hiddenInset",
    // dedicated 32px drag strip above .topbar (see .mac-titlebar in
    // style.css) — center the dots on that strip, not the toolbar below it.
    trafficLightPosition: { x: 12, y: 10 },
    backgroundColor: "#09090a", // matches --bg; no white flash
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // preload (not node) in iframes too — blk.html editor needs window.blackout
      nodeIntegrationInSubFrames: true,
    },
  });
  wireBle(win.webContents);
  win.on("close", saveWinState);
  win.on("closed", () => { win = null; });
  win.loadURL(APP_URL);
  if (process.env.BLACKOUT_FAKE_BLE) win.webContents.on("did-finish-load", startFakeBle);
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Blackout",
        submenu: [
          { role: "about" },
          { type: "separator" },
          { label: "Settings / API Keys…", accelerator: "CmdOrCtrl+,", click: () => win?.webContents.send("settings:open") },
          { type: "separator" },
          { role: "hide" },
          { role: "quit" },
        ],
      },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "togglefullscreen" }],
      },
      { role: "windowMenu" },
    ])
  );
}

if (!app.requestSingleInstanceLock()) {
  app.quit(); // second launch would fork a second server onto the same port
} else {
  app.on("second-instance", () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    app.setAboutPanelOptions({ applicationName: "Blackout", applicationVersion: app.getVersion() });
    const devIcon = path.join(__dirname, "build", "icon.png");
    if (process.platform === "darwin" && !app.isPackaged && fs.existsSync(devIcon)) app.dock.setIcon(devIcon);
    // IMPORTANT NOTE: Windows/Linux surface an OS pairing prompt Chromium won't
    // auto-answer; auto-confirm so the picker is the only UI. macOS pairs silently.
    if (process.platform !== "darwin") {
      const { session } = require("electron");
      session.defaultSession.setBluetoothPairingHandler((_details, callback) => callback({ confirmed: true }));
    }
    buildMenu();
    await startServer();
    if (!quitting) createWindow();
  });

  app.on("before-quit", () => { quitting = true; });
  app.on("will-quit", () => { serverProc?.kill(); });
  app.on("window-all-closed", () => app.quit());
}
