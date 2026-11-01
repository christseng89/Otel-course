# Worker Structured Logging Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor the Python worker so console logs are JSON objects with stable event messages and queryable context fields, matching the frontend's Winston JSON logging.

**Architecture:** Keep Python's standard `logging` API and the existing OpenTelemetry `LoggingHandler`/OTLP log pipeline. Add a JSON console formatter at the root logging configuration, then convert worker log calls from f-string interpolation to constant messages plus `extra` fields. Preserve exception tracebacks and OpenTelemetry trace/span correlation.

**Tech Stack:** Python 3.11+, stdlib `logging`, `python-json-logger`, OpenTelemetry Python SDK, pytest, Docker Compose, Loki/LogQL.

---

### Task 1: Add the JSON logging dependency

**Files:**
- Modify: `handson-labs/app-versions/code/worker/pyproject.toml`
- Modify: `handson-labs/app-versions/code/worker/uv.lock`

**Step 1: Add the dependency**

Add a pinned `python-json-logger` runtime dependency to the worker project.

**Step 2: Regenerate the lock file**

Run from `handson-labs/app-versions/code/worker`:

```bash
uv lock
```

Expected: `uv.lock` contains the new package and resolves successfully.

**Step 3: Install the locked environment**

```bash
uv sync
```

Expected: the worker environment installs without dependency conflicts.

---

### Task 2: Configure JSON console logging

**Files:**
- Modify: `handson-labs/app-versions/code/worker/src/main.py:21-26`

**Step 1: Replace the plain-text formatter**

Replace the current `logging.basicConfig(format="%(asctime)s - ...")` setup with a `pythonjsonlogger.json.JsonFormatter` and a `StreamHandler(sys.stdout)`.

Configure the formatter to emit at least:

- `timestamp`
- `level`
- `name`
- `message`
- any fields supplied through `extra`

Keep the existing root-level behavior so `config.log_level` still controls the effective log level after `Config.from_env()` is loaded.

**Step 2: Preserve OpenTelemetry logging**

Do not replace or bypass `setup_instrumentation()`. Its `LoggingHandler` must remain attached to the root logger so logs continue to be exported over OTLP and receive trace/span correlation when emitted inside a span.

**Step 3: Add a focused formatter test**

Add a test that emits a log record with `extra={"job_id": "job-123"}` and verifies the console output parses as JSON with `message`, `level`, `timestamp`, and `job_id` fields.

---

### Task 3: Convert worker log calls to structured fields

**Files:**
- Modify: `handson-labs/app-versions/code/worker/src/main.py`
- Modify: `handson-labs/app-versions/code/worker/src/queue.py`
- Modify: `handson-labs/app-versions/code/worker/src/translator.py`
- Modify: `handson-labs/app-versions/code/worker/src/instrumentation.py` if any initialization/shutdown messages contain interpolated context

**Step 1: Refactor `main.py` logs**

Replace f-string data with constant messages and `extra` fields. Examples:

```python
logger.info(
    "Processing translation job",
    extra={
        "job_id": job_id,
        "source_language": source_lang,
        "target_language": target_lang,
    },
)
```

Preserve fields for job ID, session ID, target language, source language, duration, Redis host/port, signal, and error message as appropriate. Use `exc_info=True` for unexpected exceptions where the current code already includes a traceback.

**Step 2: Refactor `queue.py` logs**

Convert connection, receive, parse-error, publish, Redis-error, and disconnect logs to structured fields such as `redis_host`, `redis_port`, `job_id`, `target_language`, `status`, and `error`.

**Step 3: Refactor `translator.py` logs**

Convert model availability, translation success, initialization, and failure logs to structured fields such as `source_language`, `target_language`, `text_length`, `output_length`, `package_count`, and `error`.

Avoid logging full input or translated text as structured fields; retain only lengths or bounded diagnostic values to prevent sensitive or high-volume payloads from entering logs.

**Step 4: Verify no interpolated worker log messages remain**

Run:

```bash
rg -n 'logger\.(debug|info|warning|error|exception)\(f["\x27]' handson-labs/app-versions/code/worker/src
```

Expected: no matches, except cases reviewed and explicitly justified.

---

### Task 4: Add behavior tests for structured context

**Files:**
- Modify: `handson-labs/app-versions/code/worker/tests/conftest.py` or create a focused logging test module under `handson-labs/app-versions/code/worker/tests/`
- Modify: `handson-labs/app-versions/code/worker/tests/test_main.py` if log assertions belong with worker-flow tests

**Step 1: Test structured fields**

Capture a representative worker log and assert its JSON payload contains stable fields rather than interpolated values in the message.

**Step 2: Test error fields**

Cover a translation failure and verify the log includes structured error context and retains exception information where expected.

**Step 3: Run the worker tests**

```bash
cd handson-labs/app-versions/code/worker
uv run pytest
```

Expected: all existing and new tests pass.

---

### Task 5: Verify the Docker and Loki path

**Files:**
- Review: `handson-labs/compose/compose.dev.yaml`
- Review: `handson-labs/compose/compose.observability.yaml`
- Review: `handson-labs/compose/otel-collector-config.yaml`
- Review: `handson-labs/compose/loki-config.yaml`

**Step 1: Rebuild the worker image and recreate it**

Run from `handson-labs/compose`:

```bash
docker compose -f compose.dev.yaml up --build -d --force-recreate worker
```

**Step 2: Inspect worker output**

```bash
docker compose -f compose.dev.yaml logs --tail=20 worker
```

Expected: each console log line is valid JSON and includes fields such as `timestamp`, `level`, `name`, and `message`.

**Step 3: Generate one successful and one failing request**

Use the existing traffic generator or send requests that exercise a supported and unsupported target language.

**Step 4: Verify Loki queries**

In Grafana Explore, run:

```logql
{service_name="translation-worker"} | json
{service_name="translation-worker"} | json | job_id = "job-123"
```

Expected: fields such as `job_id`, `target_language`, `status`, and `duration_ms` are queryable without regex parsing the message string.

---

### Task 6: Update the lab documentation

**Files:**
- Modify: `handson-labs/labs/section-distributed-systems/lab-refactoring-structured-logs.md`

Document the actual formatter configuration, representative structured log output, the fields introduced in each worker module, dependency installation, test commands, and the Docker/Loki verification steps. Keep the frontend comparison accurate: Winston's JSON formatter and Python's JSON formatter produce equivalent structured output, while OpenTelemetry export remains handled by the existing OTel logging handler.

---

## Implementation acceptance criteria

- Worker stdout contains one valid JSON object per log line.
- No routine worker logs use f-string interpolation for contextual values.
- Existing OTLP log export and trace/span correlation continue to work.
- Error logs retain useful exception information.
- Job, session, language, status, and duration fields are queryable in Loki.
- `uv run pytest` passes.
- Docker Compose worker logs show valid JSON after rebuild/recreation.
