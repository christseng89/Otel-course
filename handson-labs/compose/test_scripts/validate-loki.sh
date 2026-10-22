#!/usr/bin/env bash
set -euo pipefail

echo "🚀 Starting Loki validation..."
echo ""

LOKI_URL="${LOKI_URL:-http://localhost:3110}"
LABEL="loki-validation"
MESSAGE="loki-validation-$(date +%s)"
TIMESTAMP="$(date +%s)000000000"

# ============================================================
# Step 1: Send log data to Loki
# ============================================================
echo "📤 Step 1: Sending a test log to ${LOKI_URL}..."

status="$(curl -sS -o /dev/null -w '%{http_code}' \
  -X POST "${LOKI_URL}/loki/api/v1/push" \
  -H 'Content-Type: application/json' \
  -d "{\"streams\":[{\"stream\":{\"job\":\"${LABEL}\"},\"values\":[[\"${TIMESTAMP}\",\"${MESSAGE}\"]]}]}")"

case "$status" in
  2*) ;;
  *) echo "Loki rejected the log (HTTP ${status})."; exit 1 ;;
esac

echo ""
echo "✅ Log data sent successfully!"
echo ""

# Wait a moment for Loki to process and index the log
echo "⏳ Waiting 2 seconds for Loki to process the log..."
sleep 2
echo ""

# ============================================================
# Step 2: Query Loki to verify the log was stored
# ============================================================
echo "🔍 Step 2: Querying Loki to verify log storage..."

start="$(($(date +%s) - 60))000000000"
end="$(($(date +%s) + 60))000000000"
result="$(curl -fsS -G "${LOKI_URL}/loki/api/v1/query_range" \
  --data-urlencode "query={job=\"${LABEL}\"}" \
  --data-urlencode "start=${start}" \
  --data-urlencode "end=${end}" \
  --data-urlencode 'limit=10')"

echo "Query result:"
echo "$result" | jq '.'
echo ""

# ============================================================
# Step 3: Verify the result
# ============================================================
echo "✨ Step 3: Validating results..."

if [[ "$result" == *"$MESSAGE"* ]]; then
  echo "✅ SUCCESS: Log was successfully stored and retrieved from Loki!"
  echo "   Message '${MESSAGE}' was found in Loki "
else
  echo "❌ FAILED: Message '${MESSAGE}' was not found in Loki"
  exit 1
fi

echo ""
echo "🎉 Loki validation completed successfully!"
echo ""