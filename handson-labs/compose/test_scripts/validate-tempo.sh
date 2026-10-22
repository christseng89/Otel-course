#!/usr/bin/env bash
set -euo pipefail

TEMPO_URL="${TEMPO_URL:-http://localhost:3200}"
OTLP_URL="${OTLP_URL:-http://localhost:4318}"
SPAN_NAME="tempo-curl-validation"

# Generate valid trace/span IDs for this run.
TRACE_ID="$(printf '%s' "tempo-${RANDOM}-${EPOCHSECONDS}" | sha256sum | cut -c1-32)"
SPAN_ID="$(printf '%s' "span-${RANDOM}-${EPOCHSECONDS}" | sha256sum | cut -c1-16)"
START_SECONDS="$(date +%s)"
START_NS="${START_SECONDS}000000000"
END_NS="$((START_SECONDS + 1))000000000"

echo "🚀 Starting Tempo validation..."
echo "   Tempo API: ${TEMPO_URL}"
echo "   OTLP HTTP: ${OTLP_URL}"
echo ""

# ============================================================
# Step 1: Check Tempo readiness
# ============================================================
echo "🔍 Step 1: Checking Tempo readiness..."
ready="$(curl -fsS "${TEMPO_URL}/ready")"

if [[ "$ready" != *"ready"* ]]; then
  echo "❌ FAILED: Tempo is not ready. Response: ${ready}"
  exit 1
fi

echo "✅ Tempo is ready."
echo ""

# ============================================================
# Step 2: Send a trace through Tempo's OTLP/HTTP receiver
# ============================================================
echo "📤 Step 2: Sending a test trace..."

payload="$(jq -n \
  --arg trace_id "$TRACE_ID" \
  --arg span_id "$SPAN_ID" \
  --arg span_name "$SPAN_NAME" \
  --arg start_ns "$START_NS" \
  --arg end_ns "$END_NS" \
  '{
    resourceSpans: [{
      resource: {
        attributes: [{
          key: "service.name",
          value: { stringValue: "tempo-curl-validation" }
        }]
      },
      scopeSpans: [{
        spans: [{
          traceId: $trace_id,
          spanId: $span_id,
          name: $span_name,
          kind: 2,
          startTimeUnixNano: $start_ns,
          endTimeUnixNano: $end_ns
        }]
      }]
    }]
  }')"

status="$(curl -sS -o /dev/null -w '%{http_code}' \
  -X POST "${OTLP_URL}/v1/traces" \
  -H 'Content-Type: application/json' \
  --data-raw "$payload")"

case "$status" in
  2*) ;;
  *)
    echo "❌ FAILED: Tempo rejected the trace (HTTP ${status})."
    exit 1
    ;;
esac

echo "✅ Trace accepted."
echo "   Trace ID: ${TRACE_ID}"
echo ""

# ============================================================
# Step 3: Retrieve the trace by ID
# ============================================================
echo "🔎 Step 3: Retrieving the trace from Tempo..."

trace=""
for attempt in {1..10}; do
  if trace="$(curl -fsS "${TEMPO_URL}/api/traces/${TRACE_ID}" 2>/dev/null)"; then
    if [[ "$trace" == *"${SPAN_NAME}"* ]]; then
      break
    fi
  fi

  trace=""
  sleep 2
done

if [[ -z "$trace" || "$trace" != *"${SPAN_NAME}"* ]]; then
  echo "❌ FAILED: Trace ${TRACE_ID} was not found in Tempo."
  exit 1
fi

echo "✅ Trace retrieved successfully."
echo ""
echo "🎉 Tempo validation completed successfully!"
