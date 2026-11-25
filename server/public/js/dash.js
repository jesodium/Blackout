import { mjpegSplit } from "./mjpeg.mjs";
import { ARM_J, armSim } from "./armsim.mjs";
import { arm3d } from "./arm3d.bundle.js";
import { parse as blkParse, run as blkRun, compile as blkCompile, insLine as blkInsLine,
         interp as blkInterp, evalExpr as blkEval, clampArg as blkClamp } from "./blk.mjs";

const $ = (id) => document.getElementById(id);
const socket = io();
window.socket = socket;   // the sage panel (sage.bundle.js) shares this one connection

// ---- prefs ----
// look-and-feel is per browser, so localStorage. sage.bundle.js reads "lang" itself.
const get = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const put = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

// IMPORTANT NOTE: covers the dashboard chrome only; Sage's panel UI is still English
// (her replies follow "lang"). Move these into sage.jsx too if that matters.
const T = {
  en: {
    link: "Link robot", linking: "Linking…", linked: "Linked", stop: "Stop", stopTitle: "Emergency stop (Space)",
    settings: "Settings", close: "Close", cancel: "Cancel", ping: "ping", pingTitle: "Packet latency",
    cams: "cams", camsTitle: "Cameras", up: "up", down: "down", scanning: "scanning…", inRange: "in range",
    noRobots: "no robots in range yet", unnamed: "unnamed", online: "online", offline: "offline",
    theme: "Theme", dark: "Dark", light: "Light", system: "Match system", language: "Language",
    spaceStop: "Space bar stops the robot", calm: "Reduce animations", layout: "Sage panel width", reset: "Reset",
    advanced: "Advanced", envNote: "API keys live in server/.env. Edit it and restart the server.",
    save: "Save & restart", saving: "saving…", saveFailed: "save failed",
    temp: "temperature", humid: "humidity", dist: "distance", pressure: "pressure", alt: "altitude", lux: "light", gas: "gas index",
    warm: "warm", calibrating: "CALIBRATING", safe: "safe", caution: "caution", danger: "danger",
    camFront: "front cam", camArm: "arm cam", rotate: "Rotate", camSettings: "Camera settings", live: "live", noSignal: "no signal",
    lidar: "lidar", lidarNone: "no lidar", lidarProbing: "checking usb", lidarSilent: "usb · no reply", clear: "CLEAR",
    arm: "arm", joints: "joints", lift: "▲ lift", lower: "▼ lower", left: "◀ left", right: "right ▶", base: "base", shoulder: "shoulder", elbow: "elbow", gripper: "gripper",
    armLive: "live", armLimp: "limp", armLocked: "locked", armView: "Arm, as the board believes it is. Drag to orbit, double-click to reset.",
    open: "open", regClose: "reg close", closeLock: "close lock", home: "home", noTakes: "no recorded takes",
    armOff: "disable arm", armOn: "enable arm",
  },
  es: {
    link: "Conectar robot", linking: "Conectando…", linked: "Conectado", stop: "Parar", stopTitle: "Parada de emergencia (Espacio)",
    settings: "Ajustes", close: "Cerrar", cancel: "Cancelar", ping: "ping", pingTitle: "Latencia de paquetes",
    cams: "cámaras", camsTitle: "Cámaras", up: "activa", down: "caída", scanning: "buscando…", inRange: "al alcance",
    noRobots: "todavía no hay robots al alcance", unnamed: "sin nombre", online: "en línea", offline: "sin conexión",
    theme: "Tema", dark: "Oscuro", light: "Claro", system: "Como el sistema", language: "Idioma",
    spaceStop: "La barra espaciadora detiene el robot", calm: "Reducir animaciones", layout: "Ancho del panel de Sage", reset: "Restablecer",
    advanced: "Avanzado", envNote: "Las claves de API están en server/.env. Edítalo y reinicia el servidor.",
    save: "Guardar y reiniciar", saving: "guardando…", saveFailed: "no se pudo guardar",
    temp: "temperatura", humid: "humedad", dist: "distancia", pressure: "presión", alt: "altitud", lux: "luz", gas: "índice de gas",
    warm: "warm", calibrating: "CALIBRANDO", safe: "seguro", caution: "precaución", danger: "peligro",
    camFront: "cámara frontal", camArm: "cámara del brazo", rotate: "Girar", camSettings: "Ajustes de cámara", live: "en vivo", noSignal: "sin señal",
    lidar: "lidar", lidarNone: "sin lidar", lidarProbing: "revisando usb", lidarSilent: "usb · sin respuesta", clear: "LIBRE",
    arm: "brazo", joints: "articulaciones", lift: "▲ subir", lower: "▼ bajar", left: "◀ izquierda", right: "derecha ▶", base: "base", shoulder: "hombro", elbow: "codo", gripper: "pinza",
    armLive: "activo", armLimp: "suelto", armLocked: "bloqueado", armView: "Brazo, según lo que cree la placa. Arrastra para girar, doble clic para restablecer.",
    open: "abrir", regClose: "cerrar suave", closeLock: "cerrar fijo", home: "inicio", noTakes: "sin movimientos grabados",
    armOff: "desactivar brazo", armOn: "activar brazo",
  },
};
const t = (k) => (T[get("lang", "en")] || T.en)[k] ?? T.en[k];

const osLight = matchMedia("(prefers-color-scheme: light)");
function applyPrefs() {
  const root = document.documentElement, theme = get("theme", "dark");
  root.dataset.theme = theme === "system" ? (osLight.matches ? "light" : "dark") : theme;
  root.classList.toggle("calm", get("calm", "0") === "1");
  root.lang = get("lang", "en");
  document.querySelectorAll("[data-t]").forEach((el) => { el.textContent = t(el.dataset.t); });
  document.querySelectorAll("[data-t-title]").forEach((el) => { el.title = el.ariaLabel = t(el.dataset.tTitle); });
  $("ble-list").dataset.empty = t("noRobots");
}
osLight.addEventListener("change", applyPrefs);
applyPrefs();
socket.emit("set-language", get("lang", "en"));   // the server's own blurts/analysis

// ---- link robot ----
// Web Bluetooth to the Giga; every notify line is forwarded to the server, same as before.
const BLE_SERVICE = "19b10000-e8f2-537e-4f6c-d104768a1214";
const BLE_CHAR = "19b10001-e8f2-537e-4f6c-d104768a1214";
const BLE_CMD = "19b10002-e8f2-537e-4f6c-d104768a1214";

const linkBtn = $("link");
let device = null, cmdChar = null;

const show = (state, usb) => {
  linkBtn.dataset.state = state;
  linkBtn.disabled = state === "busy";
  linkBtn.dataset.usb = usb ? "1" : "";
  $("link-label").textContent = state === "busy" ? t("linking") : state === "on" ? t("linked") + (usb ? " · USB" : "") : t("link");
};

const forward = (e) => fetch("/api/mega/sensor", {
  method: "POST", headers: { "Content-Type": "text/plain" },
  body: new TextDecoder().decode(e.target.value),
}).catch(() => {});

// `stop` waits for the ack so it can't be dropped; so does the blk upload, the ack is
// what paces `blk,i,` lines so they can't outrun the board's parser. Everything else
// is fire-and-forget
const bleWrite = (w) => {
  if (!cmdChar) return;
  const buf = new TextEncoder().encode(w);
  return (w === "stop" || w.startsWith("blk,") || !cmdChar.writeValueWithoutResponse ? cmdChar.writeValue(buf) : cmdChar.writeValueWithoutResponse(buf))
    .catch((e) => console.error("ble write", w, e));
};

// ---- electron ble picker ----
// main.js streams what it hears on ble:devices while requestDevice() waits; picking
// (or "" to cancel) resolves that same requestDevice call.
const picker = $("ble");
const pick = (id) => window.blackout.selectBleDevice(id);
if (window.blackout) {
  window.blackout.onBleDevices((list) => {
    if (!picker.open) picker.showModal();
    const names = list.map((d) => d.deviceName);
    $("ble-list").replaceChildren(...list.map((d) => {
      const dup = !d.deviceName || names.filter((n) => n === d.deviceName).length > 1;
      const tag = d.deviceId.replace(/[^a-zA-Z0-9]/g, "").slice(-4).toUpperCase();
      const b = document.createElement("button");
      b.type = "button";
      b.innerHTML = `<span></span><span class="k"></span>`;
      b.lastChild.textContent = t("inRange");
      b.firstChild.textContent = (d.deviceName || t("unnamed")) + (dup ? ` · ${tag}` : "");
      b.onclick = () => pick(d.deviceId);
      const li = document.createElement("li");
      li.append(b);
      return li;
    }));
  });
  window.blackout.onBleClosed(() => picker.close());
  picker.querySelectorAll("[data-cancel]").forEach((b) => b.onclick = () => pick(""));
  picker.addEventListener("cancel", (e) => { e.preventDefault(); pick(""); });   // esc
  picker.addEventListener("click", (e) => { if (e.target === picker) pick(""); }); // backdrop
}

async function link() {
  show("busy");
  try {
    if (!navigator.bluetooth) throw new Error("Web Bluetooth unsupported, use Chrome/Edge");
    if (window.blackout) { $("ble-list").replaceChildren(); picker.showModal(); }
    device = await navigator.bluetooth.requestDevice({ filters: [{ services: [BLE_SERVICE] }] });
    picker.close();
    const svc = await (await device.gatt.connect()).getPrimaryService(BLE_SERVICE);
    const char = await svc.getCharacteristic(BLE_CHAR);
    cmdChar = await svc.getCharacteristic(BLE_CMD).catch(() => null);
    await char.startNotifications();
    char.addEventListener("characteristicvaluechanged", forward);
    device.addEventListener("gattserverdisconnected", unlink);
    await fetch("/api/bridge/start", { method: "POST" });
  } catch (e) { console.error(e); picker.close(); device?.gatt?.disconnect(); device = cmdChar = null; }
  poll();
}

async function unlink() {
  if (device?.gatt?.connected) device.gatt.disconnect();
  device = cmdChar = null;
  await fetch("/api/bridge/stop", { method: "POST" }).catch(() => {});
  poll();
}

// the server is the truth: usb links and other tabs show up here too
async function poll() {
  try {
    const d = await (await fetch("/api/bridge")).json();
    show(d.running ? "on" : "off", d.usb);
  } catch { show("off"); }
}

linkBtn.addEventListener("click", () => linkBtn.dataset.state === "on" ? unlink() : link());
poll();
setInterval(poll, 5000);

// commands from Sage / MCP / tablets reach the board through this tab's BLE link
socket.on("cmd", bleWrite);

// ---- ping ----
// age of the newest packet when it lands; greys out after 3s of silence
const PKT_STALE_MS = 3000;
let lastPkt = 0;
socket.on("sensor-data", (d) => {
  if (!d?.timestamp) return;
  lastPkt = Date.now();
  $("ping").textContent = Math.max(0, lastPkt - d.timestamp) + " ms";
  delete $("ping").dataset.stale;
  delete $("sensors").dataset.stale;
  for (const [k, v] of Object.entries(readings(d))) {
    const el = $("s-" + k), tile = el.parentElement, warm = k === "gas" && d.gas < 0, clear = k === "dist" && d.dist >= 999;
    const lvl = warm ? "warm" : clear ? "safe" : v == null ? "" : level(k, +v);
    tile.toggleAttribute("data-clear", clear);
    if (k === "dist" && !clear && v != null) roll(v);
    else el.textContent = v ?? "—";
    tile.dataset.level = lvl;
    tile.querySelector(".lvl").textContent = lvl && t(lvl);
  }
});
setInterval(() => {
  if (Date.now() - lastPkt < PKT_STALE_MS) return;
  $("ping").textContent = "—";
  $("ping").dataset.stale = "";
  $("sensors").dataset.stale = "";   // keep the last values, just greyed
}, 1000);

// ---- sensors ----
// only what the giga actually fills; smoke/airq/imu/co ride the packet as 0s.
// the board's "nothing there" values (0 no bme/mq, null no lux) show as —
// dist 999 = no echo inside range: shows CLEAR, not —, since nothing nearby isn't a fault
// IMPORTANT NOTE: an unplugged sonar (INPUT_PULLDOWN) also times out to 999, so CLEAR can't prove it's wired
// gas: 100 = the cleanest air the mq9 has seen since boot, lower = more gas
const readings = (d) => ({
  temp: d.temp, humid: d.humid,
  dist: d.dist >= 999 ? t("clear") : Math.round(d.dist),
  pressure: d.pressure > 0 ? d.pressure.toFixed(1) : null,
  alt: d.pressure > 0 ? d.alt.toFixed(1) : null,
  lux: d.lux >= 0 ? Math.round(d.lux) : null,
  gas: d.gas < 0 ? t("calibrating") : d.gas > 0 ? Math.round(d.gas) : null,   // negative = heater warming up
});

// distance rolls like an odometer: each digit is a 0-9 strip in a one-digit window,
// slid to its digit (dash.css). three columns since the board tops out at 998;
// leading ones squeeze to 0 width. "—" swaps them out, they come back where they were.
const odo = [0, 1, 2].map(() => {
  const c = document.createElement("span");
  c.className = "odo";
  c.innerHTML = "<span>0<br>1<br>2<br>3<br>4<br>5<br>6<br>7<br>8<br>9</span>";
  return c;
});
function roll(n) {
  const el = $("s-dist"), s = String(n).padStart(3, " ").slice(-3);
  if (el.firstChild !== odo[0]) el.replaceChildren(...odo);
  odo.forEach((c, i) => {
    c.toggleAttribute("data-lead", s[i] === " ");
    c.style.setProperty("--n", s[i] === " " ? 0 : s[i]);
  });
}

// [danger below, caution below, caution above, danger above]
// IMPORTANT NOTE: rough rover/human-comfort guesses, not calibrated. tune on the course.
// alt is metres from the leaky reference (see telemetry.js), so it's "how far did we climb/drop".
const LIMITS = {
  temp: [0, 10, 30, 40],
  humid: [20, 30, 70, 85],
  dist: [15, 40, Infinity, Infinity],
  pressure: [950, 980, 1040, 1060],
  alt: [-10, -3, 3, 10],
  lux: [10, 100, Infinity, Infinity],
  gas: [50, 80, Infinity, Infinity],
};
const level = (k, v) => {
  const [dLo, cLo, cHi, dHi] = LIMITS[k];
  return v < dLo || v > dHi ? "danger" : v < cLo || v > cHi ? "caution" : "safe";
};

// ---- cameras ----
async function cams() {
  let up = [];
  try { up = await (await fetch("/api/cams")).json(); } catch {}
  const box = $("cams");
  box.querySelectorAll(".dot").forEach((d) => d.remove());
  up.forEach((ok, i) => {
    const d = document.createElement("span");
    d.className = "dot";
    d.dataset.up = ok;
    d.title = `cam ${i}: ${t(ok ? "up" : "down")}`;
    box.append(d);
  });
}
cams();
setInterval(cams, 5000);

// ---- camera feeds ----
// One group per camera, tried in order, same as CAM_URL in vision.js. location.host is
// cam 0 on its usb cable (camserial.js re-serves it at /stream). Read as bytes, not an
// <img src>, so Sage can borrow the newest frame (cam-frame) instead of opening a second
// stream the cam can't serve.
const CAM_HOSTS = [
  ["192.168.1.10", "172.20.10.10", "192.168.1.111", "blackout-cam.local", location.host],
  ["192.168.1.11", "172.20.10.11", "blackout-cam2.local"],
];
// the https tunnel can't reach the LAN cams, so it gets the host's feed relayed
const TUNNEL = location.protocol === "https:";
const camUrl = (h) => `${h === location.host ? location.protocol : "http:"}//${h.includes(":") ? h : h + ":81"}/stream`;
const camKey = (k, cam) => k + (cam || "");   // cam 0 keeps the old unsuffixed keys
const frames = [];
const feedText = (s) => t({ live: "live", down: "noSignal" }[s] || "scanning");
socket.on("cam-frame", (cam, ack) => {
  const f = frames[cam || 0];
  ack(f && Date.now() - f.at < 2000 ? f.bytes : null);
});

function feed(box) {
  const cam = +box.dataset.cam, img = box.querySelector("img"), list = CAM_HOSTS[cam];
  const st = (s) => { box.dataset.state = s; box.querySelector(".st").textContent = feedText(s); };
  let i = Math.max(0, list.indexOf(get(camKey("camHost", cam))));

  // mount angle: the picture and Sage's stills (server-side) have to agree, so it's
  // posted on load too -- the server's angle resets with every restart
  let rot = +get(camKey("camRot", cam), 270);
  const turn = () => {
    box.style.setProperty("--rot", rot + "deg");
    box.toggleAttribute("data-side", rot % 180 !== 0);
    fetch("/api/cam-rot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: rot, cam }) }).catch(() => {});
  };
  box.querySelector(".rot").onclick = () => { rot = (rot + 90) % 360; put(camKey("camRot", cam), rot); turn(); };
  turn();

  // sensor settings, straight to the cam's /control (same as the old dash). Not persisted:
  // the cam keeps them until it reboots, and the sliders start at the firmware defaults.
  let curHost = list[i];
  const PICKS = [
    ["wb_mode", 0, [[0, "auto"], [1, "sunny"], [2, "cloudy"], [3, "office"], [4, "home"]]],
    ["framesize", 8, [[8, "SVGA 800×600"], [6, "VGA 640×480"], [5, "CIF 400×296"], [4, "QVGA 320×240"]]],
  ];
  const SLIDERS = [["brightness", -2, 2, -1], ["contrast", -2, 2, -1], ["saturation", -2, 2, 0], ["ae_level", -2, 2, 0], ["quality", 4, 30, 10], ["led", 0, 255, 15]];
  const ctrl = (k, v) => fetch(`http://${curHost}/control?var=${k}&val=${v}`).catch(() => {});
  const pop = document.createElement("div");
  pop.className = "cam-pop"; pop.hidden = true;
  for (const [k, def, opts] of PICKS) {
    const l = document.createElement("label"), sel = document.createElement("select");
    l.innerHTML = `<span>${k}</span>`;
    sel.innerHTML = opts.map(([v, n]) => `<option value="${v}"${v === def ? " selected" : ""}>${n}</option>`).join("");
    sel.onchange = () => ctrl(k, sel.value);
    l.append(sel); pop.append(l);
  }
  for (const [k, min, max, def] of SLIDERS) {
    const l = document.createElement("label");
    l.innerHTML = `<span>${k} <b>${def}</b></span><input type="range" min="${min}" max="${max}" step="1" value="${def}">`;
    const r = l.querySelector("input"), b = l.querySelector("b");
    r.oninput = () => {
      b.textContent = r.value; ctrl(k, r.value);
      if (k === "led") fetch("/api/led", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: +r.value }) }).catch(() => {});
    };
    pop.append(l);
  }
  box.append(pop);
  const gear = box.querySelector(".set");
  gear.onclick = () => { pop.hidden = !pop.hidden; gear.setAttribute("aria-expanded", !pop.hidden); };

  const run = async () => {
    const host = curHost = list[i], ctl = new AbortController();
    let last = Date.now(), shown = null;
    st("loading");
    // no first frame in 12s, or a live feed silent for 5s: drop it and reconnect
    const dog = setInterval(() => { if (Date.now() - last > (shown ? 5000 : 12000)) ctl.abort(); }, 1000);
    try {
      const res = await fetch(TUNNEL ? `/relay/${cam}/stream` : camUrl(host), { signal: ctl.signal, cache: "no-store" });
      if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
      const reader = res.body.getReader();
      let buf = new Uint8Array(0);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const next = new Uint8Array(buf.length + value.length);
        next.set(buf); next.set(value, buf.length);
        const cut = mjpegSplit(next);
        buf = cut.rest;
        for (const f of cut.frames) {
          const url = URL.createObjectURL(new Blob([f], { type: "image/jpeg" }));
          img.src = url;
          if (shown) URL.revokeObjectURL(shown);
          shown = url;
          last = Date.now();
          frames[cam] = { bytes: f, at: last };
          if (box.dataset.state !== "live") { st("live"); put(camKey("camHost", cam), host); }
        }
      }
    } catch {}
    clearInterval(dog);
    st("down");
    if (!shown) i = (i + 1) % list.length;   // never answered: try its next address
    setTimeout(run, 2000);
  };
  run();
}
document.querySelectorAll(".feed[data-cam]").forEach(feed);

// ---- lidar ----
// src/lidar.js: status on "lidar", and while live a 360-slot array of mm (0 = no return)
// IMPORTANT NOTE: fixed 4 m outer ring; the old dash auto-ranged 1-16 m, bring that back if the field outgrows it
const LIDAR_M = 4;
const lid = $("lidar"), lcv = lid.querySelector("canvas");
let lidStatus = { state: "none" };
const lidText = () => lidStatus.state === "live" ? `${lidStatus.model} · ${LIDAR_M} m`
  : t({ probing: "lidarProbing", silent: "lidarSilent" }[lidStatus.state] || "lidarNone");
socket.on("lidar", (s) => {
  lidStatus = s;
  lid.dataset.state = s.state;
  lid.title = s.port || "";
  lid.querySelector(".st").textContent = lidText();
  if (s.state !== "live") lidStop();
});
// scans land at 20 Hz (lidar.js SCAN_MS); a rAF loop eases each degree toward its latest
// reading so walls glide at 60 fps instead of jumping. new hits fade in, lost ones fade out.
// draw: faint fill of the seen area, wall outline between neighbouring returns, dots tinted by
// distance, and a line to the nearest hit (also in the caption)
// IMPORTANT NOTE: [danger, caution] mm guesses for the rover's footprint, tune on the course
const LIDAR_NEAR = [300, 600];
const LIDAR_MIN = 50;    // IMPORTANT NOTE: closer than this is the rover's own chassis/cables, not an obstacle
const LIDAR_EASE_MS = 45; // time constant: lower snaps harder, higher smooths more but lags
const lidLevel = (mm) => mm < LIDAR_NEAR[0] ? "danger" : mm < LIDAR_NEAR[1] ? "caution" : "";
const want = new Float32Array(360), shown = new Float32Array(360), vis = new Float32Array(360);
let lidRaf = 0, lidLast = 0, lidNear = -1, lidCol = null;
function lidStop() {
  cancelAnimationFrame(lidRaf); lidRaf = 0; want.fill(0); vis.fill(0);
  lcv.getContext("2d").clearRect(0, 0, lcv.width, lcv.height);
  lid.querySelector(".near").textContent = "";
}
socket.on("lidar-scan", (scan) => {
  lidNear = -1;
  scan.forEach((mm, deg) => {
    want[deg] = mm >= LIDAR_MIN && mm <= LIDAR_M * 1000 ? mm : 0;
    if (want[deg] && (lidNear < 0 || want[deg] < want[lidNear])) lidNear = deg;
  });
  const nearEl = lid.querySelector(".near");
  nearEl.textContent = lidNear < 0 ? "" : (want[lidNear] / 1000).toFixed(2) + " m";
  nearEl.dataset.level = lidNear < 0 ? "" : lidLevel(want[lidNear]);
  const css = getComputedStyle(lid), v = (n) => css.getPropertyValue(n);   // here, not per frame: theme can change
  lidCol = { "": v("--ink"), caution: v("--warn"), danger: v("--stop") };
  if (!lidRaf) { lidLast = performance.now(); lidRaf = requestAnimationFrame(lidFrame); }
});
function lidFrame(now) {
  lidRaf = requestAnimationFrame(lidFrame);
  const k = document.documentElement.classList.contains("calm") ? 1 : 1 - Math.exp(-(now - lidLast) / LIDAR_EASE_MS);
  lidLast = now;
  const dpr = window.devicePixelRatio || 1, w = lcv.clientWidth * dpr, h = lcv.clientHeight * dpr;
  if (lcv.width !== w || lcv.height !== h) { lcv.width = w; lcv.height = h; }
  const ctx = lcv.getContext("2d"), col = lidCol;
  // 0.48: the svg's outer ring is r96 of 200, same circle or a wall reads at the wrong distance
  const px = (Math.min(w, h) * 0.48) / (LIDAR_M * 1000), cx = w / 2, cy = h / 2;
  const pts = [];   // [deg, mm, x, y, alpha], 0 is straight up, clockwise, on both lidars
  for (let deg = 0; deg < 360; deg++) {
    if (want[deg]) { shown[deg] = vis[deg] < 0.05 ? want[deg] : shown[deg] + (want[deg] - shown[deg]) * k; vis[deg] += (1 - vis[deg]) * k; }
    else vis[deg] -= vis[deg] * k;
    if (vis[deg] < 0.05) continue;
    const a = (deg * Math.PI) / 180, mm = shown[deg];
    pts.push([deg, mm, cx + Math.sin(a) * mm * px, cy - Math.cos(a) * mm * px, vis[deg]]);
  }
  ctx.clearRect(0, 0, w, h);
  if (!pts.length) return;

  ctx.globalAlpha = 0.07; ctx.fillStyle = col[""];
  ctx.beginPath(); pts.forEach(([, , x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.fill();

  ctx.globalAlpha = 0.35; ctx.strokeStyle = col[""]; ctx.lineWidth = dpr; ctx.beginPath();
  pts.forEach((p, i) => {
    const q = pts[(i + 1) % pts.length], gap = (q[0] - p[0] + 360) % 360;
    if (gap > 0 && gap <= 3 && Math.abs(q[1] - p[1]) < 250 && p[4] > 0.5 && q[4] > 0.5) { ctx.moveTo(p[2], p[3]); ctx.lineTo(q[2], q[3]); }
  });
  ctx.stroke();

  const n = lidNear >= 0 && pts.find((p) => p[0] === lidNear);
  if (n) {
    ctx.globalAlpha = 0.8; ctx.strokeStyle = col[lidLevel(n[1])]; ctx.setLineDash([3 * dpr, 3 * dpr]);
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(n[2], n[3]); ctx.stroke(); ctx.setLineDash([]);
  }

  for (const [, mm, x, y, al] of pts) {
    ctx.globalAlpha = al; ctx.fillStyle = col[lidLevel(mm)];
    ctx.beginPath(); ctx.arc(x, y, (mm < LIDAR_NEAR[1] ? 2 : 1.4) * dpr, 0, 7); ctx.fill();
  }
}

// ---- arm ----
// Same commands armrec.py sends. Held buttons repeat under the board's 1s deadman
// (ARM_JOG_MS) and park on release; joints 0 base, 1 shoulder, 2 elbow, 3 gripper.
// Lift/lower/left/right are armrec.py's pad (raise = shoulder -, elbow +, checked on the
// rig 2026-11-23), raw speeds so the board's dir applies. Joint rows pre-flip by dir instead.
// Takes are played by the server (armplay.js), same player Sage uses; they come
// back through socket "cmd", so the 3D view follows them too.
const sim = armSim();
const armSend = (w) => { bleWrite(w); socket.emit("cmd", w); armSeen(w); };   // server won't echo ours back
const armSeen = (w) => { if (/^(arm|stop)/.test(w)) { sim.cmd(w, performance.now()); armKick(); } };
socket.on("cmd", armSeen);
socket.on("serial-line", (d) => { if (sim.serial(d?.line)) armKick(); });
let armHeld = null;
setInterval(() => armHeld?.forEach(([j, d]) => armSend(`arm,${j},${d}`)), 300);

// one row per joint: jog -/+ (held), slider glides there (armto). Both in the
// operator's degrees, so + always grows the number whatever the servo's dir.
let armSlideT = 0;
$("arm-joints").replaceChildren(...ARM_J.map((d, i) => {
  const row = document.createElement("div");
  row.className = "arm-j";
  row.innerHTML = `<span class="k" data-t="${d.name}">${t(d.name)}</span><button type="button" class="btn icon" aria-label="−">−</button>`
    + `<input type="range" min="${d.lo}" max="${d.hi}" step="1" value="${d.home}"><button type="button" class="btn icon" aria-label="+">+</button><output class="k">${d.home}°</output>`;
  const [, dn, rng, up] = row.children;
  [[dn, -100], [up, 100]].forEach(([b, v]) => { b.dataset.hold = `${i},${v * d.dir}`; });
  rng.setAttribute("aria-labelledby", "arm-h");
  rng.ariaLabel = d.name;
  rng.onpointerdown = () => { rng.dataset.drag = ""; };
  rng.onpointerup = rng.onblur = () => { delete rng.dataset.drag; };
  rng.oninput = () => {                       // glide while dragging, not 60 armto/s
    if (performance.now() - armSlideT < 120) return;
    armSlideT = performance.now();
    armSend(`armto,${i},${rng.value}`);
  };
  rng.onchange = () => armSend(`armto,${i},${rng.value}`);
  return row;
}));
// sliders tucked away until wanted; the d-pad covers everyday driving
$("arm-fine").open = get("armFine", "0") === "1";
$("arm-fine").ontoggle = () => put("armFine", $("arm-fine").open ? "1" : "0");
document.querySelectorAll("[data-hold]").forEach((b) => {
  const off = () => { if (!armHeld) return; armHeld.forEach(([j]) => armSend(`arm,${j},0`)); armHeld = null; };
  b.onpointerdown = (e) => { e.preventDefault(); if (armHeld) return; armHeld = b.dataset.hold.split(";").map((p) => p.split(",").map(Number)); armHeld.forEach(([j, d]) => armSend(`arm,${j},${d}`)); };
  b.onpointerup = b.onpointerleave = b.onpointercancel = off;
  b.oncontextmenu = (e) => e.preventDefault();
});
document.querySelectorAll("[data-cmd]").forEach((b) => { b.onclick = () => armSend(b.dataset.cmd); });
// OE high + a lock on the board, so nothing powers the servos while they cool.
// IMPORTANT NOTE: the board forgets on reboot (comes back enabled); this button only
// knows what it last sent, so a reflash shows "enable" over a live arm until clicked.
$("arm-en").onclick = () => {
  const off = $("arm-en").dataset.t === "armOff";
  armHeld = null;
  armSend(`armen,${off ? 0 : 1}`);
  $("arm-en").dataset.t = off ? "armOn" : "armOff";
  $("arm-en").textContent = t($("arm-en").dataset.t);
  $("armpad").toggleAttribute("data-off", off);
};
fetch("/api/arm-moves").then((r) => r.json()).then((moves) => {
  const names = Object.keys(moves);
  $("arm-takes").replaceChildren(...(names.length ? names.map((n) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "btn"; b.textContent = n.toLowerCase().replace(/_/g, " ");
    b.onclick = () => fetch("/api/arm-play", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: n }) }).catch(() => {});
    return b;
  }) : [Object.assign(document.createElement("span"), { className: "k", textContent: t("noTakes") })]));
}).catch(() => {});

// ---- arm 3D ----
// arm.glb (the MuJoCo model's meshes) drawn by arm3d.bundle.js. The drawn angle springs
// toward the sim's so it moves like a thing with mass; a ghost shows where a glide is
// headed. Only animates while something moves. Drag to orbit, double-click resets.
const view3d = arm3d($("arm3d"));
const disp = sim.j.map((j) => j.pos);
let armRaf = 0, armLast = 0;
function armDraw() {
  const goal = sim.j.map((j, i) => isNaN(j.goal) ? disp[i] : j.goal);
  view3d.draw(disp, goal.some((v, i) => Math.abs(v - disp[i]) > 0.5) ? goal : null, !sim.live || !sim.on, sim.j[3].limp);
}

function armRows() {
  $("arm-joints").querySelectorAll(".arm-j").forEach((row, i) => {
    const deg = Math.round(sim.j[i].pos), [, , rng, , out] = row.children;
    if (!("drag" in rng.dataset) && document.activeElement !== rng) rng.value = deg;
    out.textContent = `${deg}°`;
    row.toggleAttribute("data-limp", sim.j[i].limp);
  });
  $("arm-sum").textContent = sim.j.map((j) => `${Math.round(j.pos)}°`).join(" ");
  const st = !sim.on ? "armLocked" : sim.live ? "armLive" : "armLimp";
  $("arm-st").dataset.t = st; $("arm-st").textContent = t(st);
}

function armFrame(now) {
  const dt = Math.min(0.1, (now - armLast) / 1000);
  armLast = now;
  const busy = sim.tick(now, dt);
  const k = document.documentElement.classList.contains("calm") ? 1 : 1 - Math.exp(-dt * 12);
  let settling = false;
  sim.j.forEach((j, i) => { disp[i] += (j.pos - disp[i]) * k; if (Math.abs(j.pos - disp[i]) < 0.05) disp[i] = j.pos; else settling = true; });
  armDraw(); armRows();
  armRaf = busy || settling ? requestAnimationFrame(armFrame) : 0;
}
function armKick() { if (!armRaf) { armLast = performance.now(); armRaf = requestAnimationFrame(armFrame); } }

new ResizeObserver(armDraw).observe($("arm3d"));
new MutationObserver(armDraw).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
armKick();

// ---- e-stop ----
// straight to BLE (the server won't echo our own cmd back), the server for the usb
// cable, and Sage's runner. Space works anywhere a key isn't already taken.
function estop() {
  armHeld = null;
  drvHeld = null;
  blkCancel();
  bleWrite("stop");
  socket.emit("cmd", "stop");
  armSeen("stop");
  fetch("/api/claude/stop", { method: "POST" }).catch(() => {});
}
$("estop").addEventListener("click", estop);
window.addEventListener("keydown", (e) => {
  if (e.key !== " " || get("spaceStop", "1") !== "1" || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(e.target.tagName)) return;
  e.preventDefault();
  estop();
});

// ---- settings ----
// theme/language/etc apply the moment they're picked. the advanced api keys are electron
// only: it keeps them in userData and reads them at launch, so saving those relaunches.
const prefs = $("prefs"), form = $("prefs-form"), keys = $("prefs-keys");
async function openPrefs() {
  form.elements.theme.value = get("theme", "dark");
  form.elements.lang.value = get("lang", "en");
  form.elements.spaceStop.checked = get("spaceStop", "1") === "1";
  form.elements.calm.checked = get("calm", "0") === "1";
  if (window.blackout) {
    $("prefs-web").hidden = true;
    keys.hidden = false;
    $("prefs-save").hidden = true;
    $("prefs-note").textContent = "";
    const v = await window.blackout.getSettings().catch(() => ({}));
    for (const el of keys.querySelectorAll("input")) el.value = v[el.name] || "";
  }
  prefs.showModal();
}
$("settings").addEventListener("click", openPrefs);
window.blackout?.onSettingsOpen(openPrefs);   // menu: Options… (Cmd/Ctrl+,)
prefs.querySelector("[data-close]").onclick = () => prefs.close();
prefs.addEventListener("click", (e) => { if (e.target === prefs) prefs.close(); });   // backdrop
form.addEventListener("change", ({ target: el }) => {
  if (!["theme", "lang", "spaceStop", "calm"].includes(el.name)) return;
  put(el.name, el.type === "checkbox" ? (el.checked ? "1" : "0") : el.value);
  applyPrefs();
  show(linkBtn.dataset.state, linkBtn.dataset.usb);
  cams();
  document.querySelectorAll(".feed[data-cam]").forEach((b) => { b.querySelector(".st").textContent = feedText(b.dataset.state); });
  lid.querySelector(".st").textContent = lidText();
  sageState();
  if (el.name === "lang") socket.emit("set-language", el.value);
});
$("prefs-reset").onclick = () => { setSage(null); keepSage(null); };
keys.addEventListener("input", () => { $("prefs-save").hidden = false; });
form.addEventListener("submit", async (e) => {
  if (!window.blackout || $("prefs-save").hidden) return;   // enter on a toggle: just close
  e.preventDefault();
  $("prefs-note").textContent = t("saving");
  try {
    await window.blackout.saveSettings(Object.fromEntries([...keys.querySelectorAll("input")].map((el) => [el.name, el.value])));
    await window.blackout.relaunch();
  } catch (err) { $("prefs-note").textContent = t("saveFailed"); console.error(err); }
});

// ---- split ----
// drag (or arrow keys on) the line between the halves; double-click goes back to 75/25
const split = $("split");
const SAGE_MIN = 280, DASH_MIN = 420;
const setSage = (px) => {
  if (px == null) return document.body.style.removeProperty("--sage");
  px = Math.round(Math.max(SAGE_MIN, Math.min(innerWidth - DASH_MIN, px)));
  document.body.style.setProperty("--sage", px + "px");
  return px;
};
const keepSage = (px) => { try { px == null ? localStorage.removeItem("sageW") : localStorage.setItem("sageW", px); } catch {} };
try { const w = +localStorage.getItem("sageW"); if (w) setSage(w); } catch {}

split.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  split.setPointerCapture(e.pointerId);
  split.dataset.drag = "";
});
split.addEventListener("pointermove", (e) => {
  if (split.hasAttribute("data-drag")) setSage(innerWidth - e.clientX);
});
split.addEventListener("pointerup", () => {
  delete split.dataset.drag;
  keepSage(document.querySelector(".sage").offsetWidth);
});
split.addEventListener("dblclick", () => { setSage(null); keepSage(null); });
split.addEventListener("keydown", (e) => {
  const step = e.key === "ArrowLeft" ? 24 : e.key === "ArrowRight" ? -24 : 0;
  if (!step) return;
  e.preventDefault();
  keepSage(setSage(document.querySelector(".sage").offsetWidth + step));
});

// ---- sage availability ----
let sageOn = false;
const sageState = () => { $("sage-state").textContent = t(sageOn ? "online" : "offline"); };
fetch("/api/cloud").then((r) => r.json())
  .then((d) => { sageOn = !!d.sage; }).catch(() => {}).finally(sageState);

// ---- blk runner ----
// compiled to the board when it fits (the vm in vm.h plays it; this tab only services the
// say/log/ask events it sends back as E:blk lines), the browser interpreter otherwise.
// Board lines come back as serial-line from either link: BLE posts them, usb is read server-side.
// Runs from the editor's Save & run and from Sage's robot_blk (mcp.js).
let blkEvt = null, blkTok = 0, pkt = null, voice = null;
const blkCancel = () => { blkTok++; };
socket.on("serial-line", (d) => { if (d?.line?.startsWith("E:blk")) blkEvt?.(d.line); });
socket.on("sensor-data", (d) => { pkt = d; });
const boardCmd = (w) => cmdChar ? bleWrite(w) : socket.emit("cmd", w);   // no BLE here: the server has the cable or relays to the tab that does

const blkWaitFor = (pred, ms, kick) => new Promise((res) => {
  const to = setTimeout(() => { blkEvt = null; res(null); }, ms);
  blkEvt = (line) => { if (!pred(line)) return; clearTimeout(to); blkEvt = null; res(line); };
  kick();
});

const blkNote = (txt) => { const el = $("blk-run"); el.hidden = false; el.textContent = txt; };
const post = (path, body) => fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function blkIo(stopped, sleep) {
  let cam = 0;   // blk `cam`: which camera analyze/ask/find look through
  const decide = async (path, body) => {
    try {
      const d = await (await post(path, { ...body, cam })).json();
      blkNote(`${d.yes ? "yes" : "no"}${d.text ? " · " + d.text : ""}`);
      return !!d.yes;
    } catch { blkNote("AI didn't answer, treating as no"); return false; }
  };
  return {
    stopped, sleep,
    drive: async (verb, pwm, ms) => { boardCmd(`drv,${verb},${pwm},${ms}`); await sleep(ms + 150); },
    // IMPORTANT NOTE: any ai-analysis counts as ours; one landing from another request ends the wait early
    analyze: async (focus) => {
      const done = new Promise((r) => socket.once("ai-analysis", r));
      socket.emit("request-analysis", { prompt: focus, cam });
      await Promise.race([done, sleep(30000)]);
    },
    ask: (question) => decide("/api/blk-ask", { question }),
    find: (thing) => decide("/api/blk-find", { thing }),
    led: (value) => { post("/api/led", { value }).catch(() => {}); },
    cam: (n) => { cam = n; },
    log: blkNote,
    // Sage's voice pick (sage.jsx); a new line cuts the last one off
    say: (text) => {
      voice?.pause();
      const p = get("sageVoice", "");
      voice = new Audio("/api/tts?" + new URLSearchParams({ text, ...(p ? { provider: p } : {}) }));
      voice.play().catch(() => {});
    },
    sensors: () => pkt,
    halt: () => boardCmd("stop"),
    onStep: (node, n) => blkNote(`blk ${n} · ${node.op.replace("_", " ")}`),
  };
}

async function blkOnBoard({ code, nodes, slots }, io, stopped) {
  if (!await blkWaitFor((l) => l.startsWith("E:blkrdy"), 2000, () => boardCmd(`blk,n,${code.length}`))) return false;
  for (let i = 0; i < code.length; i++) {
    if (stopped()) return true;
    await boardCmd(blkInsLine(i, code[i]));
  }
  let n = 0;
  return new Promise((res) => {
    const finish = (v) => { clearInterval(poll); blkEvt = null; res(v); };
    const poll = setInterval(() => { if (stopped()) finish(true); }, 200);
    blkEvt = async (line) => {
      if (line.startsWith("E:blkend")) return finish(true);
      if (line.startsWith("E:blkerr")) return finish(false);
      if (!line.startsWith("E:blk,")) return;
      const f = line.slice(6).split(",");
      const node = nodes[+f[0]], kind = +f[1];
      if (!node) return void boardCmd("blk,res,0");
      const vars = {};
      for (const [name, i] of Object.entries(slots)) vars[name] = +f[2 + i] || 0;
      blkNote(`blk ${++n} · ${node.op.replace("_", " ")} · on board`);
      const ctx = { st: { vars }, sensors: io.sensors };
      const txt = () => blkInterp(node.text, ctx);
      let val = 0;
      switch (node.op) {
        case "say": io.say(txt()); break;
        case "log": io.log(txt()); break;
        case "led": io.led(blkClamp("led", blkEval(node.arg, ctx) || 0)); break;
        case "cam": io.cam(blkClamp("cam", blkEval(node.arg, ctx) || 0)); break;
        case "analyze": await io.analyze(txt()); break;
        case "ask": val = (await io.ask(txt())) ? 1 : 0; break;
        case "find": val = (await io.find(txt())) ? 1 : 0; break;
      }
      if (kind) await boardCmd(`blk,res,${val}`);
    };
    boardCmd("blk,go");
  });
}

async function playBlk(text) {
  const { program, errors } = blkParse(text);
  if (errors.length || !program.length) { blkNote("blk: " + (errors[0] || "empty program")); return { error: errors[0] || "empty program" }; }
  const my = ++blkTok;
  const stopped = () => blkTok !== my;
  const sleep = async (ms) => {
    const t0 = Date.now();
    while (!stopped() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
  };
  const io = blkIo(stopped, sleep);
  let built = null, where = "board";
  try { built = blkCompile(program); } catch (e) { blkNote(`blk: in browser, ${e.message}`); }
  if (!built || !await blkOnBoard(built, io, stopped)) { where = "browser"; await blkRun(program, io); }
  const cancelled = stopped();
  blkNote(cancelled ? "blk stopped" : "blk done");
  setTimeout(() => { if (blkTok === my) $("blk-run").hidden = true; }, 3000);
  return { where, cancelled };
}

// robot_blk from mcp.js: only the tab that can actually drive takes it
socket.on("blk-run", async ({ text, usb }, ack) => {
  if (!usb && !cmdChar) return ack({ skip: true });
  ack(await playBlk(text));
});

// ---- tabs ----
// blk.html is the old standalone editor, framed as-is; src set on first open so the
// dash doesn't pay for it until someone wants it. Esc in the editor posts blk:close.
const blk = $("blk");
const swap = (name) => {
  if (name === "blk" && !blk.src) blk.src = "blk.html";
  $("main").hidden = name === "blk";
  blk.hidden = name !== "blk";
  delete blk.dataset.preload;   // same frame as unhiding: dropped any earlier, the editor sees a 0-wide resize and folds its panels
  document.body.dataset.tab = name;   // dash.css drops the sage half on blk
  document.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === name));
  put("tab", name);
};
// animated with a view transition (dash.css): blk comes in from the right, dash from the left.
// not on boot, a repeat click, calm mode or reduced motion
const still = matchMedia("(prefers-reduced-motion: reduce)");
// first open loads the editor before animating, so it doesn't slide in blank. Loaded
// full-size but invisible (data-preload): at display:none it boots at 0 wide and folds its panels
const tab = async (name) => {
  const was = document.body.dataset.tab, root = document.documentElement;
  if (!was || was === name || !document.startViewTransition || root.classList.contains("calm") || still.matches) return swap(name);
  if (name === "blk" && !blk.src) {
    blk.dataset.preload = "";
    blk.src = "blk.html";
    await new Promise((r) => { blk.onload = r; setTimeout(r, 1500); });
  }
  root.dataset.dir = name === "blk" ? "fwd" : "back";
  document.startViewTransition(() => swap(name));
};
document.querySelectorAll("[data-tab]").forEach((b) => b.onclick = () => tab(b.dataset.tab));
window.addEventListener("message", (e) => {
  if (e.source !== blk.contentWindow) return;
  if (e.data === "blk:close") tab("dash");
  if (e.data?.type === "blk:run" && e.data.name) {
    if (linkBtn.dataset.state !== "on") return blkNote("blk: link the robot first");
    tab("dash");   // watch it on the cams
    fetch("/api/blk/" + encodeURIComponent(e.data.name)).then((r) => r.ok ? r.text() : Promise.reject())
      .then(playBlk).catch(() => blkNote("blk: couldn't load " + e.data.name));
  }
});
tab(get("tab", "dash"));

// ---- debug ----
// test only: WASD drive. Same drv command as blk, re-sent under its own short timeout
// (DRV_MS) while held so a dropped link or lost keyup coasts to a halt by itself.
// Unknown drv verb = halt() on the board, that's the release.
const DRV_KEYS = { w: "fwd", a: "left", s: "back", d: "right" }, DRV_MS = 400;
let drvHeld = null;
const drvSend = () => drvHeld && boardCmd(`drv,${drvHeld},${$("dbg-pwm").value},${DRV_MS}`);
setInterval(drvSend, 250);
const drvShow = () => document.querySelectorAll("[data-drv]").forEach((b) => b.toggleAttribute("data-on", b.dataset.drv === drvHeld));
const drv = (verb) => {
  if (verb === drvHeld) return;
  if (!verb) boardCmd("drv,halt,0");
  drvHeld = verb; drvSend(); drvShow();
};
document.querySelectorAll("[data-drv]").forEach((b) => {
  b.onpointerdown = (e) => { e.preventDefault(); drv(b.dataset.drv); };
  b.onpointerup = b.onpointerleave = b.onpointercancel = () => drv(null);
  b.oncontextmenu = (e) => e.preventDefault();
});
$("dbg-pwm").oninput = (e) => { $("dbg-pwm-v").value = e.target.value; };
window.addEventListener("keydown", (e) => {
  const v = DRV_KEYS[e.key.toLowerCase()];
  if (!v || $("debug").hidden || $("main").hidden || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  e.preventDefault();
  drv(v);
});
window.addEventListener("keyup", (e) => { if (DRV_KEYS[e.key.toLowerCase()] === drvHeld) drv(null); });
window.addEventListener("blur", () => drvHeld && drv(null));
const debugShow = (on) => { $("debug").hidden = !on; put("debug", on ? "1" : "0"); if (!on && drvHeld) drv(null); };
debugShow(get("debug", "0") === "1");
// menu: Debug › Show debug area. It's the last grid row, under the fold, so scroll to it
window.blackout?.onDebugToggle?.(() => {
  debugShow($("debug").hidden);
  if ($("debug").hidden) return;
  if ($("main").hidden) tab("dash");
  requestAnimationFrame(() => $("debug").scrollIntoView({ behavior: "smooth", block: "nearest" }));
});
