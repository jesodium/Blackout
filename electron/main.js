// electron shell around the server. it exists for the ble picker: chromium's own
// device chooser can't be styled or driven from the page.

const { app, BrowserWindow, utilityProcess, dialog, ipcMain, Menu, screen } = require("electron");
const path = require("path");
const http = require("http");
const fs = require("fs");

// ---- server child ----
const TUNING = {
  SERVER_READY_TIMEOUT_MS: 15000,
  SERVER_POLL_MS: 250,
  BLE_FAKE_BATCH_MS: 700,
};

const PORT = Number(process.env.PORT || 3000);
const APP_URL = `http://localhost:${PORT}`;
const SERVER_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "server")
  : path.join(__dirname, "..", "server");

let win = null;
let serverProc = null;
let quitting = false;

const SETTINGS_FILE = () => path.join(app.getPath("userData"), "blackout.env");
const SETTINGS_KEYS = ["CEREBRAS_API_KEY", "CEREBRAS_MODEL", "DEEPGRAM_API_KEY", "TTS_VOICE"];

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
  if (await probe(PORT)) return;
  serverProc = utilityProcess.fork(path.join(SERVER_DIR, "server.js"), [], {
    cwd: SERVER_DIR,
    stdio: "pipe",
    env: {
      ...process.env,
      ...loadUserEnv(),
      PORT: String(PORT),
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
    if (!serverProc) return;
    await new Promise((r) => setTimeout(r, TUNING.SERVER_POLL_MS));
  }
  dialog.showErrorBox("Blackout", `Server didn't come up on port ${PORT} within ${TUNING.SERVER_READY_TIMEOUT_MS / 1000}s.`);
  app.exit(1);
}

const STATE_FILE = () => path.join(app.getPath("userData"), "window-state.json");

function loadWinState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE(), "utf8"));
    if (s.width >= 400 && s.height >= 300) {
      const d = screen.getDisplayMatching(s).workArea;
      if (s.x < d.x + d.width && s.x + s.width > d.x && s.y < d.y + d.height && s.y + s.height > d.y) return s;
    }
  } catch {  }
  return { width: 1440, height: 900 };
}

function saveWinState() {
  try {
    if (win && !win.isMinimized() && !win.isFullScreen()) fs.writeFileSync(STATE_FILE(), JSON.stringify(win.getBounds()));
  } catch {  }
}

let bleCallback = null;
const bleDevices = new Map();

function storeBleCallback(cb) {
  if (cb !== bleCallback) bleDevices.clear();
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
  cb?.(String(deviceId));
  if (win) win.webContents.send("ble:closed");
});

function startFakeBle() {
  const FAKES = [
    { deviceId: "fake-1", deviceName: "arduino" },
    { deviceId: "fake-2", deviceName: "arduino" },
    { deviceId: "fake-3", deviceName: "" },
  ];
  storeBleCallback((id) => console.log("FAKE_BLE selected:", JSON.stringify(id)));
  FAKES.forEach((d, i) => {
    setTimeout(() => {
      if (!bleCallback) return;
      bleDevices.set(d.deviceId, d.deviceName);
      publishBleDevices();
    }, TUNING.BLE_FAKE_BATCH_MS * (i + 1));
  });
}

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

// ---- tunnel ----
// a public https url for a tablet that can't reach this machine over the LAN. server.js
// never treats a tunnelled client as host (fwdIp), so it lands in mirror like any tablet.
// IMPORTANT NOTE: cloudflared quick tunnel -- needs internet on this machine and the url
// changes every start; a named tunnel is the upgrade if a fixed url ever matters.
let tunnel = null; // { proc, url, short }
const tunnelState = () => ({ on: !!tunnel, url: tunnel?.short || tunnel?.url || null });

// spoo.me because is.gd, tinyurl and da.gd all blacklist trycloudflare.com. A failed
// shorten keeps the long url -- the tunnel works either way.
async function shorten(url) {
  try {
    const r = await fetch("https://spoo.me/", { method: "POST", signal: AbortSignal.timeout(6000),
      headers: { Accept: "application/json" }, body: new URLSearchParams({ url }) });
    const s = (await r.json()).short_url;
    return /^https?:\/\/spoo\.me\/\w+$/.test(s) ? s.replace("http:", "https:") : null;
  } catch { return null; }
}
const pushTunnel = () => win?.webContents.send("tunnel:state", tunnelState());

function startTunnel() {
  if (tunnel) return Promise.resolve(tunnelState());
  const { spawn } = require("child_process");
  return new Promise((resolve) => {
    const proc = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", APP_URL], {
      env: { ...process.env, PATH: `${process.env.PATH || ""}:/opt/homebrew/bin:/usr/local/bin` },
    });
    tunnel = { proc, url: null };
    let log = "";
    const fail = (error) => { if (tunnel?.proc === proc) tunnel = null; proc.kill(); pushTunnel(); resolve({ on: false, error }); };
    const timer = setTimeout(() => fail("cloudflared gave no url in 30s -- is this machine online?"), 30000);
    const read = (d) => {
      log = (log + d).slice(-2000);
      const m = !tunnel?.url && log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (!m) return;
      clearTimeout(timer);
      tunnel.url = m[0];
      const t = tunnel;
      shorten(t.url).then((s) => { if (s && tunnel === t) { t.short = s; pushTunnel(); } });
      pushTunnel();
      resolve(tunnelState());
    };
    proc.stdout.on("data", read);
    proc.stderr.on("data", read);
    proc.on("error", (e) => { clearTimeout(timer); fail(e.code === "ENOENT" ? "cloudflared not installed (brew install cloudflared)" : e.message); });
    proc.on("exit", () => { clearTimeout(timer); if (tunnel?.proc === proc) { tunnel = null; pushTunnel(); } resolve({ on: false, error: "cloudflared exited" }); });
  });
}

function stopTunnel() {
  tunnel?.proc.kill();
  tunnel = null;
  pushTunnel();
  return tunnelState();
}

ipcMain.handle("tunnel:start", () => startTunnel());
ipcMain.handle("tunnel:stop", () => stopTunnel());
ipcMain.handle("tunnel:get", () => tunnelState());

// ---- mcp ----
// server/mcp.mjs, run by this app's own binary as plain node (ELECTRON_RUN_AS_NODE),
// so a laptop with no node installed can still host it.
const MCP_SCRIPT = path.join(SERVER_DIR, "mcp.mjs");
const DESKTOP_CFG = () => path.join(app.getPath("appData"), "Claude", "claude_desktop_config.json");
function mcpInfo() {
  let installed = false;
  try { installed = !!JSON.parse(fs.readFileSync(DESKTOP_CFG(), "utf8")).mcpServers?.blackout; } catch { }
  return { installed, cli: `claude mcp add blackout -e ELECTRON_RUN_AS_NODE=1 -- "${process.execPath}" "${MCP_SCRIPT}"` };
}
function mcpInstall() {
  let cfg = {};
  // a config that isn't valid json is the operator's, never overwritten -- only a missing one is created
  try { cfg = JSON.parse(fs.readFileSync(DESKTOP_CFG(), "utf8")); }
  catch (e) { if (e.code !== "ENOENT") throw new Error(`${DESKTOP_CFG()}: ${e.message}`); }
  cfg.mcpServers = { ...cfg.mcpServers, blackout: { command: process.execPath, args: [MCP_SCRIPT], env: { ELECTRON_RUN_AS_NODE: "1" } } };
  fs.mkdirSync(path.dirname(DESKTOP_CFG()), { recursive: true });
  fs.writeFileSync(DESKTOP_CFG(), JSON.stringify(cfg, null, 2) + "\n");
  return mcpInfo();
}
ipcMain.handle("mcp:get", () => mcpInfo());
ipcMain.handle("mcp:install", () => mcpInstall());

ipcMain.handle("settings:get", () => readSettings());
ipcMain.handle("settings:save", (_e, values) => { writeSettings(values); return true; });
ipcMain.handle("app:relaunch", () => { app.relaunch(); app.exit(0); });

function createWindow() {
  win = new BrowserWindow({
    ...loadWinState(),
    minWidth: 720,
    minHeight: 520,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 10 },
    backgroundColor: "#09090a",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
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
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    app.setAboutPanelOptions({ applicationName: "Blackout", applicationVersion: app.getVersion() });
    const devIcon = path.join(__dirname, "build", "icon.png");
    if (process.platform === "darwin" && !app.isPackaged && fs.existsSync(devIcon)) app.dock.setIcon(devIcon);

    if (process.platform !== "darwin") {
      const { session } = require("electron");
      session.defaultSession.setBluetoothPairingHandler((_details, callback) => callback({ confirmed: true }));
    }
    buildMenu();
    await startServer();
    if (!quitting) createWindow();
  });

  app.on("before-quit", () => { quitting = true; });
  app.on("will-quit", () => { serverProc?.kill(); tunnel?.proc.kill(); });
  app.on("window-all-closed", () => app.quit());
}
