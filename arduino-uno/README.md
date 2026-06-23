# Arduino Uno — Motor Controller (Blackout V1)

Drives 4WD skid-steer via L293D Motor Shield. Runs a pre‑programmed movement sequence for the first presentation.

**Phase 1 — standalone demo.** Serial communication from Mega will be added later for sensor‑driven navigation.

## Hardware

- **Board:** Arduino Uno R3
- **Shield:** L293D Motor Shield (stacked directly)
- **Motors:** 4× DC, 4WD skid-steer

## Motor Wiring

| Shield Terminal | Motor |
|----------------|-------|
| M1 | Left front |
| M2 | Left rear |
| M3 | Right front |
| M4 | Right rear |

## Pre‑Programmed Sequence

1. Forward 2s
2. Stop 1s
3. Backward 2s
4. Stop 1s
5. Spin left 1.5s
6. Spin right 1.5s
7. Loop

## Control (AFMotor)

```cpp
AF_DCMotor motorFL(1);  // M1 = front left
motorFL.setSpeed(200);
motorFL.run(FORWARD);
```

## Libraries

- Adafruit Motor Shield library (AFMotor)

## Power

- Shield screw terminals → 6–12V battery
- Shield's 5V reg powers Uno logic
- GND shared with Mega
