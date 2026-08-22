// oled hud: the server decides the safety level and formats the metrics, the giga
// only draws them. checks a telemetry line turns into the right "hud,<level>,<metrics>"
// on the same "cmd" channel drive commands ride.
//   node server.js  +  node test-hud.mjs      (PORT=3111 to match the other tests)
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

// temp,humid,dist,smoke,airq,roll,pitch,yaw
const send = (line) => fetch(`http://localhost:${PORT}/api/mega/sensor`, {
  method: "POST", headers: { "Content-Type": "text/plain" }, body: line,
});

// spaced past HUD_MIN_GAP — pushHud drops anything closer so 10hz telemetry can't
// out-run the one-write-at-a-time ble link.
const gap = () => new Promise((r) => setTimeout(r, 300));
await send("S:22,40,999,0,0,0,0,0");   // all normal, sonar sees nothing
await gap();
await send("S:22,40,5,0,0,0,0,0");     // wall right there -> NEAR
await gap();
await send("S:50,40,30,0,0,0,0,0");    // temp over the danger threshold
await new Promise((r) => setTimeout(r, 400));

assert.deepStrictEqual(got, [
  "hud,ok,22C 40%|CLEAR",
  "hud,warn,22C 40%|5cm",
  "hud,bad,50C 40%|30cm",
], "hud level is the worst status, metrics come pre-formatted");

ws.close();
console.log("hud ok");
