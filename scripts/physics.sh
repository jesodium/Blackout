#!/usr/bin/env bash
set -euo pipefail

# Opens the MuJoCo physics sim (hardware/sim): rover + MeArm.
# Drive with the arrows (space = stop), arm with the Control panel sliders on the right.
#
# ./scripts/physics.sh            free drive
# ./scripts/physics.sh --demo     scripted: drive to the plinth, grab the cube, lift, swing
# ./scripts/physics.sh --screen 22B3HM   full size on the MSI monitor
#
# IMPORTANT NOTE: --diffbar stands in for the real corner springs, the sim's own
# spring model is a guess and pitches the rover nose-down without it.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="$HOME/.venvs/cad/bin/mjpython"
[[ -x "$PY" ]] || { echo "No MuJoCo venv at ~/.venvs/cad" >&2; exit 1; }

cd "$ROOT/hardware/sim"
exec "$PY" run.py --rocker --diffbar "$@"
