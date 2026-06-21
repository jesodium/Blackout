# TODO

## MQ-9 CO calibration — finish Option B (hardcoded R₀)

**Goal:** fixed clean-air baseline `R₀` so the MQ-9 uses the same trusted value every
boot, instead of auto-calibrating on every power-on. (Auto-cal each boot is risky —
if it boots in non-clean air or isn't warmed up, it bakes a wrong baseline.)

**Current state (2026-06-18):**
- Mega is flashed with the *auto-cal-every-boot* firmware (works, but not what we want).
- `arduino-mega/main/main.ino` has a half-done edit: `#define MQ9_R0 -1.0` exists but is
  **unused** — the loop still auto-cals via the `mq9Calibrated` flag. Compiles clean,
  **not yet flashed**. See `TODO(mq9-cal)` comment in that file.

**Steps to finish:**
1. Rewrite the loop's calibration block in `main.ino`:
   - `MQ9_R0 > 0` → use the fixed value directly, no calibration phase.
   - `MQ9_R0 == -1` → after `MQ9_WARMUP_MS`, measure once and print
     `MQ9 MEASURED R0=...` for the operator to copy. (Remove `mq9Calibrated`.)
2. Flash with `MQ9_R0 = -1`. Keep sensor in **clean air**, warm up **5–10 min**,
   read the printed R₀ from serial (dashboard serial monitor = backtick `` ` ``).
3. Paste that number into `#define MQ9_R0`, re-flash → done.

**Also still open (CO ppm accuracy):**
- Derive real `MQ9_CURVE_M` / `MQ9_CURVE_B` from two points on the MQ-9 datasheet CO
  curve (current values are placeholders). Formula in the chat / `main.ino` comments.
- Verify `MQ9_RL` (measure the module's load resistor with a multimeter).
- ppm is **serial-print only** right now. Once trusted, wire it into the BT packet
  (replace raw `co`) and update the AI hazard thresholds in `server/prompts/*.md`
  (they currently judge raw ADC counts, not ppm).

**Note on the 215–351 drift:** that's slow sensor drift, not noise (EMA smoothing is
working — consecutive samples ramp smoothly). Likely incomplete warm-up and/or power
sag from the heater (~150mA). Power the sensor from a stable dedicated 5V, common
ground. Calibration won't remove live drift, only re-zeros the baseline.

## Upload helper
```
# free the serial port (server grabs it), then flash:
pkill -f "node server.js"
cd arduino-mega/main
arduino-cli upload --fqbn arduino:avr:mega -p /dev/cu.usbserial-140 .
# restart dashboard:
cd ../../server && node server.js &
```
