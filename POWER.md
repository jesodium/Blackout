# Power — Blackout V1

Whole-robot power wiring. Goal: **simplest reliable setup, no buck converters.**

Core principle: **keep noisy motors off the logic supply.** Motors surge and
spike when they start/stall, which browns out sensitive boards (resets the Uno,
reboots the ESP32-CAM). The fix is isolation, not regulation — give the brains
clean regulated 5V and give the motors their own pack.

## Layout

```
  5V USB POWER BANK (3 ports, or 2 + a splitter, >=2A)
   |-- USB ----> MEGA      (USB port)
   |-- 5V -----> ESP32     (5V pin / USB, + 1000uF cap)

  Motor battery (4xAA / 6V pack)
   |-- screw terminals ----> L293D shield ----> motors + UNO   <- PWR JUMPER ON

  -- GND stays common (the shield ties motor GND <-> Uno GND on-board) --
```

Only **two** things need the power bank: the **Mega** and the **ESP32** link board.
The **Uno rides on the motor shield** (PWR jumper on, motor battery feeds the Uno's
Vin) — see the jumper section for the tradeoff.

## Why a power bank (and no buck converter)

A 5V USB power bank already outputs **regulated 5V** — exactly what the ESP32 and
the Mega's logic want. No DC-DC converter needed. One 2-port bank runs both easily
(Mega ~200mA + ESP32 ~300mA peak, well under 2A).

The "one battery for all 3" idea is what *forces* a buck converter: motors want
7.4V, the ESP32 wants 5V, so you'd have to convert **and** isolate. Splitting into
"power bank for the brains, cheap pack for the motors" removes the buck entirely.
Two dumb power sources beat one battery + converter.

## Per-board power input

| Board | Powered by | Connector | Notes |
|-------|-----------|-----------|-------|
| **Mega 2560** | Power bank | USB-B cable | Just a cable, no barrel jack |
| **ESP32 (link)** | Power bank | 5V pin / USB | 3.3V logic board, onboard reg accepts 5V. Add a 1000uF cap at 5V/GND for spike insurance |
| **Uno R3** | Motor shield | via L293D | Powered through the shield (PWR jumper on) — **not** on the power bank |
| **Motors (L293D)** | Motor battery | Shield screw terminals | 4xAA / 6V pack |

## The L293D PWR jumper

The shield has a **PWR jumper** by the screw terminals:

- **Jumper ON** (current setup) → motor battery voltage backfeeds the Uno's Vin,
  so the shield powers the Uno. Simpler — one less thing on the power bank. **But**
  motor surges share the Uno's rail → can cause random resets/glitches if the
  motors are big or the battery sags.
- **Jumper OFF** → motor power and Uno logic separated; power the Uno on its own
  (USB from the bank). Use this **if the Uno starts resetting** when motors kick.

The classic L293D shield has **no onboard 5V regulator** — with the jumper on it
just passes motor voltage to the Uno's Vin and the Uno's own regulator makes 5V.

Ground stays common because the shield ties motor GND and Uno GND together
on-board. Common ground is required for the serial links anyway.

## Shopping list

- 1x 5V USB power bank, 2 ports, >=2A — likely already own one
- 1x small motor battery (4xAA holder is fine)
- 1x 1000uF capacitor at the ESP32 5V/GND (optional, cheap insurance)
