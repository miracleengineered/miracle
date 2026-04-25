#!/bin/bash
# smoke-test.sh — post-deploy functional smoke test.
#
# Verifies miracle/bot is alive AND responsive, not just process-up.
# Two checks:
#   1. /health endpoint returns 200 with {status: "ok"}
#   2. Telegram getMe via the configured bot token returns a valid bot_info
#
# Exit 0 if both pass, 1 otherwise. Designed to gate a deploy.
#
# Tier 3 listener port is 127.0.0.1:8787 (see src/index.ts:143).
# Override with SMOKE_BOT_HEALTH_URL.

set -uo pipefail

HEALTH_URL="${SMOKE_BOT_HEALTH_URL:-http://127.0.0.1:8787/health}"
TIMEOUT_SEC=10
FAIL=0

# --- Check 1: /health endpoint ---
echo "smoke: checking ${HEALTH_URL}"
HEALTH_BODY=$(curl -sf --max-time "$TIMEOUT_SEC" "$HEALTH_URL" 2>&1)
HEALTH_STATUS=$?
if [ "$HEALTH_STATUS" -ne 0 ]; then
  echo "  FAIL: /health unreachable (curl exit ${HEALTH_STATUS})"
  FAIL=1
else
  if echo "$HEALTH_BODY" | grep -q '"status":"ok"'; then
    echo "  PASS: /health 200 ok"
  else
    echo "  FAIL: /health returned unexpected body: ${HEALTH_BODY:0:200}"
    FAIL=1
  fi
fi

# --- Check 2: Telegram getMe ---
# Pulls token from Keychain (production by default; MIRACLE_ENV=staging uses staging).
SERVICE="miracle-TELEGRAM_BOT_TOKEN"
if [ "${MIRACLE_ENV:-}" = "staging" ]; then
  SERVICE="miracle-TELEGRAM_BOT_TOKEN_STAGING"
fi

TOKEN=$(security find-generic-password -a miracle -s "$SERVICE" -w 2>/dev/null)
if [ -z "$TOKEN" ]; then
  echo "  FAIL: Keychain entry ${SERVICE} not found"
  FAIL=1
else
  GETME=$(curl -sf --max-time "$TIMEOUT_SEC" "https://api.telegram.org/bot${TOKEN}/getMe" 2>&1)
  GETME_STATUS=$?
  unset TOKEN
  if [ "$GETME_STATUS" -ne 0 ]; then
    echo "  FAIL: Telegram getMe unreachable (curl exit ${GETME_STATUS})"
    FAIL=1
  else
    if echo "$GETME" | grep -q '"ok":true'; then
      USERNAME=$(echo "$GETME" | grep -oE '"username":"[^"]*"' | cut -d: -f2 | tr -d '"' || echo unknown)
      echo "  PASS: Telegram getMe ok (bot: ${USERNAME})"
    else
      echo "  FAIL: Telegram getMe returned: ${GETME:0:200}"
      FAIL=1
    fi
  fi
fi

if [ "$FAIL" -eq 0 ]; then
  echo "smoke: all checks passed"
  exit 0
else
  echo "smoke: FAIL"
  exit 1
fi
