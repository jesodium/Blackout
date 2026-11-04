#!/usr/bin/env bash
set -euo pipefail

# Browsable file server over docs/marketing — the frames page, the css, and the
# exported PNGs in out/, all clickable. IMPORTANT NOTE: python3 http.server, not
# express like docs.sh, purely for the free directory listing; nothing here needs
# the Range support docs.sh went to express for (no video, just jpgs).
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${1:-5520}"

while lsof -i ":$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; do
  PORT=$((PORT + 1))
  [[ $PORT -gt 5530 ]] && { echo "No free port 5520-5530" >&2; exit 1; }
done

URL="http://localhost:$PORT/marketing/"
printf "\n\033[36m▸\033[0m marketing → \033[4m%s\033[0m   \033[2m(ctrl-c to stop)\033[0m\n" "$URL"
printf "  \033[2mexport PNGs: node docs/marketing/export.mjs\033[0m\n\n"

# served from docs/ so the frames' ../assets/*.jpg resolve; opens on marketing/
cd "$ROOT/docs"
python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT

sleep 1
open -a Safari "$URL"
wait $SRV
