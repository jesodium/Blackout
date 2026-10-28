# BLACKOUT sim (MuJoCo)

Rover + MeArm with real physics: contacts/friction, rocker suspension, TT motors as DC
motors (stall torque + back-EMF + gearbox friction), SG90s as torque-limited position servos.
Replaces `../arm-sim/` (three.js, kinematics only).

```sh
../../scripts/physics.sh [--demo]                   # shortcut: --rocker --diffbar, the current rover
~/.venvs/cad/bin/mjpython run.py                     # drive: arrows, space = stop; arm: Control panel sliders
~/.venvs/cad/bin/mjpython run.py --demo --diffbar    # drive to plinth, grab artifact, lift, swing
~/.venvs/cad/bin/python   run.py --demo --headless   # no window, prints servo load %
~/.venvs/cad/bin/mjpython run.py --screen 22B3HM      # open full-size on the MSI monitor
~/.venvs/cad/bin/mjpython run.py --rocker            # old rocker drivetrain (blackout_rocker.xml)
~/.venvs/cad/bin/python   drivetrain_test.py         # headless: settle, flat, step, ramp, pivot turn, rocks per variant
```

`blackout.xml` is the v4 swing-arm drivetrain (teacher's plate under the body, 4 free trailing arms, no springs).
As designed the weight folds every arm up ~10° until the tyres jam against the plate edge and the rover cannot move;
`drivetrain_test.py` also runs it with a bump stop, arm springs and locked arms. Arm travel limits come from
`tools/v4_limits.py` (geometry sweep against the chassis) into `tools/raw/v4_limits.json`.

2026-10-17: `blackout.xml` is the current build: v4 plate screwed to the side frames (8x M3x16 csk), body walls +15 mm
(`LIFT`), roof + HW-170/LCD boxes + RPLIDAR C1 raised with it, arm group 4 mm forward down the hood, demo plinth +16 mm
(v4 rides higher). `tools/sweep_check.py --v4` checks the arm against that roof stack.

`--diffbar` fits the proposed roof differential bar (not needed now that the corner springs are modelled).
As built: the four corner bump-stop springs (photos IMG_3813-15, `tools/corner_springs.py`) catch the body at ~3° pitch.
Before they were modelled:
nothing ties the rockers, so the arm's weight pitches the chassis ~28° nose-down until the
rockers hit the side frames and the front armor drags.

The MeArm sits on a wedge pedestal on the front armor (`ARM_MOUNT`, `hardware/cad/arm_pedestal_armor.stl`) with the forearm
at 100 mm (`FOREARM`, stock 81). The shoulder stops at horizontal, so the claw bottoms out ~10 cm above the floor: it grabs
off ledges, not the ground (207 mm would reach the floor but pitches the rover ~25° nose-down without `--diffbar`).
As is, the corner springs hold the rover at ~5° with the arm out.

Rebuild after CAD changes: run `tools/fusion_dump.py` in Fusion (`python3 tools/fusion_http.py tools/fusion_dump.py`),
then `~/.venvs/cad/bin/python tools/build_sim.py` (add `--rocker` for the old drivetrain, built from `tools/raw_rocker/`). Calibration knobs (servo torque, TT stall/no-load,
masses) are at the top of `build_sim.py`. Then `~/.venvs/cad/bin/python tools/export_glb.py` refreshes the dashboard Live View model (`server/public/models/rover.glb`).
