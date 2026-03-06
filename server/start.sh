#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"
PID_FILE="$SCRIPT_DIR/pid.txt"
LOG_FILE="$SCRIPT_DIR/server.log"
MIN_PYTHON_MAJOR=3
MIN_PYTHON_MINOR=10

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log()  { echo "[neo4j-memory] $*"; }
err()  { echo "[neo4j-memory] ERROR: $*" >&2; }
die()  { err "$@"; exit 1; }

# Find a suitable Python ≥ 3.10, checking common names in PATH
find_python() {
    local candidates=("python3.12" "python3.11" "python3.10" "python3" "python")
    for cmd in "${candidates[@]}"; do
        if command -v "$cmd" &>/dev/null; then
            local version
            version="$("$cmd" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>/dev/null)" || continue
            local major minor
            major="${version%%.*}"
            minor="${version##*.}"
            if (( major > MIN_PYTHON_MAJOR || (major == MIN_PYTHON_MAJOR && minor >= MIN_PYTHON_MINOR) )); then
                echo "$cmd"
                return 0
            fi
        fi
    done
    return 1
}

# Wait for the server to respond on its health endpoint (up to $1 seconds)
wait_for_health() {
    local url="http://localhost:${BRIDGE_PORT}/memory/health"
    local max_wait="${1:-10}"
    local elapsed=0
    while (( elapsed < max_wait )); do
        if curl -sf "$url" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
        (( elapsed++ )) || true
    done
    return 1
}

# ---------------------------------------------------------------------------
# Guard: already running?
# ---------------------------------------------------------------------------

if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        log "Bridge server already running (PID $PID)"
        exit 0
    fi
    log "Removing stale PID file (process $PID is gone)"
    rm -f "$PID_FILE"
fi

# ---------------------------------------------------------------------------
# Locate a compatible Python
# ---------------------------------------------------------------------------

PYTHON="$(find_python)" || die \
    "Python >= ${MIN_PYTHON_MAJOR}.${MIN_PYTHON_MINOR} is required but not found in PATH." \
    "Install it from https://www.python.org/downloads/ or via your system package manager."

PYTHON_VERSION="$("$PYTHON" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')")"
log "Using $PYTHON ($PYTHON_VERSION)"

# ---------------------------------------------------------------------------
# Create / activate virtualenv
# ---------------------------------------------------------------------------

if [ ! -d "$VENV_DIR" ]; then
    log "Creating virtualenv in $VENV_DIR ..."
    "$PYTHON" -m venv "$VENV_DIR" || die "Failed to create virtualenv. Ensure the 'venv' module is installed (e.g. apt install python3-venv)."
fi

# Always use the venv Python/pip from here on
VENV_PYTHON="$VENV_DIR/bin/python"
VENV_PIP="$VENV_DIR/bin/pip"

# ---------------------------------------------------------------------------
# Install / upgrade dependencies
# ---------------------------------------------------------------------------

if ! "$VENV_PYTHON" -c "import fastapi, uvicorn, neo4j" 2>/dev/null; then
    log "Installing dependencies ..."
    "$VENV_PIP" install --upgrade pip --quiet 2>/dev/null
    "$VENV_PIP" install -r "$SCRIPT_DIR/requirements.txt" --quiet \
        || die "Failed to install Python dependencies. Check $SCRIPT_DIR/requirements.txt"
fi

# ---------------------------------------------------------------------------
# Environment defaults
# ---------------------------------------------------------------------------

export NEO4J_URI="${NEO4J_URI:-bolt://localhost:7687}"
export NEO4J_USER="${NEO4J_USER:-neo4j}"
export NEO4J_PASSWORD="${NEO4J_PASSWORD:-password}"
export AGENT_ID="${AGENT_ID:-default}"
export BRIDGE_PORT="${BRIDGE_PORT:-7474}"

# ---------------------------------------------------------------------------
# Check port availability
# ---------------------------------------------------------------------------

if command -v lsof &>/dev/null; then
    if lsof -iTCP:"$BRIDGE_PORT" -sTCP:LISTEN -t &>/dev/null; then
        BLOCKING_PID="$(lsof -iTCP:"$BRIDGE_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
        die "Port $BRIDGE_PORT is already in use (PID $BLOCKING_PID). Set BRIDGE_PORT to use a different port."
    fi
fi

# ---------------------------------------------------------------------------
# Start the server
# ---------------------------------------------------------------------------

log "Starting bridge server on port $BRIDGE_PORT ..."
nohup "$VENV_PYTHON" "$SCRIPT_DIR/main.py" >> "$LOG_FILE" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_FILE"

# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

if wait_for_health 10; then
    log "Bridge server started (PID $SERVER_PID)"
    log "Health: http://localhost:$BRIDGE_PORT/memory/health"
    log "Logs:   $LOG_FILE"
else
    err "Server failed to become healthy within 10 seconds."
    if kill -0 "$SERVER_PID" 2>/dev/null; then
        err "Process is running but not responding — check Neo4j connectivity."
    else
        err "Process exited. Last 20 lines of log:"
        tail -20 "$LOG_FILE" >&2 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
    exit 1
fi
