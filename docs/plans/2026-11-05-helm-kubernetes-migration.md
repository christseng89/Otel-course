# Helm Kubernetes Migration Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate the Compose-based translation application and observability stack to Kubernetes with Helm, including staging values and an OpenTelemetry Collector deployment based on the official OpenTelemetry Helm chart.

**Architecture:** Use separate Helm releases for the application and observability components. Deploy the OpenTelemetry Collector as a single-replica gateway initially, preserving the existing OTLP traces, metrics, and logs pipelines while using Kubernetes Service DNS names and direct Pod scraping for Collector metrics. Defer multi-replica application-metrics collection until a safe aggregation strategy is designed.

**Tech Stack:** Kubernetes, Helm 3, official OpenTelemetry Collector Helm chart, Prometheus, Loki, Tempo, Grafana, Redis, Kube State Metrics, OTLP, Kubernetes RBAC, PVCs, and optional Argo CD GitOps.

---

## 0. Branch isolation and repository hygiene

Implement this migration on a dedicated feature branch rather than directly on the default branch. The repository currently uses `master` and already contains unrelated working-tree modifications.

Before implementation:

1. Inspect and record the existing working-tree changes in the current worktree without modifying or discarding them.
2. Do not create the migration branch by continuing to work in the dirty `master` worktree.
3. Start from the latest clean `master` ref and create a separate Git worktree outside the current repository directory, for example:

   ```text
   D:\development\OpenTelemetry-helm-migration
   ```

4. Create and check out a dedicated branch in that worktree, for example:

   ```text
   codex/helm-kubernetes-migration
   ```

5. Implement and validate the migration only in that worktree and branch.
6. Commit only migration-related files.
7. Preserve the original dirty worktree and exclude its unrelated modifications from migration commits.
8. Open a review or merge request back into `master` after validation.

Do not use destructive cleanup commands, reset unrelated changes, or include unrelated files in the migration branch commits. Verify the final diff and staged file list before every migration commit.

## 1. Source inventory and migration contract

Review these files before implementation:

- `handson-labs/compose/compose.yaml`
- `handson-labs/compose/compose.app.yaml`
- `handson-labs/compose/compose.observability.yaml`
- `handson-labs/compose/compose.prod.yaml`
- `handson-labs/compose/otel-collector-config.yaml`
- `handson-labs/compose/prometheus.yaml`
- `handson-labs/compose/loki-config.yaml`
- `handson-labs/compose/tempo-config.yaml`
- `handson-labs/compose/grafana-datasources.yaml`

Create a migration matrix for every service containing:

- Image repository and immutable tag
- Command and arguments
- Environment variables
- Container and host ports
- Configuration files and mount paths
- Persistent data paths
- Health checks
- Service dependencies
- Required Kubernetes Service name
- Required namespace

The application scope is frontend, worker, Redis, and Redis Exporter. The observability scope is OpenTelemetry Collector, Prometheus, Loki, Tempo, Grafana, and Kube State Metrics.

Important Compose-to-Kubernetes changes:

- Frontend and worker send OTLP to `otel-collector.observability.svc.cluster.local:4318`.
- Collector exporters use Kubernetes Service DNS names for Tempo and Loki.
- Compose configuration bind mounts become Helm-managed ConfigMaps; Compose persistent data volumes become PVC-backed Kubernetes volumes.
- Compose network connectivity is re-expressed through Kubernetes namespaces, Services, DNS, and—where required—NetworkPolicies. Namespaces provide organization and isolation; Services provide stable DNS and discovery. This is not a one-to-one conversion of a Compose network into a namespace.
- Compose restart behavior becomes Deployment lifecycle management.

The current Compose production file references prebuilt application images, but this plan must also include the image supply chain needed to produce and publish those images. The OpenTelemetry Collector, Prometheus, Loki, Tempo, Grafana, Redis, and Kube State Metrics images remain upstream/platform images and are not built by this project.

## 2. Application image build and Kubernetes re-deployment

The Docker Desktop Kubernetes workflow uses the existing development
Dockerfiles without modifying them. Compose mounts source code at runtime, but
Kubernetes does not, so build a base image first and then a wrapper image that
copies the source into the image:

```text
Frontend base: handson-labs/app-versions/code/frontend/Dockerfile.dev
Worker base: handson-labs/app-versions/code/worker/Dockerfile.dev
Frontend wrapper: handson-labs/k8s/images/frontend-dev-k8s.Dockerfile
Worker wrapper: handson-labs/k8s/images/worker-dev-k8s.Dockerfile
```

The current Docker Desktop staging tags are:

```text
christseng89/web-translator-frontend:v1.3
christseng89/web-translator-worker:v1.3
```

Build the images from the repository root:

```bash
docker build -t christseng89/web-translator-frontend:v1.3-dev-base \
  -f handson-labs/app-versions/code/frontend/Dockerfile.dev \
  handson-labs/app-versions/code/frontend

docker build -t christseng89/web-translator-worker:v1.3-dev-base \
  --network=host \
  -f handson-labs/app-versions/code/worker/Dockerfile.dev \
  handson-labs/app-versions/code/worker

docker build -t christseng89/web-translator-frontend:v1.3 \
  -f handson-labs/k8s/images/frontend-dev-k8s.Dockerfile .

docker build -t christseng89/web-translator-worker:v1.3 \
  -f handson-labs/k8s/images/worker-dev-k8s.Dockerfile .
```

The worker base build downloads the ARM64 PyTorch runtime, dependencies, and
translation models and can fail because of registry or package-index timeouts.
Do not build its wrapper until the base image exists. A previously verified
worker image may be used as an explicit local override.

For Docker Desktop Kubernetes, the local image store is shared with the
cluster. For a remote staging cluster, publish immutable tags or digests to
Docker Hub and update the staging values before deployment.

After rebuilding an existing local tag, explicitly restart the affected
Deployment because Kubernetes does not detect changes behind the same tag:

```bash
kubectl -n app rollout restart deployment/frontend
kubectl -n app rollout status deployment/frontend --timeout=180s
kubectl -n app rollout restart deployment/worker
kubectl -n app rollout status deployment/worker --timeout=180s
```

The frontend Deployment must set:

```text
NODE_OPTIONS=--experimental-loader=@opentelemetry/instrumentation/hook.mjs
```

This enables the official Node.js `ioredis` instrumentation before the Redis
module is loaded. Without it, `HSET`, `HINCRBY`, and related Redis command
spans will be absent even though application spans are exported.

The local Docker Desktop workflow currently reuses `v1.3` and requires an
explicit rollout restart after rebuilding. For shared or remote staging, use a
new immutable source-version/commit tag or digest for every image instead of
overwriting `v1.3` or using `latest`.

Production publication remains a separate CI/CD concern. CI should test,
scan, publish immutable images, and update Helm values rather than reusing the
local `v1.3` development tag.

## 3. Helm release and namespace structure

Use two local chart boundaries:

```text
handson-labs/k8s/helm/
├── observability/
└── translation-app/
```

Deploy three releases with explicit ownership:

```text
otel-collector release                   → official Collector chart, observability namespace
observability release                   → local backend/platform chart, observability namespace
translation-app release                 → local application chart, app namespace
```

Create or manage the `observability` and `app` namespaces explicitly. Keep application and platform lifecycle independent so the application can be upgraded without reinstalling storage-backed observability services.

Use common and environment-specific values:

```text
handson-labs/k8s/helm/observability/values.yaml
handson-labs/k8s/helm/observability/values-dev.yaml
handson-labs/k8s/helm/observability/values-staging.yaml
handson-labs/k8s/helm/translation-app/values.yaml
handson-labs/k8s/helm/translation-app/values-dev.yaml
handson-labs/k8s/helm/translation-app/values-staging.yaml
```

Pin chart versions, dependency versions, image repositories, image tags, and—where practical—image digests. Do not use `latest`.

## 4. OpenTelemetry Collector design

Use the official chart documented at:

<https://opentelemetry.io/docs/platforms/kubernetes/helm/collector/>

Before writing values, configure the official chart repository and inspect the exact pinned chart schema:

```text
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
helm repo update
helm show values open-telemetry/opentelemetry-collector --version <chart-version>
```

Confirm that the selected chart version supports the required values for `mode`, `fullnameOverride`, custom ports, probes, Service configuration, and PodDisruptionBudget behavior.

Before deployment, make the image-component check executable in CI or in a pre-deployment validation job. Render the exact Collector configuration and start the pinned image with that configuration in an isolated validation environment. The component-instantiation check must not require Tempo or Loki to be reachable: it should confirm that the configuration loads and all configured components can be created, while treating backend connection failures as a separate connectivity test. Where the selected distribution supports a component-listing or validation command, run that command as an additional check; otherwise use isolated Collector startup/configuration validation as the authoritative component test.

The check must verify the actual configured component instances, not only generic categories:

```text
otlp receiver
otlp_grpc/tempo exporter
otlp_http/loki exporter
prometheus exporter
batch processor
memory_limiter processor
health_check extension
```

The selected implementation uses the official contrib distribution `ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib:0.163.2` with command `otelcol-contrib`, because the configured Prometheus exporter is not present in the Kubernetes distribution used by the chart example. The selected image must support all configured exporters and processors; otherwise build an approved custom image.

Configure:

```yaml
mode: deployment
replicaCount: 1
fullnameOverride: otel-collector
```

The initial single replica is intentional. Application OTLP metrics are aggregated through the Collector's Prometheus exporter; simply scaling the gateway to two replicas can produce partial, duplicate, or inconsistent metric series. Do not add a second replica until a metrics aggregation or split-gateway architecture has been designed and tested.

Preserve the existing pipelines from `handson-labs/compose/otel-collector-config.yaml`:

```text
OTLP → traces → Tempo
OTLP → metrics → Prometheus exporter
OTLP → logs → Loki
```

Configure the health-check extension:

```yaml
extensions:
  health_check:
    endpoint: 0.0.0.0:13133

service:
  extensions:
    - health_check
```

Declare these named container ports on the Collector container:

```text
otlp: 4317
otlp-http: 4318
health-check: 13133
int-metrics: 8888
app-metrics: 8889
```

Use port `13133` for readiness and liveness probes. It must be available on the Pod; publishing it through the Service is optional and should normally be avoided.

Explicitly define all receivers, processors, exporters, and pipeline component lists. Disable unused default Jaeger, Zipkin, Prometheus, and other receivers and their ports rather than relying on chart defaults.

Use explicit Service names for the local backend workloads. Configure the local Loki and Tempo resources so their Services are named exactly `loki` and `tempo`, or verify the generated names and update the Collector endpoint values accordingly with `helm template` and `kubectl get svc -n observability`.

Use these Kubernetes backend endpoints when those explicit names are selected:

```text
tempo.observability.svc.cluster.local:4317
http://loki.observability.svc.cluster.local:3100/otlp
```

Review TLS settings separately for development and staging. Do not blindly carry forward `insecure: true` if staging requires encrypted or authenticated traffic.

Do not install the OpenTelemetry Operator initially. The application already configures its OpenTelemetry SDKs; automatic instrumentation and Collector custom resources are not required for this migration. Reconsider the Operator only if those requirements are introduced later.

Do not enable the official `logsCollection` preset initially. The current application logs are sent over OTLP. Node stdout/stderr collection should be a separate future decision using a Collector DaemonSet or the chart preset, with explicit duplicate-log and feedback-loop testing.

## 5. Collector Service and Prometheus discovery

The Collector Service must be named exactly `otel-collector`. The application chart uses:

```text
http://otel-collector.observability.svc.cluster.local:4318
```

Prometheus should use plain Kubernetes discovery with `role: pod`, because the current stack does not include Prometheus Operator. Restrict discovery explicitly to the `observability` namespace and retain namespace-scoped Pod RBAC.

Grant Prometheus namespace-scoped RBAC permissions to `get`, `list`, and `watch` Pods in `observability`.

Create two separate scrape jobs:

```text
otel-collector-internal
└── selects Collector Pods
└── scrapes named port int-metrics (8888)

otel-collector-application
└── selects Collector Pods
└── scrapes named port app-metrics (8889)
```

Use Collector-specific labels and relabeling so unrelated Pods are excluded and ports `8888` and `8889` remain distinct. A normal ClusterIP Service may remain available for OTLP application traffic, but Prometheus must not rely only on that load-balanced Service to scrape every Collector Pod if replicas are added later.

The two scrape jobs should follow this shape:

```yaml
kubernetes_sd_configs:
  - role: pod
    namespaces:
      names: [observability]

relabel_configs:
      - source_labels: [__meta_kubernetes_pod_label_app_kubernetes_io_instance]
    action: keep
    regex: otel-collector
  - source_labels: [__meta_kubernetes_pod_container_port_name]
    action: keep
    regex: int-metrics
```

Use the same namespace restriction and Collector label rule for the application-metrics job, changing only the declared port-name regex to `app-metrics`. Confirm the rendered Pod labels and named container ports match these relabel rules before deployment.

This label and port verification is a hard precondition: do not apply the Prometheus configuration until the rendered Collector Pod contains the expected `app.kubernetes.io/instance: otel-collector` label and the `int-metrics` and `app-metrics` named ports. If the official chart renders different labels or port names, update the relabel rules or explicitly configure supported chart values before proceeding.

## 6. Observability chart resources

Use explicit Helm ownership boundaries:

- Install `otel-collector` as its own release from the official `open-telemetry/opentelemetry-collector` chart.
- Use the local `observability` chart for Prometheus, Loki, Tempo, Grafana, and Kube State Metrics.
- Do not make the local observability chart own the official Collector release as a subchart for the initial implementation.

The local observability chart should manage:

- Prometheus Deployment, Service, ConfigMap, PVC, and RBAC
- Loki Deployment, Service, ConfigMap, and PVCs
- Tempo Deployment, Service, ConfigMap, and PVCs
- Grafana Deployment, Service, ConfigMap, and PVC
- Kube State Metrics Deployment, ServiceAccount, ClusterRole, ClusterRoleBinding, and Service
- Grafana and Prometheus Ingress resources using the `nginx` IngressClass

Convert Compose configuration bind mounts containing application configuration into ConfigMaps. Convert persistent data mounts for Prometheus, Loki, Tempo, and Grafana into PVC-backed volumes; persistent data must not be stored in ConfigMaps. Add configuration checksums to locally templated Pod templates so configuration changes trigger rollouts. For the separately installed official Collector chart, verify whether the pinned chart version already rolls Pods when its configuration changes; if not, use a supported chart value or release annotation mechanism rather than assuming the local checksum template applies.

Add readiness and liveness probes, resource requests and limits, security contexts, and non-root execution where supported. Make retention periods, storage classes, PVC sizes, and Grafana authentication configurable by environment.

Prometheus must scrape:

- Collector internal metrics on `8888`
- Application OTLP metrics on `8889`
- Redis Exporter on `9121`
- Kube State Metrics on `8080`

## 7. Application chart resources

The application chart should manage:

- Frontend Deployment and ClusterIP Service
- Worker Deployment
- Redis Deployment and ClusterIP Service
- Redis Exporter Deployment and Service
- Frontend Ingress resource using the `nginx` IngressClass

Preserve the Compose environment variables, including Redis settings, queue and result channel names, source language, supported languages, log level, OpenTelemetry service names, and OTLP endpoint.

Make image tags, replica counts, resource requests and limits, probes, security contexts, ingress/Gateway exposure, and NetworkPolicies configurable.

Keep Redis as a single replica initially unless a separate highly available Redis design is approved. Configure Redis health checks equivalent to the Compose `redis-cli ping` check.

## 8. NGINX Ingress and Docker Desktop access

Use the official ingress-nginx Helm chart as the HTTP entry point for the local Docker Desktop cluster. Do not expose the frontend, Grafana, or Prometheus Services with NodePort or LoadBalancer individually. Keep those Services as namespace-local ClusterIP Services and route to them through NGINX Ingress. If the cluster already has a healthy NGINX controller and `nginx` IngressClass, skip installation; do not install a second controller or take ownership of an existing Argo CD-managed controller.

Install the controller before applying application Ingress resources:

```text
helm upgrade --install ingress-nginx ingress-nginx \
  --repo https://kubernetes.github.io/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace \
  --wait \
  --timeout 10m
```

The Ingress resources must be namespace-local because an Ingress backend Service must exist in the same namespace as the Ingress. Create one Ingress in `app` and one in `observability`:

```text
app/frontend Ingress:
  frontend.test.com/ → frontend Service port 3000

observability/observability Ingress:
  grafana.test.com/ → grafana Service port 3000
  prometheus.test.com/ → prometheus Service port 9090
```

Use `spec.ingressClassName: nginx`; do not rely only on the deprecated class annotation. Kubernetes wildcard hosts support one DNS label, but Windows hosts-file entries still need to be added explicitly for local development:

```text
127.0.0.1 frontend.test.com
127.0.0.1 grafana.test.com
127.0.0.1 prometheus.test.com
```

The Docker Desktop controller in the current environment publishes HTTP on
port `9080`. The verification workflow must therefore use these URLs and must
not require port-forwarding:

```text
http://frontend.test.com:9080
http://grafana.test.com:9080
http://prometheus.test.com:9080
```

Validate the controller, Ingress resources, and routes before generating traffic:

```text
kubectl get ingressclass nginx
kubectl -n ingress-nginx get pods,svc
kubectl -n app get ingress frontend
kubectl -n observability get ingress observability
curl -fsS http://frontend.test.com:9080/health
curl -fsS http://grafana.test.com:9080/api/health
curl -fsS http://prometheus.test.com:9080/-/ready
```

The Collector OTLP Service and Pod-local health port remain internal. Do not route OTLP or Collector port `13133` through the public Ingress.

## 9. Development and staging values

Development values should use minimal replicas, smaller resources, local development storage, and the Docker Desktop NGINX Ingress hostnames.

Staging values should define:

- Explicit immutable application and platform image tags
- Persistent storage classes and PVC sizes
- Staging ingress or Gateway hostname
- Separate credentials and TLS configuration
- Production-like resource requests and limits
- Appropriate retention settings
- Network policies and restricted Grafana access

For the initial staging Collector, keep one replica and document the availability limitation. Do not configure a PodDisruptionBudget for a single-replica Collector because it provides no meaningful disruption protection.

If higher Collector availability becomes necessary, first choose between a dedicated single-replica metrics gateway and a separately scalable trace/log gateway, or design a tested Collector metrics aggregation strategy.

Store Grafana credentials, registry credentials, TLS material, and future backend credentials in Kubernetes Secrets or the platform's chosen external secret manager. Do not commit sensitive values to Helm values files.

## 10. Validation and rollout workflow

Validate the local chart directory or downloaded chart package with:

```text
helm lint handson-labs/k8s/helm/observability \
  -f handson-labs/k8s/helm/observability/values-staging.yaml
helm lint handson-labs/k8s/helm/translation-app \
  -f handson-labs/k8s/helm/translation-app/values-staging.yaml
```

Validate the separately installed official Collector chart by rendering the pinned package and using server-side dry-run against the target cluster. If the chart is pulled locally, lint that package as well; local chart linting does not lint a remote chart release automatically.

Render manifests:

```text
helm template <release> <chart> --namespace <namespace> -f <values-file>
```

Perform client-side validation without contacting the cluster:

```text
helm upgrade --install <release> <chart> \
  --namespace <namespace> \
  --create-namespace \
  -f <values-file> \
  --dry-run=client
```

Perform server-side validation against the target cluster:

```text
helm upgrade --install <release> <chart> \
  --namespace <namespace> \
  --create-namespace \
  -f <values-file> \
  --dry-run=server
```

The server-side dry run requires cluster access and validates API compatibility, permissions, admission policies, and resource schemas.

Deploy in this order:

1. Create and verify the dedicated migration branch from `master`, preserving unrelated working-tree changes.
2. Build, test, scan, and publish the frontend and worker images to Docker Hub.
3. Update and validate `handson-labs/k8s/verify-telemetry.md` so it uses the two Collector scrape jobs, NGINX Ingress hostnames, and image-pull and rollout checks.
4. Create namespaces and install platform prerequisites, including ingress-nginx.
5. Install the local observability release for Prometheus, Loki, Tempo, Grafana, and Kube State Metrics.
6. Install the official `otel-collector` Helm release.
7. Verify backend and Collector Service names, Collector image components, Collector configuration rollout behavior, Prometheus discovery, and RBAC.
8. Install the application release using the local wrapper tags for Docker Desktop, or published immutable image tags/digests for shared staging.
9. Generate application traffic.
10. Execute the updated telemetry verification procedure.

## 11. End-to-end acceptance criteria

Kubernetes resources:

- All expected Pods become Ready.
- Services have endpoints.
- PVCs bind successfully.
- Kube State Metrics RBAC works.
- Collector Service is exactly `otel-collector`.
- Collector named container ports are present.
- Health probes use port `13133`.
- No unused Jaeger or Zipkin ports are enabled.

Application and access behavior:

- Frontend responds through `http://frontend.test.com:9080` via NGINX Ingress.
- Grafana responds through `http://grafana.test.com:9080` via NGINX Ingress.
- Prometheus responds through `http://prometheus.test.com:9080` via NGINX Ingress.
- Frontend, Grafana, and Prometheus Services remain ClusterIP Services.
- Frontend reaches Redis.
- Worker consumes translation jobs.
- Redis Exporter responds on `9121`.

Telemetry behavior:

- Collector accepts OTLP traces, metrics, and logs.
- Prometheus receives Collector internal metrics from `8888`.
- Prometheus receives application metrics from `8889`.
- Loki contains frontend and worker logs.
- Tempo contains frontend and worker traces.
- Grafana data sources resolve Prometheus, Loki, and Tempo.
- Trace-to-log correlation works.
- The frontend Pod has `NODE_OPTIONS=--experimental-loader=@opentelemetry/instrumentation/hook.mjs`.
- Successful translation traces include `hset`, `hincrby`, and related `ioredis` client spans.

Upgrade behavior:

- Collector configuration changes trigger a rollout.
- Helm upgrade preserves persistent data.
- Failed upgrades can be rolled back.
- The one-replica staging limitation is documented.
- Multi-replica Collector deployment is not enabled without a metrics strategy.
- Staging application Pods pull the intended published Docker Hub image tags or digests.
- Rebuilding a reused local tag is followed by an explicit Deployment rollout restart and rollout-status check.
- The published frontend and worker images pass the agreed build, smoke-test, and vulnerability-scan checks.
- An image-pull failure is distinguishable from an application startup failure.

The required pre-test deliverable is `handson-labs/k8s/verify-telemetry.md`. Its Collector Prometheus job expectation must be mapped to the two jobs `otel-collector-internal` and `otel-collector-application`. The guide must include Docker Desktop NGINX Ingress checks, image-pull, Collector rollout, Prometheus RBAC, and backend Service-DNS checks before it is used as the acceptance-test procedure for PromQL, LogQL, and TraceQL.

## 12. Optional GitOps integration

After Helm deployment is validated manually, manage the releases through Argo CD if required:

```text
Git repository
    ↓
Argo CD Helm Application
    ↓
Kubernetes namespace
```

Keep Helm responsible for packaging and rendering. Keep Argo CD responsible for synchronization, drift detection, and rollback workflow. Use separate Argo CD Applications for the observability and application releases.

## 13. Implementation decisions required before coding

- Exact official Collector chart version and image tag
- Docker Hub organization/repository names, image tag convention, build workflow, and vulnerability scanning policy
- Application image versions and immutable digests
- Storage classes, PVC sizes, and retention requirements
- Docker Desktop NGINX Ingress controller version and installation values
- Kubernetes Secret or external secret-management solution
- Whether the platform already provides Prometheus Operator
- Whether Argo CD will manage the Helm releases
- Whether staging requires node stdout/stderr log collection
- Future design for multi-replica Collector metrics aggregation

