# OpenSpec: Translation Backend Worker

## Document status

- **Type:** As-built service specification
- **Scope:** `handson-labs/app-versions/code/worker`
- **Audience:** Backend, frontend, QA, and observability engineers
- **Source of truth:** Current Python implementation and Compose configuration
- **Review method:** Four-eyes review completed by two independent reviewers; see [Review record](#four-eyes-review)

## 1. Purpose and responsibilities

The backend worker is a long-running Python process that consumes translation jobs from a Redis list, translates text locally with Argos Translate, publishes a result through Redis Pub/Sub, and emits logs, metrics, and traces. It does not expose an HTTP endpoint.

```text
Redis translation:queue -> QueueConsumer -> Argos Translate -> Redis translation:results
```

Observed implementation references:

- Worker lifecycle: `src/main.py`
- Redis protocol: `src/queue.py`
- Translation engine: `src/translator.py`
- Environment configuration: `src/config.py`
- Metrics: `src/metrics.py`

## 2. Runtime configuration

| Variable | Default | Meaning |
|---|---:|---|
| `REDIS_HOST` | `localhost` | Redis hostname |
| `REDIS_PORT` | `6379` | Redis port |
| `QUEUE_KEY` | `translation:queue` | Redis list consumed by the worker |
| `RESULT_CHANNEL` | `translation:results` | Redis Pub/Sub channel for results |
| `SOURCE_LANGUAGE` | `en` | Source language fallback |
| `SUPPORTED_LANGUAGES` | `es,fr,de` | Comma-separated target language allow-list |
| `LOG_LEVEL` | `INFO` | Root logger level; normalized to uppercase |
| `OTEL_SERVICE_NAME` | Compose-defined | OpenTelemetry service identity |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Compose-defined | OTLP collector endpoint |

The frontend currently hard-codes the same target-language list, so configuration drift is possible. The worker configuration is the runtime authority for whether a received job is supported.

## 3. Job input contract

The worker reads JSON strings using `BRPOP` from `QUEUE_KEY`. The expected payload is:

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

Required processing fields are `jobId`, `sessionId`, non-empty `text`, and `targetLanguage`. `sourceLanguage` falls back to configured `SOURCE_LANGUAGE`; `_traceContext` is optional.

Malformed JSON is logged and discarded. A structurally invalid job is logged and discarded without a result message.

## 4. Processing contract

For each valid job, the worker:

1. Extracts the propagated trace context.
2. Starts a consumer span named `process_translation_job - <target>`.
3. Increments the active-job metric.
4. Rejects a target not in `SUPPORTED_LANGUAGES` with an error result.
5. Otherwise waits a random 0.5–2.0 seconds, then calls Argos Translate.
6. Records duration and outcome metrics.
7. Publishes one result message, including a new trace context.
8. Decrements the active-job metric.

Argos model lookup is by source/target language code. Missing models produce an error result; unexpected translation failures are converted to an error result and do not stop the main loop.

## 5. Result contract

Results are JSON-published to `RESULT_CHANNEL`:

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

Successful results contain `translatedText` and `status: completed`. Error results contain `status: error` and an `error` string; unsupported-language errors use duration `0`.

## 6. Redis delivery semantics

The worker uses one Redis client for blocking consumption and one for publishing. `BRPOP` removes the job before translation begins. The current implementation therefore provides at-most-once processing:

- No acknowledgement protocol exists.
- No visibility timeout or retry queue exists.
- No dead-letter queue exists.
- A worker crash after `BRPOP` can lose the job.
- A publish failure can prevent the frontend from receiving a result.

Redis Pub/Sub is transient. It does not provide durable result replay for a frontend subscriber that is disconnected or restarted.

## 7. Lifecycle and shutdown

The worker installs `SIGTERM` and `SIGINT` handlers, sets a shutdown flag, polls Redis with a one-second timeout, disconnects both Redis clients, shuts down OpenTelemetry, and exits. Compose configures the service to restart unless stopped.

Shutdown does not drain or reclaim an in-flight job. A job removed by `BRPOP` while translation is active can be lost if the process terminates.

## 8. Observability contract

The worker emits structured logs to stdout and OpenTelemetry signals through the configured collector.

Custom metrics:

| Name | Type | Dimensions |
|---|---|---|
| `translation.jobs.total` | Counter | target language, status |
| `translation.duration` | Histogram, `ms` | target language, status |
| `translation.active_jobs` | Up/down counter | target language |

Important span attributes include job ID, session ID, source/target language, text length, duration, output length, and trace ID. Redis instrumentation and system metrics are enabled by the worker instrumentation setup.

## 9. Acceptance criteria

- The worker connects to Redis using the configured host/port and fails clearly if the connection cannot be established.
- Valid jobs are consumed in queue order compatible with frontend `LPUSH` plus worker `BRPOP`.
- Supported jobs produce exactly one terminal result under normal operation.
- Unsupported targets produce a terminal error result without invoking the translator.
- Translation exceptions produce error results and allow later jobs to continue.
- Malformed JSON and structurally invalid jobs are logged and do not crash the worker loop.
- Trace context is extracted from jobs and injected into results.
- `SIGTERM`/`SIGINT` cause Redis and OpenTelemetry cleanup.
- Unit tests cover queue behavior, translator behavior, main processing paths, logging, and telemetry lifecycle; real Redis and end-to-end delivery remain recommended gaps.

## 10. Open decisions / follow-up requirements

1. Decide whether at-most-once delivery is acceptable or implement acknowledgement/retry/DLQ semantics.
2. Decide whether results require a durable stream or result store instead of Pub/Sub only.
3. Define the authoritative supported-language configuration shared with the frontend.
4. Define maximum text size, translation timeout, and latency/SLA expectations.
5. Define behavior for invalid jobs: discard, retry, or dead-letter.
6. Define graceful shutdown semantics for an in-flight job.
7. Ensure the standalone Compose file always includes a reachable OTEL Collector, or document the required Compose overlay.
8. Define whether error strings may contain raw model/runtime details.

## Four-eyes review

Two independent reviewers inspected the implementation before this document was written:

| Reviewer | Focus | Confirmed findings |
|---|---|---|
| Reviewer A | Worker lifecycle, Redis protocol, translation/error paths | `BRPOP` at-most-once semantics, invalid-job discard behavior, error-result construction, graceful-shutdown gap |
| Reviewer B | Cross-service contract, configuration, observability | Queue/channel schema, language configuration drift, trace propagation, metrics, Compose/collector dependency |

The author reconciled both reviews. Items described as risks or open decisions were intentionally not presented as implemented guarantees.

## Source references

- `handson-labs/app-versions/code/worker/src/main.py`
- `handson-labs/app-versions/code/worker/src/queue.py`
- `handson-labs/app-versions/code/worker/src/translator.py`
- `handson-labs/app-versions/code/worker/src/config.py`
- `handson-labs/app-versions/code/worker/src/metrics.py`
- `handson-labs/app-versions/code/worker/src/instrumentation.py`
- `handson-labs/app-versions/code/worker/pyproject.toml`
- `handson-labs/compose/compose.app.yaml`
- `handson-labs/compose/compose.observability.yaml`
