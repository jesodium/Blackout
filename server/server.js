// Blackout dashboard server. Each module in src/ adds its own routes and socket
// handlers when it is required; this file only loads them and starts listening.
// Stays at this path because Electron forks it and `npm start` runs it.
require("dotenv").config();

const { server, PORT } = require("./src/http");
require("./src/link");        // robot link: usb serial + the BLE flag
require("./src/telemetry");   // board CSV -> packets
require("./src/data");        // data/: arm takes, tapes, workflows
require("./src/tts");
require("./src/cam");
require("./src/lights");
require("./src/runs");
require("./src/sage/routes");
require("./src/sage/claude");  // BRAIN: CLAUDE, headless claude code
require("./src/flash");
require("./src/clients");     // sockets
require("./src/mcp");
const { connectSerial } = require("./src/link");
const { MDNS_HOST, startMdns } = require("./src/net");
const { pregenOnboarding } = require("./src/tts");

if (process.env.SERIAL_AUTOCONNECT === "true") connectSerial();
else console.log("USB serial auto-connect off — select a port in the dashboard (SERIAL_AUTOCONNECT=true to auto-open).");

startMdns();

server.listen(PORT, () => {
  console.log(`Server at http://localhost:${PORT}`);
  console.log(`Tablet:   http://${MDNS_HOST}:${PORT}`);
  pregenOnboarding();
});
