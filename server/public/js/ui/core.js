import htm from "htm";
import React from "react";

const html = htm.bind(React.createElement);

const NO_FEED = [];
const Icon = ({ n }) => html`<i class=${"icn icn-" + n} aria-hidden="true" />`;

// ---- viewer / cam host ----
// anything not on localhost is a read-only copy. ?operator unlocks a second machine for good.
const VIEWER = (() => {
  if (new URLSearchParams(location.search).has("operator")) localStorage.setItem("operator", "1");
  return !localStorage.getItem("operator") &&
    !["localhost", "127.0.0.1", "[::1]", "::1"].includes(location.hostname);
})();

// One group per camera, the addresses that cam answers on, tried in order -- the
// same shape (and the same reason) as CAM_URL / overCam() in vision.js: the cams
// move between the sim router, the iPhone hotspot and school DHCP, and a feed
// pinned to one address dies on every move while Sage, who walks the list, keeps
// working. That asymmetry is exactly what "Sage sees the cam but the feed is
// blank" looks like.
// location.host is the cam over its OWN USB CABLE -- this server re-serves the
// serial frames at /stream, /capture and /control (camserial.js), so a cam on a
// cable is just one more address cam 0 answers on, tried after the wifi ones.
// There is one serial port, so cam 1 has no usb entry.
const CAM_HOSTS = [
  ["192.168.1.10", "172.20.10.10", "192.168.1.111", "blackout-cam.local", location.host],
  ["192.168.1.11", "172.20.10.11", "blackout-cam2.local"],
];
// Cam 0 is the front cam and keeps the old unsuffixed keys, so a rig that already
// has a host or an angle saved doesn't lose it. Cam 1 is the arm/gripper view --
// the headlamp is still cam 0's alone, but Sage can ask for cam 1 ("armcam"), so
// both cams push their angle to the server, each tagged with its index.
const CAM_DEFAULTS = CAM_HOSTS.map(g => g[0]);
// The saved host is a starting guess, not a fact -- a working one is written back
// on the first frame, so the feed re-pins itself to whatever answered.
// A hand-typed host that isn't in the list gets one try, then the list takes over:
// an override that doesn't stream is not worth retrying forever.
const nextCamHost = (cam, h) => {
  const list = CAM_HOSTS[cam] || CAM_HOSTS[0];
  return list[(list.indexOf(h) + 1) % list.length];
};
const camKey = (base, cam) => base + (cam || "");
// Which eye a full analysis looks through: the MAXIMIZED feed, the same
// `camMain` the pip swap writes -- the operator points the big picture at what
// they want looked at, and a separate picker was one more thing to keep in step.
// Sage's own "camera"/"armcam" tools still choose for themselves; this is only
// the analysis the operator presses (and the presentation greeting, which is one).
const anaCam = () => Math.min(Math.max(0, +localStorage.getItem("camMain") || 0), CAM_HOSTS.length - 1);
const camHost = (cam = 0) => localStorage.getItem(camKey("camHost", cam)) || CAM_DEFAULTS[cam];
// a host that already carries a port is the usb bridge on this server, which
// serves the stream beside /control instead of on the cam's own :81
// our own host keeps the page's scheme: over an https tunnel an http:// feed is mixed content
const camUrl = (host) => `${host === location.host ? location.protocol : "http:"}//${host.includes(":") ? host : host + ":81"}/stream`;
// Only the cloudflared tunnel serves this page over https: the cam's LAN address is
// unreachable (and mixed content) from there, so the feed is the host's, relayed.
const TUNNEL = location.protocol === "https:";

const fmt = (v, d) => (v == null || isNaN(v) ? "--" : Number(v).toFixed(d));

// ---- sensor model ----
// min/max is the meter's travel, st() picks the label and the colour band.
// zeroOk marks the three sensors that can really read 0 — everything else sends 0 because nothing is wired yet.
const SENSORS = [
  { key: "temp",  unit: "°C",  d: 1, min: 0, max: 60,   st: v => v > 45 ? ["st.critical", "abort"] : v > 35 ? ["st.high", "warn"] : ["st.normal", "go"] },
  { key: "humid", unit: "%",   d: 1, min: 0, max: 100,  st: v => v > 75 ? ["st.humid", "warn"] : v < 20 ? ["st.dry", "warn"] : ["st.good", "go"] },
  { key: "dist",  unit: "cm",  d: 0, min: 0, max: 200,  invert: true, zeroOk: true, st: v => v < 10 ? ["st.tooClose", "warn"] : ["st.clear", "go"] },
  { key: "alt",   unit: "m",   d: 0, min: -25, max: 25, cm: true, zeroOk: true, st: () => ["st.normal", "go"] },
  { key: "pressure", unit: "hPa", d: 1, min: 950, max: 1050, st: () => ["st.normal", "go"] },
  { key: "lux", unit: "lx", d: 0, min: 0, max: 1000, zeroOk: true,
    st: v => v < 1 ? ["st.dark", "go"] : v > 500 ? ["st.bright", "go"] : ["st.normal", "go"] },
];

const reads = (s, v) => v != null && !isNaN(v) && (v !== 0 || s.zeroOk);

const PKT_STALE_MS = 3000;

const TRENDS = [
  { key: "dist", tkey: "trend.dist", color: "#9a9384" },
  { key: "humid", tkey: "trend.humid", color: "#44cf86" },
  { key: "temp", tkey: "trend.temp", color: "#3b82f6" },
];

const FINDINGS = [
  { k: "temp",  warn: 35,  danger: 45,  msg: { 1: "find.tempUp", 2: "find.tempHigh" } },
  { k: "dist",  close: 10,              msg: { 1: "find.obstacle" } },
];
const bandOf = (f, v) => {
  if (v == null || isNaN(v)) return 0;
  if (f.k === "dist") return v < f.close ? 1 : 0;
  return v >= f.danger ? 2 : v >= f.warn ? 1 : 0;
};

export { CAM_DEFAULTS, FINDINGS, Icon, NO_FEED, PKT_STALE_MS, SENSORS, TRENDS, TUNNEL, VIEWER, anaCam, bandOf, camHost, camKey, camUrl, fmt, html, nextCamHost, reads };
