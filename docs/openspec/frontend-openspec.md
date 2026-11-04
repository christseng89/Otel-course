# OpenSpec: Translation Frontend/API

## Document status

- **Type:** As-built service specification
- **Scope:** `handson-labs/app-versions/code/frontend`
- **Audience:** Frontend, backend, QA, and observability engineers
- **Source of truth:** Current TypeScript implementation and Compose configuration
- **Review method:** Four-eyes review completed by two independent reviewers; see [Review record](#four-eyes-review)

## 1. Purpose and responsibilities

The frontend service is an Express application that serves the browser UI, accepts translation requests, persists session state in Redis, publishes translation jobs, consumes worker results, and streams session updates over Server-Sent Events (SSE).

The Python worker is not called over HTTP. The integration boundary is Redis:

```text
Browser -> HTTP/SSE -> Frontend -> Redis list -> Worker
Browser <- HTTP/SSE <- Frontend <- Redis Pub/Sub <- Worker
```

Observed implementation references:

- HTTP server and static assets: `src/index.ts`
- Translation API: `src/routes/translation.ts`
- Redis integration: `src/services/queue.ts`
- SSE lifecycle: `src/services/sse.ts`

## 2. Runtime configuration

| Variable | Default | Meaning |
|---|---:|---|
| `PORT` | `3000` | HTTP listen port inside the container |
| `REDIS_HOST` | `localhost` | Redis hostname |
| `REDIS_PORT` | `6379` | Redis port |
| `CORS_ORIGIN` | `http://localhost:3001` | Allowed CORS origin |
| `LOG_LEVEL` | Compose-defined | Structured log level |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Compose-defined | OTLP collector endpoint |

Compose publishes the service as host port `3001` to container port `3000`.

The queue key (`translation:queue`), result channel (`translation:results`), source language (`en`), and supported languages (`es`, `fr`, `de`) are currently code/configuration constants rather than a single shared contract.

## 3. HTTP contract

### 3.1 `GET /health`

Returns HTTP `200`:

```json
{"status":"ok"}
```

### 3.2 `POST /api/translate`

Request content type is JSON:

```json
{
  "text": "Hello",
  "targetLanguages": ["es", "fr"]
}
```

Validation rules:

| Condition | Status | Response shape |
|---|---:|---|
| Missing/blank/non-string `text` | `400` | `{"error":"Text is required","details":"Text must be a non-empty string"}` |
| Missing/empty `targetLanguages` | `400` | `{"error":"At least one target language is required",...}` |
| More than three target languages | `400` | `{"error":"Maximum 3 target languages allowed",...}` |
| Language outside `es`, `fr`, `de` | `400` | Error plus `supportedLanguages` |

On success, the service generates a UUID session and one UUID job per requested target language. It returns HTTP `201`:

```json
{
  "sessionId": "<uuid>",
  "status": "queued",
  "jobs": [
    {"jobId":"<uuid>","targetLanguage":"es","status":"queued"}
  ]
}
```

### 3.3 `GET /api/translate/:sessionId`

Returns HTTP `200` for an existing session:

```json
{
  "sessionId": "<uuid>",
  "text": "Hello",
  "status": "queued|in_progress|completed",
  "translations": {
    "es": {
      "status": "queued|processing|completed|error",
      "translatedText": "Hola",
      "error": "optional error text"
    }
  }
}
```

Returns HTTP `404` with `{"error":"Session not found"}` when the Redis session hash does not exist. Redis or server failures return HTTP `500`.

### 3.4 `GET /api/translate/:sessionId/events`

The endpoint requires an existing session and returns an SSE stream with:

- `Content-Type: text/event-stream`
- `Cache-Control: no-cache`
- `Connection: keep-alive`
- `X-Accel-Buffering: no`

The initial payload is the comment `:ok` followed by a blank line. Events are JSON encoded in the `data` field:

```text
event: translation_complete
data: {"jobId":"...","sessionId":"...","targetLanguage":"es","translatedText":"Hola","status":"completed",...}

event: translation_error
data: {"jobId":"...","sessionId":"...","targetLanguage":"es","status":"error","error":"...",...}

event: session_complete
data: {"sessionId":"...","status":"completed"}
```

Multiple clients may subscribe to one session. Connections are removed on client disconnect or write failure. The service does not replay missed events.

## 4. Redis contract

### 4.1 Job list

Jobs are JSON objects pushed with `LPUSH` to `translation:queue`:

```json
{
  "jobId": "<uuid>",
  "sessionId": "<uuid>",
  "text": "Hello",
  "sourceLanguage": "en",
  "targetLanguage": "es",
  "createdAt": "<ISO-8601 timestamp>",
  "_traceContext": {"traceparent":"..."}
}
```

The trace context is optional from a schema perspective and is injected by OpenTelemetry at enqueue time.

### 4.2 Session hash

Key: `translation:session:<sessionId>`

Stored fields include `text`, `sourceLanguage`, `status`, `totalJobs`, `completedJobs`, and `job:<language>:status`. Completed job fields may also include `job:<language>:translatedText` and `job:<language>:error`.

Sessions expire after one hour.

### 4.3 Result subscription

The frontend subscribes to `translation:results` and expects:

```json
{
  "jobId":"<uuid>",
  "sessionId":"<uuid>",
  "targetLanguage":"es",
  "translatedText":"Hola",
  "status":"completed|error",
  "durationMs":1234,
  "completedAt":"<ISO-8601 timestamp>",
  "error":"optional error text",
  "_traceContext":{"traceparent":"..."}
}
```

## 5. State and failure behavior

The current flow is: validate request, enqueue all jobs, save the session, then return `201`. Result processing updates each language and increments `completedJobs`; when all expected jobs are terminal, the session status becomes `completed`.

The implementation is currently at-most-once at the queue/result boundaries:

- `BRPOP` removes a job before processing; there is no acknowledgement, retry, or dead-letter queue.
- Redis Pub/Sub results are transient.
- SSE events are only delivered to connected clients and are not replayed.
- Duplicate result handling is not idempotent.
- Duplicate target languages are accepted by validation but collapse into one language key in the session map.
- Enqueueing precedes session persistence, so a fast worker or save failure can produce inconsistent state.

These are documented behaviors and risks, not guarantees to strengthen without an explicit design decision.

## 6. Observability and security boundaries

The service emits structured Winston logs, OpenTelemetry traces, metrics, and OTLP logs/traces/metrics. Important business attributes include session ID, job ID, target language, text length, request result, and validation reason.

The current implementation returns raw exception messages in HTTP `500` `details`. The browser UI also renders user/result strings through `innerHTML`. These behaviors must be treated as development/demo behavior; production use requires an explicit decision on error redaction and HTML escaping.

## 7. Acceptance criteria

- `GET /health` returns `200` and the expected JSON body.
- Valid translation requests return `201`, a session UUID, and one job entry per target language.
- Invalid requests return `400` without enqueueing jobs.
- Existing sessions can be read until the one-hour Redis TTL expires.
- Existing sessions can open an SSE connection and receive terminal job/session events while connected.
- Redis connectivity failures are surfaced as HTTP `500` and logged with correlation identifiers.
- Trace context can cross the frontend → Redis → worker → Redis result path.
- Tests cover validation, queue/session operations, API routes, and SSE lifecycle; end-to-end Redis/SSE behavior remains a recommended gap.

## 8. Open decisions / follow-up requirements

1. Define whether delivery must remain at-most-once or require retries and a dead-letter queue.
2. Define whether results must be durable and replayable after reconnect/restart.
3. Choose one authoritative source for supported languages.
4. Define duplicate-language semantics.
5. Define session status semantics for partial failure (`completed`, `failed`, or `partial`).
6. Define maximum text length and latency expectations.
7. Redact internal exception details from public responses.
8. Replace unsafe HTML rendering with escaped/text-only rendering.

## Four-eyes review

Two independent reviewers inspected the implementation before this document was written:

| Reviewer | Focus | Confirmed findings |
|---|---|---|
| Reviewer A | HTTP/API, browser, SSE, security | Endpoint schemas, SSE no-replay behavior, raw error detail, unsafe HTML rendering, API test coverage |
| Reviewer B | Queue/session integration and worker boundary | Redis keys/channels, enqueue-before-save race, at-most-once delivery, duplicate-result risk, configuration drift |

The author reconciled both reviews. Items described as risks or open decisions were intentionally not presented as implemented guarantees.

## Source references

- `handson-labs/app-versions/code/frontend/src/index.ts`
- `handson-labs/app-versions/code/frontend/src/routes/translation.ts`
- `handson-labs/app-versions/code/frontend/src/services/queue.ts`
- `handson-labs/app-versions/code/frontend/src/services/sse.ts`
- `handson-labs/app-versions/code/frontend/src/types.ts`
- `handson-labs/app-versions/code/frontend/src/validation.ts`
- `handson-labs/compose/compose.app.yaml`
