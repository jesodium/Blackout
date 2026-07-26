// the dashboard must fit the viewport — nothing scrolls, not the page, not the agent box.
// same CDP pattern as test-fpv.mjs:
//   PORT=3111 node server.js  +  chrome --headless=new --remote-debugging-port=9333
import WebSocket from "ws";
const URL_PAGE = process.env.LAYOUT_URL || "http://localhost:3111/";
const CDP = process.env.LAYOUT_CDP || "http://localhost:9333";

const tgt = await (await fetch(CDP + "/json/new?" + encodeURIComponent(URL_PAGE), { method: "PUT" })).json();
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
await new Promise(r => ws.on("open", r));
ws.on("message", raw => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "eval failed");
  return r.result.result.value;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const click = (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.click(); return true;`);
const measure = (view) => ev(`
  const de = document.scrollingElement, b = document.querySelector('.agent-body');
  return { view: ${JSON.stringify(view)}, page: de.scrollHeight - de.clientHeight,
           agent: b ? b.scrollHeight - b.clientHeight : 0 };`);

await send("Runtime.enable"); await sleep(2500);
await ev(`localStorage.clear(); location.reload(); return true;`); await sleep(2500);

const fail = [];
// 780 is the floor: below it the rail runs out of room even with every optional row shed
for (const [w, h] of [[1512, 900], [1512, 860], [1440, 820], [1440, 780]]) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  const seen = [await measure("sessions")];
  await click(".chat-new"); await sleep(400);
  seen.push(await measure("briefing"));
  for (let i = 0; i < 3; i++) {                       // walk the three briefing questions
    await ev(`const ta = document.querySelector('.mission-input');
      const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      set.call(ta, 'test answer'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
    await sleep(250); await click(".brief-step .btn--primary"); await sleep(350);
  }
  seen.push(await measure("review"));
  await click(".btn--go"); await sleep(1500);
  seen.push(await measure("stage"));
  await click(".ai-hist > summary"); await sleep(300);  // history opens over the panel, never grows it
  seen.push(await measure("stage+history"));
  console.log(w + "x" + h);
  for (const r of seen) {
    const good = r.page === 0 && r.agent === 0;
    console.log("  " + (good ? "ok   " : "FAIL ") + r.view.padEnd(14) + (good ? "" : `page+${r.page} agent+${r.agent}`));
    if (!good) fail.push(`${w}x${h} ${r.view}`);
  }
  await ev(`localStorage.clear(); location.reload(); return true;`); await sleep(2500);
}
ws.close();
console.log(fail.length ? `\nFAILED: ${fail.join(", ")}` : "\nnothing scrolls at any tested size");
process.exit(fail.length ? 1 : 0);
