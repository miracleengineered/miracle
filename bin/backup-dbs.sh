#!/bin/bash
# backup-dbs.sh — hourly online backup of miracle + askmiracle SQLite databases.
#
# Uses `sqlite3 .backup` which is online-safe (no lock conflict with the
# running bot, unlike `cp`). Stores backups under ~/.miracle/backups/.
#
# Retention:
#   - hourly  backups: kept 7 days
#   - daily   backups: kept 30 days (one per day, the most recent that day)
#
# Run via launchd (com.miracle.backup-dbs.plist) every hour.

set -uo pipefail

BACKUP_ROOT="$HOME/.miracle/backups"
HOURLY_DIR="$BACKUP_ROOT/hourly"
DAILY_DIR="$BACKUP_ROOT/daily"
mkdir -p "$HOURLY_DIR" "$DAILY_DIR"

DBS=(
  "$HOME/.miracle/queue.db"
  "$HOME/.miracle/slice.db"
  "$HOME/.askmiracle/queue.db"
)

TS=$(date +%Y%m%d-%H%M%S)
DAY=$(date +%Y%m%d)

for db in "${DBS[@]}"; do
  [ -f "$db" ] || continue
  base=$(basename "$db" .db)
  account=$(basename "$(dirname "$db")")  # ".miracle" or ".askmiracle"

  # Online backup via sqlite3 .backup (no lock contention with bot)
  hourly_path="$HOURLY_DIR/${account#.}-${base}-${TS}.db"
  if sqlite3 "$db" ".backup '$hourly_path'" 2>/dev/null; then
    echo "$(date '+%Y-%m-%d %H:%M:%S'): backed up $db -> $hourly_path"
  else
    echo "$(date '+%Y-%m-%d %H:%M:%S'): backup FAILED for $db" >&2
    continue
  fi

  # Daily snapshot: one per day per db, replaces earlier-in-day version
  daily_path="$DAILY_DIR/${account#.}-${base}-${DAY}.db"
  cp "$hourly_path" "$daily_path" 2>/dev/null
done

# Retention sweeps
find "$HOURLY_DIR" -name "*.db" -mtime +7 -delete 2>/dev/null
find "$DAILY_DIR" -name "*.db" -mtime +30 -delete 2>/dev/null

# Report sizes
HOURLY_COUNT=$(find "$HOURLY_DIR" -name "*.db" | wc -l | tr -d ' ')
DAILY_COUNT=$(find "$DAILY_DIR" -name "*.db" | wc -l | tr -d ' ')
TOTAL_SIZE=$(du -sh "$BACKUP_ROOT" 2>/dev/null | cut -f1)
echo "$(date '+%Y-%m-%d %H:%M:%S'): retention OK — hourly=$HOURLY_COUNT daily=$DAILY_COUNT total=$TOTAL_SIZE"
