// smoke test for the agent session report. the modal document and the .json
// export come from one object, so this checks both read the same session.
// same CDP pattern as test-fpv.mjs:
//   PORT=3111 node server.js  +  chrome --headless=new --remote-debugging-port=9333
import WebSocket from "ws";
const URL_PAGE = process.env.REPORT_URL || "http://localhost:3111/";
const CDP = process.env.REPORT_CDP || "http://localhost:9333";

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
await sleep(2200);

// seed a briefed session with findings + messages, then reload so the app picks it up
await evaluate(`
  localStorage.setItem("chats", JSON.stringify([{
    id: "s1", title: "Cave sweep", mission: "Map the east tunnel and flag anything painted",
    created: 1750000000000,
    findings: [{ id: 1, text: "Smoke rising", kind: "warn", time: "10:02:11" },
               { id: 2, text: "Obstacle / wall found", kind: "danger", time: "10:03:40" }],
    messages: [{ role: "user", content: "what do you see" }, { role: "assistant", content: "A narrow passage, air is fine." }]
  }]));
  localStorage.setItem("activeChat", "s1");
  return 1`);
await evaluate("location.reload(); return 1");
await sleep(2500);

check("report button present", (await evaluate(`
  return [...document.querySelectorAll('.agent-foot .btn')].some(b => /report|informe/i.test(b.textContent))`)) === true);

await evaluate(`
  [...document.querySelectorAll('.agent-foot .btn')].find(b => /report|informe/i.test(b.textContent)).click(); return 1`);
await sleep(400);

check("modal opened", (await evaluate("return !!document.querySelector('.report-frame')")) === true);
const body = await evaluate("return document.querySelector('.report-body')?.textContent || ''");
check("mission shown", /east tunnel/.test(body));
check("findings shown", /Smoke rising/.test(body) && /Obstacle/.test(body));
check("conversation shown", /narrow passage/.test(body));
check("environment section shown", /Temp|Temperature|Distance/i.test(body), body.slice(0, 0));
check("status section shown", /Entry Status|Estado de Entrada/i.test(body));

// export: stub the anchor click and capture what would download
const dl = await evaluate(`
  let got = null;
  const realClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { got = { name: this.download, href: this.href }; };
  [...document.querySelectorAll('.report-actions button')].find(b => /json/i.test(b.textContent)).click();
  HTMLAnchorElement.prototype.click = realClick;
  if (!got) return null;
  const text = await (await fetch(got.href)).text();
  return { name: got.name, text };`);
check("export triggered a download", !!dl, dl?.name || "no anchor click");
let json = null;
try { json = JSON.parse(dl.text); } catch { /* handled by the check below */ }
check("download is valid json", !!json);
check("filename is a .blackout .json", /^blackout-cave-sweep-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/.test(dl?.name || ""), dl?.name);
check("json carries the mission", json?.session?.mission?.includes("east tunnel"));
// live telemetry can add more while the page sits there — the seeded two must survive
check("json carries findings", json?.findings?.length >= 2 && json.findings.some(f => f.text === "Smoke rising"), `${json?.findings?.length} findings`);
check("json carries conversation", json?.conversation?.length === 2);
check("json carries environment rows", json?.environment?.length === 5);
check("json carries events", Array.isArray(json?.events));

await evaluate(`[...document.querySelectorAll('.report-actions button')].find(b => /close|cerrar/i.test(b.textContent)).click(); return 1`);
await sleep(300);
check("modal closes", (await evaluate("return !!document.querySelector('.report-frame')")) === false);

console.log("\nconsole errors: " + (errors.length ? "\n" + errors.join("\n") : "none"));
console.log(fail ? `\n${fail} failed` : "\nall passed");
ws.close();
process.exit(fail || errors.length ? 1 : 0);
