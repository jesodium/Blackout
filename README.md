WRO 2026 Project. Future Innovators.

Single Arduino Giga R1 WiFi (sensors, BLE) + Node.js dashboard.

## Quick start

### 1. Sensors (Giga R1 WiFi)

```bash
cd giga-r1/main
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
├── giga-r1/          Giga R1 WiFi — sensors + BLE
├── esp32-cam/        ESP32-CAM — standalone MJPEG streamer (LED debug: boot=slow blink, error=rapid, ok=steady)
├── server/           Node.js dashboard + AI
├── OUTDATED/         Retired Mega 2560 + Uno R3 two-board setup (porting reference only)
├── cad/              3D models (source)
├── step/             STEP exports
└── stls/             STL files for printing
```

## Docs

- `CLAUDE.md` — architecture overview
