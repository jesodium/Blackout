# AGENTS — Shared Project Context

Read this first. Single source of truth for project context.

## Doc Rules

- README.md → detailed codebase docs (lots of tokens)
- AGENTS.md → crucial codebase context (pinout, wiring, logic)

## Architecture

Two independent Arduino boards connected via **Serial UART**:

| Board | Role | Code Location | Serial Link |
|-------|------|---------------|-------------|
| **Mega 2560** | Sensor hub — reads environment | `arduino-mega-code/main/` | TX1(D18)→Uno RX, RX1(D19)←Uno TX |
| **Uno R3** | Motor controller — drives L293D shield | `arduino-uno-code/main/` (planning) | RX(D0)←Mega TX1, TX(D1)→Mega RX1 |

**Data flow:** Mega polls sensors each cycle → prints structured string to Serial1 → Uno reads Serial → parses → drives motors.

---

## Section A: Arduino Mega — Sensors

### Mega Pinout

| Mega Pin | Sensor | Function |
|----------|--------|----------|
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
| D18 (TX1) | → Uno RX (D0) | Serial TX to Uno |
| D19 (RX1) | ← Uno TX (D1) | Serial RX from Uno |

### Mega Libraries

| Library | For | Author |
|---------|-----|--------|
| `DHT sensor library` | DHT11/DHT22 | Adafruit |
| `Adafruit Unified Sensor` | Dependency | Adafruit |
| `MPU6050_light` | MPU6050 gyro | ejoyneering |
| `NewPing` | HC-SR04 ultrasonic | Tim Eckel |
| `MQUnifiedsensor` | MQ-2 / MQ-135 gas | Miguel A. Califa |

### Mega Power

- Vin pin → battery 7–12V, or
- USB during development
- GND shared with Uno (required for Serial)

---

## Section B: Arduino Uno — Motors

### L293D Motor Shield → Uno Wiring

**Stack shield directly on Uno.** Shield occupies D4–D13 and A0–A5.

### Pinout (L293D Shield → Uno Pins)

| Uno Pin | Function | Notes |
|---------|----------|-------|
| D3 | PWM — M2 speed | |
| D4 | 74HC595 CLOCK | Shift register |
| D5 | PWM — M4 speed | |
| D6 | PWM — M3 speed | |
| D7 | 74HC595 ENABLE | Shift register |
| D8 | 74HC595 DATA | Shift register |
| D9 | Servo header 1 | Optional |
| D10 | Servo header 2 | Optional |
| D11 | PWM — M1 speed | |
| D12 | 74HC595 LATCH | Shift register |
| D13 | Physically blocked | Unused by shield |
| A0–A5 | Physically blocked | Pass-through, free |

### Motor Connections (4WD skid-steer)

| Shield Terminal | Motor |
|----------------|-------|
| M1 | Left front |
| M2 | Left rear |
| M3 | Right front |
| M4 | Right rear |

### Control (AFMotor library)

```cpp
AF_DCMotor motorL1(1);  // M1 — left front
motorL1.setSpeed(200);
motorL1.run(FORWARD);
```

### Uno Libraries

| Library | For | Author |
|---------|-----|--------|
| `Adafruit Motor Shield library` (AFMotor) | L293D shield | Adafruit |

### Uno Power

- Vin pin (from L293D shield screw terminals) → battery 6–12V
- Shield's 5V reg powers Uno logic
- GND shared with Mega (required for Serial)

---

## Section C: Serial Protocol

### Wiring

```
Mega TX1 (D18) ──── Uno RX (D0)
Mega RX1 (D19) ──── Uno TX (D1)
Mega GND       ──── Uno GND
```

### Format

Mega sends one line per cycle, comma-separated, prefix-identified:

```
S:<temp>,<humid>,<dist_cm>,<smoke_analog>,<airq_analog>,<roll>,<pitch>,<yaw>
```

Example:
```
S:25.3,60.1,45.2,120,85,0.5,-1.2,3.1
```

Uno can reply with status or acknowledgment (optional). Mega ignores if not needed.

### Code Pattern

**Mega sends:**
```cpp
Serial1.print("S:");
Serial1.print(temperature); Serial1.print(",");
Serial1.print(humidity);    Serial1.print(",");
Serial1.print(distance);    Serial1.print(",");
Serial1.print(smoke);       Serial1.print(",");
Serial1.print(airQuality);  Serial1.print(",");
Serial1.print(roll);        Serial1.print(",");
Serial1.print(pitch);       Serial1.print(",");
Serial1.println(yaw);
```

**Uno receives:**
```cpp
if (Serial.available()) {
  String line = Serial.readStringUntil('\n');
  if (line.startsWith("S:")) {
    // parse comma-separated values after "S:"
    // → setMotors based on sensor data
  }
}
```

---

## Compile & Upload

### Mega

```
cd arduino-mega-code/main
arduino-cli compile
arduino-cli upload
```

Board: `arduino:avr:mega:cpu=atmega2560`. Port: `/dev/cu.usbserial-140`. Config in `sketch.yaml`.

### Uno

```
cd arduino-uno-code/main
arduino-cli compile --fqbn arduino:avr:uno
arduino-cli upload --port /dev/cu.usbserial-XXX
```

---

## Project Structure

```
WRO2026/
├── advanced-project-context/
├── arduino-mega-code/       ← Mega: sensors only
│   ├── AGENTS.md
│   ├── README.md
│   ├── main/
│   │   ├── main.ino
│   │   ├── sensors.h/.cpp   ← DHT, MPU6050, HC-SR04, MQ-2, MQ-135
│   │   └── sketch.yaml
│   └── ref-images/
├── arduino-uno-code/        ← Uno: motors only  (TODO: create)
│   └── main/
│       ├── main.ino
│       ├── motors.h/.cpp    ← L293D motor control (AFMotor)
│       └── sketch.yaml
├── cad/
├── step/
└── stls/
```

## Reference Images

See `arduino-mega-code/ref-images/` for L293D shield photos: pinout, wiring, power, motor connections.
