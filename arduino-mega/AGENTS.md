# AGENTS — Blackout V1 (Presentation Phase)

## Architecture

Two independent Arduino boards, **no direct link yet**:

| Board | Role | Code | Notes |
|-------|------|------|-------|
| **Mega 2560** | Sensor hub — reads environment, sends data via Bluetooth + Serial USB | `arduino-mega/main/` | HC-06 Bluetooth on Serial1 |
| **Uno R3** | Motor controller — runs pre‑programmed movement sequence | `arduino-uno/main/` | Standalone demo sequence |

**Current flow:** Mega reads sensors → sends CSV over **Serial1 to HC-06 Bluetooth** + Serial USB for debug. Node.js server on PC receives BT data, serves dashboard, and sends to OpenRouter AI for area analysis.

**Later (Phase 2):** Mega Serial2/Serial3 for Uno communication for sensor‑driven navigation.

---

## Mega Pinout

| Mega Pin | Sensor / Module | Function |
|----------|-----------------|----------|
| A0 | MQ-2 (smoke) | Analog read |
| D22 | MQ-2 | Digital out |
| D23 | DHT11/DHT22 | Temp + humidity signal |
| 20 (SDA) | MPU6050 | I2C data |
| 21 (SCL) | MPU6050 | I2C clock |
| D24 | HC-SR04 | TRIG |
| D25 | HC-SR04 | ECHO |
| A1 | MQ-135 (air quality) | Analog read |
| D26 | MQ-135 | Digital out |
| A2 | Microphone (MAX9814/KY-038) | Analog |
| D18 (TX1) | → HC-06 RX | Bluetooth TX (Mega → BT) |
| D19 (RX1) | ← HC-06 TX | Bluetooth RX (BT → Mega) |

### HC-06 Bluetooth Wiring

| HC-06 Pin | Mega Pin | Notes |
|-----------|----------|-------|
| VCC | 5V | |
| GND | GND | |
| TX | D19 (RX1) | BT → Mega receive |
| RX | D18 (TX1) | Mega → BT send — use voltage divider (1kΩ + 2kΩ) or 1kΩ series resistor to drop 5V→3.3V |

HC-06 is slave-only, no AT commands needed. Pairs as serial port on PC (/dev/cu.HC-06-SPP or similar).

## Mega Sensors

| Sensor | Measures | Interface |
|--------|----------|-----------|
| MQ-2 | Smoke/gas (LPG, propane, H2) | Analog A0 + digital D22 |
| DHT11/DHT22 | Temperature + humidity | Digital D23 |
| MPU6050 | Gyroscope (roll, pitch, yaw) | I2C (20/21) |
| HC-SR04 | Distance (ultrasonic) | TRIG D24, ECHO D25 |
| MQ-135 | Air quality (CO2, NH3, benzene) | Analog A1 + digital D26 |
| MAX9814/KY-038 | Microphone / sound level | Analog A2 |

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

Receives Bluetooth data from Mega, serves real-time dashboard, sends to OpenRouter AI for analysis.

### Setup

```bash
cd server
cp .env.example .env   # add your OpenRouter API key
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
| AI | `openai` SDK with OpenRouter base URL — analyzes environment |

### OpenRouter

Configurable in `.env`:
```
OPENROUTER_API_KEY=sk-or-v1-xxx
OPENROUTER_MODEL=openai/gpt-4o-mini  # any OpenRouter model
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
```

Free/cheap models: `google/gemini-2.0-flash-lite`, `meta-llama/llama-3.2-3b-instruct`, `mistralai/mistral-7b-instruct`.

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
