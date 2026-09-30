#!/usr/bin/env bash
# Live-reloading server for the landing page (docs/). Usage: ./serve-site.sh [port]
cd "$(dirname "$0")/docs" && exec npx --yes live-server --port="${1:-8080}"
