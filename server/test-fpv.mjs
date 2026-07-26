// smoke test for fpv mode (△/Y). same CDP pattern as test-blk-editor.mjs.
//   PORT=3111 node server.js  +  chrome --headless=new --remote-debugging-port=9333
import WebSocket from "ws";
const URL_PAGE = process.env.FPV_URL || "http://localhost:3111/";
const CDP = process.env.FPV_CDP || "http://localhost:9333";

const tgt = await (await fetch(CDP + "/json/new?" + encodeURIComponent(URL_PAGE), { method: "PUT" })).json();
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const errors = [];
await new Promise(r => ws.on("open", r));
ws.on("message", (raw) => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push("EXCEPTION: " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push("CONSOLE: " + m.params.args.map(a => a.value || a.description).join(" "));
});
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "eval failed");
  return r.result.result.value;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
await send("Runtime.enable"); await send("Page.enable");
await sleep(2500);

const fail = [];
const ok = (name, cond, extra = "") => { console.log((cond ? "  ok   " : "  FAIL ") + name + (cond ? "" : " — " + extra)); if (!cond) fail.push(name); };

ok("dashboard rendered", await ev(`return !!document.querySelector('.shell .stage-cam')`));

// heading tape maths, straight out of app.js — the one bit of the hud with real logic
const tape = await ev(`
  const wrap = d => ((d % 360) + 360) % 360;
  const ticks = (yaw) => { const o = []; for (let a = Math.ceil((yaw-50)/10)*10; a <= yaw+50; a += 10) o.push({ deg: wrap(a), off: (a-yaw)/100 }); return o; };
  return { at0: ticks(0).map(k => k.deg), at355: ticks(355).map(k => k.deg),
           spread: ticks(123).map(k => +k.off.toFixed(3)) };`);
ok("heading tape wraps past 360", tape.at355.includes(350) && tape.at355.includes(0) && tape.at355.every(d => d >= 0 && d < 360), JSON.stringify(tape.at355));
ok("heading tape centres on yaw", tape.at0.includes(0) && tape.at0.length === 11, JSON.stringify(tape.at0));
ok("heading tape stays on screen", Math.min(...tape.spread) >= -0.5 && Math.max(...tape.spread) <= 0.5, JSON.stringify(tape.spread));

// enter via the △ FPV button
ok("view transitions available", await ev(`return !!document.startViewTransition`));
await ev(`document.querySelector('.fpv-enter').click(); return 1;`);
await sleep(120);
// mid-flight: the browser should be running a transition, not have snapped
ok("morph is animating", await ev(`
  return document.getAnimations().some(a => String(a.effect?.pseudoElement || '').includes('view-transition'))`));
await sleep(1300);   // morph is ~520ms + a frame or two of setup
ok("shell got is-fpv", await ev(`return document.querySelector('.shell').classList.contains('is-fpv')`));
ok("morph finished", !(await ev(`
  return document.getAnimations().some(a => String(a.effect?.pseudoElement || '').includes('view-transition') && a.playState === 'running')`)));

// no esp32-cam on the bench, so stand in a 4:3 frame the same shape the sensor sends.
// without an intrinsic ratio the img has no height and the cover maths can't be measured.
await ev(`
  const img = document.querySelector('.cam-feed'); if (!img) return 0;
  img.src = "data:image/svg+xml;utf8," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='800' height='600'><rect width='800' height='600' fill='#123'/></svg>");
  await img.decode().catch(() => {}); return 1;`);
await sleep(200);

const hud = await ev(`
  const cs = getComputedStyle(document.querySelector('.cam-feed'));
  const rt = document.querySelector('.fpv-reticle').getBoundingClientRect();
  return { glass: !!document.querySelector('.fpv-glass'),
           reticle: { cx: Math.round(rt.left + rt.width/2), cy: Math.round(rt.top + rt.height/2) },
           ticks: document.querySelectorAll('.fpv-tick').length,
           brackets: document.querySelectorAll('.fpv-brackets i').length,
           glassEvents: getComputedStyle(document.querySelector('.fpv-glass')).pointerEvents,
           feedW: Math.round(parseFloat(cs.width)),
           feedBox: (b => ({ w: Math.round(b.width), h: Math.round(b.height) }))(document.querySelector('.cam-feed').getBoundingClientRect()) };`);
console.log("  hud:", JSON.stringify(hud));
ok("hud glass drawn", hud.glass && hud.ticks >= 10 && hud.brackets === 4, JSON.stringify(hud));
ok("reticle centred", Math.abs(hud.reticle.cx - 1440 / 2) < 2 && Math.abs(hud.reticle.cy - 761 / 2) < 2, JSON.stringify(hud.reticle));
ok("hud never eats a click", hud.glassEvents === "none", hud.glassEvents);
// rotated -90°, so the feed's css width lands on screen as its height. covering the
// viewport means that height >= vh AND the resulting on-screen width >= vw.
ok("feed covers viewport (no pillarbox)", hud.feedBox.h >= 761 - 1 && hud.feedBox.w >= 1440 - 1,
  JSON.stringify(hud.feedBox) + " css-w=" + hud.feedW);

const geo = await ev(`
  const r = (s) => { const e = document.querySelector(s); if(!e) return null; const b = e.getBoundingClientRect();
    return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; };
  return { cam: r('.stage-cam'), strip: r('.strip'), rail: r('.col-rail'), agent: r('.agent'),
           topbarShown: !!document.querySelector('.topbar')?.getClientRects().length,
           driveShown: !!document.querySelector('.drive')?.getClientRects().length,
           vw: innerWidth, vh: innerHeight,
           railBg: getComputedStyle(document.querySelector('.agent')).backgroundColor };`);
console.log("  geo:", JSON.stringify(geo));

ok("camera fills viewport", geo.cam.w >= geo.vw - 1 && geo.cam.h >= geo.vh - 1, JSON.stringify(geo.cam));
ok("stats pinned left", geo.strip.x === 0 && geo.strip.w < geo.vw / 2, JSON.stringify(geo.strip));
ok("agent pinned right", geo.rail.x + geo.rail.w >= geo.vw - 1 && geo.rail.w < geo.vw / 2, JSON.stringify(geo.rail));
ok("rails do not overlap", geo.strip.x + geo.strip.w < geo.rail.x, `${geo.strip.w} + ${geo.rail.x}`);
ok("agent panel translucent", /rgba\(|, 0\.\d/.test(geo.railBg) || geo.railBg.includes("color("), geo.railBg);
ok("topbar hidden", !geo.topbarShown);
ok("drive panel hidden", !geo.driveShown);
ok("talk button present", await ev(`return !!document.querySelector('.fpv-hud .hud-btn')`));

// esc leaves
await ev(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); return 1;`);
await sleep(1300);
ok("esc exits fpv", !(await ev(`return document.querySelector('.shell').classList.contains('is-fpv')`)));
ok("layout restored", await ev(`return !!document.querySelector('.topbar')?.getClientRects().length`));

ok("no page errors", errors.length === 0, errors.join(" | "));
ws.close();
console.log(fail.length ? `\nFAILED: ${fail.join(", ")}` : "\nall fpv checks passed");
process.exit(fail.length ? 1 : 0);
