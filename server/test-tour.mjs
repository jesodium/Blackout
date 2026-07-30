// smoke test for the first-run tour: it shows once, remembers that it's done,
// and the console's restart button brings it back.
// same CDP pattern as test-report.mjs:
//   PORT=3111 node server.js  +  chrome --headless=new --remote-debugging-port=9333
import WebSocket from "ws";
const URL_PAGE = process.env.TOUR_URL || "http://localhost:3111/";
const CDP = process.env.TOUR_CDP || "http://localhost:9333";

const tgt = await (await fetch(CDP + "/json/new?" + encodeURIComponent(URL_PAGE), { method: "PUT" })).json();
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const errors = [];
await new Promise(r => ws.on("open", r));
ws.on("message", raw => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push("EXCEPTION: " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push("CONSOLE: " + m.params.args.map(a => a.value || a.description).join(" "));
});
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "eval failed");
  return r.result.result.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const check = (name, ok, extra = "") => { console.log((ok ? "ok   " : "FAIL ") + name + (extra ? " — " + extra : "")); if (!ok) fail++; };

await send("Runtime.enable");
await send("Page.enable");
await sleep(2000);

// fresh browser: no flag, no debug ack
await evaluate(`localStorage.removeItem("tourDone"); localStorage.setItem("debugAck", "1"); location.reload(); return 1`);
await sleep(3000);

check("tour opens on a fresh browser", (await evaluate("return !!document.querySelector('.tour-card')")) === true);
const first = await evaluate("return document.querySelector('.tour-count')?.textContent || ''");
check("starts at step 1", /^1 \//.test(first), first);

// the cockpit is locked while the tour runs
check("app is inert behind the tour", (await evaluate("return document.getElementById('root').inert")) === true);
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "`", code: "Backquote", windowsVirtualKeyCode: 192 });
await sleep(400);
check("backtick can't open the console", (await evaluate("return !!document.querySelector('.drawer-bar')")) === false);

// walk it to the end — the last button finishes
const steps = Number(first.split("/")[1]);
check("more than one step", steps > 1, String(steps));
for (let i = 0; i < steps; i++) {
  await evaluate(`document.querySelectorAll('.tour-actions button')[1].click(); return 1`);
  await sleep(320);
}
check("tour closes at the end", (await evaluate("return !!document.querySelector('.tour-card')")) === false);
check("completion is remembered", (await evaluate(`return localStorage.getItem("tourDone")`)) === "1");
check("lock is released at the end", (await evaluate("return document.getElementById('root').inert")) === false);

await evaluate("location.reload(); return 1");
await sleep(3000);
check("does not reopen on the next load", (await evaluate("return !!document.querySelector('.tour-card')")) === false);

// console → restart tutorial
await evaluate(`[...document.querySelectorAll('.console-btn')].pop().click(); return 1`);
await sleep(400);
check("console drawer opened", (await evaluate("return !!document.querySelector('.drawer-tour')")) === true);
await evaluate(`document.querySelector('.drawer-tour').click(); return 1`);
await sleep(700);
check("restart reopens the tour", (await evaluate("return !!document.querySelector('.tour-card')")) === true);
check("restart clears the flag", (await evaluate(`return localStorage.getItem("tourDone")`)) === null);

// escape skips and re-arms the flag
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(300);
check("escape skips the tour", (await evaluate("return !!document.querySelector('.tour-card')")) === false);
check("skip also counts as done", (await evaluate(`return localStorage.getItem("tourDone")`)) === "1");

console.log("\nconsole errors: " + (errors.length ? "\n" + errors.join("\n") : "none"));
console.log(fail ? `\n${fail} failed` : "\nall passed");
ws.close();
process.exit(fail || errors.length ? 1 : 0);
