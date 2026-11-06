# Docker Desktop Kubernetes deployment

This runbook deploys the translation application and observability stack to Docker Desktop Kubernetes using Git Bash.

Application images:

```text
christseng89/web-translator-frontend:v1.3
christseng89/web-translator-worker:v1.3
```

Ingress URLs:

```text
http://frontend.test.com:9080
http://grafana.test.com:9080
http://prometheus.test.com:9080
```

No application, Grafana, or Prometheus port-forward is required.

## 1. Prerequisites

Enable Kubernetes in Docker Desktop, then run from Git Bash:

```bash
docker --version
kubectl version --client
helm version
kubectl config current-context
kubectl get nodes
cd /d/development/OpenTelemetry
```

The context should be `docker-desktop` and the node should be `Ready`.

## 2. Stop the Compose development stack

```bash
docker compose -f handson-labs/compose/compose.dev.yaml down
```

`compose.dev.yaml` is the local hot-reload environment. No data migration is
required for this Kubernetes deployment. The `worker-models` named volume is
not removed by `docker compose down`, so downloaded translation models can be
reused if the Compose stack is started again.

### Compose development images versus Kubernetes images

The Compose development stack is intentionally different from the Kubernetes
runtime images:

- The frontend is built from `Dockerfile.dev` with the `development` target,
  installs development dependencies, mounts `src` and `tsconfig.json`, and
  runs `npm run dev`.
- The worker is built from `Dockerfile.dev`, mounts its source directory,
  stores translation models in the `worker-models` named volume, and runs
  `watchmedo auto-restart`.
- Kubernetes uses wrapper images built from the unchanged `Dockerfile.dev`
  images. The wrappers copy the application source into the image because
  Kubernetes does not provide the Compose bind mounts.

To build only the Compose development images for local hot-reload testing,
use:

```bash
docker compose -f handson-labs/compose/compose.dev.yaml build frontend worker
```

The wrapper Dockerfiles are:

```text
handson-labs/k8s/images/frontend-dev-k8s.Dockerfile
handson-labs/k8s/images/worker-dev-k8s.Dockerfile
```

`Dockerfile.dev` itself is not changed.

The frontend Kubernetes Deployment also requires this environment variable so
the Node.js OpenTelemetry loader starts before `ioredis` is imported:

```text
NODE_OPTIONS=--experimental-loader=@opentelemetry/instrumentation/hook.mjs
```

The application Helm chart configures this value automatically. Do not remove
it when using the development-based frontend image.

## 3. Build the Kubernetes application images

Build the unchanged development Dockerfiles first, then build Kubernetes
wrapper images that include the source code. Run these commands from the
repository root in Git Bash:

```bash
docker build \
  -t christseng89/web-translator-frontend:v1.3-dev-base \
  -f handson-labs/app-versions/code/frontend/Dockerfile.dev \
  handson-labs/app-versions/code/frontend

docker build \
  -t christseng89/web-translator-worker:v1.3-dev-base \
  --network=host \
  -f handson-labs/app-versions/code/worker/Dockerfile.dev \
  handson-labs/app-versions/code/worker

docker build \
  -t christseng89/web-translator-frontend:v1.3 \
  -f handson-labs/k8s/images/frontend-dev-k8s.Dockerfile \
  .

docker build \
  -t christseng89/web-translator-worker:v1.3 \
  -f handson-labs/k8s/images/worker-dev-k8s.Dockerfile \
  .

docker image ls christseng89/web-translator-frontend
docker image ls christseng89/web-translator-worker
```

### Re-deploy after rebuilding an existing tag

The staging values use the local tags `v1.3`. Kubernetes may keep using the
existing image when a tag is rebuilt because the generated Deployment does not
change. After rebuilding either application image, run the corresponding
rollout restart and wait for the rollout:

```bash
kubectl -n app rollout restart deployment/frontend
kubectl -n app rollout status deployment/frontend --timeout=180s

kubectl -n app rollout restart deployment/worker
kubectl -n app rollout status deployment/worker --timeout=180s
```

If both images were rebuilt, restart both Deployments. Confirm the frontend
loader and source are present in the running Pod:

```bash
kubectl -n app exec deployment/frontend -- sh -lc \
  'printf "%s\n" "$NODE_OPTIONS"; test -f /app/src/index.ts && echo source-present'
```

For a shared or remote cluster, use a new immutable image tag (or digest) and
update `values-staging.yaml` instead of relying on a reused `v1.3` tag.

The worker development-base build downloads the ARM64 CPU translation runtime,
Python dependencies, and language models and may take several minutes. The
`--network=host` option helps Docker Desktop avoid intermittent registry and
PyTorch download timeouts on ARM64.

If the worker build fails before producing
`christseng89/web-translator-worker:v1.3-dev-base`, do not build or deploy its
wrapper image. Resolve the package-index/download failure first, or continue
with an already verified worker image. The frontend and worker images must not
be described as both dev-based unless both base builds completed successfully.

Docker Desktop Kubernetes shares Docker Desktop's local image store. If local
images are unavailable, push the final wrapper images:

```bash
docker login
docker push christseng89/web-translator-frontend:v1.3
docker push christseng89/web-translator-worker:v1.3
```

## 4. Add Helm repositories

```bash
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
helm repo update
helm show values open-telemetry/opentelemetry-collector \
  --version 0.178.2 > /tmp/opentelemetry-collector-values.yaml
```

The `ingress-nginx` Helm repository is only needed if the cluster does not already provide NGINX Ingress.

## 5. Create namespaces

```bash
kubectl apply -f handson-labs/k8s/namespaces.yaml
kubectl get namespaces app observability
```

## 6. Check NGINX Ingress

**Skip** installation when the Docker Desktop cluster already has a healthy NGINX
Ingress controller and the `nginx` IngressClass. This is expected when the
controller is managed by Argo CD; do not install a second controller or take
ownership of its resources with Helm.

Check first:

```bash
kubectl -n ingress-nginx get pods,svc
kubectl get ingressclass nginx
kubectl -n ingress-nginx get svc ingress-nginx-controller \
  -o custom-columns=NAME:.metadata.name,TYPE:.spec.type,PORTS:.spec.ports[*].port
```

This Docker Desktop cluster publishes NGINX HTTP traffic on port `9080`, so
the local URLs include `:9080`. If the controller Service is later configured
to publish port `80`, remove the port suffix from the URLs.

If the controller is not installed, install it:

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update
helm upgrade --install ingress-nginx ingress-nginx \
  --repo https://kubernetes.github.io/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace \
  --wait \
  --timeout 10m

kubectl -n ingress-nginx rollout status deployment/ingress-nginx-controller --timeout=180s
kubectl get ingressclass nginx
```

The server-side flags are needed only when taking ownership of an existing
controller installation. Do not combine `--force-conflicts` with
`--force-replace`; Helm server-side apply does not support both operations at
the same time.

## 7. Validate the Helm charts

```bash
helm lint handson-labs/k8s/helm/observability \
  -f handson-labs/k8s/helm/observability/values-staging.yaml
helm lint handson-labs/k8s/helm/translation-app \
  -f handson-labs/k8s/helm/translation-app/values-staging.yaml

helm template observability handson-labs/k8s/helm/observability \
  --namespace observability \
  -f handson-labs/k8s/helm/observability/values-staging.yaml > /tmp/observability.yaml
helm template translation-app handson-labs/k8s/helm/translation-app \
  --namespace app \
  -f handson-labs/k8s/helm/translation-app/values-staging.yaml > /tmp/translation-app.yaml

helm upgrade --install observability handson-labs/k8s/helm/observability \
  --namespace observability --create-namespace \
  -f handson-labs/k8s/helm/observability/values-staging.yaml \
  --dry-run=server

helm upgrade --install translation-app handson-labs/k8s/helm/translation-app \
  --namespace app --create-namespace \
  -f handson-labs/k8s/helm/translation-app/values-staging.yaml \
  --dry-run=client

helm upgrade --install translation-app handson-labs/k8s/helm/translation-app \
  --namespace app --create-namespace \
  -f handson-labs/k8s/helm/translation-app/values-staging.yaml \
  --dry-run=server
```

## 8. Install observability

```bash
helm upgrade --install observability handson-labs/k8s/helm/observability \
  --namespace observability --create-namespace \
  -f handson-labs/k8s/helm/observability/values-staging.yaml

helm upgrade --install otel-collector open-telemetry/opentelemetry-collector \
  --version 0.178.2 \
  --namespace observability --create-namespace \
  -f handson-labs/k8s/otel-collector-values.yaml

kubectl -n observability rollout status deployment/prometheus --timeout=180s
kubectl -n observability rollout status deployment/loki --timeout=180s
kubectl -n observability rollout status deployment/tempo --timeout=180s
kubectl -n observability rollout status deployment/grafana --timeout=180s
kubectl -n observability rollout status deployment/otel-collector --timeout=180s
```

## 9. Install the application

```bash
helm upgrade --install translation-app handson-labs/k8s/helm/translation-app \
  --namespace app --create-namespace \
  -f handson-labs/k8s/helm/translation-app/values-staging.yaml

kubectl -n app rollout status deployment/frontend --timeout=180s

kubectl -n app rollout status deployment/worker --timeout=180s

kubectl -n app rollout status deployment/redis --timeout=180s
kubectl -n app rollout status deployment/redis-exporter --timeout=180s

kubectl -n app get deployment frontend \
  -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="NODE_OPTIONS")].value}{"\n"}'
```

## 10. Apply Ingress and configure local DNS

```bash
kubectl apply -f handson-labs/k8s/ingress.yaml
kubectl get ingress -A | grep frontend
kubectl get ingress -A | grep observability
```

As Administrator, add these entries to `C:\Windows\System32\drivers\etc\hosts`:

```text
127.0.0.1 frontend.test.com
127.0.0.1 grafana.test.com
127.0.0.1 prometheus.test.com
```

## 11. Verify the deployment

```bash
kubectl get pods -n app
kubectl get pods -n observability
kubectl get svc,endpoints -n app
kubectl get svc,endpoints -n observability
kubectl get ingress -A

curl -fsS http://frontend.test.com:9080/health
curl -fsS http://grafana.test.com:9080/api/health
curl -fsS http://prometheus.test.com:9080/-/ready
```

Verify images, Collector ports, and Prometheus permissions:

```bash
kubectl -n app get deployment frontend worker \
  -o custom-columns=NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image,PULL:.spec.template.spec.containers[0].imagePullPolicy
kubectl -n observability get pod \
  -l app.kubernetes.io/instance=otel-collector \
  -o jsonpath='{range .items[0].spec.containers[0].ports[*]}{.name}={.containerPort}{"\n"}{end}'
kubectl -n observability auth can-i list pods --as=system:serviceaccount:observability:prometheus
kubectl -n observability auth can-i watch pods --as=system:serviceaccount:observability:prometheus
```

Expected Collector ports are `otlp=4317`, `otlp-http=4318`, `health-check=13133`, `int-metrics=8888`, and `app-metrics=8889`.

## 12. Verify telemetry

```bash
less handson-labs/k8s/verify-telemetry.md
```

The verification guide checks the two Collector scrape jobs, frontend traffic, Loki logs, Tempo traces, and Grafana data sources.

## Troubleshooting

```bash
kubectl -n app describe pod -l app.kubernetes.io/name=frontend
kubectl -n app logs deployment/frontend --tail=100
kubectl -n observability describe pod -l app.kubernetes.io/name=tempo
kubectl -n observability logs deployment/tempo --tail=100
kubectl get events -A --sort-by=.lastTimestamp | tail -40
```

If an image is not found locally, push it to Docker Hub and restart the application:

```bash
docker push christseng89/web-translator-frontend:v1.3
docker push christseng89/web-translator-worker:v1.3
kubectl -n app rollout restart deployment/frontend deployment/worker
```

If a rebuilt local image is available but the Pod still runs the previous
contents, use the re-deploy procedure in Section 3. Kubernetes does not detect
changes made behind the same image tag automatically.

## Cleanup

```bash
helm uninstall translation-app -n app
helm uninstall otel-collector -n observability
helm uninstall observability -n observability
```

Do not uninstall `ingress-nginx` if it is shared by other applications or managed by Argo CD.

PVCs are not deleted automatically. Delete them only when stored data is intentionally disposable:

```bash
kubectl delete pvc --all -n app
kubectl delete pvc --all -n observability
```
