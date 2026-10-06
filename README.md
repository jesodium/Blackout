WRO 2026 Project. Future Innovators.

Single Arduino Giga R1 WiFi (sensors, BLE) + Node.js dashboard.

## Quick start

### 1. Sensors (Giga R1 WiFi)

```bash
cd firmware/giga/main
arduino-cli compile --fqbn arduino:mbed_giga:giga
arduino-cli upload --port /dev/cu.usbmodem1101 --fqbn arduino:mbed_giga:giga
```

Sensors: DHT11, BME280, HSRC04

### 2. Server (Node.js)

```bash
cd server
cp .env.example .env    # add your Cerebras API key
npm install
npm start                # → http://localhost:3000
```

Dashboard, real-time telemetry, AI area analysis via Cerebras. Open the
dashboard in Chrome/Edge (Web Bluetooth support required) and hit the BT
toggle to pair.

## Project layout

```
├── firmware/
│   ├── giga/main/       Giga R1 WiFi — sensors, motors, arm, BLE (main.ino + one .h per section)
│   ├── giga/i2c_scan/   I2C bus diagnostic
│   ├── giga/motor_test/ bench motor check
│   ├── esp32-cam/main/  ESP32-CAM — MJPEG streamer / USB frame server
│   └── uno-r4/          bench sketches
├── server/
│   ├── server.js        entry: loads src/ and listens (Electron forks this)
│   ├── mcp.mjs          MCP stdio server for Claude Desktop / Code
│   ├── src/             server modules (link, telemetry, cam, tts, …) + sage/ (the AI agent)
│   ├── public/          dashboard: index.html, js/app.js + js/ui/ components, lib modules
│   ├── prompts/         Sage's system prompts
│   ├── data/            recorded arm takes, tapes, BLK workflows
│   ├── test/            npm run test:<name>
│   └── tools/           bench tools (armrec.py, …)
├── electron/            desktop shell (custom BLE picker)
├── scripts/             flash.sh, arm-configurator.sh, docs.sh
├── docs/
├── archive/             retired Mega 2560 + Uno R3 setup (porting reference only)
└── hardware/            cad/ + step/ (local, not in git)
```

## Docs

- `CLAUDE.md` — architecture overview
