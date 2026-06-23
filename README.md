# WRO 2026 — Blackout

Exploration robot for WRO 2026 Future Innovators. Two Arduino boards + Node.js dashboard.

## Quick start

### 1. Sensors (Mega 2560)

```bash
cd arduino-mega/main
arduino-cli compile --fqbn arduino:avr:mega:cpu=atmega2560
arduino-cli upload --port /dev/cu.usbserial-140
```

Sensors: MQ-2, DHT11, MPU6050, HC-SR04, MQ-135, mic. Data sent via HC-06 Bluetooth.

### 2. Motors (Uno R3 + L293D shield)

```bash
cd arduino-uno/main
arduino-cli compile --fqbn arduino:avr:uno
arduino-cli upload --port /dev/cu.usbserial-XXX
```

4WD skid-steer — pre-programmed movement sequence.

### 3. Server (Node.js)

```bash
cd server
cp .env.example .env    # add your OpenRouter API key
npm install
npm start               # → http://localhost:3000
```

Receives Bluetooth data, real-time dashboard, AI area analysis via OpenRouter.

## Project layout

```
├── arduino-mega/     Mega 2560 sensor hub
├── arduino-uno/      Uno R3 motor controller
├── server/           Node.js dashboard + AI
├── cad/              3D models (source)
├── step/             STEP exports
└── stls/             STL files for printing
```

## Docs

- `arduino-mega/AGENTS.md` — pinout, wiring, architecture (read this first)

## License

MIT
