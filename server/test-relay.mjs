// tablet demo: a client with no ble hands its drive commands to the client that has one.
// checks the server relays "cmd" to everyone else and never back to the sender.
//   node server.js  +  node test-relay.mjs      (PORT=3111 to match the other tests)
// speaks raw engine.io/socket.io v4 over node's global WebSocket — no client dep needed.
import assert from "node:assert";

const URL = `ws://localhost:${process.env.PORT || 3000}/socket.io/?EIO=4&transport=websocket`;

function client() {
  const ws = new WebSocket(URL);
  const got = [];
  ws.addEventListener("message", (e) => {
    const d = String(e.data);
    if (d[0] === "0") ws.send("40");   // engine.io open -> connect to the "/" namespace
    else if (d === "2") ws.send("3");  // ping -> pong
    else if (d.startsWith("42")) {
      const [ev, arg] = JSON.parse(d.slice(2));
      if (ev === "cmd") got.push(arg);
    }
  });
  const ready = new Promise((res) => {
    ws.addEventListener("message", function on(e) {
      if (String(e.data).startsWith("40{")) { ws.removeEventListener("message", on); res(); }
    });
  });
  return { ws, got, ready, emit: (ev, a) => ws.send("42" + JSON.stringify([ev, a])) };
}

const laptop = client(), tablet = client();
await Promise.all([laptop.ready, tablet.ready]);

tablet.emit("cmd", "drv,fwd,110,200");
await new Promise((r) => setTimeout(r, 300));

assert.deepStrictEqual(laptop.got, ["drv,fwd,110,200"], "the ble holder should get the relayed cmd");
assert.deepStrictEqual(tablet.got, [], "sender must not hear its own cmd back — that would loop");

laptop.ws.close(); tablet.ws.close();
console.log("relay ok");
