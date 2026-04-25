#!/bin/bash
# wal-checkpoint.sh — hourly housekeeping for miracle/askmiracle.
#
# WAL: PASSIVE checkpoint, never blocks a writer; journal_size_limit caps
#      the WAL after each checkpoint.
# Queue expiry: pending jobs older than 7 days flip to 'expired' so they
#      don't sit forever in queue.db (no built-in TTL in the schema).
# Sandbox cleanup: empty UUID dirs under ~/.askmiracle/sandbox/ older than
#      one day are removed (orphans from interrupted plan runs).
# Metrics rotation: ~/.askmiracle/metrics.jsonl over 50MB is rolled to
#      .1, .2, .3 (kept 3 weeks, the rest dropped).

set -uo pipefail

DBS=(
  "$HOME/.miracle/queue.db"
  "$HOME/.miracle/slice.db"
  "$HOME/.askmiracle/queue.db"
)

for db in "${DBS[@]}"; do
  [ -f "$db" ] || continue
  sqlite3 "$db" "PRAGMA journal_size_limit=8388608; PRAGMA wal_checkpoint(PASSIVE);" 2>&1 | \
    awk -v db="$(basename "$db")" '{print db ": " $0}'
done

# --- Queue expiry: pending jobs older than 7 days → 'expired' ---
# Timestamps in jobs.created_at are unix-millis (e.g. 1776813415469).
NOW_MS=$(($(date +%s) * 1000))
SEVEN_DAYS_MS=$((7 * 86400 * 1000))
EXPIRY_THRESHOLD=$((NOW_MS - SEVEN_DAYS_MS))

for db in "$HOME/.miracle/queue.db" "$HOME/.askmiracle/queue.db"; do
  [ -f "$db" ] || continue
  # Both schemas have jobs(id, status, created_at). Use a no-op-on-zero update.
  expired_count=$(sqlite3 "$db" \
    "UPDATE jobs SET status='expired', updated_at=$NOW_MS WHERE status='pending' AND created_at < $EXPIRY_THRESHOLD; SELECT changes();" 2>/dev/null \
    | tail -1)
  if [ "${expired_count:-0}" -gt 0 ] 2>/dev/null; then
    echo "$(basename "$db"): expired $expired_count stale pending jobs"
  fi
done

# --- hook_events prune: NULL job_id rows older than 30 days ---
if [ -f "$HOME/.miracle/queue.db" ]; then
  sqlite3 "$HOME/.miracle/queue.db" "DELETE FROM hook_events WHERE job_id IS NULL AND received_at < datetime('now', '-30 days');"
  echo "$(date): pruned NULL hook_events older than 30 days"
fi

# --- Sandbox UUID cleanup: empty dirs older than 1 day ---
if [ -d "$HOME/.askmiracle/sandbox" ]; then
  removed=$(find "$HOME/.askmiracle/sandbox" -type d -empty -mtime +1 -print -delete 2>/dev/null | wc -l | tr -d ' ')
  if [ "${removed:-0}" -gt 0 ]; then
    echo "askmiracle/sandbox: removed $removed empty UUID dirs"
  fi
fi

# --- metrics.jsonl rotation: roll at 50MB, keep 3 backups ---
METRICS="$HOME/.askmiracle/metrics.jsonl"
MAX_SIZE=$((50 * 1024 * 1024))
if [ -f "$METRICS" ]; then
  size=$(stat -f%z "$METRICS" 2>/dev/null || echo 0)
  if [ "$size" -gt "$MAX_SIZE" ]; then
    rm -f "$METRICS.3"
    [ -f "$METRICS.2" ] && mv "$METRICS.2" "$METRICS.3"
    [ -f "$METRICS.1" ] && mv "$METRICS.1" "$METRICS.2"
    mv "$METRICS" "$METRICS.1"
    : > "$METRICS"
    echo "metrics.jsonl: rotated (was $size bytes)"
  fi
fi
