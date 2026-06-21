# AGENTS — Blackout V1 (Presentation Phase)

## Architecture

Two independent Arduino boards, **no direct link yet**:

| Board | Role | Code | Notes |
|-------|------|------|-------|
| **Mega 2560** | Sensor hub — reads environment, sends data via Bluetooth + Serial USB | `arduino-mega/main/` | HC-06 Bluetooth on Serial1 |
| **Uno R3** | Motor controller — runs pre‑programmed movement sequence | `arduino-uno/main/` | Standalone demo sequence |

**Current flow:** Mega reads sensors → sends CSV over **Serial1 to HC-06 Bluetooth** + Serial USB for debug. Node.js server on PC receives BT data, serves dashboard, and sends to OpenRouter AI for area analysis.

### Wireless to the PC — two paths

Sensor data reaches the Mac one of two ways. **Test Path A first; fall back to
Path B only if HC-06 won't work.**

| | Path A — HC-06 (primary) | Path B — ESP32 over WiFi (fallback) |
|---|---|---|
| Link | HC-06 Bluetooth on Serial1 | Mega serial → ESP32-CAM → WiFi |
| Server side | works **as-is** — `serialport` reads `/dev/cu.HC-06-SPP` | **rewrite** input to WiFi/TCP receive |
| Extra wiring | none (HC-06 RX wired direct) | level shift Mega TX1 (5V) → ESP32 RX (3.3V) |
| When to use | default | only if HC-06 is unreliable |

The **camera (ESP32-CAM) streams over its own WiFi regardless of which path** —
see the Camera section. In Path B the same ESP32 also relays the sensor CSV, so
one board carries both; in Path A the ESP32 does camera only and the Mega never
links to it.

**Later (Phase 2):** Mega Serial2/Serial3 for Uno communication for sensor‑driven navigation.

---

## Mega Pinout

| Mega Pin | Sensor / Module | Function |
|----------|-----------------|----------|
| A0 | MQ-2 (smoke) | Analog read |
| D22 | MQ-2 | Digital out |
| D42 | DHT11/DHT22 | Temp + humidity signal |
| 20 (SDA) | MPU6050 | I2C data |
| 21 (SCL) | MPU6050 | I2C clock |
| A6 | HC-SR04 | TRIG |
| A5 | HC-SR04 | ECHO |
| A1 | MQ-135 (air quality) | Analog read |
| D26 | MQ-135 | Digital out |
| A2 | Microphone (MAX9814/KY-038) | Analog |
| A3 | MQ-9 (CO/combustible gas) | Analog read |
| D29 | MQ-9 | Digital out |
| D18 (TX1) | → HC-06 RX | Bluetooth TX (Mega → BT) |
| D19 (RX1) | ← HC-06 TX | Bluetooth RX (BT → Mega) |
| D27 | HC-06 STATE | Connection-detect input (HIGH = paired) |
| D28 | HC-06 EN / KEY | Enable/AT-mode output (held LOW in firmware) |
| D0 (RX0) / D1 (TX0) | USB ↔ PC | Wired serial link — Node server reads `S:` packets here |

### HC-06 Bluetooth Wiring

| HC-06 Pin | Mega Pin | Notes |
|-----------|----------|-------|
| VCC | 5V | |
| GND | GND | |
| TX | D19 (RX1) | BT → Mega receive |
| RX | D18 (TX1) | Mega → BT send — **wire direct (default)**. 5V into the HC-06's 3.3V RX is out of spec but the module tolerates it; modules survive it for years. If it acts flaky, drop in a 1kΩ series resistor (or 1kΩ + 2kΩ divider) to get 3.3V. |
| STATE | D27 | Connection status — HIGH when paired |
| EN/KEY | D28 | Enable / AT-command mode (firmware holds LOW for normal operation) |

HC-06 is slave-only, no AT commands needed. Pairs as serial port on PC (/dev/cu.HC-06-SPP or similar).

### Camera (ESP32-CAM) — separate WiFi link, NOT through the Mega

The camera does **not** route through the Mega or HC-06: the Mega has no RAM to
buffer a frame (8KB) and HC-06's ~1–14 KB/s serial would take seconds per JPEG
and block the sensor stream. Instead the **ESP32-CAM (AI-Thinker, OV2640)**
streams over its **own WiFi** straight to the Mac, independent of the Mega.

- **No USB port** on the ESP32-CAM — flash it with a **CP2102 USB-TTL adapter**
  (or an ESP32-CAM-MB programmer shield). Flashing uses 3.3V TTL → no level
  shift needed for programming.
- **If the Mega is ever serial-linked to the ESP32 later:** Mega TX1 (5V) →
  ESP32 RX (3.3V, NOT 5V-tolerant) needs a level shift — 1kΩ+2kΩ divider or a
  4-channel logic level converter (BSS138). ESP32 TX → Mega RX wires direct.
  Not wired today.

Sourcing note: Electronica Caribe (Panama) stocks HC-06, ESP32-CAM, and the
CP2102, but **no standalone logic level converter** (checked full catalog) —
buy that elsewhere or use resistors.

## Mega Sensors

| Sensor | Measures | Interface |
|--------|----------|-----------|
| MQ-2 | Smoke/gas (LPG, propane, H2) | Analog A0 + digital D22 |
| DHT11/DHT22 | Temperature + humidity | Digital D42 |
| MPU6050 | Gyroscope (roll, pitch, yaw) | I2C (20/21) |
| HC-SR04 | Distance (ultrasonic) | TRIG A6, ECHO A5 |
| MQ-135 | Air quality (CO2, NH3, benzene) | Analog A1 + digital D26 |
| MAX9814/KY-038 | Microphone / sound level | Analog A2 |
| MQ-9 | CO + combustible gas (LPG, methane) | Analog A3 + digital D29 |

## Mega Libraries

| Library | For |
|---------|-----|
| DHT sensor library | DHT11/DHT22 |
| Adafruit Unified Sensor | Dependency |
| MPU6050_light | MPU6050 gyro |
| NewPing | HC-SR04 ultrasonic |
| MQUnifiedsensor | MQ-2 / MQ-135 gas |

## Mega Power

- Vin → battery 7–12V (or USB for dev)
- GND shared with Uno (required for Serial later)

---

## Uno — Pre‑Programmed Sequence

L293D Motor Shield stacked directly on Uno. Runs a hard‑coded movement demo:

1. Forward 2s
2. Stop 1s
3. Backward 2s
4. Stop 1s
5. Spin left 1.5s
6. Spin right 1.5s
7. Loop

### Uno Pinout (L293D Shield)

| Uno Pin | Function |
|---------|----------|
| D3 | PWM — M2 speed |
| D4 | 74HC595 CLOCK |
| D5 | PWM — M4 speed |
| D6 | PWM — M3 speed |
| D7 | 74HC595 ENABLE |
| D8 | 74HC595 DATA |
| D11 | PWM — M1 speed |
| D12 | 74HC595 LATCH |

### Motor Wiring (4WD Skid-Steer)

| Shield Terminal | Motor |
|----------------|-------|
| M1 | Left front |
| M2 | Left rear |
| M3 | Right front |
| M4 | Right rear |

### Uno Libraries

| Library | For |
|---------|-----|
| Adafruit Motor Shield library (AFMotor) | L293D shield |

### Uno Power

- Shield screw terminals → battery 6–12V
- Shield's 5V reg powers Uno logic
- GND shared with Mega

---

## Compile & Upload

### Mega
```
cd arduino-mega/main
arduino-cli compile
arduino-cli upload
```
Board: `arduino:avr:mega:cpu=atmega2560`, Port: `/dev/cu.usbserial-140`

### Uno
```
cd arduino-uno/main
arduino-cli compile --fqbn arduino:avr:uno
arduino-cli upload --port /dev/cu.usbserial-XXX
```

---

## Node.js Server (`server/`)

Receives Bluetooth data from Mega, serves real-time dashboard, sends to Cerebras AI for analysis.

### Setup

```bash
cd server
cp .env.example .env   # add your Cerebras API key
npm install
npm start
```

Opens at `http://localhost:3000`.

### Server Stack

| Component | Library |
|-----------|---------|
| Serial port | `serialport` — reads from HC-06 |
| Web server | `express` — serves dashboard |
| Real-time | `socket.io` — pushes sensor data to browser |
| AI | `openai` SDK with Cerebras base URL — analyzes environment |

### Cerebras

Configurable in `.env`:
```
CEREBRAS_API_KEY=your-cerebras-key-here
CEREBRAS_MODEL=gpt-oss-120b
```

Get a key at https://cloud.cerebras.ai (generous free tier).

---

## Project Structure
```
WRO2026/
├── advanced-project-context/
├── arduino-mega/             ← Mega: sensors + Bluetooth
│   ├── AGENTS.md
│   ├── README.md
│   ├── main/
│   │   ├── main.ino
│   │   ├── sensors.h/.cpp
│   │   └── sketch.yaml
│   └── ref-images/
├── arduino-uno/              ← Uno: motors only
│   ├── README.md
│   └── main/
│       ├── main.ino
│       ├── motors.h/.cpp
│       └── sketch.yaml
├── server/                   ← Node.js server
│   ├── package.json
│   ├── server.js
│   ├── public/
│   │   └── index.html
│   └── .env.example
├── cad/
├── step/
└── stls/
```
