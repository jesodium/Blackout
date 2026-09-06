# WRO 2026 — Blackout

WRO 2026 robot project. Single Arduino Giga R1 WiFi (sensor hub, BLE) plus a
Node.js PC server/dashboard. The board advertises as **BLACKOUT-V3**
(`BOARD_NAME` in `main.ino`) — that string is what BLE pairing matches on.

## Layout

- `giga-r1/` — Giga R1 WiFi (`main/`): sensor hub + motor driver + BLE
  command endpoint, one board. Reads sensors, broadcasts CSV over BLE notify;
  DHT11 (temp/humidity, **A5**, A6 -> D74 -> D24 -> D71 -> A5, last move 2026-09-02 — the lib
  bit-bangs a one-wire protocol and never calls `analogRead`, so any digital-capable pin
  does; A0-A7 qualify, A8-A11 do not. A5 is SPI2_MISO on the pin map and nothing calls
  `SPI2`, so it is free — but if the panel ever moves to the stm32 SPI2 fallback below,
  these two collide),
  BME280 (pressure, 0x76 on **Wire1** — SDA1 D102 /
  SCL1 D101; its own temp/humidity registers go unread) and RCWL-1601
  (ultrasonic, TRIG D52 / ECHO D50), plus GY-302/BH1750 (ambient light, 0x23 on
  its own I2C bus, Wire2 — SDA2 D9 / SCL2 D8; CSV field 12, and `lux` in BLK) wired so far, rest of the CSV
  field set sends 0 until a sensor lands.
  The GY-302's ADDR pin is tied to GND to hold 0x23 — on VCC it becomes 0x5C and
  the sketch stops finding it.
  **There is no I2C anywhere but the digital header**: every I2C-capable pin the
  H747 breaks out is D0, D6, D8/D9, D20/D21 and SDA1/SCL1 — the analog header
  (PC_4/PC_5/PB_0/PB_1/PC_3/PC_2/PC_0/PA_0) and the whole D22-D53 block have no I2C
  alternate function at all, so "move a sensor to the other side" is a cable that
  leaves the digital header, never a pin change.
  **The three I2C buses are separate objects and a sensor only answers on its own**
  (`variants/GIGA/pins_arduino.h:228`): `Wire` = D20/D21, `Wire1` = **SDA1 D102 /
  SCL1 D101**, `Wire2` = D9/D8. `Wire` carries the arm's PCA9685 (0x40) and nothing
  else, on purpose — see below. A device wired to
  SDA1/SCL1 while the sketch calls plain `bme.begin(0x76)` reads exactly like a
  dead sensor — pressure pinned at 0.00, the 5s re-probe never printing "BME280
  back" — which cost a session on 2026-08-31; the bus is the second argument
  (`bme.begin(0x76, &Wire1)`), and `Wire1.begin()` has to be called too.
  **0x60 answers on Wire1 with nothing plugged in** — something onboard on that
  pair, junk registers (WHO_AM_I inconsistent, only reg 0x00 reads). Not a device,
  not the bme, ignore it. Only 0x76 there is real.
  **Reversed VCC/GND on an I2C module pins both its lines high, it does not just
  go dead** (2026-08-25, cost a day on the gy-302): the chip's ESD clamps conduct
  from its "GND" pin out through SDA and SCL, holding them at 3V3 harder than the
  H747 can sink. Symptoms read as everything *but* power — both lines pass a
  pull-up check (they're *on* the rail, not pulled to it), every address NACKs on
  hardware I2C and bit-bang alike, and the board browns out off USB whenever
  something tries to pull a line down. The one test that finds it: `pinMode(pin,
  OUTPUT); digitalWrite(pin, LOW);` then read the pin back. A working line reads
  0; a line that reads 1 is tied to a rail, because nothing legal on an I2C bus
  beats a 25mA push-pull driver. `giga-r1/i2c_scan/` is that check. It sweeps
  **all three buses** (D20/D21, D9/D8, D102/D101) bit-banged *and* over hardware
  `Wire1`, and dumps chip-ID registers for anything it finds. The positive control
  is the **bh1750 at 0x23 on D9/D8** — D20/D21 is empty now, so a silent bus there
  proves nothing; "nothing" anywhere means nothing until the same run has printed
  0x23. Identify by register, never by address alone: `reg 0xD0 = 0x60` is a real
  BME280 (0x58 BMP280, 0x61 BME680), and a bare address that ACKs can be onboard
  junk.
  **Every sensor runs off the 3V3 rail, not 5V** — the Giga's pins are 3.3V and
  not 5V tolerant, so the ultrasonic is an RCWL-1601 (3.3V-capable, HC-SR04
  drop-in) rather than an HC-SR04, and the dht11 is powered at 3V too. A 5V
  sensor here means a 5V signal into a 3.3V pin. Also drives an
  L298N (ENA D2, IN1 D3, IN2 D4, IN3 D5, IN4 D6, ENB D7 — D2-D7 in the same
  order as the L298N's own header, so the ribbon runs straight across with no
  crossed wires; D8 is SCL2, kept free for Wire2)
  and runs on-board `Step` motion routines
  (`routines.h`, see "Dictated routines" below) or direct gamepad/dashboard
  drive commands over the same BLE `cmdChar` — routines run standalone on
  the board so a BLE drop mid-run doesn't strand it. `motor_test/` is a
  bench-only sketch for wiring/direction checks, not part of the build.
  - **Three relay channels** (D26 cam light, D28 led strip, D30 spare led) — each
    pin is a low-current input to a relay module that switches the light's own
    supply, so the pin never sees lamp current. `digitalWrite` only: a relay
    can't be dimmed, pwm just chatters the coil, which is why they sit outside
    the D2-D13 pwm band on purpose. **The common boards are ACTIVE LOW** — HIGH
    releases, LOW pulls in — so `RELAY_ON`/`RELAY_OFF` hold that polarity in one
    place (lights on at boot = flip it), and the level is written *before*
    `pinMode(OUTPUT)` or the pin's default low turns everything on for a moment
    at boot.
  - **Buzzer on D72** (D75 -> A7 -> D72, all 2026-09-01; confirmed audible on D72).
    `tone()` on the mbed core is ticker-driven, so it needs no pwm pin and any gpio does.
    **Not A8-A11** — see below. A7 works too but also feeds the 3.5mm audio jack. **Not A8-A11**: those are
    ADC-only die pads with no gpio, and the core makes it a *compile* error
    (`__attribute__((error("Can't use pins A8-A11 as digital")))` in
    `variants/GIGA/pure_analog_pins.h`) — `A9` is not even an int, it is a
    `PureAnalogPin` object. Driven off the same `hud,<level>` the panel face already gets —
    `tickBuzz()` in `main.ino`: `bad` holds a continuous tone until the level clears, `warn`
    beeps intermittently for as long as it holds (`BUZZ_BEEP_MS` 120 on,
    `BUZZ_GAP_MS` 600 off), anything else is silent, and a BLE drop clears
    `hudLevel` so a lost link silences it. `tone()` on the
    mbed core is ticker-driven, so it needs no pwm pin and never blocks.
    Re-issuing `tone()` while it is already sounding leaks a `DigitalOut` each call
    (core bug), which is why `buzzSet()` only ever writes on a change. **`noTone()`
    does not silence an active module** — it detaches the ticker and drops the pin
    object wherever the last toggle left it, and half the time that is HIGH, which on
    a buzzer with its own oscillator is a beep that never ends; `buzzSet()` parks the
    pin low by hand after it. CONSOLE → BUZZER is the mute (`buz,<0|1>`, off silences
    at once); the flag lives on the board, so the dashboard re-pushes it on every
    connect — a reset brings it back on.
  - **Screensavers** (see "Screensavers" below): the console can put a
    screensaver on the panel instead of the HUD. The board animates it; the
    link only carries which one, and a BLE drop turns it off.
  - **Servos hang off a PCA9685** (silkscreened **HW-170**) — I2C, address 0x40,
    16 channels, so more servos cost no pins. **It is on the Giga now**
    (`giga-r1/main/arm.h`, ported off the bench rig 2026-09-01): `armBegin()` from
    `setup()`, `armTick()` from `loop()`. The bench rig (`OUTDATED/pca_test/`, Uno
    R4) still exists and is still where a channel gets identified; the two share a
    joint table that must agree.
    - **It is on `Wire` (D20/D21) alone, deliberately.** A stalled servo browns the
      PCA9685 out and it clamps SDA — on a shared bus that takes the bme280 or the
      bh1750 down with it, so the arm gets the bus with nothing else on it. That is
      why "nothing is on `Wire`" is no longer true and why nothing else may move
      there.
    - **VCC is 3V3 on the Giga, 5V on the bench rig, and that is not a
      contradiction.** The Giga drives 3.3V logic; a PCA9685 at VDD 5V wants
      0.7*VDD = 3.5V to read a HIGH, which 3.3V never clears. Powering the chip at
      3V3 moves its threshold down with it. On the 5V-logic Uno rig, VCC on 3V3 is
      the failure below.
    - **`OE` is wired to D32** on the Giga (active low: HIGH = all 16 channels off).
      **Not D8** — that is SCL2. It is the only stop that still works with the I2C
      bus dead, so `armStopAll()` raises OE *first* and writes the full-off bits
      after; `armBegin()` sets the level before `pinMode(OUTPUT)`, or the pin's
      default low enables every channel for a moment at boot.
    - **Every `Wire` call is guarded on `armOk`.** A chip that never answered is
      all no-ops, because a blocking transaction into a browned-out PCA9685 looks
      exactly like a bricked board — silent from boot, USB still enumerated.
      `armBegin()` prints `PCA9685 ok` / `PCA9685 not found`.
    - **The travel budget is GONE (2026-09-05), by operator request** — off the
      dashboard 2026-09-03 and out of the firmware now: no `limit` column in
      `armSv[]`, no `ARM_TRAVEL_MS`, no `armLimits`, no `arml,` command, and the
      `<meter>` per row and greyed-out arrow went with the dashboard half. It was
      dead reckoning with no encoder behind it, so it drifted, and a joint that
      parked itself at a phantom stop read as an arm that refuses to move. What
      stands between a 360 and the frame is now the operator on the button and the
      `ARM_JOG_MS` deadman behind them. `test-arm.mjs` asserts all four names stay
      out, so it cannot creep back one file at a time.
      **`armTravel[]` and RE-HOME stayed**: the sag trim reads the travel count as
      its only estimate of pose, and `armz,` re-zeroes it after a stall or a shove.
      **The hold bias is not integrated** — `armPark()` zeroes `armSpeed[]`,
      because a hold that balances gravity moves nothing.
      Every arm command still goes through the one choke point (`armSend()` in
      `app.js`), which is what the test asserts and where anything that has to see
      every arm command belongs.
    - **Canned moves are recorded on the bench and replayed as one tap** — the
      arrows and hold sliders are a live control surface, and a live control
      surface is how a joint gets overdriven, so the overdriving happens once,
      off-line. `./cmds/arm-configurator.sh` (:5006, bumps on a busy port) is a
      flask serial pipe to the
      **Giga**, not to the Uno bench rig: `main.ino` reads the same command
      strings off USB that it reads off BLE (`Serial.readStringUntil` in
      `loop()`), so every line it writes is what the dashboard would have sent.
      **It finds the board by SERVICE UUID, never by name** — the same filter the
      dashboard and the Electron picker use. `main.ino` sets only the
      advertisement's local name, so the *GAP device name* stayed ArduinoBLE's
      default `"Arduino"`; bleak's `find_device_by_name()` reads that one, so the
      BLE mode never found a board that was advertising the whole time
      (2026-09-02). `BLE.setDeviceName(BOARD_NAME)` now goes out alongside
      `setLocalName()`, but the service match is the fix — a scanner that matches
      on a name is one reflash away from lying again.
      **It speaks either transport, operator's pick** (the USB/BLE buttons on the
      page, or `--ble` to start there): USB is the bench cable and is instant,
      BLE is the link the rover actually runs on and a with-response write is
      round-trip bound at the ~15ms connection interval — so a take recorded over
      BLE has comp-day timing baked into its gaps. **Only one central can hold
      the peripheral**, so the dashboard has to drop the link first. The one
      thing the two transports do differently is the terminator (`wire()`): USB
      needs the `\n` `readStringUntil` waits for, BLE must not carry one or it
      rides into the command string. bleak is async and flask is not, so one
      event loop lives in a daemon thread and `LOCK` keeps writes from
      interleaving on a link that is round-trip bound.
      **It has to read the board's serial output even though it wants none of
      it** (2026-09-02): `main.ino` prints the telemetry CSV at 10Hz, and with
      nothing draining it the tty buffer fills in seconds, `Serial.println()`
      blocks on a CDC endpoint the host stopped reading, and `loop()` stalls
      *inside* it — so the command written a moment ago sits unread. That was
      **60ms a command over the USB cable**, slower than BLE; the discard thread
      (`_drain()`) puts it at ~1ms. A laggy USB link here is this, never the cable.
      A take is saved as **its own file**, `server/arm_moves/<name>.json`, holding
      flat `{ms, cmd}` steps plus its two flags; the dashboard's arm pad turns each
      one into a button (`/api/arm-moves`). **The filename is the name and the
      folder is the collection** — no index file to fall out of step with it, and a
      take can be opened, diffed, copied to another rig or deleted in Finder with
      nothing running. That makes the filename rules the naming rules (`path_of()`
      refuses a blank, a leading dot and a slash), and it is why a rename is
      `os.rename` — the steps never pass through it.
      **A take's clock starts at RECORD, not at the first jog**, so every one of
      them carried the operator's reaction time as dead air at the head — 2.1s on
      `Open Gripper`, replayed faithfully as a button that does nothing for two
      seconds. `clean()` shifts every step by the first one's timestamp on save
      (the eight takes on disk were migrated 2026-09-03); the **gaps** all
      survive, because the gaps are the take. The selftest asserts both halves.
      **A take that only ever drives one joint one way is rendered as a HELD
      button, not a tape** — `armJogOf()` in `app.js` reads that off the steps, so
      "Open Gripper" behaves exactly like the gripper arrow and a short recording
      no longer replays as a twitch. Anything mixed stays a tap-to-replay tape.
      **Each joint row has a speed slider and the speed is part of the take**
      (`SPEED_MIN` 20..100, scaling the arrows' +/-100): some moves want slow —
      lining the gripper up — and some want everything the joint has. It goes out
      as the ordinary `arm,<j>,<speed>` the firmware already took, so nothing
      downstream learned a new field: the recorder saves the wire command,
      `armJogOf()` in `app.js` already replays a HELD take at its recorded speed,
      and Sage's tapes are unchanged. Kept per rig in `localStorage.armSpd`.
      **Slow is also weak** — pulse width is speed and torque at once — so a slow
      setting may not lift a gravity-loaded joint at all; that is the servo, not
      the slider, and the fix is still a shorter burst at full power. The floor is
      20 because below ~100us off neutral the pulse is inside the servo deadband
      and the joint only buzzes; `armrec.py --selftest` checks that against the
      narrowest `span` in `arm.h`.
      **It records commands, not positions** — same reason as everything else
      here — so a take replays from wherever the arm is sitting and drifts a
      little each time; start it from the same pose. **The gaps are the take**:
      the board's deadman lives on them, so playback is timeouts off one clock,
      never a loop with waits. A queued step must die on the panic key or space
      stops the arm and the next step restarts it — that is a `keydown` listener
      in `Arm`, and the test asserts it. `npm run test:armrec` covers the
      recorder maths without a board.
    - **`armJog()` has exactly one call site: the BLE `arm,<joint>,<speed>` command.**
      The dashboard's `Arm` pad (`app.js`) holds a button and re-sends every 300ms
      against the board's 3s deadman; releasing sends `arm,<joint>,0`, and a bare
      `arm,` is all joints off. Don't wire it to a routine or anything unheld — a 360
      with nobody on the button winds itself into the frame, which is what happened
      on the bench. `npm run test:arm` (`server/test-arm.mjs`) re-runs the pulse
      maths, the clamp, the 500-2500us bounds and the deadman in js against the
      constants read out of `arm.h`, and **fails if a second call site appears**.
    - **Swing is per joint** (`span` in `armSv[]`), because pulse width is speed and
      torque at once and the six joints carry very different loads. The default
      `ARM_SPAN_US` is **700**, not the nominal 500: the base carries the whole arm
      and had nothing left at 500. **gripwrist is on 1000** — it moved but fell short
      of full travel at 700 (2026-09-02), and 1000 is the ceiling on a 1500 neutral
      before the pulse leaves the 500-2500us bounds. Buzzing at rest means saturated —
      go back down. Don't raise the default to fix one joint: the base is already near
      its limit. `npm run test:arm` re-checks the bounds for every row.
    - **A released joint sags, and neither stopping method prevents it** — a 360
      outputs zero drive at its neutral and free-wheels with the pulse cut, so a
      gravity-loaded joint falls either way. The only thing that holds it is a small
      pulse pushing back up: `hold` in `armSv[]`, in the same -100..100 the pad sends,
      applied by `armPark()` on release and when the deadman fires. **0 (cut the pulse)
      is the default and is right for anything unloaded**; shoulder and elbow are the
      two that sag. The holding band is only a few counts wide and it **moves with the
      arm's pose**, because gravity torque does: there is no one number that holds at
      every angle — which is why the bias is a **line, not a constant**: `sag` in
      `armSv[]` is that same -100..100 bias again *per 1000ms of travel*, and
      `armHoldAt()` applies `hold + sag * armTravel[i]/1000`, clamped to
      `ARM_HOLD_MAX` either way. `armTravel[]` is the only estimate of pose this
      arm has (dead reckoning: `speed x ms` since the last re-home — it outlived
      the travel budget it was built for) — so it **drifts, and a stall or a shove
      makes it wrong**; RE-HOME (`armz,`) is the fix. `sag` 0 is the old flat bias and is right for
      anything unloaded. **Measure it at two poses**: trim `hold` at home, jog the
      joint out ~2s, trim again — half the difference is `sag`. The test rejects a
      `sag` steep enough to saturate the clamp within 5s of full-speed travel
      (`SAG_REACH`, past the mechanical end of every joint here), because at that
      point the trim is a knob that has stopped doing anything. The cap is **35**. **Measure it, never guess** — jog the joint up at 3, then 5, then 8
      until it stops sagging, and put that number in with the sign that lifts. Too high
      is a slow unattended climb into the frame, which is why the test caps `hold` at
      25. The trade is current: a held joint drives until the next jog or a panic stop.
      **`armStopAll()` never parks** — space is a true kill (OE dropped, full-off on all
      16), and the test asserts it stays that way.
    - **The hold is trimmed live, not by reflashing** — a slider per row in the
      dashboard's arm pad sends `armh,<joint>,<bias>[,<sag>]` and `armSetHold()`
      applies it straight away (re-parking an idle joint so the change is felt),
      printing both plus the resulting bias *at the current pose* to serial. Two
      sliders per row: the left is `hold`, the right is `sag`. Turn them until the
      sag stops at both ends of the joint's travel, then **copy both numbers into
      `armSv[]`** and into `ARM_HOLD_INIT`/`ARM_SAG_INIT` in `app.js` (the test
      fails if the two tables drift) — it is RAM only and a reset goes back to the
      table. The clamp to
      `ARM_HOLD_MAX` (35) is on the *board*, not just the slider: `armh,` arrives over
      BLE like anything else. **The jog buttons stay at full ±100** — a gentle pulse is
      a weak one, and a variable-speed jog is how four working joints once read as
      nothing; the slider trims the hold only, never the jog.
      `ARM_JOG_MS` is 3000 (was 800, raised 2026-09-05 by operator request now that
      the travel budget is gone) — the same deadman the bench page refreshes every
      300ms. It is the LAST stop on this arm: a dropped link leaves a joint
      driving for 3s, which is the trade that was taken.
    - **The pad is driveable from the gamepad** (2026-09-03): **LB/RB** step the
      selected joint (six joints, one stick) and the **right stick Y** jogs it —
      a direction, not a throttle, so it is the same full ±100 the arrows send;
      a gentle pulse on a 360 is a weak one. It feeds the same `heldRef` the
      300ms repeat and the deadman already run on. The **wheels park while the
      ARM tab is open** (`subRef` in `Drive`'s pad loop): one stick, and a jog
      that also rolls the rover off the bench is how a joint gets wound into the
      frame. Chrome hides a gamepad from the page until it sends input, so a
      silent controller reads as no controller.
    - **Shift-click an arrow to name that direction** — "gripper ▶" says nothing
      about which way is open. The word renders inside the square and lives in
      `localStorage.armLabels` (per rig, not in a table anyone has to reflash).
      It is a `<dialog>`, **never `prompt()`**: Electron never implemented
      `window.prompt`, so a prompt-based dialog is dead inside the app. For the
      same class of reason the arrows are greyed with a class and `aria-disabled`
      rather than `disabled` — **a disabled button emits no pointer events at
      all**, so the shift-click could never reach the buttons that most needed a
      name.

    Everything below is the bench rig, and the hardware facts carry over.
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
    `OE` is pulled low already, and the Uno rig leaves it that way (confirmed
    2026-09-02 — `outputs()` there is a no-op and every stop is i2c-only); only the
    Giga wires it (D32, above) for a hardware all-channels-off kill.
    - **It drives a 6-DOF arm** (**rewired 2026-08-31** — every channel moved, the
      old ch15/12/4/8/11 map is dead): **ch6 base, ch5 shoulder, ch4 elbow, ch3
      wrist, ch12 gripwrist, ch1 gripper**. ch2 is unused. **All six are 360s**,
      the gripper included (stripped pot), so there is no positional channel left
      on the arm. **ch12 (gripwrist) is unconfirmed** — it has never been seen to
      move, and it did not respond on ch2 either, so suspect the servo before the
      channel; it is typed `cont` because cont gets the deadman and positional does
      not.
      The map now lives in **four** places that must agree or it half-works:
      `armSv[]` in `giga-r1/main/arm.h` (the robot), `sv[]` in `pca_test.ino`, `J`
      in `servo.py`, and the constants at the top of `hand.py` (the bench rig).
      **`pca_test.ino`'s header comment is the authority nowhere** — `sv[]` is.
      **A channel reading back a healthy pulse proves nothing about the servo** —
      `d<ch>` dumps MODE1 plus that channel's own registers over I2C, and ch7
      reported a textbook 2197us all afternoon with nothing plugged into it.
      That empty channel is what made four working joints look like a failing
      servo rail. Nudge and watch; the registers only ever clear the board.
      **A joint typed positional that is really a 360 never stops** — an angle
      maps to 500-2500us, which a 360 reads as full speed, and only continuous
      channels get the deadman. The wrist was mislabelled SG90 and ran away on the
      bench 2026-08-25 (it was ch8 then, ch3 now); `t<ch>` first, and if it keeps turning it's a 360. The bench rig is `OUTDATED/pca_test/` (Uno R4) plus its
      `servo.py`, a flask page that is nothing but a serial pipe to
      it. Joint-to-channel mapping is unconfirmed for the 360s — `t<ch>` nudges
      one joint so you can watch which moves, and `T` sweeps all 16 — including
      channels no table knows about, which is where a servo hides after a
      re-plug. **A nudge has to run at FULL power**: it was 35%, and on this arm
      a gentle pulse is a weak one, so four plugged-in joints identified as
      "nothing" until it was raised (2026-08-27).
      **A 360 in an arm joint has no position feedback and no end stop**, so
      there is no "go to 45deg", only "move while the button is held": the
      continuous channels run on a 0.8s deadman (`JOG_MS` on the rig,
      `ARM_JOG_MS` on the robot) that the browser refreshes every 300ms while
      held. That is also why the sketch has no
      demo mode — an unattended joint winds itself into the frame, which is
      exactly what happened the first time it ran.
      A 360 takes a *speed*, not an angle: ~1500us is stop, below is one way,
      above is the other, so `Servo.write(90)` logic does not apply. Every one
      of them creeps at its nominal neutral, so the neutral pulse is a
      per-servo bench knob (the `sv[]` table in the test sketch), not 1500 by
      definition — which is why the wire format is `<ch>:<val>` and the value
      means speed or angle depending on the channel's type, never both.
      **Neutral is measured per servo, never assumed** — the base sits still at
      **1490us**, measured on the bench 2026-08-24 (it has been on three channels
      since; the number belongs to the servo, not the channel). Shoulder, elbow,
      wrist, gripwrist and gripper are all still on the nominal 1500 and will each
      want their own. The measured values live in the `sv[]`/`armSv[]` tables so a
      reflash keeps them. A too-small
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
      **Hand position is a velocity, not a pose** — every joint is a 360 with no
      encoder, so "match my elbow" is unanswerable; the hand is a joystick.
      Nothing maps absolutely any more — the gripper was the one channel that did,
      off pinch distance, and it is a 360 now (`GRIP_STEP` in `hand.py` is dead
      code while the gripper stays continuous). No hand in
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
    `ledUpdate()` in `main.ino`, and it runs **only during setup()** — once the cam
    is up the lamp is written to 0 and belongs to `control?var=led`. So a blinking
    lamp on a booted cam is never the indicator: it's the auto headlamp walking, or
    the board in the wifi-fail reboot loop.
- `server/public/js/blk.mjs` — the BLK language (parser, serializer, evaluator,
  linter, interpreter). Text is the file format; `blkedit.js` + `blk.html` are
  the editor, `blksim.js` the offline rover simulator. See "BLK" below.
- `server/` — Node.js dashboard + "Sage" AI agent (Cerebras first, the rest as fallback
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
    **The robot's own panel wears the same face** — `FACE_G` + `drawFace()` in
    `main.ino` draw the identical glyphs where the HUD used to draw a smiley and a
    warning triangle, so the rover and the dashboard are one character, not two
    mascots. The link still carries only `hud,<level>` — the board picks the mood
    off that and animates it itself, self-clocked off `millis()` (`oledFrame` steps
    at 120ms, and a shake at 8fps reads as a stutter).
    **What capped the frame rate was never the draw interval** — a frame is ~1.3ms of
    spi — it was the sonar's ring-down waits, ~180ms of blocking every send, ~18
    dropped frames in a row. That wait is **gone** (2026-09-01): `medianPingCm()` fires
    **one** ping per send and takes the median of the last `SONAR_ITER` of them out of a
    ring buffer, because sends are already `SEND_INTERVAL` apart and the ring-down gap is
    free. `panelDelay()` was that wait and is deleted with it — the sonar was its only
    caller. The same ~180ms was also the **command latency**, because `handleCmd()` never
    ran inside it: a `stop` or a drive command sat ~200ms before the board read it, and
    idle telemetry ran at ~4Hz, not 10. **The ring must be seeded to -1 in `setup()`** —
    a zero-initialised slot reads as a wall at 0cm and ends a `until dist < 5` on the
    spot. The EMA on top (`DIST_ALPHA`) went too: the median already rejects the stray
    corner echo, and stacking both put ~2 extra samples of lag on the one number
    `until dist <` steers on. `npm run test:sonar` is the check.
    The tick is 10ms, and that is the floor worth
    having: the ssd1306 refreshes itself at ~100Hz, so anything sent faster is never
    displayed. Anything new that blocks in `loop()` for longer than the draw tick is a
    dropped frame and a command-latency hit both — the dht11's own 30ms read is one
    already. There is no `panelDelay()` to hide behind any more: make it non-blocking,
    the way the sonar now is.
    **Frame rate is not what makes it look animated** — travel is. A move of one pixel,
    or one that only ever lands on two positions, reads as two stills cutting between
    each other no matter how often it is drawn, which is what the first panel face did.
    Every mood now travels 4-12px through every pixel in between (`tri()` slides,
    `arc()` hops) and everything carries the idle bob on top, so nothing is ever
    perfectly still. `npm run test:face` diffs the two glyph tables, re-runs `tri()`
    off the sketch's constants, checks the panel's timings against the css animations,
    and fails any mood whose travel drops to a single pixel.
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
    isn't on the robot, in the tile *and* in the go/no-go verdict. `reads()`
    (`app.js:48`) is the one gate: `zeroOk` marks the three that really can read
    zero — `dist` (nothing in range), `alt` (level with the start) and `lux` (a
    genuinely dark room); everything else shows NOT READING. Add the flag when a
    sensor's zero becomes real, not when a tile looks empty.
  - **CONSOLE → DEMO DATA is the emergency stand-in for a sensor that dies mid-run**
    (`DEMO_RANGE`/`demoFill()` in `app.js`, `localStorage.demoMode`, default OFF): every
    tile `reads()` calls dead gets a plausible wandering number instead of NOT READING,
    so a wire that falls off in front of the judges doesn't turn the whole board red. It
    fills a **stale packet too** — the numbers keep moving on a dropped link, which is why
    the toggle is a deliberate act and not a fallback. **`dist` is never faked**: the sonar
    is what `until dist <` steers on, and an invented wall is worse than a blank tile.
    Browser-side only — nothing fake reaches `/api/mega/sensor`, `dataHistory`, a snapshot
    or Sage, so her readings stay honest while the tiles read pretty.
    `npm run test:demo` checks the ranges, the untouched live readings and that `dist`
    stays out.
  - **Stale telemetry is treated as no telemetry** — `PKT_STALE_MS` (3s) in `app.js`.
    The board streams at 10Hz (2Hz behind a screensaver), so the sensor stream *is* the
    heartbeat and no ping command was added. Nothing for 3s and `view` goes null: every
    tile blanks to "—", the link pill drops, ping stops claiming a number, and the bridge
    button reads NO DATA in amber instead of LINKED. A hung sketch keeps its gatt
    connection up, so "linked" alone was never proof anything was talking, and the last
    packet held on screen reads exactly like a live one.
  - **Panic stop is global** — space fires `stop` from anywhere, bound at the app root
    (Drive's own space key only listens while the drive zone is armed, which left a
    running routine with no key at all). Buttons, links and text inputs keep space for
    themselves. Every client binds it, mirror included: `stop` is never gated.
  - **The camera feed is read with `fetch`, not `<img src=…/stream>`.** The browser's
    own multipart decoder stalls: bytes keep arriving on the socket, the picture
    stops, and **nothing fires** — no `load`, no `error` — so the feed sat frozen
    until someone reloaded the page. The cam sends `Access-Control-Allow-Origin: *`
    on `/stream`, so `CamView` reads the body itself, splits it with `mjpegSplit`
    (`public/js/mjpeg.mjs`) and paints one blob url per frame — a plain single-jpeg
    decode, which can't wedge. That also makes "frozen" a *timestamp*, which is what
    the 5s watchdog reconnects on. The reconnect is silent: the last frame stays on
    screen and state is left at `live`, so no placeholder flashes over it, and the
    clock resets on connect or the watchdog re-fires every second. **Never a canvas**
    — the cam is another origin, so anything drawn from it is tainted and unreadable.
    Frames are taken **by `Content-Length`, never by scanning for the next boundary**
    (jpeg payload can spell the boundary). `npm run test:mjpeg` feeds the splitter a
    frame containing its own boundary, one byte at a time.
    **Only one `/stream` at a time exists** — the cam runs a second httpd on :81 whose
    handler never returns — so a reconnect must tear down before opening, and two
    CamViews mounted at once would deadlock.
  - **Object detection on the feed** — DETECT OBJECTS next to CAMERA SETTINGS draws
    labelled boxes over the live frame (coco-ssd / ssdlite-mobilenet-v2 on tfjs,
    `public/js/detect.mjs`). **Not opencv+yolo**: `model.detect(img)` returns the 80
    coco classes with NMS and the label table already done, where a yolo `.onnx` is
    letterboxing + sigmoid decode + NMS by hand and opencv.js is a 10MB wasm on top.
    Everything is vendored (`vendor/tf.min.js`, `vendor/coco-ssd.min.js`,
    `models/coco-ssd/`, 18MB of weights) because the venue has no internet and the
    stock `cocoSsd.load()` fetches from storage.googleapis — which works on the bench
    and dies on comp day. `npm run test:detect` is that check. The 18MB is also why
    the model loads on the first toggle, not at boot.
    **This is the one place a canvas is allowed** — it reads the `<img>`'s `blob:` url,
    which is same-origin, so the frame isn't tainted; pointing it at the cam url
    directly would throw. The overlay canvas carries the **same `.cam-feed` class** as
    the feed and is sized to the frame's natural size, so it inherits the -90deg mount
    rotation and every fpv zoom — boxes are drawn in frame-pixel coords with no
    mapping maths.
    **The model is fed an un-rotated frame, not the raw one** (`detectUpright()`), for
    the same reason `upright()` exists in `vision.js`: the cam is mounted on its side,
    only the css ever un-rotates it, and coco-ssd is not rotation invariant — a desk
    read *sink 0.28* sideways and *keyboard 0.72* upright, and across this cam's own
    stills rotating first found 20 objects against 12. The boxes come back in the
    rotated frame's coords and `rotBox()` maps them back to raw-frame coords so the
    overlay's inherited css transform still lands them on the object; that mapping is
    a sign error waiting to happen, so `npm run test:detect` checks it off-browser.
    **The mount angle is one fact in four places and there is a button for it now**
    (2026-09-03): ROTATE next to DETECT OBJECTS cycles 0/90/180/270 and drives the
    `--cam-rot` css var on `.cam-feed`, the frame `detectUpright()` hands the model,
    the label counter-rotation, and — over `POST /api/cam-rot` → `setCamRot()` in
    `vision.js` — the still **Sage** is shown. That last one is the trap: rotate only
    the picture and her vision quietly goes sideways, which is the failure the -90 was
    there to prevent in the first place. It is kept per rig in `localStorage.camRot`;
    `CAM_ROTATE` (env) is still the boot default, and `npm run test:detect` asserts all
    four copies move together and round-trips `rotBox` against its forward map at every
    angle. Remounting the cam upright is now the button, not an edit.
    **The label is drawn counter-rotated by `-rot`** for that same reason: inheriting the css
    transform is what keeps the boxes aligned for free, but it also turns the text, so a
    label drawn plainly above a box comes out *beside* it reading bottom-to-top. Cancel
    the rotation and screen-up is local -y again. **The plate is anchored on the box
    centre**, because a centre is the one point that does not move under rotation — no
    per-angle corner table, and a box coco hung off the edge cannot fling its plate
    off-screen the way a corner anchor could (the centre is still clamped into the
    frame). Keep it
    thin and small: the box is the readout, the label only says which box. Detection is on its own 100ms timer with a busy flag rather than off
    the paint path, so a slow machine drops boxes instead of frames — measured 25ms
    warm on webgl (47ms first, 733ms to load the model), against a feed that arrives
    at ~10fps, so every frame gets boxes. Without webgl it falls back to cpu at
    ~280ms and the busy flag just skips ticks. `DET_MIN_SCORE` is a bench knob — a
    real shot of a person off this cam came back at 0.52.
  - **Auto headlamp:** `lux < 100` (`LUX_DARK`) means Sage is going blind, so
    `darkCheck()` in `server.js` fires a canned line of hers on `agent-blurt`
    ("it's going dark in here — turning the headlamp on") and ramps the cam lamp
    up to **250** (`LAMP_MAX`), `LAMP_RAMP_STEP` at a time every `LAMP_RAMP_MS`
    (`rampTo()` in `vision.js` is the level list, pure and tested). The line is
    canned and not an llm call for the same reason `emitBlurt()` is: the venue's
    run has no internet and a round trip is seconds spent blind. It ramps **once**
    per dark spell — `lampAuto` latches until `lux >= LUX_LIGHT` (1.5x, hysteresis
    so it can't flap on the threshold), which is also what gives the lamp back
    rather than burning it for the rest of the run.
    **The frame-judged bracket walk is no longer wired in** — `autoLamp()` /
    `lampStep()` are still in `vision.js` and still tested, but nothing calls them:
    a ramp to a fixed 250 and a walk that reads mean luma back off the frame will
    hunt against each other if both run, so it is one or the other. The walk is
    what caught a blown-out close-up wall; wire it in *after* the ramp settles if
    that ever matters.
    `lux` parses to **null** when field 12 is absent instead of 0: a real
    pitch-black cave reads 0 lx, so 0 can't double as "not wired" or the lamp
    ramps to 250 on a rover with no bh1750. The blurt only reaches the operator
    while a briefed session is open (same gate every `agent-blurt` has).
  - **The agent tab is a terminal, not a chat box** (`Agent`/`Feed`/`FeedLine` in
    `app.js`, `.term-*`/`.fl-*` in `style.css`): a bar with the ascii face, a
    transcript, a prompt line. One row per move — `›` the operator, `●` Sage,
    `◆` a tool she reached for, with the still she read under it. The transcript
    lives on the chat object (`chat.feed`, capped at 80) so it survives a reload,
    and it is display only: what the model sees is still `chat.messages`.
  - **Sage calls her own tools** — `agentLoop()` in `server.js`. She answers with
    a `tool` in her json, the server runs it, hands her the result and asks
    again, so one turn is several visible moves ("let me take a look" → camera →
    the answer). `camera` grabs a fresh still, `sensors` re-reads the numbers;
    `led`, `finding` and `snapshot` stay one-shot side effects of the same reply.
    **Not the providers' function-calling api** — the three brains in `BRAINS`
    spell it three ways and one has no vision+tools combo at all, so the name
    rides in the json `parseSage` already reads. The loop is **bounded**
    (`wantsTool()` in `sage.js`, `SAGE_MAX_STEPS`, default 3): the last pass has
    to answer, or a model that keeps asking to look never says anything and every
    pass is a paid round trip the operator sits through. Steps go out over the
    socket as `sage-step` while she works, not with the reply.
    **The chat turn no longer ships a frame up front** — she asks for one. A
    picture in every prompt cost an svga upload on "is it hot?" *and* she reached
    for the camera anyway (an attached frame reads as history, not as "now"), so
    the turn paid for two. Measured after: 1.4s for a question with no tool,
    ~17s when she looks. `tool` takes a colon note (`sensors: temperature`) that
    the transcript prints as "Sage used temperature readings" — the operator sees
    the thing they asked about, not a field name.
    Anything a step showed her is written to `public/shots/` (last 20) so the
    transcript can show it too. `npm run test:auto` covers the parse and the bound.
  - **Sage suggests moves, she never drives** — `"move"` in her json is a short BLK
    program, and it lands in the transcript as a card with RUN / NOT NOW. Nothing
    turns until the operator presses RUN; NOT NOW sends nothing at all.
    **It is BLK and not a drive command because the card takes the on-board VM path** —
    `forward until dist < 5` compiles and uploads, so the stop happens in one `loop()`
    pass instead of a ~400ms round trip, which is the difference between stopping at
    5cm and hitting the wall. The card says which one it got (instruction count =
    board, a reason = browser) *before* it is pressed, so an operator can see a
    suggestion that would run slow. That is also why `prompts/chat.md` teaches her a
    cut-down BLK — one comparison per line, constant arguments, no `and`/`or` — and
    why `node test-blk.mjs` compiles every shape that prompt teaches: a prompt that
    drifts wider makes every card fall back to the browser silently.
    **No move she proposes drives forward blind** — `guard()` in `blk.mjs` rewrites a
    bare `forward 800` into `forward until dist < 10 timeout 800` before the card is
    built: the same burst, ended the moment the sonar sees something inside 10cm,
    which is what the board's `moveu` already does (bursts, condition re-checked every
    `loop()` pass). She is told to write the guard herself in all three prompts that
    can move the rover (`chat.md`, `blk.md`, and `autonomous.md`, which has no
    condition to ride along — a raw `drv` burst checks nothing, so there the rule is a
    distance floor); the rewrite is the belt, and the card shows the guarded text so
    what the operator reads is what runs. A `dist` guard she wrote is left alone — a
    wider berth (`until dist < 25`) is the point, not a miss — and `back`/`left`/`right`
    are never guarded, because the sensor faces forward and the check would fire on the
    wall being driven away from. **An operator's own workflow is never rewritten**:
    theirs comes back from `lint()` as a warning the run panel already shows.
    The runner is shared with `BlkCtl`, not a second copy — `playBlk()` in `app.js`
    (upload → `blk,go` → service the `evt` steps → browser fallback), so a move and a
    saved workflow can never diverge, and one `blkToken` means one program at a time.
    **CONSOLE → SAGE MOVES turns it off** (`sageMoves` in localStorage): the flag
    rides on `/api/chat`, so off tells her the drive is locked and she stops offering
    rather than writing cards the dashboard would hide.
  - **Sage can move the arm, but only when the operator asks for it in words, and
    only from the takes the crew recorded** — `"arm"` in her json is a take's
    NAME, one per line, any number of them (`ARM_MAX_TAKES` came off 2026-09-05
    — a long chain is still one YES press); `parseArm()` in `sage.js` resolves them
    against `arm_moves/` **server-side** into the flat `{ms, cmd}` tape the
    pad already replays, so the browser needs no second copy of anything. **There
    is deliberately no joint jog**: a freeform burst on a 360 with no encoder is
    exactly what the recorder exists to keep out of her hands, so every arm move
    she can ask for is one somebody already ran on the bench and kept. An unknown
    name throws the whole proposal out. The available names go into her prompt
    from the file (`armLine()`), so recording a take is all it takes to give her
    one — nothing to edit in `chat.md`, and a name written there would go stale.
    **"Only when asked" is a prompt rule, not a gate** — the gate is the YES
    press, exactly like a drive move, and SAGE MOVES off locks the arm too.
    `armJog()` still has one call site; the tape goes out as ordinary `arm,`
    commands, so the deadman applies unchanged.
  - **Each take carries its own two flags** — the bench fills up with debug takes,
    and a debug take is exactly what should not be one tap away on comp day or in
    Sage's hands. A take in `arm_moves/<name>.json` is either a bare list of steps
    (everything recorded before the flags existed — those count as usable
    everywhere) or `{steps, sage_can_use, show_in_app}`, and `armMovesFor()` in
    `sage.js` is the one filter: `/api/arm-moves` reads `show_in_app`, Sage's
    prompt and `parseArm()` read `sage_can_use`. Set them with the two chips per
    row in the configurator (`/moves/<name>/flag`) — re-recording a take keeps
    them. **A take's name is its filename, and nothing caches it** —
    `/api/arm-moves` and Sage's `armLine()` both re-read the folder per call — so
    clicking a name in the configurator renames it in place
    (`/moves/<name>/rename`, which refuses a blank, a dot-leading name, a slash
    and a collision) and both sides pick it up on their next read. **The bench itself plays anything regardless**, flags or not; they only
    gate the two places a take fires with nobody watching the arm.
  - **The arm travel ledger lives outside `<Arm/>`** (`armLedger` / `armSend()` /
    `armPlay()` in `app.js`): the pad unmounts on every tab switch, and a
    component that unmounts forgets the count — it showed a fresh meter on an arm
    already at its stop. Sage's arm cards fire from the agent feed with no pad on
    screen at all. `armSend()` is the choke point the test still asserts on, and
    the panic key kills the tape from the app root.
  - **PERMISSIONS is two modes, ASK or BYPASS** — one tap-to-flip pill in the
    agent tab's own bar next to the voice picker, not in the console drawer where
    nobody looking at Sage would find it (`sageConfirm` in localStorage, default
    ASK). **The colour is the state**: blue `--ask` + `shield` for ASK, red
    `--abort` + `shield-off` for BYPASS, so a glance at the bar says whether she
    is on a leash. Both children are keyed on the flag, so a tap remounts them
    and the swap animation replays — there is no js animation to schedule: the flag rides on `/api/chat`, `askConfirm()` in
    `server.js` parks the agent loop and emits `sage-confirm`, and the browser
    answers over the socket. **ASK gates every tool, not just the loop's two** —
    `camera`/`sensors` are gated in `agentLoop()`, and the lamp, a `finding` and a
    `snapshot` are side effects of the *reply* so they are gated inside
    `askSage()` (`allow()`); a declined side effect is skipped silently, because
    it changed nothing there is anything to tell her about. Anything new that
    fires off a parsed field belongs behind `allow()` too — `npm run test:auto`
    fails if one of the three loses it. Sage's move/arm/tape cards keep their own
    YES/NO in the feed and are not part of this. **A silent browser reads as NO** after 60s, same rule
    as blk's `ask`/`find`. It only ever gates the operator's own turns — gating
    the autonomous analysis would park the loop for a minute with nobody watching
    the feed. A declined tool is told to her as "the operator turned that down"
    so she answers from what she has instead of asking again.
  - **Sage can ask for a 10s sensor snapshot** when she isn't sure about something:
    `"snapshot": "<why>"` in her json → `takeSnapshot()` dumps the last 10s of
    `dataHistory` to `public/snapshots/<ts>.json` and logs a summary row.
    **Backwards, not forwards** — `dataHistory` already holds ~100s, so the moment
    that made her unsure is already in hand and there's nothing to wait for.
    `npm run test:auto` covers both (lamp step + convergence, snapshot summary).
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

## Tapes

A whole manual run written down and replayed as one tap — CONSOLE → **TAPES**.
`server/tapes/<name>.json`, one file per tape, filename = the name, same rules
as `arm_moves/` (no index file to fall out of step with it, editable in Finder).

- **A tape is the arm take's `{ms, cmd}`, deliberately** — same shape, same
  player, so drive, arm, lights and routines live in ONE list and there is no
  second format to keep in step. `tapePlay()` in `app.js` is `armPlay()` with one
  branch added, and it runs on `armLedger.tape`, so the panic key kills a tape
  mid-run exactly as it kills an arm take. It parks the robot at the end (`stop`
  then `arm,`) — the last step of a recording is whatever the operator's finger
  was doing, which is not necessarily "stopped".
- **Recording is a tap in `sendCmd()`, not a per-widget hook** — that is the one
  place every command leaves the browser (drive, gamepad, arm pad, lights,
  routines, Sage's cards), so everything is caught with one line and nothing new
  has to remember to register itself. `blk,` upload chatter is the one thing
  dropped: a workflow is already its own file.
- **The clock starts at the first step, not at REC** — the same dead-air-at-the-
  head bug `armrec.py`'s `clean()` fixes, for the same reason. The **gaps are the
  take** (the board's deadman lives on them), the operator's reaction time is not.
- **`@` steps never reach the board**: `@sage <cue>`, `@say <text>`,
  `@analyze [focus]`, `@log <text>`, `@led <0-255>` are the things only the PC
  has, and they are the reason a presentation run is a tape and not a `Step`
  table in `routines.h`. They are typed in by hand when the JSON is edited —
  nothing records them, because there is no button on the dashboard that means
  "say this here". Adding a kind is a case in `tapeStep()` plus its name in
  `TAPE_EVENTS`.
- **`@sage <cue>` is a cue, `@say <text>` is a script** — and a presentation read
  off a script is the same words every run and sounds like it. A cue goes to
  `/api/tape-line`, where she writes the sentence herself in her own voice off
  the live readings, so a rehearsed run comes out different every time and
  grounded in the room ("Hello everyone! I'm Sage…" was 0.75s and never twice the
  same). **The ask goes out when the tape STARTS, not when the step fires** —
  waiting seconds for a model mid-presentation is dead air — and whatever has not
  landed by then **falls back to speaking the cue as written**. The venue has no
  internet, so that fallback is the normal case, not the unhappy one: write the
  cue as a sentence that is fine to hear out loud, and the model only ever
  improves on it. One request per distinct cue, `TAPE_LINE_MS` (6s) to answer.
- **Editing is a textarea of the raw JSON**, and the file on disk is the same
  thing — trimming a botched approach, retiming a gap, or dropping a `@say` in
  is a text edit, not a timeline GUI. The server re-checks the shape on save
  (`{ms >= 0, cmd}`), because hand-edited JSON is a trust boundary.
- **Not `giga-r1/main/routines.h`** — those are `Step` tables compiled into
  flash, they have **no arm op**, and `analyze`/`say` do not exist on the board.
  A tape runs from the PC. The cost is the PC: a BLE drop mid-tape strands it the
  way a routine or an uploaded BLK program would not.
- **Sage can ask to play one, and only one, and only when asked in words** —
  `"tape"` in her json is a name, resolved server-side (`parseTape()` in
  `sage.js`) into the same `{ms, cmd}` tape the drawer plays, and it lands in the
  feed as a card with YES/NO exactly like an arm take. Chaining two is refused: a
  tape is a whole run, so a pair is a routine nobody rehearsed. The names come
  from the folder (`tapeLine()`), so recording a run is all it takes to give her
  one — nothing to edit in `chat.md`. CONSOLE → SAGE MOVES locks it with the
  drive and the arm.
- **A tape carries the same two flags an arm take does** (`sage_can_use`,
  `show_in_app`) and the same filter reads them (`armMovesFor()` — one reader,
  `readTakes(dir)`, for both folders). There is deliberately **no toggle in the
  drawer**: the file is the editor, so hiding a debug tape from Sage is a line of
  json. Missing flag = usable, same as arm.
- English-only strings in the drawer, on purpose: it is a bench tool, and the
  drawer is not something a judge sees (the feed card is translated).
  `npm run test:tape` pulls the player out of `app.js` and re-runs the
  head-shift, the `@` split, the cue prefetch and its offline fallback, and the
  end-of-tape park off-browser.

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

### BLE stalls are BLE.poll() starvation, never the host

Commands that land fine and then stop landing — or arrive hundreds of ms late,
in the dashboard, the Electron app and `armrec.py` alike — are the board, and no
host-side change can touch it. ArduinoBLE on mbed runs the HCI transport in a
**second thread** that parks received packets in a fixed buffer; the sketch
thread drains it by calling `BLE.poll()`, and when it fills the controller's
packets are **dropped, not queued**
([ArduinoBLE#130](https://github.com/arduino-libraries/ArduinoBLE/issues/130),
`HCICordioTransport.cpp`). Polling once per `loop()` pass is not enough here: an
oled frame is ~23ms of i2c and `pulseIn()` sits up to `SONAR_TIMEOUT_US`, both
longer than the 30-50ms connection interval.

`blePump()` in `main.ino` is the fix — `BLE.poll()` guarded on `bleReady`, called
from inside the known blockers: the u8g2 byte callback's end-of-transfer (~16 a
frame, so the 23ms blind spot becomes ~1.5ms), either side of `pulseIn()`, and
after the dht's ~30ms bit-bang. **Anything new that blocks `loop()` for longer
than a connection interval has to pump**, the same rule as the draw tick.
Writes-with-response are ATT-acked from inside `poll()`, so their round-trip time
is a direct read of whether polling is starved — that is what the bench probe
measures.

### The board's black box

Why the link died, read back AFTER the fact — `main.ino`'s `logRing` (48 events,
`{ms, code, arg}`) plus `RCC->RSR`, dumped as `E:log,<ms>,<text>` lines on the
notify characteristic. The dashboard asks for it on **every connect** (one
`log,` write right after `startNotifications`), so the reason for the *last*
drop is in the log panel before the next run starts. `log,clear` wipes it.

- **The ring and the reset register answer different halves of the same
  question.** A BLE drop leaves the sketch running, so the ring holds it (`ble
  down`, `loop stall <ms>`, `notify failed`); a **reset wipes the ring**, and
  the only thing that survives is `RCC->RSR`, read and cleared first thing in
  `setup()` and logged as the boot event's arg. So: events present = the board
  stayed up and the link died; ring empty + `last reset brownout` = the motors
  browned it out and no host-side fix will ever touch it. **Clearing RSR is not
  optional** — the flags latch, so a boot that skips `RCC_RSR_RMVF` reports the
  reset from three power-ups ago.
- **The reset-flag names are the dual-core ones** — `RCC_RSR_SFT1RSTF`,
  `RCC_RSR_LPWR1RSTF`, `RCC_RSR_IWDG1RSTF` (core 1's). The single-core spellings
  (`RCC_RSR_SFTRSTF`) do not exist on the H747 and are a compile error.
- **`loop stall` is the BLE-starvation symptom with a number on it** — a pass
  over `LOOP_STALL_MS` (150, ~10 connection intervals) means `BLE.poll()` went
  unfed and inbound packets were *dropped*, which reads as a dead link that comes
  back. See "BLE stalls" above; the log names it so the ring never just says
  "ble down" with no cause.
- Text is formatted **on the board** (`logName()`, `resetWhy()`), so there is no
  second code table on the dashboard to drift. `npm run test:blackbox` re-runs
  the ring wrap and the lost-event count off-board and fails if either side
  loses its half.
- **RAM only** — a power cut takes the ring (the boot line survives, it is a
  register). The upgrade if that ever matters is the RTC backup registers (32
  words that survive reset), not a bigger ring.

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
  `loop()` blocks the panel: one sonar ping is
  ~25ms of dead time and a dht11 read ~30ms, inside a 10ms draw tick — at 10Hz that's a
  visible run of dropped frames, which is exactly what reads as stutter. Anything moving (routine, blk, live drive) clears `busy` and puts the
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
- The panel is a **4-pin i2c ssd1306 at 0x3C on `Wire1` (sda1 d102 / scl1 d101)**, next to
  the bme280 (moved off Wire2 2026-09-02), via a custom u8g2 byte callback (`oledI2c1` in
  `main.ino`) — u8g2's `*_HW_I2C`
  constructor only knows the `Wire` object, and `Wire` is the arm's PCA9685 bus alone. The
  `SW_I2C` constructor it is built with is there only for its gpio/delay callback; `byte_cb`
  is replaced in `setup()`, so nothing is bit-banged. **I2C is ~10x slower than the old spi
  panel**: a full 1KB frame is ~23ms at `OLED_I2C_HZ` 400000, so `OLED_DRAW_INTERVAL` is
  40ms, not 10 — at 10 the draw re-fires the instant it returns and starves `loop()`.
  **1MHz is the usual ssd1306 overclock and this panel came up dark on it** (2026-09-02) —
  400k is the specced clock and what works here, so raise it only with the panel in front
  of you. **A dark panel is almost never the pins**: `giga-r1/i2c_scan/` sweeps all three
  buses, and 0x3C acking there means address, lines and bus are all fine and the fault is
  the clock or the charge-pump `delay(100)` before `begin()`. That scan is what settled it
  on 2026-09-02, after a bus mismatch (panel on Wire1, sketch driving Wire2) and then the
  clock had each read as "move it to another pin".
  Everything below is the **old 7-pin spi panel** (d13 sck, d11 copi, d10 dc, d12 rst on
  `SPI1`), kept because the pin-map findings still hold if it ever goes back. **Tried to move it
  off the digital header 2026-09-01 and reverted the same day**; what that cost bought:
  - **D54-D75: the datasheet and the bench disagree, and the bench won.** The datasheet
    lists D68-D75 under the display connector and D54-D67 under the camera one (§2), and
    none of D54-D75 appear in its header tables (§14.2/14.3/14.5/14.6) — but **a buzzer
    on D72 audibly beeps** (measured 2026-09-01). So that range *is* reachable on this
    board; do not repeat the claim that it isn't.
    **What is still unexplained:** the panel drew nothing on D69/D71/D73/D75 across both
    dc/rst orderings on the same day. If D72 works, that failure had some other cause and
    the block is worth retrying before it is written off.
  - **The Arduino SPI object names are offset from the ST peripheral names.** `SPI` is
    stm32 **SPI1**, and it is the **2x3 icsp header** (d89 cipo / d90 copi / d91 sck) —
    *not* a high-density connector. `SPI1` is stm32 **SPI5** (d13/d11/d12), which is what
    the panel actually uses. Nothing calls `SPI.begin()`, so stm32 SPI1 is free.
  - **Where the panel could go instead**, if the digital header is ever needed:
    **DAC0 dc / DAC1 sck / CANRX copi / CANTX rst** — the last four holes of the analog
    header (positions 21-24, adjacent), on stm32 SPI1 via
    `arduino::MbedSPI oledSPI(NC, PB_5, PA_5)`. Second choice is stm32 SPI2: sck CANTX
    (PB_13), copi A4 (PC_3), miso A5 (PC_2) — same header, not adjacent. **Note DAC0,
    DAC1 and A7 all also feed the 3.5mm audio jack**, so the jack's series parts hang off
    sck there; drop `OLED_SPI_HZ` if it tears.
  - **A0-A5 cannot host it at all** — A4 is SPI2_MOSI and A5 is SPI2_MISO, but there is
    **no sck anywhere on A0-A7 or DAC0**.
  - **The pin map is the authority and it is in no header** — it is `PinMap_SPI_SCLK` /
    `_MOSI` / `_MISO` in `PeripheralPins.o` inside `variants/GIGA/libs/libmbed.a`
    (`ar x`, then `objdump -s -j .rodata.PinMap_SPI_SCLK`). Entries are 12 bytes,
    `{PinName, peripheral base, function}`, PinName = `port*16 + pin`; SPI1 =
    0x40013000, SPI2 = 0x40003800, SPI5 = 0x40015000.
  - **Never bit-banged sw-spi**, whatever pins it moves to: ~20ms a frame against a 10ms
    draw tick means `tickPanel()` re-fires the instant it returns and the panel starves
    `loop()` outright — `BLE.poll()` stops reading an inbound `stop`, and the blk vm's
    `until dist <` check runs 20ms late every pass.
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
- `routines.h` holds five tables today — `TEST`, `PRESENTATION`, `MISSION`,
  `TEST2` and `RUN` (`RUN` is an empty `{END, 0, 0}` placeholder). `MISSION` and
  `TEST2` run on a measured pwm of 103, not `SPEED_SLOW`. All five are wired in
  `startRoutine()` and matched by lowercase name (`"test2"`, `"mission"`, …).
- Always close with `{END, 0, 0}`. **There is no arm op** — `Op` is
  `FWD BACK LEFT RIGHT WAIT ANALYZE END` and the runner has no arm case, and the
  recorded takes live in `server/arm_moves/` on the PC, not in flash. A
  routine that works the arm means a new op plus getting the take onto the board;
  today the arm only ever moves from an `arm,` command over BLE/USB.
  **A run that needs the arm, or `analyze`/`say`, is a tape, not a routine** —
  see "Tapes" above: recorded off the operator driving, replayed from the PC.
- Add/update the table, then wire it into `startRoutine()` in `main.ino` and
  (if it's a new named routine, not an edit to `RUN`) a dashboard button, per
  the file's own "Adding a routine" note.

## TODO

- (empty)

DO NOT PUSH COMMITS WITH SESSION LINKS.