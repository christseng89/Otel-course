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

## 2. Application image build and Docker Hub publishing

Build the application images from the existing Dockerfiles:

```text
Frontend context: handson-labs/app-versions/code/frontend
Frontend Dockerfile: Dockerfile
Worker context: handson-labs/app-versions/code/worker
Worker Dockerfile: Dockerfile
```

Publish the images to the Docker Hub repositories already implied by `handson-labs/compose/compose.prod.yaml`:

```text
lmacademy/web-translator-frontend:<immutable-tag>
lmacademy/web-translator-worker:<immutable-tag>
```

Before publishing an image:

1. Run the frontend and worker unit tests.
2. Build each production Dockerfile with a unique release tag.
3. Run container smoke tests and verify the expected startup command and ports.
4. Scan the images for vulnerabilities according to the project/platform policy.
5. Authenticate to Docker Hub using a short-lived token or CI secret, never a password committed to the repository.
6. Push the tagged images and record their immutable digests.
7. Use the published tag and, where supported, digest in the Helm staging values.

The exact release tag convention must be decided before implementation. Prefer a source version plus commit identifier, for example `v1.1.0-<git-sha>`, or another immutable convention. Do not overwrite a staging tag or use `latest`.

The CI/CD workflow should build and publish only after tests pass. It should not rebuild upstream observability images. Docker Hub credentials belong in the CI secret store, and Kubernetes pull credentials should be configured only if the application repositories are private.

The image publication step is a prerequisite for deploying the application chart to a cluster that cannot build from local source. A local development cluster may use locally built images only as an explicit development override; staging must pull the published Docker Hub images.

## 3. Helm release and namespace structure

Use two local chart boundaries:

```text
deploy/helm/
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
deploy/helm/observability/values.yaml
deploy/helm/observability/values-dev.yaml
deploy/helm/observability/values-staging.yaml
deploy/helm/translation-app/values.yaml
deploy/helm/translation-app/values-dev.yaml
deploy/helm/translation-app/values-staging.yaml
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
otlp/tempo exporter
otlphttp/loki exporter
prometheus exporter
batch processor
memory_limiter processor
health_check extension
```

This image-component check is required because the plan uses the Kubernetes Collector distribution, such as `otel/opentelemetry-collector-k8s`, rather than the Compose `otel/opentelemetry-collector-contrib` image. The selected image must support the configured exporters and processors; otherwise select a compatible distribution or build an approved custom image.

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
otlp-grpc: 4317
otlp-http: 4318
health-check: 13133
internal-metrics: 8888
application-metrics: 8889
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
└── scrapes named port internal-metrics (8888)

otel-collector-application
└── selects Collector Pods
└── scrapes named port application-metrics (8889)
```

Use Collector-specific labels and relabeling so unrelated Pods are excluded and ports `8888` and `8889` remain distinct. A normal ClusterIP Service may remain available for OTLP application traffic, but Prometheus must not rely only on that load-balanced Service to scrape every Collector Pod if replicas are added later.

The two scrape jobs should follow this shape:

```yaml
kubernetes_sd_configs:
  - role: pod
    namespaces:
      names: [observability]

relabel_configs:
  - source_labels: [__meta_kubernetes_pod_label_app_kubernetes_io_name]
    action: keep
    regex: otel-collector
  - source_labels: [__meta_kubernetes_pod_container_port_name]
    action: keep
    regex: internal-metrics
```

Use the same namespace restriction and Collector label rule for the application-metrics job, changing only the declared port-name regex to `application-metrics`. Confirm the rendered Pod labels and named container ports match these relabel rules before deployment.

This label and port verification is a hard precondition: do not apply the Prometheus configuration until the rendered Collector Pod contains the expected `app.kubernetes.io/name: otel-collector` label and the `internal-metrics` and `application-metrics` named ports. If the official chart renders different labels or port names, update the relabel rules or explicitly configure supported chart values before proceeding.

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

Preserve the Compose environment variables, including Redis settings, queue and result channel names, source language, supported languages, log level, OpenTelemetry service names, and OTLP endpoint.

Make image tags, replica counts, resource requests and limits, probes, security contexts, ingress/Gateway exposure, and NetworkPolicies configurable.

Keep Redis as a single replica initially unless a separate highly available Redis design is approved. Configure Redis health checks equivalent to the Compose `redis-cli ping` check.

## 8. Development and staging values

Development values should use minimal replicas, smaller resources, local development storage, and port-forward access.

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

## 9. Validation and rollout workflow

Validate the local chart directory or downloaded chart package with:

```text
helm lint deploy/helm/observability
helm lint deploy/helm/translation-app
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
3. Update and validate `handson-labs/labs/section3-kubernetes/lab-verify-telemetry.md` so it uses the two Collector scrape jobs and includes image-pull and rollout checks.
4. Create namespaces and install platform prerequisites.
5. Install the local observability release for Prometheus, Loki, Tempo, Grafana, and Kube State Metrics.
6. Install the official `otel-collector` Helm release.
7. Verify backend and Collector Service names, Collector image components, Collector configuration rollout behavior, Prometheus discovery, and RBAC.
8. Install the application release using the published image tags/digests.
9. Generate application traffic.
10. Execute the updated telemetry verification procedure.

## 10. End-to-end acceptance criteria

Kubernetes resources:

- All expected Pods become Ready.
- Services have endpoints.
- PVCs bind successfully.
- Kube State Metrics RBAC works.
- Collector Service is exactly `otel-collector`.
- Collector named container ports are present.
- Health probes use port `13133`.
- No unused Jaeger or Zipkin ports are enabled.

Application behavior:

- Frontend responds through its Service or ingress.
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

Upgrade behavior:

- Collector configuration changes trigger a rollout.
- Helm upgrade preserves persistent data.
- Failed upgrades can be rolled back.
- The one-replica staging limitation is documented.
- Multi-replica Collector deployment is not enabled without a metrics strategy.
- Staging application Pods pull the intended published Docker Hub image tags or digests.
- The published frontend and worker images pass the agreed build, smoke-test, and vulnerability-scan checks.
- An image-pull failure is distinguishable from an application startup failure.

The required pre-test deliverable is an update to `handson-labs/labs/section3-kubernetes/lab-verify-telemetry.md`. Its current Collector Prometheus job expectation must be mapped to the two jobs `otel-collector-internal` and `otel-collector-application`. The updated guide must include image-pull, Collector rollout, Prometheus RBAC, and backend Service-DNS checks before it is used as the acceptance-test procedure for PromQL, LogQL, and TraceQL.

## 11. Optional GitOps integration

After Helm deployment is validated manually, manage the releases through Argo CD if required:

```text
Git repository
    ↓
Argo CD Helm Application
    ↓
Kubernetes namespace
```

Keep Helm responsible for packaging and rendering. Keep Argo CD responsible for synchronization, drift detection, and rollback workflow. Use separate Argo CD Applications for the observability and application releases.

## Implementation decisions required before coding

- Exact official Collector chart version and image tag
- Docker Hub organization/repository names, image tag convention, build workflow, and vulnerability scanning policy
- Application image versions and immutable digests
- Storage classes, PVC sizes, and retention requirements
- Ingress or Gateway API choice
- Kubernetes Secret or external secret-management solution
- Whether the platform already provides Prometheus Operator
- Whether Argo CD will manage the Helm releases
- Whether staging requires node stdout/stderr log collection
- Future design for multi-replica Collector metrics aggregation

