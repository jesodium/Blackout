# AGENTS — Blackout V1 (Presentation Phase)

## Current Status

**Done**
- Mega firmware: DHT11, HC-SR04, MQ-2 (smoke), MQ-135 (air quality), MQ-9 (CO),
  MPU6050 gyro. CSV out: `S:temp,humid,dist,smoke,airq,roll,pitch,yaw,co,co_alert`
- ESP32 BT relay sketch (UART0 → BluetoothSerial "BLACKOUT-V1"). No WiFi, no camera.
- ESP32 camera test (OV2640 MJPEG @ QVGA) confirmed working — dev-only, not in comp.
- Server: BT serial read, dashboard (React/htm, Three.js rover, gauges, trends),
  Cerebras AI analysis, TTS, voice chat.
- Uno firmware: L293D shield, 4WD skid-steer demo sequence.

**Blocked**
- Resistors not yet obtained — need 1kΩ + 2kΩ (or logic level converter) before
  Mega→ESP32 wiring is safe. GPIO3 is NOT 5V-tolerant; direct wire fries it.
- Boot loop on BT sketches after full flash erase — root cause unclear (suspected
  brownout/NVS). Workaround: power cycle after flash.

**Todo**
1. [BLOCKED] Wire Mega → voltage divider → ESP32, test full chain to server.
2. Finish MQ-9 CO calibration (`TODO.md`) — currently auto-cals every boot,
   should use hardcoded R₀.
3. Final wiring: 1000µF cap across ESP32 5V/GND, battery power.

**Gotchas**
- HC-06 is dead (fried UART pins) — not reusable.
- Server reads `/dev/cu.BLACKOUT-V1` (NOT `-SPP`).
- AI/TTS features are optional (env-gated); dashboard works without them.

---

## Architecture

| Board | Role | Code | Notes |
|-------|------|------|-------|
| **Mega 2560** | Sensor hub — reads environment, sends CSV over Serial3 | `arduino-mega/main/` | Mega TX3 (D14) → voltage divider → ESP32 GPIO16 |
| **ESP32-WROOM** | Bluetooth serial relay (NodeMCU-32S) | `arduino-mega/esp-32-extension/` | Reads Mega on Serial2 (GPIO16), forwards over BT as "BLACKOUT-V1" |
| **Uno R3** | Motor controller — runs pre‑programmed sequence | `arduino-uno/main/` | Standalone demo |

**Current flow:** Mega reads sensors → sends CSV over Serial3 (D14) → voltage divider
→ ESP32 GPIO16 (Serial2/RX2). ESP32 forwards over Bluetooth SPP to the Mac. Node server
reads the BT serial port (`/dev/cu.BLACKOUT-V1`) and serves the dashboard. USB UART0
stays free for debug.

**Power:** Mega Vin → battery 7-12V. Mega 5V pin powers the ESP32. Motor battery
(4xAA/6V) powers Uno + motors via L293D shield.

**Phase 2:** Mega Serial2/Serial3 for Uno communication for sensor‑driven navigation.

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
| D14 (TX3) | → ESP32 GPIO16 (via voltage divider) | Mega serial TX to ESP32 Serial2 |
| D0 (RX0) / D1 (TX0) | USB ↔ PC | Wired serial link / debug |
| 5V | → ESP32 5V (VIN) | Powers ESP32 from Mega's Vin regulator |
| GND | → ESP32 GND | Common ground |

### Mega → ESP32 Wiring

| Mega | | ESP32 (NodeMCU-32S) |
|------|-|-----------|
| D14 (TX3) | 1kΩ → node → 2kΩ → GND | node → GPIO16 (RX2) |
| 5V | wire direct | VIN (5V) pin |
| GND | wire direct | GND pin |

Add **1000µF electrolytic cap** across ESP32 5V/GND (striped leg = GND).

**Voltage divider:** drops Mega TX3 5V to ~3.3V (5 × 2k / (1k+2k) = 3.33V).
ESP32 GPIO is NOT 5V-tolerant — do NOT wire D14 direct.

### ESP32-WROOM — Bluetooth serial relay

The **ESP32-WROOM (NodeMCU-32S)** reads Mega CSV on **Serial2 (GPIO16 @ 9600)** and
forwards over **Bluetooth Classic SPP** as **"BLACKOUT-V1"**. USB UART0 is left free,
so it can stay plugged in for debug while wired to the Mega.

- **Flash over USB** — onboard CP2102, no shield/jumpers needed.
- **Mega link on Serial2**, independent of the USB/flash UART — no contention.
- On the Mac, pair with "BLACKOUT-V1" — port is `/dev/cu.BLACKOUT-V1`.

### Power

Mega Vin → battery 7-12V (or USB for dev). Mega's onboard regulator (~1A) handles
both Mega (~200mA) + ESP32-CAM (~300mA). The 500mA USB polyfuse only applies when
on USB — use Vin (battery) for competition.

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
Board: `arduino:avr:mega:cpu=atmega2560`, Port: `/dev/cu.usbserial-XXX`

### ESP32-WROOM
```
cd arduino-mega/esp-32-extension
arduino-cli compile --fqbn esp32:esp32:esp32
arduino-cli upload --port /dev/cu.usbserial-XXX --fqbn esp32:esp32:esp32
```
Flash over USB (onboard CP2102). Mega link is on Serial2 (GPIO16), separate from the
USB/flash UART, so no need to unwire to reflash.

---

## Node.js Server (`server/`)

Receives sensor data from the ESP32 Bluetooth serial port, serves real-time dashboard, sends to Cerebras AI for analysis.

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
| Bluetooth serial | `serialport` — reads from `/dev/cu.BLACKOUT-V1` |
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
├── arduino-mega/             ← Mega: sensors + Serial3 → ESP32
│   ├── AGENTS.md
│   ├── README.md
│   ├── main/
│   │   ├── main.ino
│   │   └── sketch.yaml
│   ├── esp-32-extension/  ← ESP32-WROOM: BT serial relay
│   │   └── esp-32-extension.ino
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
