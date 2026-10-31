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

Inside the `process_translation_job` span, add `active_jobs.add(1)` right before the `try`, add a `finally` block to the `try/except` that calls `active_jobs.add(-1)`, and record `translation_duration` and `jobs_total` after a successful translate:

```python
) as span:
    # Custom Metrics
    start_time = time.time()
    active_jobs.add(
        1, attributes={"translation.target_language": target_lang}
    )
...
# Context Propagation
span.set_status(Status(StatusCode.ERROR, error_msg))
# Custom Metrics
jobs_total.add(
    1,
    attributes={
        "translation.target_language": target_lang,
        "translation.status": "error",
    },
)
...
# Custom Metrics
else:
    # Translate
    # Ensure text is not None
...
duration_ms = int((time.time() - start_time) * 1000)
    # Custom Metrics
    translation_duration.record(
        duration_ms / 1000,
        attributes={
            "translation.target_language": target_lang
        },
    )
    jobs_total.add(
        1,
        attributes={
            "translation.target_language": target_lang,
            "translation.status": "completed",
        },
    )
    # Context Propagation
...

# Context Propagation
span.record_exception(e)
span.set_status(Status(StatusCode.ERROR, error_msg))
# Custom Metrics
jobs_total.add(
    1,
    attributes={
        "translation.target_language": target_lang,
        "translation.status": "error",
    },
)
...
~
# Custom Metrics
finally:
    active_jobs.add(
        -1, attributes={"translation.target_language": target_lang}
    )

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

```promql
rate(translation_jobs_total{exported_job="translation-worker"}[2m])
histogram_quantile(0.95, rate(translation_duration_seconds_bucket{exported_job="translation-worker"}[5m]))
translation_duration_seconds_count{exported_job="translation-worker"}
translation_active_jobs{exported_job="translation-worker"}
```

---
