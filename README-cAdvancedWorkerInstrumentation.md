# Advanced Worker Instrumentation

- Worker Manual Metrics
- Worker Manual Spans
- Redis Exporter 
- Environment-Driven Worker Configuration
- Structured Logging

---
# Hands on Worker Custom Metrics

- Refer to `lab-worker-metrics-manual.md`

## 1. Create `app-versions/code/worker/src/metrics.py`

```python
"""Custom business metrics for the translation worker."""
from opentelemetry import metrics

meter = metrics.get_meter(__name__)

# Total jobs processed — dimensions: language, status (completed / error)
jobs_total = meter.create_counter(
    name="translation.jobs.total",
    description="Total number of translation jobs processed",
    unit="1",
)

# Distribution of translation execution time
translation_duration = meter.create_histogram(
    name="translation.duration",
    description="Time taken to translate a single job",
    unit="s",
)

# Current number of jobs being actively processed
active_jobs = meter.create_up_down_counter(
    name="translation.active_jobs",
    description="Number of jobs currently being processed",
    unit="1",
)
```

| Instrument      | When to use                                        |
| --------------- | -------------------------------------------------- |
| `Counter`       | Value only ever goes up (total jobs, total errors) |
| `Histogram`     | Distribution of values over time (latency)         |
| `UpDownCounter` | Value can decrease (active jobs, queue depth)      |

## 2. Update `app-versions/code/worker/src/main.py`

Add the import:

```python
from .metrics import jobs_total, translation_duration, active_jobs
```

Use a helper so all duration measurements apply the same attributes:

```python
def record_translation_duration(
    duration_ms: int, target_lang: str, status: str
) -> None:
    translation_duration.record(
        duration_ms / 1000,
        attributes={
            "translation.target_language": target_lang,
            "translation.status": status,
        },
    )
```

Use the same pattern for the job counter:

```python
def add_job_total(target_lang: str, status: str) -> None:
    jobs_total.add(
        1,
        attributes={
            "translation.target_language": target_lang,
            "translation.status": status,
        },
    )
```

Use a helper for both active-job increments and decrements:

```python
def add_active_jobs(amount: int, target_lang: str) -> None:
    active_jobs.add(
        amount,
        attributes={"translation.target_language": target_lang},
    )
```

Inside the `process_translation_job` span, call `add_active_jobs(1, target_lang)` right before the `try`, call `add_active_jobs(-1, target_lang)` in the `finally` block, and record `translation_duration` and `jobs_total` after a successful translate:

```python
) as span:
    # Custom Metrics
    start_time = time.time()
    add_active_jobs(1, target_lang)
...
# Context Propagation
span.set_status(Status(StatusCode.ERROR, error_msg))
# Custom Metrics
duration_ms = int((time.time() - start_time) * 1000)
record_translation_duration(duration_ms, target_lang, "error")
add_job_total(target_lang, "error")
...
# Custom Metrics
else:
    # Translate
    # Ensure text is not None
...
duration_ms = int((time.time() - start_time) * 1000)
    # Custom Metrics
    record_translation_duration(duration_ms, target_lang, "completed")
    add_job_total(target_lang, "completed")
    # Context Propagation
...

# Context Propagation
span.record_exception(e)
span.set_status(Status(StatusCode.ERROR, error_msg))
# Custom Metrics
record_translation_duration(duration_ms, target_lang, "error")
add_job_total(target_lang, "error")
...
~
# Custom Metrics
finally:
    add_active_jobs(-1, target_lang)

# Publish result
publish_result_with_context(queue_consumer, result)

```

## 3. Deploy and verify

Changes are picked up by hot-reload. Generate traffic, then verify in Prometheus at http://localhost:9100:

```bash
cd handson-labs/compose
docker compose -f compose.dev.yaml up --build worker -d
docker compose -f compose.dev.yaml logs worker

curl -X POST http://localhost:3001/api/translate \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world", "targetLanguages": ["es", "fr"]}'
```

```prompt
I want to test the translation service. Here is an example curl request. Generate a script test_traffic.sh in handson-labs folder that generates traffic every 0.2 to 0.7 seconds. The traffic should be diverse and cover success and failure scenarios. Here is one example of curl request. Supported languages are "es", "fr", "de".

curl -X POST http://localhost:3001/api/translate \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world", "targetLanguages": ["es", "fr"]}'

```

```bash
cd ..
bash test_traffic.sh

```

```promql
rate(translation_jobs_total{exported_job="translation-worker"}[2m])
translation_duration_seconds_count{exported_job="translation-worker"}
translation_active_jobs{exported_job="translation-worker"}

<!-- histogram_quantile(0.95, rate(translation_duration_seconds_bucket{exported_job="translation-worker"}[5m]))
translation_duration_seconds_bucket{exported_job="translation-worker"} -->

histogram_quantile(0.95, rate(translation_duration_milliseconds_bucket{exported_job="translation-worker"}[5m]))
translation_duration_milliseconds_bucket{exported_job="translation-worker"}
```

---
# Hands on Worker Custom Traces / Spans

- Refer to `lab-worker-traces-manual.md`

## 1. Update `app-versions/code/worker/src/translator.py`

Add the imports and a module-level tracer at the top:

```python
from opentelemetry import trace
from opentelemetry.trace import StatusCode

tracer = trace.get_tracer(__name__)
```

Wrap the `translate()` method body in a span:

```python
def translate(self, text: str, source: str, target: str) -> str:
    if not text or not text.strip():
        return text

    with tracer.start_as_current_span(
        "translate_text",
        attributes={
            "translation.source_language": source,
            "translation.target_language": target,
            "translation.text_length": len(text),
        },
    ) as span:
        try:
            translation = argostranslate.translate.get_translation_from_codes(source, target)

            if translation is None:
                error_msg = f"Translation model not available for {source} -> {target}"
                span.set_status(trace.Status(StatusCode.ERROR, error_msg))
                raise ValueError(error_msg)

            translated_text = translation.translate(text)
            span.set_attribute("translation.output_length", len(translated_text))
            span.set_status(trace.Status(StatusCode.OK))
            return translated_text

        except ValueError:
            raise
        except Exception as e:
            span.record_exception(e)
            span.set_status(trace.Status(StatusCode.ERROR, str(e)))
            raise RuntimeError(f"Translation failed ({source} -> {target}): {e}") from e
```

## 2. Deploy and verify

```bash
cd compose
docker compose -f compose.dev.yaml up --build worker -d
docker compose -f compose.dev.yaml logs worker

cd ..
bash test_traffic.sh
```

Changes are hot-reloaded. Generate traffic and open a trace in Tempo. Expected span hierarchy:

```
[translation-worker] process_translation_job - fr
  └─ [translation-worker] translate_text
       └─ [translation-worker] PUBLISH  (Redis auto-span)
```

Click `translate_text` and confirm attributes `translation.source_language`, `translation.target_language`, `translation.text_length`, `translation.output_length` are all present.

---

# Hands on Redis Exporter Metrics

- Refer to `lab-redis-metrics.md`

## 1. Add `redis-exporter` to `compose/compose.app.yaml`

Open `compose/compose.app.yaml` and add the `redis-exporter` service after the `redis` service:

```yaml
  redis-exporter:
    image: oliver006/redis_exporter:v1.81.0-alpine
    container_name: redis-exporter
    environment:
      - REDIS_ADDR=redis://redis:6379
    ports:
      - '9121:9121'
    networks:
      - app
      - observability
    depends_on:
      redis:
        condition: service_healthy
    restart: unless-stopped
```

## 2. Add the Redis scrape job to `compose/prometheus.yaml`

Open `compose/prometheus.yaml` and add a new scrape job at the end of `scrape_configs`:

```yaml
- job_name: 'redis'
  static_configs:
    - targets: ['redis-exporter:9121']
```

## 3. Deploy the exporter and reload Prometheus

```bash
cd compose/
docker compose -f compose.dev.yaml up -d redis-exporter
docker compose -f compose.dev.yaml logs redis-exporter

docker compose -f compose.dev.yaml restart prometheus
docker compose -f compose.dev.yaml logs prometheus

cd ..
bash test_traffic.sh
```

## 4. Verify the exporter is up

```bash
curl -s http://localhost:9121/metrics
curl -s http://localhost:9121/metrics | grep "redis_up 1"
```

Expected output:

```
redis_up 1
```

## 5. Verify Prometheus is scraping the target

Open Prometheus at http://localhost:9100/targets and confirm the `redis` job shows `UP`.

## 6. Explore Redis metrics in Grafana

Open Grafana at http://localhost:3010 → Explore → Prometheus.

Try these queries:

| Query                            | What it shows                                |
| -------------------------------- | -------------------------------------------- |
| `redis_memory_used_bytes`        | Current memory consumed by Redis             |
| `redis_connected_clients`        | Active connections at this moment            |
| `rate(redis_commands_total[1m])` | Commands per second across all clients       |
| `redis_db_keys{db="db0"}`        | Total number of keys in the default database |

Generate some traffic first:

```bash
curl -X POST http://localhost:3001/api/translate \
  -H "Content-Type: application/json" \
  -d '{"text": "The quick brown fox jumps over the lazy dog", "targetLanguages": ["es", "fr", "de"]}'
```

Then re-run the Prometheus queries to see the metrics change.

---
#  Environment-Driven Configuration

- Refer to [`lab-refactoring-env-config.md`](labs/section-distributed-systems/lab-refactoring-env-config.md)

## 1. Review the OTel configuration in `frontend/src/instrumentation.ts`

Open `app-versions/code/frontend/src/instrumentation.ts`. The file has already been updated to remove all hardcoded OTel values — review it to understand how the Node.js OTel SDK reads standard environment variables automatically when no explicit value is provided.

The file should look like this:

```typescript
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { WinstonInstrumentation } from '@opentelemetry/instrumentation-winston';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';

// All configuration is driven by standard OTel environment variables:
//   OTEL_SERVICE_NAME                   — service name (required)
//   OTEL_EXPORTER_OTLP_ENDPOINT         — base URL for all signals, e.g. http://otel-collector:4318
//   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT  — override traces endpoint
//   OTEL_EXPORTER_OTLP_METRICS_ENDPOINT — override metrics endpoint
//   OTEL_EXPORTER_OTLP_LOGS_ENDPOINT    — override logs endpoint
//   OTEL_METRIC_EXPORT_INTERVAL         — metrics export interval in ms (default 60000)
const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter(),
    exportIntervalMillis: parseInt(
      process.env.OTEL_METRIC_EXPORT_INTERVAL || '60000',
      10,
    ),
  }),
  logRecordProcessors: [new BatchLogRecordProcessor(new OTLPLogExporter())],
  instrumentations: [
    getNodeAutoInstrumentations(),
    new WinstonInstrumentation(),
  ],
});

sdk.start();
```

The standard environment variables automatically handled by the SDK are:

| Environment variable                  | What it controls                       |
| ------------------------------------- | -------------------------------------- |
| `OTEL_SERVICE_NAME`                   | Service name attached to all telemetry |
| `OTEL_EXPORTER_OTLP_ENDPOINT`         | Base URL for all three OTLP exporters  |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`  | Traces-specific override               |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Metrics-specific override              |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`    | Logs-specific override                 |
| `OTEL_METRIC_EXPORT_INTERVAL`         | Metric export interval in ms           |

> **Why keep `exportIntervalMillis` explicit?** The `PeriodicExportingMetricReader` constructor does not currently read `OTEL_METRIC_EXPORT_INTERVAL` automatically in all SDK versions, so we read it explicitly with a default of 60000ms. Everything else — `serviceName`, all OTLP URLs — is handled by the SDK.

> **Why does removing `serviceName` from code matter?** If `serviceName: 'translation-frontend'` is set explicitly in the `NodeSDK` constructor, it silently overrides `OTEL_SERVICE_NAME` regardless of what Kubernetes injects at runtime. Removing the hardcoded value ensures the environment variable always takes effect.

## 2. Fix the log level in `frontend/src/logger.ts`

The logger hardcodes `level: 'info'`, ignoring the `LOG_LEVEL` environment variable that is already set in the Compose file:

```typescript
// Before:
export const logger = winston.createLogger({
  level: 'info',
  // ...
});

// After:
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL?.toLowerCase() || 'info',
  // ...
});
```

## 3. Move hardcoded queue config to env vars in `worker/src/config.py`

The worker's `Config` class already reads most values from the environment, but three are hardcoded:

```python
# Before:
return cls(
    redis_host=os.getenv("REDIS_HOST", "localhost"),
    redis_port=int(os.getenv("REDIS_PORT", "6379")),
    queue_key="translation:queue",           # ← hardcoded
    result_channel="translation:results",    # ← hardcoded
    source_language=os.getenv("SOURCE_LANGUAGE", "en"),
    supported_languages=["es", "fr", "de"],  # ← hardcoded
    log_level=os.getenv("LOG_LEVEL", "info").upper(),
)

# After:
supported_languages_raw = os.getenv("SUPPORTED_LANGUAGES", "es,fr,de")
supported_languages = [l.strip() for l in supported_languages_raw.split(",") if l.strip()]

return cls(
    redis_host=os.getenv("REDIS_HOST", "localhost"),
    redis_port=int(os.getenv("REDIS_PORT", "6379")),
    queue_key=os.getenv("QUEUE_KEY", "translation:queue"),
    result_channel=os.getenv("RESULT_CHANNEL", "translation:results"),
    source_language=os.getenv("SOURCE_LANGUAGE", "en"),
    supported_languages=supported_languages,
    log_level=os.getenv("LOG_LEVEL", "info").upper(),
)
```

`SUPPORTED_LANGUAGES` accepts a comma-separated list: `es,fr,de` or `es,fr,de,ja,zh`.

## 3 Update `compose.app.yaml`

```yaml
  worker:
    # image: lmacademy/web-translator-worker:v1.1.0
    container_name: worker
    environment:
      - REDIS_HOST=redis
      - REDIS_PORT=6379
      - QUEUE_KEY=translation:queue
      - RESULT_CHANNEL=translation:results
      - LOG_LEVEL=info
      - SOURCE_LANGUAGE=en
      - SUPPORTED_LANGUAGES=es,fr,de
      # Refactoring
      - OTEL_SERVICE_NAME=translation-worker
      - OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
```

## 4 Deploy

```bash
cd compose
docker compose -f compose.dev.yaml up --build -d --force-recreate
docker compose -f compose.dev.yaml logs worker

cd ..
bash test_traffic.sh
```

## 4 🔑 Environment Variable Reference

After this lab, every runtime value in both services is configurable via env vars:

**Frontend:**

| Variable                      | Default      | Purpose                       |
| ----------------------------- | ------------ | ----------------------------- |
| `OTEL_SERVICE_NAME`           | _(required)_ | Service name in all telemetry |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | _(required)_ | OTel Collector base URL       |
| `OTEL_METRIC_EXPORT_INTERVAL` | `60000`      | Metric flush interval (ms)    |
| `REDIS_HOST`                  | `localhost`  | Redis hostname                |
| `REDIS_PORT`                  | `6379`       | Redis port                    |
| `PORT`                        | `3000`       | HTTP server port              |
| `LOG_LEVEL`                   | `info`       | Winston log level             |

**Worker:**

| Variable                      | Default                      | Purpose                           |
| ----------------------------- | ---------------------------- | --------------------------------- |
| `OTEL_SERVICE_NAME`           | `translation-worker`         | Service name in all telemetry     |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://otel-collector:4318` | OTel Collector base URL           |
| `OTEL_METRIC_EXPORT_INTERVAL` | `60000`                      | Metric flush interval (ms)        |
| `REDIS_HOST`                  | `localhost`                  | Redis hostname                    |
| `REDIS_PORT`                  | `6379`                       | Redis port                        |
| `QUEUE_KEY`                   | `translation:queue`          | Redis list key for jobs           |
| `RESULT_CHANNEL`              | `translation:results`        | Redis pub/sub channel for results |
| `SOURCE_LANGUAGE`             | `en`                         | Source language code              |
| `SUPPORTED_LANGUAGES`         | `es,fr,de`                   | Comma-separated target languages  |
| `LOG_LEVEL`                   | `info`                       | Python log level                  |

---

# Structured Logging for the Worker

- Refer to `lab-refactoring-structured-logs.md`

## 1. Study the current logging in the worker

Read through `app-versions/code/worker/src/main.py` and `app-versions/code/worker/src/queue.py`. Note:

- How `logging.basicConfig()` is configured
- Every `logger.info()`, `logger.error()`, and `logger.debug()` call that uses f-string interpolation
- What contextual data (job IDs, language codes, durations, host/port) is currently interpolated into message strings

## 2. Ask your AI assistant to perform the refactoring

Open your AI assistant and provide this prompt:

```prompt
I want to refactor the logs from the worker to also follow structured logging, similar to the frontend. Research the codebase under `handson-labs/app-versions/code` and provide a plan for the implementation. Pause and ask for my feedback on the plan before proceeding with the implementation.
```

**Review the AI's plan before approving it.** Check:

- Does it plan to add a JSON formatter library to the `pyproject.toml` file?
- Does it plan to replace `basicConfig` with a structured JSON handler?
- Does it identify the f-string log calls in both `main.py` and `queue.py`?
- Does the plan separate event descriptions from contextual data (no variable interpolation in message strings)?

Once you're happy with the plan, tell the AI to proceed with the implementation.

## 3. Apply the changes and verify

Once satisfied with the AI's output, apply the changes.

Reinstall dependencies in the worker. Depending on your setup:

**With `uv` (recommended):**

```bash
cd app-versions/code/worker
uv sync
```

**With `pip` and a virtual environment:**

```bash
cd app-versions/code/worker
# source .venv/bin/activate   # or .venv\Scripts\activate on Windows
pip install -r requirements.txt
```

Restart the worker (if running via Docker Compose):

```bash
cd ../../../compose
docker compose -f compose.dev.yaml up --build worker -d

docker compose -f compose.dev.yaml logs worker --tail=20
docker compose -f compose.dev.yaml logs -f worker | grep -E 'src\.main|src\.queue|src\.translator'

cd ..
bash test_traffic.sh

```

You should now see JSON lines in the worker logs:

```json
{
  "timestamp": "2024-01-15 10:23:45,123",
  "level": "INFO",
  "name": "worker.main",
  "message": "Worker ready, waiting for jobs..."
}
```

## 4. Send a translation request and check Loki

Generate a request:

```bash
curl -X POST http://localhost:3000/api/translate \
  -H "Content-Type: application/json" \
  -d '{"text": "Structured logging", "targetLanguages": ["es"]}'
```

In Grafana → Explore → Loki, run:

```logql
{service_name="translation-worker"} | json
```

Expand a log entry. You should now see `job_id`, `target_language`, and `duration_ms` as separate fields rather than embedded in a message string.

Try a field filter that would have been impossible before:

```logql
{service_name="translation-worker"} | json | target_language = "es"
```

## 5 Upgrade python-json-logger

```prompt
The latest available version for python-json-logger is 4.2.0. Changelog under https://nhairs.github.io/python-json-logger/latest/changelog/

Make sure you implement the correct API and function calls for version 4.2.0. Other than that, the plan looks good and you may proceed.
```
---
