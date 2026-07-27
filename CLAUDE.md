# WRO 2026 — Blackout V1

WRO 2026 robot project. Single Arduino Giga R1 WiFi (sensor hub, BLE) plus a
Node.js PC server/dashboard.

## Layout

- `giga-r1/` — Giga R1 WiFi (`main/`): sensor hub + motor driver + BLE
  command endpoint, one board. Reads sensors, broadcasts CSV over BLE notify;
  DHT11 (temp/humidity, D2) and HC-SR04 (ultrasonic, D11/D12) wired so far,
  rest of the CSV field set sends 0 until a sensor lands. Also drives an
  L298N (D3-D7, D10) and runs on-board `Step` motion routines
  (`routines.h`, see "Dictated routines" below) or direct gamepad/dashboard
  drive commands over the same BLE `cmdChar` — routines run standalone on
  the board so a BLE drop mid-run doesn't strand it. `motor_test/` is a
  bench-only sketch for wiring/direction checks, not part of the build.
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
  - **Mirror mode:** the dashboard opened over the LAN (the judges' tablet) is
    telemetry only — no link controls, no firmware updater, no drive — until the
    host grants it from CONNECTED DEVICES in the topbar. The host is whoever
    loaded it over loopback, and the server decides that from the socket's
    address, so a granted client is enforced server-side too (`stop` is never
    gated). `npm run test:mirror` covers grant + revoke.
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


DO NOT PUSH COMMITS WITH SESSION LINKS.