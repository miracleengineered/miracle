#!/bin/bash
# monitor-miracle.sh — watch the miracle launchd labels; alert via Telegram on outage.
# Hardcoded label list (intentional: keeps blast radius isolated from askmiracle's
# scan-signals.ts loader). Dedupes alerts via ~/.miracle/monitor-state.json.
# Bash 3.2 compatible (macOS default).

set -uo pipefail

LABELS="com.miracle.bot com.miracle.aunt-cam-bot com.miracle.morning-digest com.miracle.yesterday-summary com.askmiracle.bot com.askmiracle.scan-signals com.miracle.session-log com.miracle.wal-checkpoint com.miracle.tj-math-bot"

STATE_FILE="$HOME/.miracle/monitor-state.json"
mkdir -p "$(dirname "$STATE_FILE")"

# Helper: parse a label's prev state from JSON file ('1' or '')
prev_state_of() {
  [ -f "$STATE_FILE" ] || { echo ""; return; }
  awk -v lbl="$1" -F'"' '$2==lbl {print $4; exit}' "$STATE_FILE"
}

NEW_STATE=""
DOWN=""
ALERT=""

for label in $LABELS; do
  line=$(launchctl list | awk -v l="$label" '$3==l {print}')
  state="0"
  reason=""
  if [ -z "$line" ]; then
    state="1"; reason="NOT-LOADED"
  else
    pid=$(echo "$line" | awk '{print $1}')
    exit_code=$(echo "$line" | awk '{print $2}')
    plist="$HOME/Library/LaunchAgents/${label}.plist"
    has_keepalive=$(plutil -extract KeepAlive raw "$plist" 2>/dev/null)
    if [ -n "$has_keepalive" ] && [ "$pid" = "-" ]; then
      state="1"; reason="NO-PID"
    elif [ "$exit_code" != "0" ] && [ "$exit_code" != "-" ]; then
      state="1"; reason="EXIT=$exit_code"
    fi
  fi

  if [ "$state" = "1" ]; then
    DOWN="${DOWN}${label} ${reason}\n"
    prev=$(prev_state_of "$label")
    if [ "$prev" != "1" ]; then
      ALERT="${ALERT}DOWN: ${label} (${reason})\n"
    fi
  fi

  if [ -z "$NEW_STATE" ]; then
    NEW_STATE="  \"${label}\": \"${state}\""
  else
    NEW_STATE="${NEW_STATE},
  \"${label}\": \"${state}\""
  fi
  # Skip the '1' state values — we want stable state stored as the value
  # The above already handles it correctly via "$state"
done

# Replace the placeholder above: actually we stored state directly as 0 or 1.
# Convert "0" to empty for state file readability.
# (Simpler: just keep 0/1.)

printf "{\n%s\n}\n" "$NEW_STATE" > "$STATE_FILE"

if [ -n "$ALERT" ]; then
  TOKEN=$(security find-generic-password -a miracle -s askmiracle-TELEGRAM_BOT_TOKEN -w 2>/dev/null)
  CHAT=$(security find-generic-password -a miracle -s askmiracle-TELEGRAM_CHAT_ID -w 2>/dev/null)
  if [ -n "$TOKEN" ] && [ -n "$CHAT" ]; then
    msg=$(printf "miracle-monitor:\n%b" "$ALERT")
    curl -sS --max-time 10 -X POST \
      "https://api.telegram.org/bot${TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${CHAT}" \
      --data-urlencode "text=${msg}" >/dev/null
  fi
  unset TOKEN CHAT
fi

N_LABELS=$(echo $LABELS | wc -w | tr -d ' ')
if [ -n "$DOWN" ]; then
  printf "monitor: down\n%b" "$DOWN"
else
  echo "monitor: all $N_LABELS labels healthy"
fi

# --- Digest section completeness ---
# The morning digest writes a snapshot listing each section that rendered.
# A missing section (e.g. news subprocess timing out) doesn't show up in
# the launchd checks above — exit code is 0 because the digest still ships
# whatever did render. This block surfaces section drops directly.
# Dedupes via its own state file (separate from the launchd-label state).
DIGEST_SNAPSHOT="$HOME/Library/Caches/com.miracle.digest/last-morning.json"
DIGEST_STATE_FILE="$HOME/.miracle/digest-monitor-state"
EXPECTED_SECTIONS=4  # weather, today, news, tip

if [ -f "$DIGEST_SNAPSHOT" ]; then
  FIRED_AT=$(awk -F'"' '/"fired_at"/ {print $4; exit}' "$DIGEST_SNAPSHOT")
  if [ -n "$FIRED_AT" ]; then
    FIRED_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${FIRED_AT%.*}" "+%s" 2>/dev/null || echo 0)
    NOW_EPOCH=$(date +%s)
    AGE=$((NOW_EPOCH - FIRED_EPOCH))
    # Only check digests fired within the last 25h. Older = no fresh fire today; skip.
    if [ "$FIRED_EPOCH" -gt 0 ] && [ "$AGE" -lt 90000 ]; then
      SECTION_COUNT=$(grep -c '"module"' "$DIGEST_SNAPSHOT")
      DIGEST_PREV_BAD=""
      [ -f "$DIGEST_STATE_FILE" ] && DIGEST_PREV_BAD=$(cat "$DIGEST_STATE_FILE")
      if [ "$SECTION_COUNT" -lt "$EXPECTED_SECTIONS" ]; then
        echo "monitor: digest delivered $SECTION_COUNT/$EXPECTED_SECTIONS sections (snapshot ${AGE}s old)"
        if [ "$DIGEST_PREV_BAD" != "$FIRED_AT" ]; then
          TOKEN=$(security find-generic-password -a miracle -s askmiracle-TELEGRAM_BOT_TOKEN -w 2>/dev/null)
          CHAT=$(security find-generic-password -a miracle -s askmiracle-TELEGRAM_CHAT_ID -w 2>/dev/null)
          if [ -n "$TOKEN" ] && [ -n "$CHAT" ]; then
            curl -sS --max-time 10 -X POST \
              "https://api.telegram.org/bot${TOKEN}/sendMessage" \
              --data-urlencode "chat_id=${CHAT}" \
              --data-urlencode "text=miracle-monitor: morning digest delivered ${SECTION_COUNT}/${EXPECTED_SECTIONS} sections" >/dev/null
          fi
          unset TOKEN CHAT
          printf "%s" "$FIRED_AT" > "$DIGEST_STATE_FILE"
        fi
      else
        # Clear the state once a clean digest fires.
        [ -f "$DIGEST_STATE_FILE" ] && rm -f "$DIGEST_STATE_FILE"
      fi
    fi
  fi
fi

exit 0
