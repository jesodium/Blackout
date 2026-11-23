# TODO

## Sage reads instructions off the camera
Show the camera a card like `[LOWER ARM]` and Sage sees it, says "Lowering arm." and
plays the matching take, no operator in the loop.
- She already has the pieces: the arm takes (`server/data/arm_moves/`), the arm
  player (`server/src/armplay.js`) and the autonomous analysis loop
  (`server/src/sage/analysis.js`), which looks at frames but never sets `arm`.
- Needs: a card word → take map (or let her match names), the analysis loop allowed
  to set `arm` only when a card is in frame, and a guard so the same card sitting in
  view doesn't replay the take every frame.

## Stale
- `server/test/arm.mjs` still asserts the old 6-joint continuous-servo arm; rewrite for
  the 4-joint MeArm (`firmware/giga/main/arm.h`) or drop it.
