import { mjpegSplit } from "./mjpeg.mjs";

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
    lidar: "lidar", lidarNone: "no lidar", lidarProbing: "checking usb", lidarSilent: "usb · no reply",
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
    lidar: "lidar", lidarNone: "sin lidar", lidarProbing: "revisando usb", lidarSilent: "usb · sin respuesta",
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

// `stop` waits for the ack so it can't be dropped; everything else is fire-and-forget
const bleWrite = (w) => {
  if (!cmdChar) return;
  const buf = new TextEncoder().encode(w);
  (w === "stop" || !cmdChar.writeValueWithoutResponse ? cmdChar.writeValue(buf) : cmdChar.writeValueWithoutResponse(buf))
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
    const el = $("s-" + k), tile = el.parentElement, warm = k === "gas" && d.gas < 0, lvl = warm ? "warm" : v == null ? "" : level(k, +v);
    if (k === "dist" && v != null) roll(v);
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
// the board's "nothing there" values (999 no echo, 0 no bme/mq, null no lux) show as —
// gas: 100 = the cleanest air the mq9 has seen since boot, lower = more gas
const readings = (d) => ({
  temp: d.temp, humid: d.humid,
  dist: d.dist >= 999 ? null : Math.round(d.dist),
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
  if (s.state !== "live") lcv.getContext("2d").clearRect(0, 0, lcv.width, lcv.height);
});
socket.on("lidar-scan", (scan) => {
  const dpr = window.devicePixelRatio || 1, w = lcv.clientWidth * dpr, h = lcv.clientHeight * dpr;
  if (lcv.width !== w || lcv.height !== h) { lcv.width = w; lcv.height = h; }
  const ctx = lcv.getContext("2d"), dot = 1.5 * dpr;
  // 0.48: the svg's outer ring is r96 of 200, same circle or a wall reads at the wrong distance
  const px = (Math.min(w, h) * 0.48) / (LIDAR_M * 1000);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = getComputedStyle(lcv).color;
  scan.forEach((mm, deg) => {
    if (!mm || mm > LIDAR_M * 1000) return;
    const a = (deg * Math.PI) / 180;   // 0 is straight up, clockwise, on both lidars
    ctx.fillRect(w / 2 + Math.sin(a) * mm * px - dot / 2, h / 2 - Math.cos(a) * mm * px - dot / 2, dot, dot);
  });
});

// ---- e-stop ----
// straight to BLE (the server won't echo our own cmd back), the server for the usb
// cable, and Sage's runner. Space works anywhere a key isn't already taken.
function estop() {
  bleWrite("stop");
  socket.emit("cmd", "stop");
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
