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
