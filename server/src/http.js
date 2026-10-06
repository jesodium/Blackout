// The express app, the http server and socket.io — created once, required by
// every module that adds a route or emits an event. Plus the two "is this the
// operator's own machine" checks, one for requests and one for sockets.
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.json());
app.use(express.text({ type: "text/plain" }));
app.use(express.static(path.join(__dirname, "..", "public")));

// every call from mcp.mjs, shown in the dashboard log and the Settings modal.
// Registered here, before any route exists, so it sees all of them.
let mcpLast = null;
app.use((req, res, next) => {
  if (req.get("x-blackout-mcp")) {
    mcpLast = { at: Date.now(), path: req.path, arg: req.body?.cmd ?? req.body?.mission ?? req.body?.text ?? req.body?.messages?.at(-1)?.content ?? req.query.cam ?? null };
    io.emit("mcp", mcpLast);
  }
  next();
});
app.get("/api/mcp", (req, res) => res.json(mcpLast));

const LOOPBACK = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];

// Driving is loopback only: a tunnel delivers remote clients FROM loopback, so a
// request carrying a proxy header is never local.
const localReq = (req) => !req.get("cf-connecting-ip") && !req.get("x-forwarded-for")
  && LOOPBACK.includes(req.socket.remoteAddress);

// IMPORTANT NOTE: a tunnel (scripts/tunnel.sh) delivers every remote client FROM loopback,
// so a request carrying a proxy header is never the host -- its ip is the header's.
const fwdIp = (s) => {
  const h = s.handshake.headers;
  return h["cf-connecting-ip"] || String(h["x-forwarded-for"] || "").split(",")[0].trim() || null;
};
const isHost = (s) => !fwdIp(s) && LOOPBACK.includes(s.handshake.address);

module.exports = { app, server, io, PORT, localReq, fwdIp, isHost };
