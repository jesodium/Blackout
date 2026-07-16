# WRO 2026 — Blackout

Exploration robot for WRO 2026 Future Innovators. Single Arduino Uno R4 WiFi
(sensors, BLE) + Node.js dashboard.

## Quick start

### 1. Sensors (Uno R4 WiFi)

```bash
cd arduino-uno-r4/main
arduino-cli compile --fqbn arduino:renesas_uno:unor4wifi
arduino-cli upload --port /dev/cu.usbmodem1101 --fqbn arduino:renesas_uno:unor4wifi
```

Sensors: DHT11, HSRC04

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
├── arduino-uno-r4/   Uno R4 WiFi — sensors + BLE
├── server/           Node.js dashboard + AI
├── OUTDATED/         Retired Mega 2560 + Uno R3 two-board setup (porting reference only)
├── cad/              3D models (source)
├── step/             STEP exports
└── stls/             STL files for printing
```

## Docs

- `CLAUDE.md` — architecture overview
