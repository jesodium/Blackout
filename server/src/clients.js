// Connected dashboards. The host is whoever loaded over loopback; everyone else
// is telemetry-only (mirror / judge) until the host grants them full control.
// This is also the socket side of every feature: commands, analysis requests,
// confirms, language, the mirrored feed.
const { io, fwdIp, isHost } = require("./http");
const { usbWrite } = require("./link");
const state = require("./state");
const { camCount } = require("./vision");
const { getLed } = require("./lights");
const { mockPacket } = require("./telemetry");
const { answerConfirm } = require("./sage/agent");
const { runAiAnalysis, setMission } = require("./sage/analysis");

const clients = new Map();
// granted modes, held by ip so they survive a reconnect
const grants = new Map();

const kindOf = (ua = "") => /iPad|Tablet/.test(ua) ? "iPad" : /iPhone/.test(ua) ? "iPhone"
  : /Android/.test(ua) ? "Android" : /Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "device";
const pushClients = () => io.emit("clients", [...clients].map(([id, c]) => ({ id, ...c })));

io.on("connection", (socket) => {
  console.log("Client connected");
  const host = isHost(socket);
  const ip = fwdIp(socket) || String(socket.handshake.address).replace("::ffff:", "");
  const mode = host ? "full" : (grants.get(ip) || "mirror");
  clients.set(socket.id, {
    ip,
    kind: kindOf(socket.handshake.headers["user-agent"]),
    host, mode, granted: mode === "full",
  });
  pushClients();
  socket.emit("led", getLed());
  socket.on("disconnect", () => { clients.delete(socket.id); pushClients(); });

  socket.on("grant", (d) => {
    if (!isHost(socket)) return;
    const c = clients.get(d?.id);
    if (!c || c.host) return;
    const m = ["mirror", "judge", "full"].includes(d?.mode) ? d.mode : "mirror";
    if (m === "mirror") grants.delete(c.ip); else grants.set(c.ip, m);

    for (const o of clients.values()) if (!o.host && o.ip === c.ip) { o.mode = m; o.granted = m === "full"; }
    console.log(`${c.ip} (${c.kind}) set to ${m}`);
    pushClients();
  });
  if (state.latestData) socket.emit("sensor-data", state.latestData);
  socket.on("request-analysis", (opts) => {
    const mode = opts?.mode;
    if (typeof opts?.demo === "boolean") state.demoMode = opts.demo;
    const focus = String(opts?.prompt || "").trim().slice(0, 300) || null;
    // the operator's eye for this analysis; out of range falls back to the front cam
    const cam = Number(opts?.cam) > 0 && Number(opts.cam) < camCount ? Number(opts.cam) : 0;
    console.log(`On-demand analysis requested${mode ? ` (${mode})` : ""} on cam ${cam}${focus ? ` — focus: ${focus}` : ""}`);
    runAiAnalysis(mode, focus, cam);
  });

  socket.emit("mission-set", { mission: state.currentMission });
  socket.on("set-mission", setMission);

  socket.on("cmd", (w) => {
    if (w !== "stop" && !clients.get(socket.id)?.granted) return;
    usbWrite(w);                      // the cable, if one is open
    socket.broadcast.emit("cmd", w);  // and the host browser, which relays over BLE
  });

  // the operator's agent feed, mirrored to the judge tablets. Relay only — the host
  // browser owns the transcript (localStorage), the server just repeats it.
  socket.on("feed", (e) => { if (isHost(socket)) socket.broadcast.emit("feed", e); });
  // a card can hand Claude a shell (sage "claude"), so a read-only tablet's tap
  // is not an answer — same grant as driving
  socket.on("sage-confirm-res", (d) => { if (d && d.id && clients.get(socket.id)?.granted) answerConfirm(d.id, !!d.ok); });

  socket.on("set-language", (code) => {
    state.currentLanguage = (code === "es") ? "es" : "en";
    console.log("Language set:", state.currentLanguage);
  });

  socket.on("mock-data", () => {
    mockPacket();
    console.log("Mock data injected");
    runAiAnalysis();
  });
});

module.exports = { clients };
