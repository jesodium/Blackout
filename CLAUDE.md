# WRO 2026 — Blackout V1

WRO 2026 robot project. Single Arduino Uno R4 WiFi (sensor hub, BLE) plus a
Node.js PC server/dashboard.

## Layout

- `arduino-uno-r4/` — Uno R4 WiFi (`main/`): reads sensors, broadcasts CSV
  over BLE notify. DHT11 (temp/humidity, data D2), HC-SR04 (ultrasonic,
  D11/D12) wired so far. CSV still carries the full field set
  (temp,humid,dist,smoke,airq,roll,pitch,yaw,co,co_alert,pressure); unwired
  fields send 0. More sensors land here as pins are assigned.
- `esp32-cam/` — ESP32-CAM (AI-Thinker) (`main/`): standalone MJPEG streamer
  on its own WiFi + power. Never touches the Uno/BLE path; the dashboard
  `<img>` pulls `http://blackout-cam.local/stream` directly.
- `server/` — Node.js: dashboard, Cerebras AI analysis. BLE is read directly
  by the browser (Web Bluetooth) and forwarded to `/api/mega/sensor`.
- `OUTDATED/` — retired Mega 2560 + Uno R3 two-board setup, kept only for
  porting reference. Not part of the current build.
- `cad/`, `step/` — mechanical

## Dictated routines

When the user narrates a new motion routine step by step ("go forward once,
back up, rotate, turn 360°, ...") for `arduino-uno-r4/main/routines.h`,
they're recording a `Step` sequence, not asking for a fresh design — transcribe
each spoken step into `{op, ms, pwm}` in order using the file's own
conventions:

- Op names as defined there: `FWD BACK LEFT RIGHT WAIT ANALYZE END`.
- `pwm` = `SPEED_SLOW` unless the user names a different speed — don't invent
  a new duty-cycle constant.
- `ms` follows the existing routines' scale (`TEST`/`PRESENTATION`: mostly
  600-800ms moves, 400ms turns) unless the user gives a duration or a turn
  amount (e.g. "360°") that implies one — flag when a spoken duration/angle
  needs bench tuning per the file's open-loop note.
- Always close with `{END, 0, 0}`.
- Add/update the table, then wire it into `startRoutine()` in `main.ino` and
  (if it's a new named routine, not an edit to `RUN`) a dashboard button, per
  the file's own "Adding a routine" note.
