// The http side of mcp.mjs: Claude Desktop / Claude Code read and drive the robot
// through these, alongside whatever else they do on the operator's machine.
// Anything that moves the robot is loopback only (localReq).
const path = require("path");
const { pathToFileURL } = require("url");
const { app, io, localReq } = require("./http");
const link = require("./link");
const state = require("./state");
const { grabFrame, camCount } = require("./vision");
const { setMission } = require("./sage/analysis");
const { clients } = require("./clients");

app.get("/api/now", (req, res) => res.json({
  data: state.freshData(), link: link.linked(), usb: link.usbOpen(), mission: state.currentMission,
}));

app.post("/api/cmd", (req, res) => {
  if (!localReq(req)) return res.status(403).json({ error: "loopback only" });
  const w = String(req.body?.cmd || "").trim();
  if (!w || /[\r\n]/.test(w)) return res.status(400).json({ error: "one command line required" });
  link.usbWrite(w);     // the cable, if one is open
  io.emit("cmd", w);    // and the host browser, which relays over BLE
  res.json({ ok: true, sent: w, link: link.linked() });
});

app.get("/api/look", async (req, res) => {
  const cam = Number(req.query.cam) > 0 && Number(req.query.cam) < camCount ? Number(req.query.cam) : 0;
  try { res.type("jpeg").send(await grabFrame(cam)); }
  catch (err) { res.status(503).json({ error: err.message }); }
});

// A BLK program runs in the host dashboard, through the same playBlk() Sage's move
// cards use: compiled to the board when it can be (one loop() pass per `until`
// check), the browser interpreter otherwise, and say/ask/analyze serviced up
// there. Guarded like her moves -- a bare `forward` gets `until dist < 10`.
// IMPORTANT NOTE: needs a dashboard open on this machine; a headless runner would
// be a second copy of playBlk, add one only if that case comes up.
const BLK_RUN_WAIT_MS = 120000;
const BLK_MJS = pathToFileURL(path.join(__dirname, "..", "public", "js", "blk.mjs")).href;
async function runBlk(raw) {
  const { parse, guard, serialize } = await import(BLK_MJS);
  const { program, errors } = parse(String(raw || ""));
  if (errors.length || !program.length) return { code: 400, body: { error: errors[0] || "empty program" } };
  const { program: safe, added } = guard(program);
  const text = serialize(safe);
  const usb = link.usbOpen();
  // the host that holds the link runs it; one that can't drive answers {skip}
  for (const [id, c] of clients) {
    const s = c.host && io.sockets.sockets.get(id);
    if (!s) continue;
    try {
      const r = await s.timeout(BLK_RUN_WAIT_MS).emitWithAck("blk-run", { text, usb });
      if (r?.skip) continue;
      return { code: 200, body: { ran: text, guarded: added, ...r } };
    } catch {
      return { code: 200, body: { ran: text, guarded: added, running: true, note: `still running after ${BLK_RUN_WAIT_MS / 1000}s; send stop to end it` } };
    }
  }
  return { code: 409, body: { error: "no dashboard on this machine holds the robot link -- open it and CONNECT first" } };
}
app.post("/api/blk-run", async (req, res) => {
  if (!localReq(req)) return res.status(403).json({ error: "loopback only" });
  const { code, body } = await runBlk(req.body?.text);
  res.status(code).json(body);
});

app.post("/api/mission", (req, res) => {
  if (!localReq(req)) return res.status(403).json({ error: "loopback only" });
  setMission(req.body?.mission);
  res.json({ ok: true, mission: state.currentMission });
});
