// drives the real dashboard over cdp and checks the pane splitters: a drag
// resizes the pane AFTER the divider, it survives a reload, the keyboard does
// the same job, and the mobile layout ignores every pinned size.
// needs a server on :3111 and a debuggable chrome (LAYOUT_CDP), same as test-layout.

import WebSocket from "ws";
const URL_PAGE = process.env.LAYOUT_URL || "http://localhost:3111/";
const CDP = process.env.LAYOUT_CDP || "http://localhost:9333";

const tgt = await (await fetch(CDP + "/json/new?" + encodeURIComponent(URL_PAGE), { method: "PUT" })).json();
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const errs = [];
await new Promise(r => ws.on("open", r));
ws.on("message", raw => {
  const m = JSON.parse(raw);
  if (m.method === "Runtime.exceptionThrown") errs.push((m.params.exceptionDetails.exception?.description || "error").slice(0, 140));
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result.result.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const size = (w, h) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
const mouse = (type, x, y) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: 1, clickCount: 1 });
const key = async (k, code) => {
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code: k, windowsVirtualKeyCode: code });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: code });
};
const drag = async (sel, n, dx, dy) => {
  const b = await ev(`const r=document.querySelectorAll('${sel}')[${n}].getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};`);
  await mouse("mousePressed", b.x, b.y);
  await mouse("mouseMoved", b.x + dx / 2, b.y + dy / 2);
  await mouse("mouseMoved", b.x + dx, b.y + dy);
  await mouse("mouseReleased", b.x + dx, b.y + dy);
  await sleep(120);
};
const px = (sel, dim = "offsetWidth") => ev(`return document.querySelector('${sel}').${dim};`);
const fail = [];
const is = (name, got, want, slack = 3) => { if (Math.abs(got - want) > slack) fail.push(`${name}: ${got} != ${want}`); };

await send("Runtime.enable");
await size(1512, 900);
await sleep(3000);
// tourDone or the onboarding overlay eats every pointer event
await ev(`localStorage.clear(); localStorage.setItem("tourDone", "1"); location.reload(); return 1;`);
await sleep(3500);

const splits = await ev(`return document.querySelectorAll('.split').length;`);
if (splits !== 4) fail.push(`expected 4 splitters, got ${splits}`);
const wide0 = { cam: await px(".stage-cam"), rail: await px(".col-rail"), strip: await px(".strip", "offsetHeight") };
const ovf0 = await ev(`return document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth;`);
if (ovf0 > 0) fail.push(`splitters widened the page by ${ovf0}px`);

// a divider drag resizes the pane after it, toward the drag
await drag(".split--x", 0, -100, 0);
is("cam after drag", await px(".stage-cam"), wide0.cam + 100);
await drag(".split--y", 0, 0, -80);
is("strip after drag", await px(".strip", "offsetHeight"), wide0.strip + 80);
await drag(".split--x", 1, -120, 0);
is("rail after drag", await px(".col-rail"), wide0.rail + 120);

// and survives a reload
await ev(`location.reload(); return 1;`); await sleep(3500);
is("cam after reload", await px(".stage-cam"), wide0.cam + 100);
is("rail after reload", await px(".col-rail"), wide0.rail + 120);

// keyboard moves it and Enter hands the pane back to css
await ev(`document.querySelectorAll('.split--x')[1].focus(); return 1;`);
for (let i = 0; i < 5; i++) await key("ArrowLeft", 37);
await sleep(150);
is("rail after 5 arrows", await px(".col-rail"), wide0.rail + 170);
await key("Enter", 13); await sleep(150);
is("rail after reset", await px(".col-rail"), wide0.rail);
if (await ev(`return localStorage.getItem('split.rail');`) !== null) fail.push("reset left the size in localStorage");

// a pane can never be dragged away entirely
await drag(".split--x", 1, 900, 0);
is("rail clamped", await px(".col-rail"), 120);

// the stacked layout ignores all of it
await size(820, 1000);
await ev(`location.reload(); return 1;`); await sleep(3500);
if (await ev(`return getComputedStyle(document.querySelector('.split')).display;`) !== "none") fail.push("splitters visible in the stacked layout");
if (await ev(`return document.querySelector('.stage-cam').style.flex;`)) fail.push("pinned pane size applied in the stacked layout");

if (errs.length) fail.push("console: " + errs[0]);
await fetch(CDP + "/json/close/" + tgt.id);
if (fail.length) { console.error("test-split FAILED\n - " + fail.join("\n - ")); process.exit(1); }
console.log("test-split ok — 4 splitters, drag + keyboard + reset, persisted, clamped, off under 1024px");
process.exit(0);
