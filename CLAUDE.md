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
  L298N (ENA/IN1-IN4 on D3-D7, ENB on D2 — D8 is SCL2, kept free for Wire2)
  and runs on-board `Step` motion routines
  (`routines.h`, see "Dictated routines" below) or direct gamepad/dashboard
  drive commands over the same BLE `cmdChar` — routines run standalone on
  the board so a BLE drop mid-run doesn't strand it. `motor_test/` is a
  bench-only sketch for wiring/direction checks, not part of the build.
  - **Screensavers** (see "Screensavers" below): the console can put a
    screensaver on the panel instead of the HUD. The board animates it; the
    link only carries which one, and a BLE drop turns it off.
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
    gated). `npm run test:mirror` covers grant + revoke.
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