#!/bin/bash
# install-plists.sh — lint, archive, deploy, and (re)bootstrap a launchd plist.
# Usage: install-plists.sh <path-to-canonical-plist>
#
# Behavior:
#   1. plutil -lint the canonical source — fail fast if invalid.
#   2. Extract Label from the plist.
#   3. Archive any existing live plist to ~/.miracle/plist-archive/<ts>/.
#   4. Copy canonical to ~/Library/LaunchAgents/<Label>.plist.
#   5. Strip com.apple.quarantine xattr (silent if absent).
#   6. bootout (if loaded) + bootstrap.
#
# Reversible: archived live plists let you cp back + re-bootstrap.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <canonical-plist-path>" >&2
  exit 64
fi

SRC="$1"
if [ ! -f "$SRC" ]; then
  echo "error: source plist not found: $SRC" >&2
  exit 66
fi

plutil -lint "$SRC" >/dev/null

LABEL=$(plutil -extract Label raw -o - "$SRC")
if [ -z "$LABEL" ]; then
  echo "error: could not extract Label from $SRC" >&2
  exit 65
fi

LIVE="$HOME/Library/LaunchAgents/${LABEL}.plist"
TS=$(date +%Y%m%d-%H%M%S)
ARCHIVE_DIR="$HOME/.miracle/plist-archive/$TS"

if [ -f "$LIVE" ]; then
  mkdir -p "$ARCHIVE_DIR"
  cp -p "$LIVE" "$ARCHIVE_DIR/"
  echo "archived: $ARCHIVE_DIR/$(basename "$LIVE")"
fi

cp "$SRC" "$LIVE"
xattr -d com.apple.quarantine "$LIVE" 2>/dev/null || true

UID_NUM=$(id -u)
launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true

# launchctl bootstrap occasionally returns EIO (5) on first attempt
# even when nothing is wrong; retry once after a short sleep before
# giving up. Use || rc=$? so set -e doesn't kill us on the first failure.
rc=0
launchctl bootstrap "gui/${UID_NUM}" "$LIVE" || rc=$?
if [ "$rc" -ne 0 ]; then
  if [ "$rc" -eq 5 ]; then
    echo "bootstrap rc=5 (EIO); retrying in 1s..." >&2
    sleep 1
    launchctl bootstrap "gui/${UID_NUM}" "$LIVE"
  else
    echo "bootstrap failed rc=$rc (non-EIO; not retrying)" >&2
    exit "$rc"
  fi
fi

echo "installed: $LABEL"
launchctl print "gui/${UID_NUM}/${LABEL}" 2>/dev/null | grep -E '^\s+(state|pid)' || true
