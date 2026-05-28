# WRO 2026 — Arduino Mega 2560 Rover

Exploration rover for hazardous environments. Navigates unstable structures, caves, and areas with toxic gases. Collects environmental data to assess safety for human entry.

## Microcontroller

- **Board:** Arduino Mega 2560
- **All sketches in `main/`**

## Sensors & Components

| Component | Function |
|-----------|----------|
| Smoke sensor | Detect smoke / combustion |
| Humidity sensor | Measure ambient humidity |
| Temperature sensor | Measure ambient temperature |
| Gyroscope | Orientation / heading |
| Ultrasonic sensor | Obstacle detection / distance |
| Air quality sensor | Detect toxic gases / air quality |
| Camera | Visual feed of environment |
| Microphone | Audio capture |
| Solar panels | Supplementary power |
| DC motors (x2) | Differential drive |
| L298N motor driver | Motor control |

## Core Functions

- **Localize** — Determine position in environment
- **Map** — Build spatial model of explored area
- **Detect** — Identify smoke, humidity, temperature, air quality hazards

## Power

```
Battery (7-12V) ── L298N 12V in
                ── L298N GND ── Arduino GND + Battery GND
Jumper ON       ── Enables L298N onboard 5V regulator
```

## L298N → Arduino Mega Wiring

```
MOTOR A (LEFT)              MOTOR B (RIGHT)
─────────────                ──────────────
IN1 ─── D8                   IN3 ─── D11
IN2 ─── D9                   IN4 ─── D12
ENA ─── D10 (PWM~)           ENB ─── D13 (PWM~)

OUT1/OUT2 ── DC Motor A      OUT3/OUT4 ── DC Motor B
```

## Motor Control Logic

| IN1/IN3 | IN2/IN4 | ENA/ENB | State |
|---------|---------|---------|-------|
| LOW     | LOW     | PWM     | BRAKE |
| HIGH    | LOW     | PWM     | FORWARD |
| LOW     | HIGH    | PWM     | BACKWARD |
| HIGH    | HIGH    | PWM     | BRAKE |

PWM duty cycle (0–255) controls speed.

## Applications

- Archaeological site exploration
- Post-disaster structural assessment
- Cave / tunnel reconnaissance
- Hazardous environment pre-entry survey
- Mining safety inspection
