# BLACKOUT — WRO 2026 Future Innovators

Team Blackout (Carlos Jaramillo, Dylan Crespo, Ricardo Gaudiano), I.B.C.M, Panama.
Qualified to the Puerto Rico 2026 final. The robot is **Blackout V4**: a
rover that helps archaeologists explore and document dig sites ("shaping
archaeology with robotics"). An AI copilot, **Sage**, sees through its camera and
talks to the operator.

One Arduino **Giga R1 WiFi** runs sensors, motors, arm and BLE. A **Node.js
server + dashboard** on the PC (also wrapped as an Electron app) drives it.

## Layout

```
firmware/giga/main/    the robot sketch: main.ino + one .h per section (one translation unit, include ORDER MATTERS)
firmware/giga/*        bench sketches: i2c_scan, motor_test, drive_loop
firmware/esp32-cam/    ESP32-CAM: MJPEG over wifi, or frames over USB serial
server/server.js       entry (Electron forks it); loads src/ and listens
server/src/            modules: link, telemetry, status, cam, vision, tts, data, clients, mcp, ...
server/src/sage/       Sage agent: parse, prompts, context, agent, analysis, routes, claude
server/public/         dashboard: js/app.js (<App/>), js/ui/ (one React file per screen area), js/control.js
server/prompts/        Sage's system prompts (chat, analysis, blk, present, demo, robot)
server/data/           arm_moves/, tapes/, workflows/ — what the crew records (one JSON/.blk per item)
server/test/           npm run test:<name>; tests read code via test/source.js, never by path
server/mcp.mjs         MCP stdio server so Claude can drive the rover
electron/              desktop shell (custom BLE picker, tunnel button)
scripts/               flash.sh, arm-configurator.sh, physics.sh, docs.sh
hardware/              cad/step (gitignored), pcb/hub_v1.5 (Giga shield), sim/ (MuJoCo)
archive/               retired Mega/Uno setups — reference only, not built
```

## Commands

```bash
./scripts/flash.sh                       # detects boards, compiles + uploads
cd server && npm install && npm start    # dashboard → http://localhost:3000
npm run app                              # Electron app (from server/)
npm test                                 # BLK self-check; other suites are npm run test:<name>
./scripts/arm-configurator.sh            # record arm takes over USB/BLE (:5006)
./scripts/physics.sh [--demo]            # MuJoCo rover + arm sim
```

Board FQBNs/ports live in `fluxus.yaml` (Giga `arduino:mbed_giga:giga`,
cam `esp32:esp32:esp32cam`). CI compiles the Giga sketch on firmware pushes.
Config is `server/.env` (see `.env.example`); the Electron app reads keys from
its userData settings instead.

## Git

- Work on **nightly**, merge to **main**. **website** branch holds only the
  landing page (GitHub Pages deploys from it); keep site code off nightly/main.
- Commit/push only when asked. **Never push commits containing session links.**
- Never commit API keys.

## Hardware (Giga R1)

Everything runs on **3V3** — Giga pins are not 5V tolerant (hence RCWL-1601, not HC-SR04).

| Part | Where |
|---|---|
| L298N, 4 motors | ENA D2, IN1 D3, IN2 D4, IN3 D5, IN4 D6, ENB D7 |
| RCWL-1601 sonar | TRIG D52, ECHO D50 |
| DHT11 | A5 |
| BME280 (pressure) | 0x76 on **Wire1** (SDA1 D102 / SCL1 D101) |
| SSD1306 OLED 128x64 | 0x3C on **Wire1**, 400kHz |
| BH1750 / GY-302 (lux) | 0x23 on **Wire2** (D9/D8) |
| PCA9685 servo driver | 0x40 on **Wire** (D20/D21) alone, OE on D32 |
| Relays (cam light, strip, spare) | D26, D28, D30 — **active LOW** |
| Buzzer | D72 |

- Three I2C buses are separate objects; a sensor only answers on its own
  (`bme.begin(0x76, &Wire1)` + `Wire1.begin()`). 0x60 on Wire1 is onboard junk.
- A8-A11 are ADC-only; using them as digital is a compile error. PWM only D2-D13.
- Dead I2C sensor: run `firmware/giga/i2c_scan/` first. Reversed VCC/GND pins
  both lines high and looks like everything except power.
- ESP32-CAM is separate (own power). Ships as `NET_NONE` = USB-cable-only; the
  server re-serves it at its own `/stream` `/capture` `/control`. 921600 baud.

## Arm — TBD

**Being reworked; to be discovered.** The new arm is a **MeArm**: 4 SG90
position servos (base, shoulder, elbow, gripper), modelled in `hardware/sim/`.
`arm.h`, the arm pad and `server/data/arm_moves/` still target the old 6-joint
360-servo arm, so treat them as legacy until the MeArm lands. Known so far:
PCA9685 at 0x40 on `Wire` alone, OE on D32, servo rail 5-6V (never 12V).

## Links

- **BLE**: board advertises **BLACKOUT-V3**; match on service UUID, not name.
  Browser (Web Bluetooth) holds the link and POSTs CSV to `/api/mega/sensor`.
- **USB**: same command strings over Serial at **9600**; every command needs a
  trailing `\n` (`usbWrite()` in `src/link.js`). One link at a time.
- Always drain the board's serial output — the 10Hz CSV fills the buffer and
  blocks `loop()`.
- `cu.usbmodem*` = Giga, `usbserial`/`wchusbserial` = ESP32-CAM.

## Firmware rules

- Nothing may block `loop()` longer than a BLE connection interval. BLE drops
  packets when `BLE.poll()` starves; call `blePump()` inside anything slow.
  Library `delay()`s count (that's why `dht.setDelay(0)` exists).
- Black box: `log,` dumps the event ring + last reset reason (works over USB too).
  Empty ring + brownout = power problem, not software.
- Sonar takes one ping per send, median of a ring buffer seeded to -1.
- Relay pins: write the level **before** `pinMode(OUTPUT)`. Same for PCA9685 OE.
- `noTone()` can leave an active buzzer on; `buzzSet()` parks the pin low.
- Routines (`routines.h`) are `Step` tables `{op, ms, pwm}`, ops
  `FWD BACK LEFT RIGHT WAIT ANALYZE END`, default pwm `SPEED_SLOW`, end with
  `{END, 0, 0}`, wire into `startRoutine()`. No arm op — arm/speech runs are tapes.

## Sage (AI)

- Brain: **Cerebras `qwen-3.8-27b`, paid**, only provider (`src/brain.js`). Needs
  image input + JSON replies. Empty balance = Sage off, no fallback. Other
  providers were tested and rejected (too slow or no vision) — don't redo it.
- TTS: Deepgram if keyed, else Edge neural voices.
- She calls tools via a `tool` field in her JSON (`agentLoop()`), bounded steps.
- She **suggests**, never drives: moves (BLK), arm takes and tapes show as cards
  the operator must approve. OPTIONS → SAGE MOVES / SAGE LAMP gate her.
- Proposed `forward` moves get a sonar guard (`guard()` in `blk.mjs`).
- **CLAUDE mode**: agent bar pill switches the chat to headless `claude -p` with
  `mcp.mjs` attached (`src/sage/claude.js`), default haiku + low effort,
  loopback only, panic key kills it.

## Dashboard

- Gamepad: sticks drive (`drv,tank,<l>,<r>`), d-pad navigates UI, VIEW = cursor mode.
- **Space = panic stop**, global, never gated.
- Mirror mode: LAN clients are read-only until the host grants them
  (`mirror`/`judge`/`full`). Electron has a TUNNEL button (cloudflared) for tablets.
- CONSOLE is read-only; all toggles live in OPTIONS (topbar gear).
- A sensor sending bare 0 = not wired (except `dist`, `alt`, `lux`). Telemetry
  older than 3s counts as none.
- Camera feed is read with `fetch` + `mjpegSplit`, never `<img src=stream>`.
  Only one `/stream` exists at a time. Sage borrows frames from the browser.
- Object detection: coco-ssd on tfjs, fully vendored.
- **The venue has no internet**: vendor everything, no CDNs, no emoji, icons are
  SVG masks (`public/icons/` + `.icn-<name>` in `style.css` and `blk.html`).
- Panes resize via `ui/split.js`; sizes per rig in localStorage.
- Strings go through `i18n.js` (English + Spanish).

## BLK (workflow language)

Plain text `.blk` in `server/data/workflows/`, `server/public/js/blk.mjs`.
Compiled and run **on the board** when possible (`blkvm.h`), else the browser
interprets it. A new language feature must land in all five: parse+serialize,
`NODE_META`, interpreter, `compile`, `prompts/blk.md`. `npm test` checks
the board VM mirror against the interpreter.

## Tapes

Whole runs replayed from the PC (`server/data/tapes/<name>.json`, same `{ms, cmd}`
shape as arm takes). `@` steps are PC-only: `@say`, `@sage <cue>`, `@present`,
`@analyze`, `@tape`, `@under`, `@log`, `@led`. Language variants: `@say.es`.
Write `@sage` cues as sentences fine to hear verbatim (offline fallback).
Phrases like "present yourself" trigger tapes directly (`ui/commands.js`).

## MCP

`server/mcp.mjs` (`claude mcp add blackout -- node "<repo>/server/mcp.mjs"`):
`robot_status`, `robot_camera`, `robot_command`, `robot_blk`, `robot_mission`,
`sage_chat`. Thin client of the running server — `npm start` first; BLK runs
need a dashboard open.

## Conventions

- Match surrounding style; terse comments explain *why*.
- Hardware values (neutrals, holds, pwm) are measured on the bench, never guessed.
- Dated notes in code (`2026-09-05`) record why something is the way it is — read them before undoing it.
