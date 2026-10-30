for i in {1..5}; do
  curl -s -X POST http://localhost:3001/api/translate \
    -H "Content-Type: application/json" \
    -d '{"text": "Hello world", "targetLanguages": ["es", "fr", "de"]}'
  echo ""
  sleep 2
done