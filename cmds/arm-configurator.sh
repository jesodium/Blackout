#!/usr/bin/env bash
set -euo pipefail

# Bench rig for the arm: hold-to-jog every joint, record a take, save it by name
# into server/arm_moves.json. The dashboard turns each saved take into one tap,
# which is the point — the arrows and hold sliders are what overdrives a joint,
# so the overdriving happens once, here, on the cable.
#
# IMPORTANT NOTE: this drives the GIGA over USB, not the Uno bench rig — main.ino
# reads the same command strings off Serial that it reads off BLE. Close the
# dashboard's BLE link first if the arm starts arguing with itself.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT=5006
BLE=""

# ./cmds/arm-configurator.sh [port] [--ble]
for a in "$@"; do
  case "$a" in
    --ble) BLE="--ble" ;;                  # start on the link the rover runs on
    *) PORT="$a" ;;
  esac
done

# bump on busy port, same as docs.sh — give up after 10
while lsof -i ":$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; do
  PORT=$((PORT + 1))
  [[ $PORT -gt 5016 ]] && { echo "No free port 5006-5016" >&2; exit 1; }
done

URL="http://127.0.0.1:$PORT"   # not localhost: safari tries ::1 first, and a refused
                                #  connection per request is the lag all over again
printf "\n\033[36m▸\033[0m arm configurator → \033[4m%s\033[0m   \033[2m(ctrl-c to stop)\033[0m\n" "$URL"
printf "  \033[2msaves to server/arm_moves.json — space is the panic stop\033[0m\n"
printf "  \033[2mUSB / BLE picker is on the page; --ble starts there\033[0m\n\n"

python3 "$ROOT/server/armrec.py" --port "$PORT" $BLE &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT

sleep 1
open -a Safari "$URL"
wait $SRV
