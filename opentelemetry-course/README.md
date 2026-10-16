# OpenTelemetry for Observability: The Complete Course

This repository contains all the code, lab guides, and supporting materials for my **OpenTelemetry for Observability: The Complete Course** course.

### ➡️ Course link (with a big discount 🙂): [https://www.lauromueller.com/courses/opentelemetry-observability](https://www.lauromueller.com/courses/opentelemetry-observability)

### Check my other courses:

- 👉 [Argo CD and Argo Rollouts for GitOps: The Definitive Guide](https://www.lauromueller.com/courses/argo-cd-rollouts)
- 👉 [Prompt Engineering for Developers: The Definitive Guide](https://www.lauromueller.com/courses/prompt-engineering)
- 👉 [Python for DevOps: Mastering Real-World Automation](https://www.lauromueller.com/courses/python-devops)
- 👉 [The Complete Docker and Kubernetes Course: From Zero to Hero](https://www.lauromueller.com/courses/docker-kubernetes)
- 👉 [The Definitive Helm Course: From Beginner to Master](https://www.lauromueller.com/courses/definitive-helm-course)
- 👉 [Mastering Terraform: From Beginner to Expert](https://www.lauromueller.com/courses/mastering-terraform)
- 👉 [Mastering GitHub Actions: From Beginner to Expert](https://www.lauromueller.com/courses/mastering-github-actions)
- 👉 [Write better code: 20 code smells and how to get rid of them](https://www.lauromueller.com/courses/writing-clean-code)

## Welcome!

I'm really glad to have you here! This repository is the hands-on companion for the course. Everything you need to follow along — the demo application, Docker Compose and Kubernetes configurations, and step-by-step lab guides — lives here.

The course is built around a realistic async translation service (**Translation Queue**) composed of a Node.js frontend, a Python worker, and Redis. You will instrument this application from scratch using OpenTelemetry, progressively adding metrics, traces, and logs across both services until you have full end-to-end observability.

## 🗂️ Repository Structure

```
.
├── app-versions/        # Versioned ZIP snapshots of the demo application
├── compose/             # Docker Compose files and observability stack configs
├── k8s/                 # Kubernetes manifests (bonus section)
└── labs/                # Step-by-step lab guides, organised by course section
    ├── section-setup/
    ├── section-single-system/
    ├── section-distributed-systems/
    └── section-kubernetes/
```

## 🚀 Getting Started

### Prerequisites

Before your first lab, make sure you have the following installed:

- **Docker** and **Docker Compose** — used throughout the course for running the application and observability stack locally
- **kubectl** — required for the Kubernetes bonus section
- A local Kubernetes cluster (**Kind**, **Minikube**, or **Docker Desktop**) — required for the bonus section only

Run through the setup lab to verify everything is in place:

👉 [`labs/section-setup/`](labs/section-setup/INDEX.md)

## 📚 Lab Sections

Work through the sections in order. Each section has an `INDEX.md` with a numbered list of labs.

### 1. Setup

Get your local environment ready and spin up the full observability stack (Prometheus, Loki, Tempo, Grafana) with Docker Compose.

👉 [`labs/section-setup/`](labs/section-setup/INDEX.md)

### 2. Single System Instrumentation

Instrument the Node.js frontend end-to-end: start with auto-instrumentation, then layer in custom business metrics, manual traces, structured logs, and log-to-trace correlation.

👉 [`labs/section-single-system/`](labs/section-single-system/INDEX.md)

### 3. Distributed Systems Observability

Instrument the Python worker and connect the two services through distributed tracing over Redis. By the end of this section, a single translation request will appear as one connected trace spanning the frontend and the worker.

👉 [`labs/section-distributed-systems/`](labs/section-distributed-systems/INDEX.md)

### 4. Deploying to Kubernetes _(Bonus)_

Take the fully instrumented application and deploy it — together with the complete observability stack — to a local Kubernetes cluster. You will write the manifests, wire them together with Kustomize, and verify that all three telemetry signals flow correctly in the new environment.

👉 [`labs/section-kubernetes/`](labs/section-kubernetes/INDEX.md)

## 🏗️ Application Versions

The demo application evolves across the course. Each lab section references a specific version — download the ZIP from the course platform and extract it to your working directory before starting the corresponding labs.

| Version    | Description                                                            | Docker Images                                                                                                                               |
| ---------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **v1.1.0** | Baseline application — no OpenTelemetry instrumentation                | [frontend](https://hub.docker.com/r/lmacademy/web-translator-frontend) • [worker](https://hub.docker.com/r/lmacademy/web-translator-worker) |
| **v1.2.0** | Frontend fully instrumented — metrics, traces, and logs                | [frontend](https://hub.docker.com/r/lmacademy/web-translator-frontend) • [worker](https://hub.docker.com/r/lmacademy/web-translator-worker) |
| **v1.3.0** | Both frontend and worker fully instrumented — end-to-end observability | [frontend](https://hub.docker.com/r/lmacademy/web-translator-frontend) • [worker](https://hub.docker.com/r/lmacademy/web-translator-worker) |

Pre-built Docker images are available for every version and are tagged accordingly (e.g. `lmacademy/web-translator-frontend:v1.3.0`). Images are built for both `linux/amd64` and `linux/arm64`.

I'm looking forward to seeing you in the course!
