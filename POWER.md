> **OUTDATED** — written for the retired Mega 2560 + ESP32 + Uno R3 setup
> (now in `OUTDATED/`). Kept for reference; needs a rewrite for the single
> Uno R4 WiFi + whatever motor driver comes back.

# Power — Blackout V1

## Core principle

**Motors off the logic supply.** Motors surge/spike on start/stall — browns out
sensitive boards. Isolate: brains from power bank (or Mega Vin), motors from
separate battery.

## Layout

```
Mega Vin → battery 7-12V (or USB for dev)
 └─ Mega 5V pin → ESP32-CAM 5V pin (+ 1000µF cap at ESP32 5V/GND)

Motor battery (4xAA / 6V pack)
 └─ screw terminals → L293D shield → motors + Uno (PWR jumper ON)

GND common across all boards (required for serial links).
```

**Only two power sources needed:**
1. Mega battery (7-12V) — powers Mega + ESP32-CAM
2. Motor battery (4xAA/6V) — powers Uno + motors via shield

## Why this works

- Mega's onboard regulator handles ~1A on Vin (7-12V). Mega ~200mA + ESP32
  ~300mA = well under 1A. The 500mA USB polyfuse limit only applies when
  powered via USB — Vin bypasses it.
- 1000µF cap at ESP32 5V/GND absorbs WiFi/BT current spikes (~700mA bursts).
  Without it the shared rail can sag and reset the Mega.
- USB-only dev: the 500mA polyfuse might brown out if ESP32 spikes while
  motors also surge. Use Vin (battery) for reliable comp operation.

## Per-board power input

| Board | Powered by | Connector | Notes |
|-------|-----------|-----------|-------|
| **Mega 2560** | Battery 7-12V | Vin pin (or USB for dev) | Regulator handles ~1A |
| **ESP32-CAM** | Mega 5V pin | 5V pin on programming header | Add 1000µF cap at ESP32 5V/GND |
| **Uno R3** | Motor shield | via L293D (PWR jumper ON) | Not on the Mega battery |
| **Motors** | Motor battery | Shield screw terminals | 4xAA / 6V pack |

## L293D PWR jumper

- **Jumper ON** (current setup) → motor battery feeds Uno's Vin via shield.
  Simpler, but motor surges share Uno's rail.
- **Jumper OFF** → motor power and Uno logic separated. Use if Uno resets
  when motors kick.

## Shopping list

- 1x battery 7-12V for Mega (2-cell LiPo or 8xAA holder)
- 1x motor battery (4xAA holder)
- 1x 1000µF electrolytic capacitor (at ESP32 5V/GND)
