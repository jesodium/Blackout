// elevation: the tile reads metres relative to where the rover started, so the
// first pressure reading is the zero and nothing depends on the venue's QNH.
//   node server.js  +  node test-elev.mjs      (no SEA_LEVEL_HPA in the env)
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
    if (ev === "sensor-data") got.push(arg.alt);
  }
});
await new Promise((res) => ws.addEventListener("message", function on(e) {
  if (String(e.data).startsWith("40{")) { ws.removeEventListener("message", on); res(); }
}));

// temp,humid,dist,smoke,airq,roll,pitch,yaw,co,co_alert,pressure
const send = (p) => fetch(`http://localhost:${PORT}/api/mega/sensor`, {
  method: "POST", headers: { "Content-Type": "text/plain" },
  body: `S:22,40,50,0,0,0,0,0,0,0,${p}`,
});

await send(1021.4);  // wherever we are today -> zero, whatever the number is
await send(1021.4);  // same pressure, same spot
await send(1020.2);  // 1.2 hPa lower -> ~10m higher
await send(1022.6);  // 1.2 hPa higher -> ~10m lower
await send(0);       // no bme wired: not "sea level", no reading
await new Promise((r) => setTimeout(r, 300));

// the zero leaks toward ambient, so a pressure that stays put decays back to 0
// instead of reading a climb forever — that's the weather rejection. run the
// server with REF_TAU_S=1 to see it in a test's lifetime.
if (process.env.REF_TAU_S) {
  await send(1020.2);
  await new Promise((r) => setTimeout(r, 2500)); // >2 tau
  await send(1020.2);
  await new Promise((r) => setTimeout(r, 300));
  const settled = got.pop(), first = got.pop();
  assert.ok(first > 5, `step should still read a climb, got ${first}`);
  assert.ok(Math.abs(settled) < first / 3, `held pressure should decay, got ${settled}`);
  console.log(`leak ok: ${first} -> ${settled}`);
}

assert.strictEqual(got.length, 5, `expected 5 packets, got ${got.length}`);
assert.strictEqual(got[0], 0, "first reading must be the zero");
assert.strictEqual(got[1], 0, "same pressure must stay at zero");
assert.ok(got[2] > 9 && got[2] < 11, `climb should read ~10m, got ${got[2]}`);
assert.ok(got[3] < -9 && got[3] > -11, `descent should read ~-10m, got ${got[3]}`);
assert.strictEqual(got[4], 0, "no pressure is no reading");

console.log("elevation ok:", got.join(" "));
ws.close();
