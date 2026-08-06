// minimal CDP driver — the bit test-blk-editor.mjs does inline, pulled out so
// record-blk.mjs (the landing page's editor recording) can reuse it.
import WebSocket from "ws";
const CDP = process.env.CDP || "http://localhost:9333";

export async function open(url) {
  const t = await (await fetch(CDP + "/json/new?" + encodeURIComponent(url), { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  await new Promise(r => ws.on("open", r));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else listeners.forEach(fn => fn(m));
  });
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "eval failed");
    return r.result.result.value;
  };
  const on = (fn) => listeners.push(fn);
  const close = async () => { ws.close(); await fetch(CDP + "/json/close/" + t.id); };
  await send("Runtime.enable");
  await send("Page.enable");
  return { send, evaluate, on, close, sleep };
}
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
