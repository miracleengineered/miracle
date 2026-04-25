#!/bin/bash
# preflight.sh — single-screen PASS/FAIL ops health check.
# Exit 0 if all checks pass, 1 if any fail. Designed to gate morning-digest.

set -uo pipefail

LA="$HOME/Library/LaunchAgents"
PASS=0; FAIL=0
mark() { if [ "$1" = "PASS" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi; printf "%-5s %s\n" "$1" "$2"; }

# 1. Every miracle/askmiracle plist lints
for p in "$LA"/com.miracle.*.plist "$LA"/com.askmiracle.*.plist; do
  [ -e "$p" ] || continue
  if plutil -lint "$p" >/dev/null 2>&1; then
    mark PASS "lint: $(basename "$p")"
  else
    mark FAIL "lint: $(basename "$p")"
  fi
done

# 2. Every KeepAlive=true plist has ThrottleInterval
for p in "$LA"/com.miracle.*.plist "$LA"/com.askmiracle.*.plist; do
  [ -e "$p" ] || continue
  ka=$(plutil -extract KeepAlive raw "$p" 2>/dev/null || echo "")
  if [ -n "$ka" ]; then
    if plutil -extract ThrottleInterval raw "$p" >/dev/null 2>&1; then
      mark PASS "throttle: $(basename "$p")"
    else
      mark FAIL "throttle missing: $(basename "$p")"
    fi
  fi
done

# 3. NO secret literals in any LaunchAgents file (including backups)
leaks=$(grep -lE '_(SECRET|TOKEN|KEY|PASSWORD)=' "$LA"/*.plist* 2>/dev/null | wc -l | tr -d ' ')
if [ "$leaks" = "0" ]; then
  mark PASS "no secret literals in $LA"
else
  mark FAIL "secret literals found in $leaks file(s)"
fi

# 4. WAL/db ratio < 2× on the three known DBs
for db in "$HOME/.miracle/queue.db" "$HOME/.miracle/slice.db" "$HOME/.askmiracle/queue.db"; do
  [ -f "$db" ] || continue
  dsz=$(stat -f%z "$db" 2>/dev/null || echo 0)
  wsz=$(stat -f%z "$db-wal" 2>/dev/null || echo 0)
  if [ "$dsz" -gt 0 ] && [ $((wsz * 1)) -lt $((dsz * 2)) ]; then
    mark PASS "WAL ok: $(basename "$db") db=${dsz} wal=${wsz}"
  else
    mark FAIL "WAL bloat: $(basename "$db") db=${dsz} wal=${wsz}"
  fi
done

# 5. Live-vs-repo plist diff for canary label
canary="$LA/com.miracle.bot.plist"
canary_repo="$HOME/Projects/miracle/bot/launchd/com.miracle.bot.plist"
if [ -f "$canary" ] && [ -f "$canary_repo" ]; then
  if diff -q <(plutil -p "$canary") <(plutil -p "$canary_repo") >/dev/null 2>&1; then
    mark PASS "drift: com.miracle.bot live==repo"
  else
    mark FAIL "drift: com.miracle.bot live!=repo"
  fi
fi

# 6. No miracle/askmiracle service in failed (last-exit-nonzero) state
failed=$(launchctl list | awk '$2 != "0" && $2 != "-" && $3 ~ /^com\.(miracle|askmiracle)\./ {print $3}')
if [ -z "$failed" ]; then
  mark PASS "no failed miracle services"
else
  mark FAIL "failed services: $(echo "$failed" | tr '\n' ' ')"
fi

# 7. Port 8787 contention check
p8787=$(lsof -nP -iTCP:8787 -sTCP:LISTEN 2>/dev/null | tail -n +2 | wc -l | tr -d ' ')
if [ "$p8787" -le 1 ]; then
  mark PASS "port 8787 listeners=$p8787"
else
  mark FAIL "port 8787 contention: $p8787 listeners"
fi

echo "---"
echo "preflight: $PASS pass, $FAIL fail"
[ "$FAIL" = "0" ] && exit 0 || exit 1
