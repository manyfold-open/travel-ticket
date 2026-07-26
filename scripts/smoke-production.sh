#!/usr/bin/env bash
# Travel Ticket production smoke test.
# Usage: TRAVEL_TICKET_ACCESS_PASSCODE=123456 npm run smoke -- [baseUrl]
set -uo pipefail

BASE="${1:-https://mf-travel-ticket.netmind-ai.workers.dev}"
ACCESS_PASSCODE="${TRAVEL_TICKET_ACCESS_PASSCODE:-}"
PROPAGATION_ATTEMPTS="${TRAVEL_TICKET_SMOKE_ATTEMPTS:-15}"
PROPAGATION_DELAY="${TRAVEL_TICKET_SMOKE_DELAY_SECONDS:-3}"
fails=0
pass(){ echo "  ✓ $1"; }
fail(){ echo "  ✗ $1"; fails=$((fails+1)); }

wait_for_gate(){
  local attempt=1
  local gate=""
  while [ "$attempt" -le "$PROPAGATION_ATTEMPTS" ]; do
    gate=$(curl --silent --show-error --max-time 30 --output /dev/null \
      --write-out '%{http_code} %{redirect_url}' \
      "$BASE/?smoke_deploy=$attempt-$(date +%s)" 2>/dev/null || true)
    if echo "$gate" | grep -qE '^302 .*/access\?next='; then
      pass "access: visitor gate enabled"
      return 0
    fi
    if [ "$attempt" -lt "$PROPAGATION_ATTEMPTS" ]; then
      sleep "$PROPAGATION_DELAY"
    fi
    attempt=$((attempt+1))
  done
  fail "access: expected redirect after deployment propagation ($gate)"
  return 1
}

echo "smoke: $BASE"

wait_for_gate || true

access_status=$(curl --silent --show-error --max-time 30 "$BASE/api/access/status")
echo "$access_status" | grep -q '"configured":' \
  && echo "$access_status" | grep -q '"authenticated":false' \
  && pass "access: status endpoint" \
  || fail "access: invalid status response ($access_status)"

access_page=$(curl --silent --show-error --max-time 30 "$BASE/access")
echo "$access_page" | grep -q '6-digit access code' \
  && pass "access: login page" \
  || fail "access: login page missing"

settings_page=$(curl --silent --show-error --max-time 30 "$BASE/settings")
echo "$settings_page" | grep -q 'Runtime settings' \
  && pass "settings: admin page" \
  || fail "settings: admin page missing"

if ! [[ "$ACCESS_PASSCODE" =~ ^[0-9]{6}$ ]]; then
  protected_status=$(curl --silent --show-error --max-time 30 --output /dev/null \
    --write-out '%{http_code}' "$BASE/api/config")
  [[ "$protected_status" = "401" || "$protected_status" = "503" ]] \
    && pass "access: protected API rejects anonymous requests" \
    || fail "access: protected API returned HTTP $protected_status"
  echo "  authenticated endpoint checks skipped: set TRAVEL_TICKET_ACCESS_PASSCODE"
  echo
  if [ "$fails" -eq 0 ]; then echo "SMOKE PASS"; else echo "SMOKE FAIL ($fails)"; fi
  exit "$fails"
fi

cookie_jar=$(mktemp)
trap 'rm -f "$cookie_jar"' EXIT
login=$(printf '{"passcode":"%s"}' "$ACCESS_PASSCODE" \
  | curl --silent --show-error --max-time 30 --cookie-jar "$cookie_jar" \
      --header 'content-type: application/json' --data-binary @- "$BASE/api/access/login")
echo "$login" | grep -q '"authenticated":true' \
  && pass "access: code login" \
  || fail "access: login failed"

home=$(curl --silent --show-error --max-time 30 --cookie "$cookie_jar" "$BASE/")
echo "$home" | grep -q '一句話' \
  && pass "home: application shell" \
  || fail "home: application shell missing"

config=$(curl --silent --show-error --max-time 30 --cookie "$cookie_jar" "$BASE/api/config")
echo "$config" | grep -q '"ready":' \
  && pass "config: runtime readiness endpoint" \
  || fail "config: invalid readiness response"

unknown_status=$(curl --silent --show-error --max-time 30 --cookie "$cookie_jar" \
  --output /dev/null --write-out '%{http_code}' "$BASE/api/trips/smoke-unknown")
[ "$unknown_status" = "404" ] \
  && pass "api: unknown trip is a controlled 404" \
  || fail "api: expected 404 for unknown trip (HTTP $unknown_status)"

echo
if [ "$fails" -eq 0 ]; then echo "SMOKE PASS"; else echo "SMOKE FAIL ($fails)"; fi
exit "$fails"
