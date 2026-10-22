#!/usr/bin/env bash
set -euo pipefail

echo "🧹 Starting Loki cleanup..."
echo ""

LOKI_URL="${LOKI_URL:-http://localhost:3110}"
LABEL="loki-validation"

# The delete API expects Unix seconds, not nanoseconds.
start="$(($(date +%s) - 86400))"
end="$(date +%s)"

echo "📋 Cleanup details:"
echo "   Target: Logs with job=${LABEL}"
echo "   Time range: ${start} to ${end}"
echo ""

# ============================================================
# Step 1: Create a deletion request
# ============================================================
echo "🗑️  Step 1: Sending deletion request to Loki from ${LOKI_URL}..."

status="$(curl -sS -o /dev/null -w '%{http_code}' \
  -g -X POST "${LOKI_URL}/loki/api/v1/delete?query=%7Bjob%3D%22${LABEL}%22%7D&start=${start}&end=${end}")"

case "$status" in
  2*) echo "PASS: Loki accepted the cleanup request (HTTP ${status})." ;;
  *) echo "FAIL: Loki rejected the cleanup request (HTTP ${status})."; exit 1 ;;
esac

echo "Deletion is asynchronous; the data may remain queryable briefly."

echo ""
echo "✅ Deletion request submitted!"
echo ""

# ============================================================
# Step 2: Verify deletion
# ============================================================
echo "⏳ Waiting 5 seconds for deletion to process..."
sleep 5
echo ""

echo "🔍 Step 2: Verifying logs were deleted..."

QUERY_RESULT=$(curl -s -G "${LOKI_URL}/loki/api/v1/query_range" \
  --data-urlencode "query={job=\"${LABEL}\"}" \
  --data-urlencode "start=${start}" \
  --data-urlencode "end=${end}" \
  --data-urlencode "limit=10")

# Check if any results remain
RESULT_COUNT=$(echo "$QUERY_RESULT" | jq -r '.data.result | length')

if [ "$RESULT_COUNT" -eq 0 ]; then
  echo "✅ SUCCESS: Test logs have been deleted from Loki!"
else
  echo "⚠️  WARNING: Some logs may still exist (found $RESULT_COUNT streams)"
  echo "   Note: Loki compaction runs periodically, so deletion may take a few minutes"
fi

echo ""
echo "🎉 Cleanup completed!"
