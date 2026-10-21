# Loki checks in Prometheus

Prometheus scrapes Loki at `loki:3100`. Open the Prometheus UI at `http://localhost:9100` and wait at least 15 seconds after starting the stack.

## Health and runtime

```promql
loki_build_info
```

Confirms that Loki exposes build information.

```promql
up{job="loki"}
```

Expected value: `1`, meaning Prometheus can scrape Loki.

```promql
process_resident_memory_bytes{job="loki"} / 1024 / 1024
```

Shows Loki memory usage in MB.

## Ingestion

```promql
rate(loki_distributor_lines_received_total[5m])
```

Shows the average rate of log lines received by Loki.

```promql
rate(
  loki_request_duration_seconds_count{
    job="loki",
    method="POST",
    route="loki_api_v1_push",
    status_code=~"2.."
  }[5m]
)
```

Shows the rate of successful log-push requests.

## Errors and latency

```promql
rate(loki_request_duration_seconds_count{status_code=~"5.."}[5m])
```

Shows Loki requests returning HTTP 5xx. A healthy result is empty or `0`.

```promql
histogram_quantile(
  0.99,
  sum by (le, route) (
    rate(loki_request_duration_seconds_bucket[5m])
  )
)
```

Shows p99 request latency by route.

## Ingester and storage health

```promql
loki_ingester_memory_streams
```

Shows active in-memory log streams.

```promql
loki_ingester_memory_chunks
```

Shows chunks currently held in memory.

```promql
loki_ingester_flush_queue_length
```

Shows pending chunk flushes. A sustained increase may indicate storage pressure.

```promql
rate(loki_ingester_chunks_flushed_total[5m])
```

Shows the rate at which Loki flushes chunks.

## Cleanup

```promql
loki_compactor_pending_delete_requests_count
```

Shows pending delete requests. `0` means no delete requests are waiting.

```promql
rate(
  loki_request_duration_seconds_count{
    job="loki",
    method="POST",
    route="loki_api_v1_delete",
    status_code="204"
  }[5m]
)
```

Shows the rate of successful cleanup requests accepted by Loki.

Some metrics only appear after the related Loki component has handled traffic. An empty result can therefore be normal for a new or idle instance.
