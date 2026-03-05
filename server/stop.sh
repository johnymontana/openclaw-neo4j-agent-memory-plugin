#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/pid.txt"

if [ ! -f "$PID_FILE" ]; then
    echo "Bridge server is not running (no PID file)"
    exit 0
fi

PID=$(cat "$PID_FILE")
if kill -0 "$PID" 2>/dev/null; then
    echo "Stopping bridge server (PID $PID)..."
    kill "$PID"
    sleep 1
    # Force kill if still running
    if kill -0 "$PID" 2>/dev/null; then
        kill -9 "$PID"
    fi
    echo "Bridge server stopped"
else
    echo "Bridge server was not running (stale PID file)"
fi

rm -f "$PID_FILE"
