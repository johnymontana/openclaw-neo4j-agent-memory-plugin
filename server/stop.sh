#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$SCRIPT_DIR/pid.txt"

log()  { echo "[neo4j-memory] $*"; }
err()  { echo "[neo4j-memory] ERROR: $*" >&2; }

NEO4J_INSTANCE="${NEO4J_INSTANCE:-openclaw-memory}"

# ---------------------------------------------------------------------------
# Stop the bridge server
# ---------------------------------------------------------------------------

if [ ! -f "$PID_FILE" ]; then
    # Check if something is still listening on the expected port
    BRIDGE_PORT="${BRIDGE_PORT:-7575}"
    if command -v lsof &>/dev/null; then
        ORPHAN_PID="$(lsof -iTCP:"$BRIDGE_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)" || true
        if [ -n "${ORPHAN_PID:-}" ]; then
            log "No PID file, but found process $ORPHAN_PID listening on port $BRIDGE_PORT"
            log "If this is the bridge server, stop it manually:  kill $ORPHAN_PID"
        else
            log "Bridge server is not running (no PID file, port $BRIDGE_PORT is free)"
        fi
    else
        log "Bridge server is not running (no PID file)"
    fi
else
    # Read PID and attempt graceful shutdown
    PID="$(cat "$PID_FILE")"

    if ! kill -0 "$PID" 2>/dev/null; then
        log "Bridge server was not running (stale PID $PID)"
        rm -f "$PID_FILE"
    else
        log "Stopping bridge server (PID $PID) ..."

        # Send SIGTERM for graceful shutdown
        kill "$PID" 2>/dev/null || true

        # Wait up to 5 seconds for the process to exit
        WAITED=0
        while (( WAITED < 5 )); do
            if ! kill -0 "$PID" 2>/dev/null; then
                log "Bridge server stopped gracefully"
                rm -f "$PID_FILE"
                break
            fi
            sleep 1
            (( WAITED++ )) || true
        done

        # Still alive — escalate to SIGKILL
        if kill -0 "$PID" 2>/dev/null; then
            err "Process did not exit after 5 seconds, sending SIGKILL ..."
            kill -9 "$PID" 2>/dev/null || true
            sleep 1
            if kill -0 "$PID" 2>/dev/null; then
                err "Failed to stop process $PID — you may need to kill it manually"
            else
                log "Bridge server stopped (SIGKILL)"
                rm -f "$PID_FILE"
            fi
        fi
    fi
fi

# ---------------------------------------------------------------------------
# Stop local Neo4j instance
# ---------------------------------------------------------------------------

if [ -d "$PLUGIN_DIR/node_modules/@johnymontana/neo4j-local" ]; then
    log "Stopping local Neo4j instance ($NEO4J_INSTANCE) ..."
    npx --prefix "$PLUGIN_DIR" @johnymontana/neo4j-local stop --instance "$NEO4J_INSTANCE" 2>&1 || {
        err "Failed to stop Neo4j instance (it may not have been running)"
    }
    log "Neo4j stopped"
else
    log "neo4j-local not installed, skipping Neo4j shutdown"
fi
