# Lab: Verify Telemetry in Kubernetes

## 🎯 Lab Goal

Confirm that all three telemetry signals — metrics, logs, and traces — are flowing correctly through the full Kubernetes observability pipeline: application → OTel Collector → Prometheus / Loki / Tempo.

## 📝 Overview & Concepts

After deploying to Kubernetes, the telemetry path is identical in structure to Docker Compose but the network hops now cross namespace and pod boundaries. This guide targets Docker Desktop's embedded Kubernetes cluster on Windows. Before trusting the data in dashboards, it is worth running a set of targeted queries to prove each signal is present and meaningful.

## Prerequisites — Docker Desktop Kubernetes

Run these commands from Git Bash. The expected Kubernetes context is `docker-desktop`:

```bash
kubectl config current-context
kubectl cluster-info
kubectl get nodes
```

The context should be `docker-desktop` and the node should be `Ready`. If the context is missing, enable Kubernetes in Docker Desktop and wait for the cluster to finish starting. Docker Desktop Kubernetes uses the same Docker Desktop image store, so locally tagged images such as `christseng89/web-translator-frontend:v1.3` and `christseng89/web-translator-worker:v1.3` do not need to be pushed to a registry. This applies only when the Deployment uses an appropriate pull policy such as `IfNotPresent`.

Confirm that the required namespaces exist:

```bash
kubectl get namespaces app observability
```

The user-facing endpoints are exposed through the NGINX Ingress controller. No
application, Grafana, or Prometheus port-forward is required.

Add these entries to the Windows hosts file
(`C:\Windows\System32\drivers\etc\hosts`) with administrator privileges:

```bash
127.0.0.1 frontend.test.com
127.0.0.1 grafana.test.com
127.0.0.1 prometheus.test.com
```

Verify the NGINX controller and Ingress resources:

```bash
kubectl get ingressclass nginx
kubectl -n ingress-nginx get pods,svc
kubectl -n app get ingress frontend
kubectl -n observability get ingress observability
```

Use these URLs in the steps below:

- Frontend: `http://frontend.test.com:9080`
- Grafana: `http://grafana.test.com:9080`
- Prometheus: `http://prometheus.test.com:9080`

Check the ingress routes before generating traffic:

```bash
curl -fsS http://frontend.test.com:9080/health
curl -fsS http://grafana.test.com:9080/api/health
curl -fsS http://prometheus.test.com:9080/-/ready
```

Generate some traffic — including a few invalid requests to produce warnings and errors:

```bash
# Valid requests
for i in {1..5}; do
  curl -sS -X POST http://frontend.test.com:9080/api/translate \
    -H 'Content-Type: application/json' \
    -d '{"text":"Hello Kubernetes!","targetLanguages":["es","fr","de"]}'
  echo
done

# Invalid requests (unsupported language — triggers validation warning)
for i in {1..3}; do
  curl -sS -o /dev/null -w 'HTTP %{http_code}\n' \
    -X POST http://frontend.test.com:9080/api/translate \
    -H 'Content-Type: application/json' \
    -d '{"text":"Hello!","targetLanguages":["xx"]}'
done
```

## 📋 Tasks

### Part 0 — Preflight checks

Before generating traffic, verify the deployment and scrape wiring:

```bash
kubectl -n observability get pods,svc,endpoints
kubectl -n app get pods,svc,endpoints
kubectl -n observability get pod -l app.kubernetes.io/instance=otel-collector \
  -o jsonpath='{range .items[0].spec.containers[0].ports[*]}{.name}{"="}{.containerPort}{"\n"}{end}'
kubectl -n observability auth can-i list pods --as=system:serviceaccount:observability:prometheus
kubectl -n observability auth can-i watch pods --as=system:serviceaccount:observability:prometheus
kubectl -n observability describe pod -l app.kubernetes.io/name=otel-collector
```

Confirm that the Collector Pod exposes `otlp`, `otlp-http`, `health-check`,
`int-metrics`, and `app-metrics`. Confirm that Prometheus has two
separate Collector jobs and that both are `UP`. If a Pod is not ready, inspect
image-pull events separately from application startup logs.

For Docker Desktop, image-pull failures usually mean the image tag is missing
from Docker Desktop or the Deployment is trying to pull it. Check the exact
image and pull policy with:

```bash
kubectl -n app get deployment frontend worker \
  -o custom-columns=NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image,PULL:.spec.template.spec.containers[0].imagePullPolicy
docker image ls christseng89/web-translator-frontend christseng89/web-translator-worker
```

The Collector health endpoint is Pod-local and is intentionally not routed
through the public Ingress. Verify the readiness state and probe configuration
without exposing port `13133` through a Service:

```bash
kubectl -n observability get pod -l app.kubernetes.io/instance=otel-collector \
  -o custom-columns=NAME:.metadata.name,READY:.status.containerStatuses[0].ready,PHASE:.status.phase
kubectl -n observability describe pod -l app.kubernetes.io/instance=otel-collector \
  | grep -A8 -E 'Readiness|Liveness|13133'
```

If the Collector configuration changes, verify that the Deployment's Pod
template changes and that a new Pod replaces the old one:

```bash
kubectl -n observability rollout status deployment/otel-collector
kubectl -n observability get pods -l app.kubernetes.io/instance=otel-collector
```

Verify the Collector's backend DNS names before telemetry testing:

```bash
kubectl -n observability get svc otel-collector loki tempo
kubectl -n observability get endpoints otel-collector loki tempo
```

### Part 1 — Verify metrics in Prometheus

Open the Prometheus UI at `http://prometheus.test.com:9080`.

**1. Confirm the OTel Collector pipeline is healthy**

In **Status → Targets**, find both `otel-collector-internal` and
`otel-collector-application` and verify they show `UP`. The internal job
scrapes port `8888`; the application job scrapes port `8889`. Then check that
all three signals are flowing through the Collector:

```promql
rate(otelcol_receiver_accepted_spans_total[5m])
rate(otelcol_receiver_accepted_metric_points_total[5m])
rate(otelcol_receiver_accepted_log_records_total[5m])
```

All three should be non-zero. If any reads zero, check that the Deployment manifests use `otel-collector.observability.svc.cluster.local:4318` as the OTLP endpoint.

**2. Frontend request and validation error rates**

```promql
# Per-second translation request rate
rate(translation_requests_total{exported_job="translation-frontend"}[5m])

# Validation errors by error type (should spike after the invalid requests above)
translation_validation_errors_total{exported_job="translation-frontend"}
```

**3. Worker job outcomes by language and status**

```promql
sum by (translation_target_language, translation_status) (
  translation_jobs_total{exported_job="translation-worker"}
)
```

You should see `status="completed"` entries for `es`, `fr`, and `de`.

**4. 95th percentile translation duration**

```promql
histogram_quantile(
  0.95,
  rate(translation_duration_milliseconds_bucket{exported_job="translation-worker"}[5m])
)
```

> **Note on metric names:** The OTel Collector's Prometheus exporter converts dots to underscores and appends the unit suffix. `translation.duration` with unit `ms` becomes `translation_duration_milliseconds`.

---

### Part 2 — Verify logs in Loki

Open Grafana at `http://grafana.test.com:9080`, navigate to **Explore**, and select the **Loki** data source.

**5. Confirm logs from both services**

```logql
{service_name="translation-frontend"} | json
```

```logql
{service_name="translation-worker"} | json
```

Both should return structured JSON entries. If either returns nothing, check that the OTel Collector log pipeline is receiving data (step 1 above).

**6. Filter for warnings and errors across all services**

```logql
{service_name=~"translation-.*"} | json | severity_text=~"(?i)warn|error"
```

The invalid requests from the traffic loop above should have produced warning entries in the frontend logs.

**7. Trace a specific session across both services**

Copy a `session_id` from any frontend log entry, then filter both services down to that session:

```logql
{service_name="translation-frontend"} | json | session_id="<paste-session-id-here>"
```

Click the `trace_id` field on any log line — if Tempo is wired up as a data source in Grafana, a direct link to the trace will appear.

---

### Part 3 — Verify traces in Tempo

**8. Find a recent trace**

In Grafana Explore, switch to the **Tempo** data source. Use **Search** mode with:

- **Service name**: `translation-frontend`
- **Span name**: `create_translation_session`

Click any result to open the flame graph. Verify that:

- Child spans `validate_request` and `enqueue_translation_jobs` appear under the root.
- The worker span `process_translation_job` appears as a child, confirming cross-service context propagation over Redis.

If the worker span is a separate root trace instead of a child, context propagation is broken — review the `_traceContext` injection in the frontend and `propagate.extract()` in the worker.

## 📚 Resources

- [PromQL basics](https://prometheus.io/docs/prometheus/latest/querying/basics/)
- [Loki LogQL reference](https://grafana.com/docs/loki/latest/query/)
- [OpenTelemetry Collector observability](https://opentelemetry.io/docs/collector/internal-telemetry/)
