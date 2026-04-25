#!/usr/bin/env bash
# Rotate Miracle log files. Keep 7 days of archives.
set -euo pipefail

LOG_DIR="$HOME/.miracle/logs"
ARCHIVE_DIR="$LOG_DIR/archive"
MAX_SIZE_BYTES=5242880  # 5MB

mkdir -p "$ARCHIVE_DIR"

for f in "$LOG_DIR"/*.out "$LOG_DIR"/*.err; do
    [[ -f "$f" ]] || continue
    size=$(stat -f%z "$f" 2>/dev/null || echo 0)
    if (( size > MAX_SIZE_BYTES )); then
        ts=$(date +%Y%m%d-%H%M%S)
        base=$(basename "$f")
        mv "$f" "$ARCHIVE_DIR/${base%.log}-${ts}.log"
        touch "$f"
        echo "$(date): rotated $base (${size} bytes)" >> "$LOG_DIR/rotate.log"
    fi
done

# Prune archives older than 7 days
find "$ARCHIVE_DIR" -name "*.log" -mtime +7 -delete
