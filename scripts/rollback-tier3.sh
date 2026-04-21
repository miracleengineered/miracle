#!/bin/bash
# rollback-tier3.sh — roll the live bot back from Tier 3 to MVP path.
#
# Flips TIER_3_ENABLED=false in com.miracle.bot.plist, then reloads the
# launchd job via bootout + bootstrap (the modern way — NOT kickstart -k,
# which respawns against a cached job spec and does not re-read the plist).
#
# Default is --dry-run. Pass --execute to actually roll back.
#
# Exit codes:
#   0 — success (or dry run completed)
#   1 — preflight failure (plist missing, not a user job, etc.)
#   2 — rollback failed verification (TIER_3_ENABLED still true, or port
#       8787 still bound)
#   3 — already rolled back (no-op, not an error)

set -u

PLIST="$HOME/Library/LaunchAgents/com.miracle.bot.plist"
LABEL="com.miracle.bot"
UID_STR="$(id -u)"
DOMAIN="gui/$UID_STR"
TIER_3_PORT=8787

MODE="dry-run"
for arg in "$@"; do
  case "$arg" in
    --execute) MODE="execute" ;;
    --dry-run) MODE="dry-run" ;;
    -h|--help)
      grep '^#' "$0" | head -20
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      exit 1
      ;;
  esac
done

say() { echo "[rollback-tier3] $*"; }
run() {
  if [ "$MODE" = "dry-run" ]; then
    echo "[dry-run] $*"
  else
    echo "[exec] $*"
    eval "$@"
  fi
}

# --- Preflight ---
say "mode: $MODE"

if [ ! -f "$PLIST" ]; then
  say "ERROR: plist not found at $PLIST"
  exit 1
fi

CURRENT_TIER3=$(/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:TIER_3_ENABLED" "$PLIST" 2>/dev/null || echo "<unset>")
say "plist TIER_3_ENABLED currently: $CURRENT_TIER3"

if [ "$CURRENT_TIER3" = "false" ]; then
  say "already rolled back (plist TIER_3_ENABLED=false). No action."
  exit 3
fi

CURRENT_PID=$(launchctl list | awk -v lbl="$LABEL" '$3 == lbl {print $1}')
say "current bot PID: ${CURRENT_PID:-<not running>}"

# --- Flip plist ---
say "flipping plist TIER_3_ENABLED to false..."
run "/usr/libexec/PlistBuddy -c 'Set :EnvironmentVariables:TIER_3_ENABLED false' \"$PLIST\""

# --- Bootout ---
say "bootout current job (bootout, NOT kickstart -k)..."
run "launchctl bootout $DOMAIN/$LABEL"

# --- Bootstrap ---
say "bootstrap from plist..."
run "launchctl bootstrap $DOMAIN \"$PLIST\""

# --- Verification ---
if [ "$MODE" = "dry-run" ]; then
  say "dry run complete. No changes were made."
  exit 0
fi

# Give launchd a moment to settle
sleep 2

POST_TIER3=$(/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:TIER_3_ENABLED" "$PLIST")
POST_ENV=$(launchctl print "$DOMAIN/$LABEL" 2>/dev/null | awk '/TIER_3_ENABLED/ {print}' | head -1)
POST_PID=$(launchctl list | awk -v lbl="$LABEL" '$3 == lbl {print $1}')
PORT_BOUND=$(lsof -iTCP:$TIER_3_PORT -sTCP:LISTEN 2>/dev/null | grep -v COMMAND | head -1)

say "post-rollback state:"
say "  plist TIER_3_ENABLED: $POST_TIER3"
say "  launchd env: ${POST_ENV:-<not found>}"
say "  bot PID: ${POST_PID:-<not running>}"
say "  port $TIER_3_PORT bound: ${PORT_BOUND:-no}"

FAIL=0
if [ "$POST_TIER3" != "false" ]; then
  say "FAIL: plist TIER_3_ENABLED is $POST_TIER3, expected false"
  FAIL=1
fi
if [ -n "$PORT_BOUND" ]; then
  say "FAIL: port $TIER_3_PORT is still bound"
  FAIL=1
fi
if [ -z "$POST_PID" ]; then
  say "FAIL: bot not running after bootstrap"
  FAIL=1
fi

if [ "$FAIL" -eq 1 ]; then
  exit 2
fi

say "rollback verified. Bot running on MVP path."
exit 0
