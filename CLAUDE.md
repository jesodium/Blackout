# WRO 2026 — Blackout V1

WRO 2026 robot project. Single Arduino Uno R4 WiFi (sensor hub, BLE) plus a
Node.js PC server/dashboard.

## Layout

- `arduino-uno-r4/` — Uno R4 WiFi (`main/`): reads sensors, broadcasts CSV
  over BLE notify. Only MQ-9 (CO/gas) wired so far — analog A3, digital D13.
  More sensors land here as pins are assigned.
- `esp32-cam/` — ESP32-CAM (AI-Thinker) (`main/`): standalone MJPEG streamer
  on its own WiFi + power. Never touches the Uno/BLE path; the dashboard
  `<img>` pulls `http://blackout-cam.local/stream` directly.
- `server/` — Node.js: dashboard, Cerebras AI analysis. BLE is read directly
  by the browser (Web Bluetooth) and forwarded to `/api/mega/sensor`.
- `OUTDATED/` — retired Mega 2560 + Uno R3 two-board setup, kept only for
  porting reference. Not part of the current build.
- `cad/`, `step/` — mechanical
