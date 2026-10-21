# Simple Loki validation

These scripts use `curl`, so they work from Git Bash on Windows ARM. The handson Compose stack exposes Loki at `http://localhost:3200`.

## 1. Start the stack

```bash
cd /d/development/OpenTelemetry/handson-labs/compose
docker compose up -d
```

## 2. Send and verify a test log

```bash
cd /d/development/OpenTelemetry/opentelemetry-course/compose/test_scripts
bash validate-loki.sh
```

The script sends one labelled log, queries Loki, and prints `PASS` when the message is returned.

If Loki uses another host port:

```bash
LOKI_URL=http://localhost:3100 bash validate-loki.sh
```

## 3. Clean up test logs

```bash
bash cleanup-loki.sh
```

Deletion is asynchronous, so deleted logs may remain queryable briefly.

## 4. Check Loki metrics in Prometheus

Open `http://localhost:9100` and run:

```promql
up{job="loki"}
```

Expected value: `1`.

```promql
rate(loki_distributor_lines_received_total[5m])
```

Shows the rate of log lines received by Loki.

```promql
rate(loki_request_duration_seconds_count{route="/loki/api/v1/push"}[5m])
```

Shows the rate of log-push requests handled by Loki.

The full query list is in [`loki-promql-queries.md`](compose/test_scripts/loki-promql-queries.md).
