#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${1:-5500}"

# IMPORTANT NOTE: bump on busy port, give up after 10 — plenty for a docs preview
while lsof -i ":$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; do
  PORT=$((PORT + 1))
  [[ $PORT -gt 5510 ]] && { echo "No free port 5500-5510" >&2; exit 1; }
done

URL="http://localhost:$PORT"
printf "\n\033[36m▸\033[0m docs → \033[4m%s\033[0m   \033[2m(ctrl-c to stop)\033[0m\n\n" "$URL"

# IMPORTANT NOTE: express, not `python3 -m http.server` — SimpleHTTP ignores
# Range: and answers 200 with the whole file. Safari then refuses to play the
# hero video and shows only its poster. express.static answers 206.
cd "$ROOT/server"
node -e "const e=require('express');e().use(e.static('$ROOT/docs')).listen($PORT,'127.0.0.1')" &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT

sleep 1
open -a Safari "$URL"
wait $SRV
