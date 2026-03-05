#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/pid.txt"
LOG_FILE="$SCRIPT_DIR/server.log"

# Check if already running
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        echo "Bridge server already running (PID $PID)"
        exit 0
    fi
    rm -f "$PID_FILE"
fi

# Install dependencies if needed
if ! python3 -c "import fastapi" 2>/dev/null; then
    echo "Installing dependencies..."
    pip3 install -r "$SCRIPT_DIR/requirements.txt" --quiet
fi

# Read config from environment or openclaw config
export NEO4J_URI="${NEO4J_URI:-bolt://localhost:7687}"
export NEO4J_USER="${NEO4J_USER:-neo4j}"
export NEO4J_PASSWORD="${NEO4J_PASSWORD:-password}"
export AGENT_ID="${AGENT_ID:-default}"
export BRIDGE_PORT="${BRIDGE_PORT:-7474}"

echo "Starting Neo4j Memory Bridge on port $BRIDGE_PORT..."
nohup python3 "$SCRIPT_DIR/main.py" > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
echo "Bridge server started (PID $(cat "$PID_FILE"))"

# Wait briefly and check that it started
sleep 2
if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "ERROR: Server failed to start. Check $LOG_FILE"
    cat "$LOG_FILE"
    rm -f "$PID_FILE"
    exit 1
fi

echo "Health check: http://localhost:$BRIDGE_PORT/memory/health"
