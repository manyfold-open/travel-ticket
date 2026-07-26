#!/usr/bin/env bash
# Travel Ticket production smoke test.
# Usage: npm run smoke -- [baseUrl]
set -uo pipefail

BASE="${1:-https://mf-travel-ticket.netmind-ai.workers.dev}"
fails=0
pass(){ echo "  ✓ $1"; }
fail(){ echo "  ✗ $1"; fails=$((fails+1)); }
get(){
  curl --silent --show-error --location --max-time 30 \
    --retry 8 --retry-delay 3 --retry-all-errors "$1"
}
wait_for_contains(){
  local url="$1"
  local pattern="$2"
  local label="$3"
  local body=""
  local attempt=1
  while [ "$attempt" -le 10 ]; do
    body=$(get "$url" 2>/dev/null || true)
    if echo "$body" | grep -q "$pattern"; then
      pass "$label"
      return 0
    fi
    attempt=$((attempt+1))
    sleep 3
  done
  fail "$label"
  return 1
}

echo "smoke: $BASE"

wait_for_contains "$BASE/" '一句話' "home: application shell" || true
wait_for_contains "$BASE/settings" 'Runtime settings' "settings: admin page" || true
wait_for_contains "$BASE/api/config" '"ready":' "config: runtime readiness endpoint" || true

unknown_status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --max-time 30 "$BASE/api/trips/smoke-unknown")
[ "$unknown_status" = "404" ] \
  && pass "api: unknown trip is a controlled 404" \
  || fail "api: expected 404 for unknown trip (HTTP $unknown_status)"

echo
if [ "$fails" -eq 0 ]; then echo "SMOKE PASS"; else echo "SMOKE FAIL ($fails)"; fi
exit "$fails"
