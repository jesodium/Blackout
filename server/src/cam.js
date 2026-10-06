// The cameras as the server sees them: the cam over its own usb cable re-served
// at /capture /stream /control, the tunnel relay of the host's feed, where Sage's
// stills are borrowed from, the mount angle, and the board's cam-connected icon.
const { app, io, isHost } = require("./http");
const { usbWrite } = require("./link");
const { setFrameSource, setCamRot, pingCam } = require("./vision");
const camusb = require("./camserial");

// ---- the cam over usb ----
// The same three paths the wifi cam serves, on this server's own origin, so a cam
// on a cable is reached by adding ONE host to the list (location.host in app.js,
// 127.0.0.1 in vision.js) and nothing else learns a second shape. The serial port
// is opened on the first request and only when something asks, so a rig with no
// cable plugged in pays nothing.
const CAM_USB_BOUNDARY = "blackoutusb";

app.get("/capture", async (_req, res) => {
  try {
    const f = await camusb.frame();
    res.set({ "Content-Type": "image/jpeg", "Access-Control-Allow-Origin": "*" }).send(f);
  } catch (err) { res.status(503).send(err.message); }
});

// Pull one frame, write it, pull the next: the board only ever sends what was asked
// for, so a client that stops reading can never back the serial port up.
app.get("/stream", async (req, res) => {
  let alive = true;
  req.on("close", () => { alive = false; });
  try {
    while (alive) {
      const f = await camusb.frame();
      if (!alive) break;
      if (!res.headersSent) res.set({
        "Content-Type": `multipart/x-mixed-replace;boundary=${CAM_USB_BOUNDARY}`,
        "Access-Control-Allow-Origin": "*",
      });
      res.write(`\r\n--${CAM_USB_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${f.length}\r\n\r\n`);
      res.write(f);
    }
  } catch (err) {
    if (!res.headersSent) return res.status(503).send(err.message);
  }
  res.end();
});

app.get("/control", async (req, res) => {
  const { var: v, val } = req.query;
  try {
    await camusb.set(String(v), Number(val));
    res.set("Access-Control-Allow-Origin", "*").type("text").send(`OK:${v}=${Number(val)}`);
  } catch (err) { res.status(503).send(err.message); }
});

// ---- borrowed frames ----
// Sage borrows her still off a dashboard's live feed instead of opening a second
// stream the cam can't serve -- see setFrameSource in vision.js. The host first, any
// other client second (a judge tablet's feed is still a feed); no client, no frame,
// or no answer inside 800ms all resolve null and fall through to /capture.
const frameSocket = () => {
  const all = [...io.sockets.sockets.values()];
  return all.find(isHost) || all[0] || null;
};
setFrameSource((cam) => new Promise((resolve) => {
  const s = frameSocket();
  if (!s) return resolve(null);
  s.timeout(800).emit("cam-frame", cam, (err, frame) => resolve(err ? null : frame));
}));
// The tunnel can't reach the cam (it's on the LAN, and it's http under an https
// page), so a tunnelled viewer gets the HOST's own feed re-served here, borrowed
// frame by frame exactly like Sage's stills -- never a second /stream on the cam.
// IMPORTANT NOTE: only live while the host has that CamView mounted (camFrames is
// filled by the feed); host on another tab = the relay just waits.
app.get("/relay/:cam/stream", (req, res) => {
  const cam = Number(req.params.cam) || 0;
  let alive = true, last = null;
  req.on("close", () => { alive = false; });
  res.set({ "Content-Type": `multipart/x-mixed-replace;boundary=${CAM_USB_BOUNDARY}`, "Cache-Control": "no-store" });
  (async () => {
    while (alive) {
      const s = [...io.sockets.sockets.values()].find(isHost);
      const f = s && await new Promise(r => s.timeout(800).emit("cam-frame", cam, (e, b) => r(e ? null : b)));
      if (alive && f?.length && !(last && Buffer.from(f).equals(last))) {
        last = Buffer.from(f);
        res.write(`\r\n--${CAM_USB_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${last.length}\r\n\r\n`);
        res.write(last);
      }
      await new Promise(r => setTimeout(r, 100));
    }
    res.end();
  })();
});

// The dashboard's ROTATE button. Sage grabs her own stills, so the mount angle has
// to reach the server too or a flipped cam leaves her reading sideways frames.
app.post("/api/cam-rot", (req, res) => {
  const v = Number(req.body?.value);
  if (!Number.isFinite(v)) return res.status(400).json({ error: "value in degrees required" });
  const cam = Number(req.body?.cam) || 0;
  setCamRot(v, cam);
  res.json({ ok: true, value: v, cam });
});

// the board's panel shows whether the cam answers
let camConnected = null;
setInterval(async () => {
  const up = await pingCam();
  if (up === camConnected) return;
  camConnected = up;
  const w = `cam,${up ? "connected" : "not connected"}`;
  usbWrite(w);
  io.emit("cmd", w);
}, 5000);

module.exports = { closeUsbCam: () => camusb.close() };
