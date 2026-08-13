# WRO 2026 — Blackout V1

WRO 2026 robot project. Single Arduino Giga R1 WiFi (sensor hub, BLE) plus a
Node.js PC server/dashboard.

## Layout

- `giga-r1/` — Giga R1 WiFi (`main/`): sensor hub + motor driver + BLE
  command endpoint, one board. Reads sensors, broadcasts CSV over BLE notify;
  DHT11 (temp/humidity, A6), BME280 (pressure, I2C on D20/D21 — its own
  temp/humidity registers go unread) and HC-SR04 (ultrasonic, D49/D47) wired
  so far, rest of the CSV
  field set sends 0 until a sensor lands. Also drives an
  L298N (D3-D8, connector order) and runs on-board `Step` motion routines
  (`routines.h`, see "Dictated routines" below) or direct gamepad/dashboard
  drive commands over the same BLE `cmdChar` — routines run standalone on
  the board so a BLE drop mid-run doesn't strand it. `motor_test/` is a
  bench-only sketch for wiring/direction checks, not part of the build.
  - **OLED video** (`vidChar`, see "OLED video" below): the panel can play an
    operator's clip instead of the HUD. The clip is uploaded into the Giga's 8MB
    SDRAM first and then played from there, so playback never depends on the
    link. It reverts to the HUD when the clip ends, when the link drops, or when
    no chunk arrives for 4s *mid-upload* — it can never be left stuck on a meme.
- `esp32-cam/` — ESP32-CAM (AI-Thinker) (`main/`): standalone MJPEG streamer
  on its own WiFi + power. Never touches the Giga/BLE path; the dashboard
  `<img>` pulls `http://blackout-cam.local/stream` directly.
  - **Flash LED (GPIO 4) debug:** boot = slow blink (500ms), error (camera/WiFi
    fail) = rapid blink (100ms), connected = steady dim (PWM 32). Handled by
    `ledUpdate()` in `main.ino`, called from `loop()` every 50ms.
- `server/public/js/blk.mjs` — the BLK language (parser, serializer, evaluator,
  linter, interpreter). Text is the file format; `blkedit.js` + `blk.html` are
  the editor, `blksim.js` the offline rover simulator. See "BLK" below.
- `server/` — Node.js dashboard + "Sage" AI agent (Cerebras). BLE is read
  directly by the browser (Web Bluetooth) and forwarded to
  `/api/mega/sensor`; gamepad input goes out the same way as dashboard
  drive commands. `sage.js` parses the model's JSON replies; `vision.js`
  grabs ESP32-CAM stills for Sage to see; TTS is Deepgram (if keyed) falling
  back to Edge neural voices; prompts live in `prompts/*.md`.
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
    gated). `npm run test:mirror` covers grant + revoke.
  - **Height/altitude** is derived in `server.js` (`altitudeM`) from the pressure
    the board already sends — same barometric formula as
    `bme.readAltitude()`, but the sea-level reference is `SEA_LEVEL_HPA` (env,
    default 1013.25) so the venue is a knob, not a reflash. No CSV field: the
    board sends pressure, the server adds `alt` to the packet.
- `OUTDATED/` — retired Mega 2560 + Uno R3 two-board setup, kept only for
  porting reference. Not part of the current build.
- `cad/`, `step/` — mechanical

## BLK

Operator-authored workflows, saved as plain `.blk` text in `server/workflows/`
and run **in the browser** (the browser owns the BLE link) by `BlkCtl` in
`app.js`. Not to be confused with the on-board `Step` routines below — BLK runs
off the board, `routines.h` runs on it.

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
- Anything added to the language must land in **all four** places or it silently
  half-works: `parse` + `serialize` (roundtrip), `NODE_META` (editor blocks),
  the interpreter's `runList`, and `prompts/blk.md` (what Sage is allowed to
  write). `node server/test-blk.mjs` is the self-check — extend it too.

## OLED video

Play a clip on the robot's own 64x128 panel from the dashboard (Drive zone →
OLED VIDEO, so it's in the Electron app too), then the panel goes back to the
HUD by itself.

**Upload first, then play** — no ffmpeg and no server round-trip, but the whole
clip does go into the board's RAM before anything appears. Three phases, and only
the middle one touches BLE:

1. **Capture** — a detached `<video>` plays the picked file and
   `requestVideoFrameCallback` hands over every decoded frame; each is
   center-cropped + thresholded to the panel's 1-bit bitmap
   (`public/js/oledvid.mjs`) into an array. Real-time, so a 10s clip takes 10s.
2. **Upload** — `vid,load,<frames>,<fps>` reserves the frames in the Giga's 8MB
   external SDRAM (`SDRAM.malloc`), then the bitmaps go out `vidChar` as one flat
   byte stream. Chunks are appended in arrival order and deliberately do **not**
   respect frame boundaries, so `VID_CHUNK` needn't divide 1024.
3. **Play** — the board runs the clip off its own `micros()` clock (`tickVideo`).
   The link is irrelevant from here: a BLE drop mid-clip can't stutter or strand it.

- Don't go back to streaming frame-by-frame. It capped at single-digit fps and
  that is not a code problem: 60fps is ~61KB/s and a with-response write is
  round-trip bound at the ~15ms connection interval. Uploading pays the link cost
  once instead of every frame.
- **`VID_CHUNK` must stay under the board's ATT MTU** (~240 — ArduinoBLE takes it
  from the controller's ACL packet length, `utility/HCI.cpp`). Above that the
  central splits each write into prepare-write PDUs of `mtu - 5`, each its own
  round trip plus an execute — which is exactly what made the old 512-byte chunks
  ~4x slower than they looked. `test-oledvid.mjs` asserts this and cross-checks
  every `VID_*` constant against `main.ino`, since the two files can't import
  each other.
- Writes stay **with response** (the board appends by arrival order and can't spot
  a gap) and go through the same `bleWrite` chain as every other GATT write.
  Without-response would upload several times faster but needs a per-chunk
  sequence number first.
- The panel is on **SPI1** (d13 sck, d11 copi) via a custom u8g2 byte callback, not
  bit-banged sw-spi: u8g2's `*_HW_SPI` constructors only know the `SPI` object, which
  on the Giga is d89-d91 on the high-density connector. Don't "fix" that by going back
  to sw-spi — it cost ~20ms a frame.
- Each frame is auto-levelled (its own min/max stretched to full range) then hard
  thresholded — `DITHER` is 0. On a 64x128 panel the dither texture was never
  resolvable across a room, it only greyed the shot down. Put it back to 1-2 only
  if a gradient-heavy clip blobs up.
- The threshold slider is the per-clip knob: a 1-bit panel has no grey, so a dark
  source needs a lower threshold. It applies at **capture** — once a clip is
  uploaded it's a fixed bitmap, so changing it means re-picking the file.
- Playback frame rate is the clip's own, measured from what actually decoded, and
  capped at 60. Don't pad a 24/30fps source up to 60: identical motion, twice the
  upload wait.
- The flash-time twin is `giga-r1/oled_video_test/` (`pack_xbm.py` + a bench
  sketch) — same bit order, same geometry, but baked into the firmware.

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