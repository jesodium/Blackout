# Arduino Uno — Motor Controller (Blackout V1)

Drives the two rear motors via an L298N dual H-bridge. Runs a pre‑programmed
forward/backward sequence for the first presentation.

**Phase 1 — standalone demo.** Serial communication from Mega will be added
later for sensor‑driven navigation.

> Migrated off the L293D stacking shield — it could not reverse the motors
> (dead 74HC595 direction latch, confirmed not a power issue: tested 6–12V).
> L298N is stronger (2A/ch) and won't brown out the Uno.

## Hardware

- **Board:** Arduino Uno R3
- **Driver:** L298N dual H-bridge (separate module, wired with jumpers)
- **Motors:** 2× rear DC motors (front wheels free-rolling). One motor per channel.

## Signal Wiring — Uno → L298N

| L298N pin | Uno pin | Purpose |
|-----------|---------|---------|
| ENA | 5  | Left speed (PWM) |
| IN1 | 9  | Left direction |
| IN2 | 4  | Left direction |
| IN3 | 10 | Right direction |
| IN4 | 13 | Right direction |
| ENB | 3  | Right speed (PWM) |

Pins 2 / 7 / 8 / 12 avoided — bad on this Uno.

## Motor Wiring

| L298N Output | Motor |
|--------------|-------|
| OUT1 / OUT2 | Rear left |
| OUT3 / OUT4 | Rear right |

## Power

```
Battery +  → L298N +12V terminal   (label only; takes 6–12V, battery is < 12V)
Battery −  → L298N GND terminal
L298N +5V  → Uno 5V pin             (onboard regulator powers the Uno)
L298N GND  → Uno GND                (common ground — required)
```

- Keep the **5V-EN jumper ON** — enables the onboard regulator that feeds +5V.
  Requires battery ≤ 12V.
- **ENA/ENB jumper caps:** leave ON = motors always enabled at full speed
  (skip ENA/ENB wiring). Pull OFF and wire pins 5/3 for PWM speed control.

## Flashing gotcha

Unplug the **L298N +5V → Uno 5V** wire (or switch the battery off) before
uploading over USB. Two 5V sources defeat the auto-reset → "programmer is not
responding". Reconnect +5V after flashing for battery-only running.

## Control (plain digitalWrite / analogWrite)

```cpp
digitalWrite(IN1, HIGH); digitalWrite(IN2, LOW);  // direction
analogWrite(ENA, 200);                             // speed 0–255
```

If a side spins the wrong way, flip its `INV_LEFT` / `INV_RIGHT` flag in
`main/main.ino` and re-upload — no rewiring.

## Pre‑Programmed Sequence

1. Forward 2s
2. Backward 2s
3. Loop
