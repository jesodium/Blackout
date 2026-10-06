// The robot link. Over BLE the BROWSER holds it and the server only keeps the
// flag; over USB the server holds the port itself. One link at a time.
const fs = require("fs");
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");
const { app } = require("./http");

const SERIAL_BAUD = parseInt(process.env.SERIAL_BAUD || "9600", 10);

let serialPort;
let bleActive = false;
// every line the board prints goes here; telemetry.js registers processLine
let lineHandler = () => {};
const onLine = (fn) => { lineHandler = fn; };

const usbOpen = () => !!serialPort?.isOpen;
const linked = () => bleActive || usbOpen();

// The giga reads the same command strings off usb that it reads off BLE
// (Serial.readStringUntil in loop()), so the cable is a second transport and
// nothing downstream learns a second shape. The \n is the terminator it waits for.
const usbWrite = (w) => { if (serialPort?.isOpen) serialPort.write(w + "\n"); };

async function listSerialPorts() {
  const names = await fs.promises.readdir("/dev");
  return names.filter((n) => n.startsWith("cu.")).map((n) => "/dev/" + n);
}

function attachParser(sp) {
  const parser = sp.pipe(new ReadlineParser({ delimiter: "\n" }));
  parser.on("data", (raw) => lineHandler(raw));
}

function disconnectSerial() {
  if (serialPort) {
    serialPort.removeAllListeners("close");
    serialPort.removeAllListeners("error");
    try { serialPort.close(); } catch {  }
    serialPort = null;
  }
}

async function connectSerial(path, cb) {
  if (bleActive) { cb?.(new Error("BT mode active")); return; }
  if (!path) {
    const ports = await listSerialPorts();
    // the giga is cu.usbmodem*; usbserial/wchusbserial is the esp32-cam's cable
    // (camserial.js owns that one) and writing drive commands at it does nothing.
    const usbPorts = ports.filter(p => /usbmodem/.test(p));
    if (usbPorts.length === 0) {
      console.log("No giga (cu.usbmodem*) ports found.");
      cb?.(new Error("no board on usb"));
      return;
    }
    path = usbPorts[0];
    console.log(`Auto-selected: ${path}`);
  }
  disconnectSerial();

  serialPort = new SerialPort({ path, baudRate: SERIAL_BAUD }, (err) => {
    if (err) console.error(`Failed to open ${path}: ${err.message}`);
    // why the LAST link died, before the next run starts -- same `log,` the
    // browser writes right after startNotifications
    else { console.log(`Connected to ${path}`); usbWrite("log,"); }
    cb?.(err);
  });

  attachParser(serialPort);
  serialPort.on("error", (err) => console.error("Serial error:", err.message));
  serialPort.on("close", () => console.log("Serial closed."));
}

app.get("/api/ports", async (req, res) => {
  const ports = await listSerialPorts();
  res.json({ ports, current: serialPort?.path || null });
});

app.get("/api/bridge", (req, res) =>
  res.json({ running: linked(), usb: usbOpen(), last: "" }));

app.post("/api/bridge/start", (req, res) => {
  // one link at a time: the board answers both, but two centrals writing at once
  // is two operators on one stick.
  if (req.body?.usb) {
    bleActive = false;
    connectSerial(req.body.port, (err) => res.json(err ? { error: err.message } : { ok: true, usb: true }));
    return;
  }
  disconnectSerial();
  bleActive = true;
  res.json({ ok: true });
});

app.post("/api/bridge/stop", (req, res) => {
  bleActive = false;
  disconnectSerial();
  res.json({ ok: true });
});

module.exports = { usbWrite, usbOpen, linked, onLine, connectSerial, disconnectSerial, SERIAL_BAUD };
