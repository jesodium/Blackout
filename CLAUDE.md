# WRO 2026 — Blackout V1

WRO 2026 robot project. Single Nano RP2040 Connect (sensor hub, BLE) plus a
Node.js PC server/dashboard.

## Layout

- `nano-rp2040/` — Nano RP2040 Connect (`main/`): active sensor hub. Reads
  sensors, broadcasts CSV over BLE notify (via the onboard u-blox NINA module,
  same ArduinoBLE API). MQ-9 (CO/gas, analog A3 + digital D13), HC-SR04
  (ultrasonic, D11/D12), BME280 (temp/humidity, I2C SDA/SCL, addr 0x76/0x77).
  Ported from the R4 build. IMPORTANT: 3.3V board — BME280 + L298N logic are
  fine, but HC-SR04 echo and MQ-9 AO are 5V and need resistor dividers before
  wiring. NINA needs BLE-capable firmware (flash with arduino-fwuploader if
  `BLE.begin()` fails). More sensors land here as pins are assigned.
- `arduino-uno-r4/` — retired Uno R4 WiFi build (`main/`). Original 5V sensor
  hub; board died (MCU fault). Kept for porting reference only, not the current
  build.
- `esp32-cam/` — ESP32-CAM (AI-Thinker) (`main/`): standalone MJPEG streamer
  on its own WiFi + power. Never touches the sensor-hub/BLE path; the dashboard
  `<img>` pulls `http://blackout-cam.local/stream` directly.
- `server/` — Node.js: dashboard, Cerebras AI analysis. BLE is read directly
  by the browser (Web Bluetooth) and forwarded to `/api/mega/sensor`.
- `OUTDATED/` — retired Mega 2560 + Uno R3 two-board setup, kept only for
  porting reference. Not part of the current build.
- `cad/`, `step/` — mechanical
