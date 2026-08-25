# WRO 2026 — Blackout V1

WRO 2026 robot project. Single Arduino Giga R1 WiFi (sensor hub, BLE) plus a
Node.js PC server/dashboard.

## Layout

- `giga-r1/` — Giga R1 WiFi (`main/`): sensor hub + motor driver + BLE
  command endpoint, one board. Reads sensors, broadcasts CSV over BLE notify;
  DHT11 (temp/humidity, A6), BME280 (pressure, I2C on D20/D21 — its own
  temp/humidity registers go unread) and RCWL-1601 (ultrasonic, TRIG D50 /
  ECHO D52), plus GY-302/BH1750 (ambient light, 0x23 on
  its own I2C bus, Wire2 — SDA2 D9 / SCL2 D8; CSV field 12, and `lux` in BLK) wired so far, rest of the CSV
  field set sends 0 until a sensor lands.
  **Reversed VCC/GND on an I2C module pins both its lines high, it does not just
  go dead** (2026-08-25, cost a day on the gy-302): the chip's ESD clamps conduct
  from its "GND" pin out through SDA and SCL, holding them at 3V3 harder than the
  H747 can sink. Symptoms read as everything *but* power — both lines pass a
  pull-up check (they're *on* the rail, not pulled to it), every address NACKs on
  hardware I2C and bit-bang alike, and the board browns out off USB whenever
  something tries to pull a line down. The one test that finds it: `pinMode(pin,
  OUTPUT); digitalWrite(pin, LOW);` then read the pin back. A working line reads
  0; a line that reads 1 is tied to a rail, because nothing legal on an I2C bus
  beats a 25mA push-pull driver. `giga-r1/i2c_scan/` is that check, and it runs
  every probe on D20/D21 first as a positive control — "nothing" on the bus under
  test means nothing until the same code has found the bme at 0x76.
  **Every sensor runs off the 3V3 rail, not 5V** — the Giga's pins are 3.3V and
  not 5V tolerant, so the ultrasonic is an RCWL-1601 (3.3V-capable, HC-SR04
  drop-in) rather than an HC-SR04, and the dht11 is powered at 3V too. A 5V
  sensor here means a 5V signal into a 3.3V pin. Also drives an
  L298N (ENA D3, IN1 D2, IN2 D7, IN3 D6, IN4 D4, ENB D10 — pins follow the
  loom's wire colours, not connector order; D8 is SCL2, kept free for Wire2)
  and runs on-board `Step` motion routines
  (`routines.h`, see "Dictated routines" below) or direct gamepad/dashboard
  drive commands over the same BLE `cmdChar` — routines run standalone on
  the board so a BLE drop mid-run doesn't strand it. `motor_test/` is a
  bench-only sketch for wiring/direction checks, not part of the build.
  - **Screensavers** (see "Screensavers" below): the console can put a
    screensaver on the panel instead of the HUD. The board animates it; the
    link only carries which one, and a BLE drop turns it off.
  - **Servos hang off a PCA9685** (silkscreened **HW-170**), not off the board's
    own pins — I2C, address 0x40, 16 channels, so more servos cost no pins.
    **Its two power rails are not the same thing:** `VCC` is chip logic (5V from
    the board, ~10mA), `V+` is the servo rail and is **6V max** — the 12V pack
    goes through a buck to 5-6V before it ever reaches V+, or the servos and the
    board's protection diode are gone. **VCC on 3V3 is not "close enough"** —
    the chip half-powers, clamps SDA low, and the sketch blocks forever inside
    the first `Wire` transaction: the board goes silent from boot with USB still
    enumerated, which reads exactly like a bricked Arduino (2026-08-25, cost an
    afternoon). No serial banner at all, arm connected = check VCC first.
    The duplicated `V+`/`GND` pins on the
    opposite header are the *same nets*, there for daisy-chaining: feed V+ once,
    but do tie a GND to the board (common ground is what makes I2C work at all).
    `OE` is pulled low already; wire it only for a hardware all-channels-off kill.
    - **It drives a 5-DOF arm**: ch0 base, ch4 shoulder, ch6 elbow, ch8 wrist
      (all 360, continuous rotation) and ch15 gripper (SG90, positional 0-180).
      **A joint typed positional that is really a 360 never stops** — an angle
      maps to 500-2500us, which a 360 reads as full speed, and only continuous
      channels get the deadman. ch8 was mislabelled SG90 and ran away on the
      bench 2026-08-25; `t<ch>` first, and if it keeps turning it's a 360. The bench rig is `OUTDATED/pca_test/` (Uno R4) plus its
      `servo.py`, a flask page that is nothing but a serial pipe to
      it. Joint-to-channel mapping is unconfirmed for the 360s — `t<ch>` nudges
      one joint so you can watch which moves; the gripper landed 2026-08-25 and
      is on **ch15**, not ch11.
      **A 360 in an arm joint has no position feedback and no end stop**, so
      there is no "go to 45deg", only "move while the button is held": the
      continuous channels run on a 0.8s deadman (`JOG_MS`) that the browser
      refreshes every 300ms while held. That is also why the sketch has no
      demo mode — an unattended joint winds itself into the frame, which is
      exactly what happened the first time it ran.
      A 360 takes a *speed*, not an angle: ~1500us is stop, below is one way,
      above is the other, so `Servo.write(90)` logic does not apply. Every one
      of them creeps at its nominal neutral, so the neutral pulse is a
      per-servo bench knob (the `sv[]` table in the test sketch), not 1500 by
      definition — which is why the wire format is `<ch>:<val>` and the value
      means speed or angle depending on the channel's type, never both.
      **Neutral is measured per servo, never assumed** — ch0 (base) sits still
      at **1490us**, found on the bench 2026-08-24; shoulder and elbow are
      still on the nominal 1500 and will each want their own. The measured
      values live in the `sv[]` table so a reflash keeps them. A too-small
      swing around a wrong neutral is why a joint moves one way and not the
      other: the deadband is 100us+, so jog runs full-scale (1000-2000us).
      **Pulse width is speed and torque at once**, so a slow command is a weak
      one — at 35% the shoulder could not lift its own arm while gravity took
      it down fine (2026-08-25). Fine control on a loaded joint is a *shorter
      burst at full power*, never a gentler one; the bench page's two arrow
      sizes differ in duration only.
      **Hand control** (`OUTDATED/pca_test/hand.py`, opencv + mediapipe) drives
      the arm off a webcam: `python3 hand.py` next to a running `servo.py`,
      which it talks to over http so the two never fight over the serial port.
      Three held poses calibrate it (rest, open, pinch) into `hand_cal.json`.
      **Hand position is a velocity, not a pose** — four joints are 360s with no
      encoder, so "match my elbow" is unanswerable; the hand is a joystick, and
      only the gripper (sg90) maps absolutely, off pinch distance. No hand in
      frame = stop, because a frozen camera looks exactly like a hand held
      still. Needs **mediapipe 0.10.x**: 1.0.1's macOS arm64 build dies in
      DrishtiMetalHelper before the first frame, CPU delegate included.
      `python3 hand.py --selftest` checks the mapping without a camera.
      **Stopping a 360 means killing the pulse, not sending 1500us** — the
      PCA9685's full-off bit (`LEDn_OFF_H` bit 4), because a neutral pulse is
      still a command and an untrimmed 360 creeps on it forever. And the
      PCA9685 keeps driving its last registers while the Arduino reboots, so
      every reset must write full-off to all 16 channels before anything else.
- `esp32-cam/` — ESP32-CAM (AI-Thinker) (`main/`): standalone MJPEG streamer
  on its own WiFi + power. Never touches the Giga/BLE path; the dashboard
  `<img>` pulls `http://blackout-cam.local/stream` directly.
  - **Flash LED (GPIO 4) debug:** boot = slow blink (500ms), error (camera/WiFi
    fail) = rapid blink (100ms), connected = steady dim (PWM 32). Handled by
    `ledUpdate()` in `main.ino`, called from `loop()` every 50ms.
- `server/public/js/blk.mjs` — the BLK language (parser, serializer, evaluator,
  linter, interpreter). Text is the file format; `blkedit.js` + `blk.html` are
  the editor, `blksim.js` the offline rover simulator. See "BLK" below.
- `server/` — Node.js dashboard + "Sage" AI agent (Gemini, Cerebras as fallback
  — `BRAINS`/`chat()` in `server.js`: one openai-sdk client per keyed provider,
  tried in order, so a dead or rate-limited primary costs one retry, not the run).
  BLE is read directly by the browser (Web Bluetooth) and forwarded to
  `/api/mega/sensor`; gamepad input goes out the same way as dashboard
  drive commands. `sage.js` parses the model's JSON replies; `vision.js`
  grabs ESP32-CAM stills for Sage to see; TTS is Deepgram (if keyed) falling
  back to Edge neural voices; prompts live in `prompts/*.md`.
  - **Gamepad** is a first-class input, not a shortcut layer, and it splits in two:
    the **sticks drive**, the **d-pad drives the UI**. Left stick is an arcade mix
    (throttle + steering at once) and the right stick x is a slow on-the-spot pivot
    for lining up; both land on `drv,tank,<l>,<r>` — signed pwm per side, the one
    motion primitive the firmware keeps (`tank()` in `main.ino`, the four named verbs
    are its corners). Stick travel maps into `[MIN_PWM, cap]`: below that the L298N
    buzzes instead of turning, so both are bench knobs in `Drive`, not magic numbers.
    `padnav.mjs` owns the UI half — d-pad roams focus spatially, ✕ presses, ○ backs
    out of the top modal, OPTIONS opens the console. **VIEW/SHARE (button 8) flips to
    cursor mode:** a free pointer flown by the left stick (or d-pad), ✕ clicks whatever
    is under it, edges pan the page — for what focus can't reach (charts, the 3d view).
    While it's up Drive's loop parks itself (`cursorOn()`), so aiming can never drive
    by accident. It re-reads the dom on
    every move, so nothing needs registering; a modal just needs a close button to
    be backed out of. FPV and the first-run tour take the pad back while they're up
    (they bind the same buttons). `npm run test:padnav` covers the mix and the
    roaming maths and cross-checks the constants against `main.ino`.
  - **Icons** are files — `public/icons/<name>.svg` — used as a css **mask**
    (`.icn .icn-<name>`), never an `<img>`: masked, they take `currentColor` and
    the font size of whatever they sit in, so the same file is amber in a
    warning and white in a button. Using one is just a class
    (`<i class="icn icn-warn">`); `icons.mjs` holds the name list plus `icon()`
    / `prefixIcon()` for js callers and `Icon` in `app.js` for jsx. **No emoji,
    no icon font, no cdn** — an emoji is a different picture on every machine
    and the venue has no internet. The terminal glyphs (`✕ ● ○ △ ▶ ■`) are
    *not* emoji and stay as text: on the gamepad they *are* the button faces.
    An icon is three things that must line up — the name, the svg, and the
    `.icn-<name>` rule in **both** `style.css` and `blk.html`'s own `<style>`
    (miss one and it renders as an empty box); `npm run test:icons` is the
    check, and it also fails on any emoji added back.
  - **Sage's face** (`public/js/sageface.js`) is ascii (`-_-`, `o_o`, `x_x`)
    animated in css — each eye is an open glyph with a shut `-` stacked on it and
    the blink is a step-timed opacity swap, so it snaps like text.
    The moods are `MOODS` in that file; all the motion is
    `.sage-face.is-<mood>` in `style.css` (an intent key *is* the mood name).
    Adding a mood without its css rule renders a blank face silently —
    `npm run test:face` is the check.
  - **Mirror mode:** the dashboard opened over the LAN (the judges' tablet) is
    telemetry only — no link controls, no firmware updater, no drive — until the
    host grants it from CONNECTED DEVICES in the topbar. The host is whoever
    loaded it over loopback, and the server decides that from the socket's
    address, so a granted client is enforced server-side too (`stop` is never
    gated). Each device is one of three modes in that roster's dropdown:
    `mirror` (the read-only dashboard), `judge` (**JudgeView** — the same telemetry
    in a flat presentation layout: verdict, camera, big numbers, nothing to press),
    and `full` (drive, behind a 3s confirm). Judge is a *layout*, not a permission —
    the server holds it as telemetry-only exactly like mirror, so nothing about the
    drive gate changes. Modes are held by ip and survive a reconnect.
    `npm run test:mirror` covers all three.
  - **A sensor sending a bare 0 is not wired** — the CSV pads unlanded fields with
    zeroes, and 0 ppm rendered as "normal/good" is a green lamp for hardware that
    isn't on the robot, in the tile *and* in the go/no-go verdict. `reads()` in
    `app.js` is the one gate: `zeroOk` on `dist` (nothing in range) and `alt` (level
    with the start) marks the two that really can read zero; everything else shows
    NOT READING. Add the flag when a sensor's zero becomes real, not when a tile
    looks empty.
  - **Panic stop is global** — space fires `stop` from anywhere, bound at the app root
    (Drive's own space key only listens while the drive zone is armed, which left a
    running routine with no key at all). Buttons, links and text inputs keep space for
    themselves. Every client binds it, mirror included: `stop` is never gated.
  - **Cloud pills** (SAGE / VOICE in the topbar) are a reachability probe, not a health
    check: `/api/cloud` HEADs the two api roots, cached ~25s, and the dashboard polls it
    every 30s. The venue has no internet and both Gemini and Deepgram fail quietly
    without it. Probe the api *root* — an authenticated path just hangs for an
    unauthenticated request and reads as offline.
  - **Elevation** is derived in `server.js` (`altitudeM`) from the pressure the
    board already sends — same barometric formula as `bme.readAltitude()`, but the
    reference defaults to the **first valid reading**, so the tile reads metres
    climbed/descended *since the rover started* and self-zeroes at any venue. A
    fixed 1013.25 read tens of metres off (often negative) whenever the day's QNH
    differed, which is what made the tile look broken. Set `SEA_LEVEL_HPA` (env,
    venue QNH) to get true height above sea level instead — an explicit QNH is
    absolute and is never leaked.
    **The zero leaks toward ambient** (`REF_TAU`, 300s, `REF_TAU_S` to override):
    a fixed zero *drifts on its own* and that is weather, not a bug — the air moves
    1-2 hPa an hour, which the formula reads as 8-17 m of climbing while the rover
    sits still. Leaking the reference is a high-pass: slower than `REF_TAU` is
    absorbed as weather, faster than it shows, and a ramp takes seconds. Cost: a
    *held* height decays to 0 over ~`REF_TAU`. Don't chase the remaining ~1 m of
    jitter with more filtering — that's the bme's own noise floor; sub-metre
    absolute height needs a tof/sonar to the floor, not a better filter. No CSV field: the board
    sends pressure, the server adds `alt` to the packet (2dp, so cm resolution).
    **Clicking the tile switches it to cm** — same number, unit swap only, for
    steps and ramps. Below ~10cm it's fiction anyway: the board prints pressure
    with 2 decimals (0.01 hPa ≈ 8cm) and the bme's own noise is around a metre.
    `npm run test:elev` is the check (needs a *freshly started* server — a server
    that already has a reference pressure fails the "first reading is zero" assert).
- `OUTDATED/` — retired Mega 2560 + Uno R3 two-board setup, kept only for
  porting reference. Not part of the current build.
- `cad/`, `step/` — mechanical

## BLK

Operator-authored workflows, saved as plain `.blk` text in `server/workflows/`
and driven by `BlkCtl` in `app.js`. Not to be confused with the on-board `Step`
routines below — those are compiled-in tables, BLK is authored on the dashboard.

- Ops: `forward/back/left/right <expr>` (or `… until <cond> [timeout <ms>]`),
  `speed`, `wait`, `wait until`, `repeat n|until|while`, `forever`, `if/else`,
  `break`, `continue`, `stop`, `set`/`change` (variables), `def`/`call`
  (procedures), `say`, `log`, `led`, `analyze [focus]`, `ask`, `find`, `#`
  comments, `~` prefix to disable a block.
- Expressions and conditions are real: maths, `and/or/not`, parens,
  `min/max/abs/round/random/clamp`, sensor and variable reads, `{var}`
  interpolation inside `say`/`log`.
- `ask`/`find` are Sage yes/no calls (`/api/blk-ask`, `/api/blk-find`); the
  answer lands in the `answer`/`found` variable so the program can branch. A
  failed request reads as *no* — never as "go ahead".
- The editor is **touch-first**: dragging is pointer-event based (html5
  drag-and-drop never fires on a touchscreen — don't "fix" it by adding
  `draggable`), hit targets are 44px, and every destructive action is on the
  selection action bar or the drag-to-bin target, never keyboard-only.
  `npm run test:editor` drives the real page over CDP and checks exactly that.
- **A workflow is uploaded to the board and run there whenever it can be.**
  `compile()` in `blk.mjs` turns the tree into a flat instruction list; `BlkCtl`
  writes it over the same BLE `cmdChar` (`blk,n` → one `blk,i` line per
  instruction → `blk,go`) and the `blk vm` in `main.ino` plays it. The reason is
  latency, not robustness: `forward until dist < 15` interpreted up here costs a
  ~400ms round trip per burst (write → drive → notify → decide) and the rover
  overshoots; on the board the same check is one `loop()` pass, and a BLE drop
  mid-run no longer strands the program. The board only ever *starts* moving on
  its own — every instruction is still time-limited, and `stop` still ends it.
  - **The PC stays in the loop for what only it has** — Sage, TTS, the camera,
    the HTTP headlamp. `say/log/led/analyze/ask/find` compile to `evt`: the board
    halts, notifies `E:blk,<node>,<kind>,<vars…>`, and for `ask`/`find` parks
    until the browser writes back `blk,res,<0|1>`. It ships its variables with
    every event so `{name}` still interpolates up here. A silent browser times
    out (60s) and the program carries on rather than hanging.
  - **The instruction set is deliberately narrow** — constant arguments, one-term
    comparisons. Anything else (`forward n * 100`, `dist < temp`, `and`/`or`,
    >8 variables) throws `Unsupported` and that workflow runs in the browser
    interpreter exactly as before, so the *language* never has to shrink to fit
    the firmware. The run panel says which one it picked, and why, before you
    press RUN. Don't "fix" a fallback by widening the VM unless the workflow
    actually needs on-board timing.
- Anything added to the language must land in **all five** places or it silently
  half-works: `parse` + `serialize` (roundtrip), `NODE_META` (editor blocks),
  the interpreter's `runList`, `compile` (or it quietly falls back to the
  browser), and `prompts/blk.md` (what Sage is allowed to write).
  `node server/test-blk.mjs` is the self-check — it runs a JS mirror of the
  firmware VM against the browser interpreter and asserts the same trace, so
  extend it too, and keep `BOPS` in step with `blkvm.h`.

## Screensavers

Screensavers on the robot's own 128x64 panel (landscape, U8G2_R0 — layouts are
written against `OLED_W`/`OLED_H`, so a remount is those two defines plus the
rotation, not the drawing code), picked from the dropdown in the
console drawer (topbar → CONSOLE, so it's in the Electron app too). BLE carries
`scr,<n>` and nothing else — `0` is off, and the rest are the `SCR_*` enum in
`main.ino` (matrix rain, a bouncing BLACKOUT, a falling starfield, a self-playing
tetris). The board animates them off the same 20ms draw tick, in
`startSaver()` / `stepSaver()` /
`drawSaver()`; adding one is a case in each of those three, an entry in `SAVERS`
in `app.js` (**the index is the wire value** — same order as the enum), and a
`drawer.*` string in `i18n.js`.

- **A screensaver drops the sensor cadence to 2Hz** while the rover is otherwise idle
  (`SAVER_SEND_INTERVAL` / `SAVER_ENV_INTERVAL`). Everything below the send gate in
  `loop()` blocks the panel: one sonar ping is ~25ms of dead time and a dht11 read ~30ms,
  inside a 20ms draw tick — at 10Hz that's a dropped frame in five, which is exactly what
  reads as stutter. Anything moving (routine, blk, live drive) clears `busy` and puts the
  full 10Hz back, so this only ever costs telemetry resolution on a parked rover. If the
  animation ever stutters again, look for something new that blocks in `loop()` — not at
  the draw code.
- **The board owns the animation, not the browser.** This is the same wall the
  old OLED-video feature hit: BLE can't carry 1KB frames at video rates (60fps
  is ~61KB/s and a with-response write is round-trip bound at the ~15ms
  connection interval). Anything animated on that panel has to run on the board.
- **Contrast on a 1-bit panel is density, not brightness.** Four tiers down the
  tail: head glyph knocked *out of a filled cell* (the only way to read brighter
  than white), two solid behind it, then half-dimmed by erasing every other
  scanline through the glyph, then quarter for the last third. Erasing scanlines
  is what "grey" means here — don't reach for a dither pattern, at 5px it just
  eats the glyph.
- Glyphs are ASCII (`MTX_GLYPHS`). Katakana means shipping a u8g2 japanese font,
  tens of KB of flash for shapes nobody can resolve at 5px.
- It takes the panel over the HUD and the operator message both, and the **only**
  things that end it are `scr,0` and a BLE drop — the panel can never be left
  stuck on it with no console to switch it off.
- The panel is on **SPI1** (d13 sck, d11 copi) via a custom u8g2 byte callback, not
  bit-banged sw-spi: u8g2's `*_HW_SPI` constructors only know the `SPI` object, which
  on the Giga is d89-d91 on the high-density connector. Don't "fix" that by going back
  to sw-spi — it cost ~20ms a frame, which is the whole draw tick.
- `npm run test:matrix` re-runs the fall/draw/bounce/star loops in js against the
  `MTX_*` / `ST_N` / `TET_*` constants (and the tetromino table) read out of
  `main.ino` — a drop that walks off `mtxCell[][]`, or a piece merged past the wall,
  is a silent out-of-bounds write on a board with no MPU, so the indexing is checked
  off-board.

## Dictated routines

When the user narrates a new motion routine step by step ("go forward once,
back up, rotate, turn 360°, ...") for `giga-r1/main/routines.h`,
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

## TODO

- (empty)

DO NOT PUSH COMMITS WITH SESSION LINKS.