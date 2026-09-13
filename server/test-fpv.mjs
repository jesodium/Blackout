// opens fpv over cdp and checks the overlay, zoom and gamepad hand-off

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

// fpv takes the gamepad back while it is up, so the checks below drive it that way
await send("Runtime.enable"); await send("Page.enable");
await sleep(2500);

const fail = [];
const ok = (name, cond, extra = "") => { console.log((cond ? "  ok   " : "  FAIL ") + name + (cond ? "" : " — " + extra)); if (!cond) fail.push(name); };

ok("dashboard rendered", await ev(`return !!document.querySelector('.shell .stage-cam')`));

ok("view transitions available", await ev(`return !!document.startViewTransition`));
await ev(`document.querySelector('.fpv-enter').click(); return 1;`);
await sleep(120);

ok("morph is animating", await ev(`
  return document.getAnimations().some(a => String(a.effect?.pseudoElement || '').includes('view-transition'))`));
await sleep(1300);
ok("shell got is-fpv", await ev(`return document.querySelector('.shell').classList.contains('is-fpv')`));
ok("morph finished", !(await ev(`
  return document.getAnimations().some(a => String(a.effect?.pseudoElement || '').includes('view-transition') && a.playState === 'running')`)));

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
           tape: document.querySelectorAll('.fpv-tape').length,
           brackets: document.querySelectorAll('.fpv-brackets i').length,
           glassEvents: getComputedStyle(document.querySelector('.fpv-glass')).pointerEvents,
           feedW: Math.round(parseFloat(cs.width)),
           feedBox: (b => ({ w: Math.round(b.width), h: Math.round(b.height) }))(document.querySelector('.cam-feed').getBoundingClientRect()) };`);
console.log("  hud:", JSON.stringify(hud));
ok("hud glass drawn", hud.glass && hud.tape === 0 && hud.brackets === 4, JSON.stringify(hud));
ok("reticle centred", Math.abs(hud.reticle.cx - 1440 / 2) < 2 && Math.abs(hud.reticle.cy - 761 / 2) < 2, JSON.stringify(hud.reticle));
ok("hud never eats a click", hud.glassEvents === "none", hud.glassEvents);

ok("feed covers viewport (no pillarbox)", hud.feedBox.h >= 761 - 1 && hud.feedBox.w >= 1440 - 1,
  JSON.stringify(hud.feedBox) + " css-w=" + hud.feedW);

const geo = await ev(`
  const r = (s) => { const e = document.querySelector(s); if(!e) return null; const b = e.getBoundingClientRect();
    return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; };
  return { cam: r('.stage-cam'), sage: r('.fpv-sage'),
           topbarShown: !!document.querySelector('.topbar')?.getClientRects().length,
           driveShown: !!document.querySelector('.drive')?.getClientRects().length,
           railShown: !!document.querySelector('.col-rail')?.getClientRects().length,
           stripShown: !!document.querySelector('.strip')?.getClientRects().length,
           cells: [...document.querySelectorAll('.fpv-sage-row div small')].map(e => e.textContent),
           vw: innerWidth, vh: innerHeight,
           sageBg: getComputedStyle(document.querySelector('.fpv-sage')).backgroundColor };`);
console.log("  geo:", JSON.stringify(geo));

ok("camera fills viewport", geo.cam.w >= geo.vw - 1 && geo.cam.h >= geo.vh - 1, JSON.stringify(geo.cam));

ok("sage card shown", !!geo.sage && geo.cells.length === 5 + 1, JSON.stringify(geo.cells));
ok("sage card centred at the bottom", Math.abs((geo.sage.x + geo.sage.w / 2) - geo.vw / 2) <= 1
  && geo.sage.y + geo.sage.h <= geo.vh - 1 && geo.sage.y > geo.vh / 2, JSON.stringify(geo.sage));
ok("sage card small enough to fly through", geo.sage.w <= geo.vw / 2 && geo.sage.h <= geo.vh / 3, JSON.stringify(geo.sage));
ok("sage card translucent", /rgba\(|, 0\.\d/.test(geo.sageBg) || geo.sageBg.includes("color("), geo.sageBg);
ok("cockpit rails hidden", !geo.railShown && !geo.stripShown);
ok("topbar hidden", !geo.topbarShown);
ok("drive panel hidden", !geo.driveShown);
ok("talk button present", await ev(`return !!document.querySelector('.fpv-hud .hud-btn')`));

await ev(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); return 1;`);
await sleep(1300);
ok("esc exits fpv", !(await ev(`return document.querySelector('.shell').classList.contains('is-fpv')`)));
ok("layout restored", await ev(`return !!document.querySelector('.topbar')?.getClientRects().length`));

ok("no page errors", errors.length === 0, errors.join(" | "));
ws.close();
console.log(fail.length ? `\nFAILED: ${fail.join(", ")}` : "\nall fpv checks passed");
process.exit(fail.length ? 1 : 0);
