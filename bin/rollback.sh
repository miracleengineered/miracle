#!/usr/bin/env bash
# rollback.sh — one-command rollback of miracle/bot to a known-good SHA.
# Scope: main bot only. Does NOT touch digest, monitor, session-log, or
# the python tutoring/cam bots — they're independent processes with their
# own deploys.
#
# Usage:
#   ./rollback.sh                 # rollback to LAST_GOOD_SHA (or HEAD~1 fallback)
#   ./rollback.sh --to-sha <sha>  # rollback to specific commit
#   ./rollback.sh --dry-run       # preview without executing
#
# Health check: post-restart, polls /health endpoint for up to 60s.
# If /health hasn't responded by then, exits non-zero so the caller
# knows the rollback didn't reach a healthy state.
#
# Adapted from askmiracle-v1's rollback.sh (T3.4, 2026-04-25).

set -euo pipefail

REPO="/Users/genesisai/Projects/miracle/bot"
LABEL="com.miracle.bot"
LAST_GOOD_FILE="${REPO}/.last-good-sha"
HEALTH_URL="${MIRACLE_BOT_HEALTH_URL:-http://127.0.0.1:8787/health}"
DRY_RUN=0
TARGET_SHA=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --to-sha)  TARGET_SHA="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

cd "$REPO"

if [[ -z "$TARGET_SHA" ]]; then
  if [[ -f "$LAST_GOOD_FILE" ]]; then
    TARGET_SHA="$(cat "$LAST_GOOD_FILE")"
  else
    TARGET_SHA="$(git rev-parse HEAD~1 2>/dev/null || echo '')"
  fi
fi

if [[ -z "$TARGET_SHA" ]]; then
  echo "[rollback] no target SHA (empty LAST_GOOD_FILE and no HEAD~1)" >&2
  exit 3
fi

CURRENT_SHA="$(git rev-parse HEAD)"
echo "[rollback] current=$CURRENT_SHA target=$TARGET_SHA dry_run=$DRY_RUN"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "[rollback] would: git reset --hard $TARGET_SHA"
  echo "[rollback] would: launchctl kickstart -k gui/\$UID/$LABEL"
  echo "[rollback] would: poll $HEALTH_URL up to 60s"
  exit 0
fi

if [[ "$CURRENT_SHA" == "$TARGET_SHA" ]]; then
  echo "[rollback] already at target"
  exit 0
fi

git reset --hard "$TARGET_SHA"
echo "[rollback] code reset; restarting bot"

launchctl kickstart -k "gui/$UID/$LABEL" 2>/dev/null || {
  echo "[rollback] bot not loaded; bootstrapping"
  launchctl bootstrap "gui/$UID" "$HOME/Library/LaunchAgents/$LABEL.plist" 2>/dev/null || true
}

# Wait-for-healthy: poll /health endpoint for up to 60s
DEADLINE=$(( $(date +%s) + 60 ))
while (( $(date +%s) < DEADLINE )); do
  if curl -sf --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
    echo "[rollback] healthy; /health responded"
    exit 0
  fi
  sleep 2
done

echo "[rollback] did NOT reach healthy within 60s" >&2
exit 4
