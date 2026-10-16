# App Versions — Local Development Setup

> **Important!!** During the course, **we will set everything up with Docker Compose**. Most of the instructions for running the apps in standalone mode in this file are not necessary for our development setup, but I'm leaving them here for the sake of completeness.

This directory contains the application code under `code/`. It consists of two services:

- **Frontend** — Express.js / TypeScript server (`code/frontend/`)
- **Worker** — Python translation service (`code/worker/`)

Both services require a running **Redis** instance (default: `localhost:6379`).

---

## Prerequisites

| Tool            | Version |
| --------------- | ------- |
| Node.js         | 18+     |
| npm             | 9+      |
| Python          | 3.11+   |
| Redis           | 6+      |
| uv _(optional)_ | latest  |

Start Redis locally (e.g. via Docker):

```bash
docker run -d -p 6379:6379 redis:7
```

---

## Frontend

```bash
cd code/frontend
```

### Install dependencies

```bash
npm install
```

### Environment variables

| Variable     | Default     | Description                     |
| ------------ | ----------- | ------------------------------- |
| `PORT`       | `3000`      | HTTP port the server listens on |
| `REDIS_HOST` | `localhost` | Redis hostname                  |
| `REDIS_PORT` | `6379`      | Redis port                      |

### Run in development mode (hot-reload)

```bash
npm run dev
```

### Build and run in production mode

```bash
npm run build
npm start
```

### Run tests

```bash
npm test
```

The frontend is available at <http://localhost:3000> by default.

---

## Worker

```bash
cd code/worker
```

### Environment variables

| Variable          | Default     | Description          |
| ----------------- | ----------- | -------------------- |
| `REDIS_HOST`      | `localhost` | Redis hostname       |
| `REDIS_PORT`      | `6379`      | Redis port           |
| `SOURCE_LANGUAGE` | `en`        | Source language code |
| `LOG_LEVEL`       | `info`      | Logging verbosity    |

### Option A — uv (recommended)

[uv](https://docs.astral.sh/uv/) is a fast Python package manager. Install it with:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Create a virtual environment and install dependencies (dev dependencies as well):

```bash
uv sync --all-extras
```

### Option B — pip

Create and activate a virtual environment:

```bash
python3 -m venv .venv
source .venv/bin/activate
```

Install dependencies:

```bash
pip install -e .
```

Install dev dependencies as well:

```bash
pip install -e ".[dev]"
```

> **Note:** The worker uses [Argos Translate](https://github.com/argosopentech/argos-translate) for offline machine translation. On first run it will download language models (~300 MB) which may take a few minutes.
