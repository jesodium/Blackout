# WRO 2026 — Two-Board Rover

Exploration rover for hazardous environments. Navigates unstable structures, caves, and areas with toxic gases. Collects environmental data to assess safety for human entry.

## Architecture

Two Arduino boards connected via **Serial UART**:

```
┌──────────────────────┐    Serial     ┌──────────────────────┐
│  Arduino Mega 2560   │  TX1→RX      │   Arduino Uno R3     │
│  (Sensor hub)        │  RX←TX1      │  (Motor controller)  │
│                      │  GND─GND     │                      │
│  • DHT11/DHT22       │              │  • L293D Motor Shield│
│  • MPU6050 gyro      │              │  • 4× DC motors      │
│  • HC-SR04 ultrasonic│              │  • 4WD skid-steer    │
│  • MQ-2 smoke        │              │                      │
│  • MQ-135 air quality│              │                      │
│  • Microphone        │              │                      │
└──────────────────────┘              └──────────────────────┘
```

**Flow:** Mega reads sensors each cycle → sends comma-separated values over Serial1 to Uno → Uno parses and adjusts motors accordingly.

## Boards

| Role | Board | Sketch Location |
|------|-------|-----------------|
| Sensor hub | **Arduino Mega 2560** | `arduino-mega-code/main/` |
| Motor driver | **Arduino Uno R3** | `arduino-uno-code/main/` (planning) |

## Mega — Sensors

### Pinout

| Mega Pin | Sensor | Function |
|----------|--------|----------|
| A0 | MQ-2 (smoke) | Analog input |
| D22 | MQ-2 | Digital out / threshold |
| D23 | DHT11 / DHT22 | Data signal |
| 20 (SDA) | MPU6050 | I2C data |
| 21 (SCL) | MPU6050 | I2C clock |
| D24 | HC-SR04 | TRIG |
| D25 | HC-SR04 | ECHO |
| A1 | MQ-135 (air quality) | Analog input |
| D26 | MQ-135 | Digital out / threshold |
| A2 | Microphone (MAX9814 / KY-038) | Analog input |
| D18 (TX1) | → Uno RX | Serial TX |
| D19 (RX1) | ← Uno TX | Serial RX |

### Mega Libraries

| Library | For | Author |
|---------|-----|--------|
| `DHT sensor library` | DHT11/DHT22 | Adafruit |
| `Adafruit Unified Sensor` | Dependency | Adafruit |
| `MPU6050_light` | MPU6050 gyro | ejoyneering |
| `NewPing` | HC-SR04 ultrasonic | Tim Eckel |
| `MQUnifiedsensor` | MQ-2 / MQ-135 gas | Miguel A. Califa |

### Mega Compile / Upload

```
cd arduino-mega-code/main
arduino-cli compile
arduino-cli upload
```

Board: `arduino:avr:mega:cpu=atmega2560`. Port: `/dev/cu.usbserial-140`. Config in `sketch.yaml`.

---

## Uno — Motors

### L293D Motor Shield → Uno

**Stack shield directly on Uno.** Occupies D4–D13 + A0–A5.

### Pinout (L293D Shield → Uno)

| Uno Pin | Function |
|---------|----------|
| D3 | PWM — M2 speed |
| D4 | 74HC595 CLOCK |
| D5 | PWM — M4 speed |
| D6 | PWM — M3 speed |
| D7 | 74HC595 ENABLE |
| D8 | 74HC595 DATA |
| D9 | Servo header 1 (optional) |
| D10 | Servo header 2 (optional) |
| D11 | PWM — M1 speed |
| D12 | 74HC595 LATCH |
| D13 | Physically blocked |

### Motor Connections (4WD skid-steer)

| Shield Terminal | Motor |
|----------------|-------|
| M1 | Left front |
| M2 | Left rear |
| M3 | Right front |
| M4 | Right rear |

### Control (AFMotor)

```cpp
#include <AFMotor.h>

AF_DCMotor motorL1(1);  // M1 — left front
AF_DCMotor motorL2(2);  // M2 — left rear
AF_DCMotor motorR1(3);  // M3 — right front
AF_DCMotor motorR2(4);  // M4 — right rear

motorL1.setSpeed(200);
motorL1.run(FORWARD);
```

### Uno Libraries

| Library | For | Author |
|---------|-----|--------|
| `Adafruit Motor Shield library` (AFMotor) | L293D shield | Adafruit |

### Uno Compile / Upload

```
cd arduino-uno-code/main
arduino-cli compile --fqbn arduino:avr:uno
arduino-cli upload --port /dev/cu.usbserial-XXX
```

---

## Serial Communication

### Wiring

```
Mega TX1 (D18) ──── Uno RX (D0)
Mega RX1 (D19) ──── Uno TX (D1)
Mega GND       ──── Uno GND
```

Mega uses `Serial1` (hardware UART on D18/D19), leaving `Serial` (USB) free for debug.

### Protocol

Mega sends one CSV line per sensor cycle:

```
S:<temp>,<humid>,<dist_cm>,<smoke_analog>,<airq_analog>,<roll>,<pitch>,<yaw>
```

Example: `S:25.3,60.1,45.2,120,85,0.5,-1.2,3.1`

Uno reads, parses, drives motors. Optional: Uno can reply with status (Mega ignores).

### Code Snippets

**Mega send:**
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

**Uno receive:**
```cpp
if (Serial.available()) {
  String line = Serial.readStringUntil('\n');
  if (line.startsWith("S:")) {
    // parse values → control motors
  }
}
```

---

## Power

Each board powered independently. Common GND required for Serial.

| Board | Power Source |
|-------|-------------|
| Mega | Vin pin → battery 7–12V, or USB |
| Uno | Shield screw terminals → battery 6–12V (shield reg → Uno 5V) |

Both batteries share GND with each other.

---

## Bill of Materials

### Electronics

| Item | Qty | Notes |
|------|-----|-------|
| Arduino Mega 2560 | 1 | Sensor hub |
| Arduino Uno R3 | 1 | Motor controller |
| L293D Motor Shield | 1 | On Uno, drives 4 DC motors |
| DC motor (TT / N20) | 4 | 4WD skid-steer |
| MQ-2 smoke sensor | 1 | Analog + digital |
| DHT11 / DHT22 | 1 | Temp + humidity |
| MPU6050 gyroscope | 1 | I2C |
| HC-SR04 ultrasonic | 1 | Distance / obstacle |
| MQ-135 air quality | 1 | Analog + digital |
| Camera module | 1 | OV7670 or ESP32-CAM |
| Microphone module | 1 | MAX9814 / KY-038 |
| Solar panel (5V) | 1 | Supplementary |
| Battery (7–12V) x2 | 2 | One for each board |
| Jumper wires | ~40 | M-F + M-M |

### Mechanical

| Item | Qty | Notes |
|------|-----|-------|
| M3 bolts + nuts | ~20 | Frame assembly |
| Wheels | 2–4 | Rover wheels |
| Ball caster | 1 | Front/rear support |

---

## 3D-Printed Parts (`stls/`)

| File | Part | Qty |
|------|------|-----|
| `main_frame-MK2.STL` | Main chassis | 1 |
| `mid_frame-MK2.STL` | Mid chassis | 1 |
| `belly_frame-MK2.STL` | Belly plate | 1 |
| `brace_frame-MK2.STL` | Brace / support | 1 |
| `rockers-MK2.STL` | Rocker arm (suspension) | 2 |
| `climber wheel-MK2.STL` | Climbing wheel | 2–4 |
| `Pivot_cap-MK2.STL` | Pivot cap | 2 |

## CAD

- **Fusion 360 source:** `cad/Rover Model.f3d`
- **STEP archive:** `step/Rover Model.STEP`

## Applications

- Archaeological site exploration
- Post-disaster structural assessment
- Cave / tunnel reconnaissance
- Hazardous environment pre-entry survey
- Mining safety inspection
