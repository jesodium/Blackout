// hud level pushes: repeat window, minimum gap, and what a ble drop clears

import assert from "node:assert";

const PORT = process.env.PORT || 3000;
const ws = new WebSocket(`ws://localhost:${PORT}/socket.io/?EIO=4&transport=websocket`);
const got = [];
ws.addEventListener("message", (e) => {
  const d = String(e.data);
  if (d[0] === "0") ws.send("40");
  else if (d === "2") ws.send("3");
  else if (d.startsWith("42")) {
    const [ev, arg] = JSON.parse(d.slice(2));
    if (ev === "cmd" && String(arg).startsWith("hud,")) got.push(arg);
  }
});
await new Promise((res) => ws.addEventListener("message", function on(e) {
  if (String(e.data).startsWith("40{")) { ws.removeEventListener("message", on); res(); }
}));

const send = (line) => fetch(`http://localhost:${PORT}/api/mega/sensor`, {
  method: "POST", headers: { "Content-Type": "text/plain" }, body: line,
});

const gap = () => new Promise((r) => setTimeout(r, 300));
await send("S:22,40,999,0,0,0,0,0");
await gap();
await send("S:22,40,5,0,0,0,0,0");
await gap();
await send("S:50,40,30,0,0,0,0,0");
await new Promise((r) => setTimeout(r, 400));

assert.deepStrictEqual(got, [
  "hud,ok,22C 40%|CLEAR",
  "hud,warn,22C 40%|5cm",
  "hud,bad,50C 40%|30cm",
], "hud level is the worst status, metrics come pre-formatted");

ws.close();
console.log("hud ok");
