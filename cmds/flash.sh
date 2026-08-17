#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# blackout v2 (uno r4) firmware was renamed away in 8b84d0c and only lives in
# history now. flashing a v2 checks that sketch out of git into a temp dir —
# no retired source comes back into the tree. it's frozen: this ref IS v2.
V2_REF=829924d
V2_SRC=arduino-uno-r4/main

detect_boards() {
  python3 -c "
import json, subprocess

r = subprocess.run(['arduino-cli', 'board', 'list', '--format', 'json'],
                   capture_output=True, text=True)
data = json.loads(r.stdout)

profiles = [
    ('giga-r1/main',        'arduino:mbed_giga:giga',        'usbmodem',    'Giga R1 WiFi'),
    ('$V2_SRC',             'arduino:renesas_uno:unor4wifi', None,          'Blackout V2'),
    ('esp32-cam/main',      'esp32:esp32:esp32cam',          'usbserial',   'ESP32-CAM'),
    ('esp32-cam/main',      'esp32:esp32:esp32cam',          'wchusbserial','ESP32-CAM'),
]

seen = set()
for port_info in data.get('detected_ports', []):
    addr = port_info['port']['address']
    boards = port_info.get('matching_boards', []) or []
    detected_fqbns = {b['fqbn'] for b in boards}
    for d, fqbn, pattern, label in profiles:
        if d in seen:
            continue
        # trust a reported fqbn over the port-name guess: a uno r4 also shows up
        # on a usbmodem port, and the giga profile would otherwise swallow it.
        hit = fqbn in detected_fqbns if detected_fqbns else (pattern and pattern in addr)
        if hit:
            print(f'{d}|{fqbn}|{addr}|{label}')
            seen.add(d)
            break
"
}

spin() {
  local pid=$1 msg=$2
  local s=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
  local i=0
  while kill -0 "$pid" 2>/dev/null; do
    printf "\r\033[36m%s\033[0m %s" "${s[i]}" "$msg"
    i=$(( (i + 1) % ${#s[@]} ))
    sleep 0.08
  done
  # `wait` must be part of a || list: a bare failing wait trips `set -e` and kills
  # the script right here, which is how a failed compile used to exit silently
  # mid-spinner with no message at all.
  local rc=0
  wait "$pid" || rc=$?
  if [[ $rc -eq 0 ]]; then
    printf "\r\033[32m✔\033[0m %s\n" "$msg"
  else
    printf "\r\033[31m✘\033[0m %s\n" "$msg" >&2
    # the whole point of the spinner is hiding arduino-cli's noise — but hiding it
    # on failure too is why "flash.sh doesn't work" used to come with no reason.
    [[ -s "$log" ]] && cat "$log" >&2
    hint >&2
    exit $rc
  fi
}

# known failures that look like "the script is broken" but aren't. one line each,
# matched against arduino-cli's own output.
hint() {
  if grep -q "bad CPU type in executable" "$log"; then
    cat <<'EOT'

  → Apple Silicon Mac without Rosetta 2. arduino:mbed_giga ships an x86_64
    arm-none-eabi-gcc (7-2017q4), so the compiler can't even start. Install it
    once and this works forever:

        softwareupdate --install-rosetta --agree-to-license

EOT
  elif grep -qi "no device found\|failed uploading\|can't open device" "$log"; then
    echo
    echo "  → Board didn't answer on the port. Double-tap RST on the Giga to force"
    echo "    the bootloader, then run this again."
    echo
  fi
}

boards=$(detect_boards)
if [[ -z "$boards" ]]; then
  echo "No boards found. Connect Giga R1 or ESP32-CAM." >&2
  exit 1
fi

log=$(mktemp)
boards_ts=$(mktemp)
v2tmp=$(mktemp -d)
trap 'rm -rf "$log" "$boards_ts" "$v2tmp"' EXIT
echo "$boards" > "$boards_ts"

HEAD_REF=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo "?")

# remember what source each board was last flashed from, so the dashboard can
# say "out of date" without the firmware having to report its own version.
# IMPORTANT NOTE: only knows about flashes that went through this script — a
# board flashed elsewhere reads as unknown. have the sketch report a build hash
# over ble if that stops being good enough.
record() {
  local f="$ROOT/.last-flash"
  { [[ -f "$f" ]] && grep -v "^$1|" "$f" || true; } > "$f.tmp"
  echo "$1|$2" >> "$f.tmp"
  mv "$f.tmp" "$f"
}

while IFS='|' read -r dir fqbn port label; do
  src="$ROOT/$dir"
  ref="$HEAD_REF"
  if [[ "$dir" == "$V2_SRC" ]]; then
    git -C "$ROOT" archive "$V2_REF" "$V2_SRC" | tar -x -C "$v2tmp"
    src="$v2tmp/$V2_SRC"
    ref="$V2_REF"
  fi

  printf "\033[36m▸\033[0m %s @ %s — %s\n" "$label" "$port" "$ref"

  ( arduino-cli compile --fqbn "$fqbn" "$src" >"$log" 2>&1 ) &
  spin $! "  Compile $dir"

  if [[ "$label" == "ESP32-CAM" ]]; then
    echo "  ⚠  Hold GPIO0→GND, press RST, release GPIO0 for flash mode"
    sleep 1
  fi

  # Giga R1 re-enumerates after compile — get fresh port
  fresh=$(detect_boards | grep "^$dir|" | head -1 | cut -d'|' -f3)
  port="${fresh:-$port}"

  # one silent retry: the board is mid-re-enumeration often enough that the first
  # upload hits a port that existed a second ago. anything that fails twice is real.
  ( arduino-cli upload -p "$port" --fqbn "$fqbn" "$src" >"$log" 2>&1 ||
    { sleep 2; port=$(detect_boards | grep "^$dir|" | head -1 | cut -d'|' -f3 || true)
      arduino-cli upload -p "${port:-$fresh}" --fqbn "$fqbn" "$src" >"$log" 2>&1; } ) &
  spin $! "  Upload → $port"
  record "$dir" "$ref"
done < "$boards_ts"

printf "\n\033[32mDone — %s\033[0m\n" "$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo "?")"
