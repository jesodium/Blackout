// mirror mode + the host's device roster. the dashboard served to the judges' tablet
// (any non-loopback hostname) is telemetry only — no link controls, no updater, no drive —
// until the host flips it to full control from CONNECTED DEVICES. the same picker also
// has a judge view: still telemetry-only, but a bare presentation layout.
// same CDP pattern as test-layout.mjs:
//   PORT=3111 node server.js  +  chrome --headless=new --remote-debugging-port=9333
import assert from "node:assert";
import os from "node:os";
import WebSocket from "ws";

const PORT = process.env.PORT || 3111;
const CDP = process.env.LAYOUT_CDP || "http://localhost:9333";
const lan = Object.values(os.networkInterfaces()).flat()
  .find(i => i.family === "IPv4" && !i.internal)?.address;
assert(lan, "no lan address to pose as the tablet");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// one page, kept open — the grant has to be seen crossing from host to tablet live.
async function open(origin, query = "") {
  const url = `http://${origin}:${PORT}/${query}`;
  const tgt = await (await fetch(CDP + "/json/new?" + encodeURIComponent(url), { method: "PUT" })).json();
  const ws = new WebSocket(tgt.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  await new Promise(r => ws.on("open", r));
  ws.on("message", raw => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Runtime.enable");
  await sleep(2000);
  // ?operator is remembered per origin, so a previous run would poison this one.
  // tourDone goes straight back in: the first-run tour makes the app inert, and an
  // inert element swallows .click() — every check below would fail on a fresh profile.
  await send("Runtime.evaluate", { expression: `localStorage.clear(); localStorage.setItem("tourDone", "1"); location.reload()` });
  await sleep(2500);
  const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.result.value;
  return {
    ev,
    click: (sel) => ev(`!!document.querySelector(${JSON.stringify(sel)})?.click() || !!document.querySelector(${JSON.stringify(sel)})`),
    state: () => ev(`({
      conn:    !!document.querySelector('.top-conn'),
      mirror:  !!document.querySelector('.top-mirror'),
      control: !!document.querySelector('.top-mirror.is-go'),
      devices: !!document.querySelector('.topbar .console-btn'),
      drive:   !!document.querySelector('.zone.drive'),
      judge:   !!document.querySelector('.judge'),
      cockpit: !!document.querySelector('.cockpit'),
      pad:     [...document.querySelectorAll('.pad-btn')].every(b => b.disabled),
      chips:   [...document.querySelectorAll('.routine-row .chip')].every(b => b.disabled),
    })`),
    close: async () => { ws.close(); await fetch(CDP + "/json/close/" + tgt.id); },
  };
}

// a page left open by an aborted run is still a client on the roster — start clean.
for (const p of await (await fetch(CDP + "/json/list")).json()) {
  if (p.type === "page") await fetch(CDP + "/json/close/" + p.id);
}
await sleep(1500);

const pages = [];
try {
const host = await open("localhost"); pages.push(host);
const tab = await open(lan); pages.push(tab);

const h = await host.state();
assert(h.conn && !h.mirror && h.drive, "operator laptop lost its link controls");

let s = await tab.state();
assert(!s.conn && s.mirror && !s.control, "tablet still sees the link controls");
assert(!s.drive, "tablet sees the drive zone before being granted");

// host opens CONNECTED DEVICES and hands the tablet full control. only non-host rows
// carry a switch — wait for the roster to settle on exactly one, or a socket still
// closing from a reload would leave two rows for the same tablet and we'd click the ghost.
const roster = () => host.ev(`[...document.querySelectorAll('.device-row')].map(r => r.textContent).join(' | ')`);
const setMode = (m) => host.ev(`(() => {
  const s = document.querySelector('.device-row select');
  if (!s) return false;
  // react patches the node's own value setter to track it — a plain assignment goes
  // through that tracker and react then swallows onChange. the prototype setter gets past it.
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(s), 'value').set.call(s, ${JSON.stringify(m)});
  s.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
// full control goes through a confirm that arms after 3s; every other mode applies at once.
const confirmGrant = () => host.ev(`(() => { const b = document.querySelector('.warn-go:not([disabled])'); if (!b) return false; b.click(); return true; })()`);
await host.click(".topbar .console-btn");
const settle = async () => {
  for (let i = 0; i < 20; i++) {
    if (await host.ev(`document.querySelectorAll('.device-row select').length`) === 1) return;
    await sleep(300);
  }
};
await settle();
assert(await host.ev(`document.querySelectorAll('.device-row select').length`) === 1,
  `roster should show exactly one switchable device — ${await roster()}`);

await setMode("full");
await sleep(600);
assert(!(await tab.state()).control, "the grant confirm was skipped — one click handed over the robot");
await sleep(3000);
assert(await confirmGrant(), "grant confirm never armed after 3s");
await sleep(600);
s = await tab.state();
assert(s.control && s.drive, `tablet was granted control but never heard about it — ${await roster()}`);
assert(s.pad && s.chips, "granted tablet drives with no ble link of its own");

// a wifi blip reconnects the tablet as a brand new socket. the grant is held by ip,
// so it comes back driving instead of silently dropping to view-only mid-run.
await tab.ev("location.reload()");
await sleep(3000);
assert((await tab.state()).control, "the tablet lost its grant just by reconnecting");
// wait for the dropped socket to fall off the roster, or setMode() drives the ghost row.
await settle();

// judge view: still telemetry-only, but the cockpit is replaced by the flat layout.
await setMode("judge");
await sleep(800);
s = await tab.state();
assert(s.judge && !s.cockpit, `judge view never replaced the cockpit — ${await roster()}`);
assert(!s.control && !s.drive, "judge view kept control — it is a layout, not a permission");

await setMode("mirror");                       // revoke
await sleep(800);
s = await tab.state();
assert(!s.control && !s.drive, `control was revoked but the tablet kept driving — ${await roster()}`);
assert(!s.judge && s.cockpit, "back to mirror but the judge layout stayed");

const unlocked = await open(lan, "?operator"); pages.push(unlocked);
const u = await unlocked.state();
assert(u.conn && !u.mirror, "?operator did not unlock a second machine");

console.log("mirror ok — tablet read-only, host sets mirror/judge/full live, ?operator unlocks");
} finally {
  for (const p of pages) await p.close(); // a live page keeps polluting the next run's roster
}
