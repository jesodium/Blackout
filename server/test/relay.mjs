// a command from a granted client reaches the ble holder, and never echoes back to the sender

import assert from "node:assert";

const URL = `ws://localhost:${process.env.PORT || 3000}/socket.io/?EIO=4&transport=websocket`;

function client() {
  const ws = new WebSocket(URL);
  const got = [];
  ws.addEventListener("message", (e) => {
    const d = String(e.data);
    if (d[0] === "0") ws.send("40");
    else if (d === "2") ws.send("3");
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
