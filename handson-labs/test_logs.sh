#!/usr/bin/env bash

set -u

FRONTEND_URL="${FRONTEND_URL:-http://localhost:3001}"
RUN_ERROR_CASES="${RUN_ERROR_CASES:-false}"

valid_requests=(
  '{"text": "Hello world", "targetLanguages": ["es"]}'
  '{"text": "Good morning", "targetLanguages": ["fr"]}'
  '{"text": "How are you?", "targetLanguages": ["de"]}'
  '{"text": "See you soon", "targetLanguages": ["es", "fr"]}'
  '{"text": "Thank you", "targetLanguages": ["de", "es"]}'
  '{"text": "Have a nice day", "targetLanguages": ["fr", "de"]}'
  '{"text": "Welcome", "targetLanguages": ["es", "fr", "de"]}'
  '{"text": "Please wait", "targetLanguages": ["es"]}'
  '{"text": "Request completed", "targetLanguages": ["fr"]}'
  '{"text": "Goodbye", "targetLanguages": ["de"]}'
)

warning_requests=(
  '{"text": "", "targetLanguages": ["es"]}'
  '{"text": "Hello world", "targetLanguages": []}'
  '{"text": "Hello world", "targetLanguages": ["es", "fr", "de", "ja"]}'
  '{"text": "Hello world", "targetLanguages": ["xx"]}'
  '{"text": "Hello world", "targetLanguages": "es"}'
)

# These requests produce application errors only when the backend dependency
# is unavailable. Stop Redis before running with RUN_ERROR_CASES=true.
error_requests=(
  '{"text": "Redis failure test one", "targetLanguages": ["es"]}'
  '{"text": "Redis failure test two", "targetLanguages": ["fr", "de"]}'
)

send_requests() {
  local request_type="$1"
  shift

  echo "Sending $# ${request_type} requests..."

  for payload in "$@"; do
    curl -sS -X POST "${FRONTEND_URL}/api/translate" \
      -H "Content-Type: application/json" \
      -d "$payload"
    echo
  done
}

if [[ "$RUN_ERROR_CASES" == "true" ]]; then
  send_requests "error" "${error_requests[@]}"
else
  send_requests "valid" "${valid_requests[@]}"
  send_requests "warning" "${warning_requests[@]}"
  echo "Skipping error cases; set RUN_ERROR_CASES=true with Redis stopped to run them."
fi
