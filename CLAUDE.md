# WRO 2026 — Blackout V1

WRO 2026 robot project. Two independent Arduino boards (Mega 2560 sensor hub +
Uno R3 motor controller) plus a Node.js PC server/dashboard.

## Read this first

- **`arduino-mega/AGENTS.md`** — architecture, full Mega pinout, wiring, and code
  layout (Mega + Uno + server). The canonical reference for this robot.

## Layout

- `arduino-mega/` — Mega 2560 sensor hub (`main/`), HC-06 Bluetooth on Serial1
- `arduino-uno/` — Uno R3 motor controller (`main/`), standalone movement demo
- `server/` — Node.js: receives Bluetooth data, serves dashboard, OpenRouter AI analysis
- `cad/`, `step/` — mechanical
