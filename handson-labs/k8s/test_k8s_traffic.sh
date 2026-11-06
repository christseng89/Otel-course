#!/usr/bin/env bash

# Continuously generate diverse traffic for the Kubernetes translation service.
# The default target uses the Docker Desktop NGINX Ingress endpoint.
# Override TRANSLATE_URL when the service is running elsewhere.

K8S_HOST="${K8S_HOST:-frontend.test.com}"
INGRESS_PORT="${INGRESS_PORT:-9080}"
BASE_URL="${TRANSLATE_URL:-http://${K8S_HOST}:${INGRESS_PORT}/api/translate}"

SUCCESS_PAYLOADS=(
  '{"text":"Hello world","targetLanguages":["es"]}'
  '{"text":"Good morning","targetLanguages":["fr"]}'
  '{"text":"How are you?","targetLanguages":["de"]}'
  '{"text":"See you soon","targetLanguages":["es","fr"]}'
  '{"text":"Thank you very much","targetLanguages":["fr","de"]}'
  '{"text":"OpenTelemetry is amazing","targetLanguages":["es","fr","de"]}'
  '{"text":"The quick brown fox jumps over the lazy dog","targetLanguages":["de"]}'
)

FAILURE_PAYLOADS=(
  # Unsupported languages
  '{"text":"Hello world","targetLanguages":["it"]}'
  '{"text":"Hello world","targetLanguages":["es","xx"]}'

  # Missing or empty values
  '{"targetLanguages":["es"]}'
  '{"text":"Hello world"}'
  '{"text":"","targetLanguages":["es"]}'
  '{"text":"Hello world","targetLanguages":[]}'

  # Invalid types and malformed JSON
  '{"text":12345,"targetLanguages":["es"]}'
  '{"text":"Hello world","targetLanguages":"es"}'
  'not-valid-json'
)

random_delay() {
  awk -v random_value="$RANDOM" \
    'BEGIN { printf "%.2f\n", 0.2 + (random_value / 32767) * 0.5 }'
}

pick_random() {
  local values=("$@")
  local index=$((RANDOM % ${#values[@]}))
  printf '%s\n' "${values[$index]}"
}

send_request() {
  local kind="$1"
  local payload="$2"
  local http_code

  http_code=$(curl -sS -o /dev/null -w "%{http_code}" \
    -X POST "$BASE_URL" \
    -H "Content-Type: application/json" \
    -d "$payload") || http_code="curl-error"

  printf '[%s] %-7s HTTP %s | %s\n' \
    "$(date '+%H:%M:%S')" "$kind" "$http_code" "$payload"
}

echo "Generating Kubernetes traffic for $BASE_URL"
echo "Press Ctrl+C to stop."

request_count=0
while true; do
  if (( RANDOM % 10 < 7 )); then
    send_request "success" "$(pick_random "${SUCCESS_PAYLOADS[@]}")"
  else
    send_request "failure" "$(pick_random "${FAILURE_PAYLOADS[@]}")"
  fi

  request_count=$((request_count + 1))
  printf 'Requests sent: %d\n\n' "$request_count"
  sleep "$(random_delay)"
done
