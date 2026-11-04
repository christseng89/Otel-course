import signal
import sys
import logging
import time
import random
from datetime import datetime, timezone
from typing import Any, Optional
from .config import Config
from .queue import QueueConsumer
from .translator import Translator
from .logger import setup_logging

from .instrumentation import setup_instrumentation, shutdown_instrumentation
from .otel_api import (
    SpanKind,
    extract_context,
    inject_active_context,
)
from .otel_tracing import set_span_attributes, set_span_error, set_span_success, tracer

# Custom Metrics
from .metrics import jobs_total, translation_duration, active_jobs

# Configure structured logging before creating module loggers.
setup_logging()

logger = logging.getLogger(__name__)

# Global shutdown flag
shutdown_flag = False
TARGET_LANGUAGE_ATTRIBUTE = "translation.target_language"


def handle_shutdown(signum: int, frame) -> None:
    """Handle shutdown signals gracefully."""
    global shutdown_flag
    logger.info("Graceful shutdown requested", extra={"signal": signum})
    shutdown_flag = True


# Custom Metrics - Refactoring
def record_translation_duration(
    duration_ms: int, target_language: str, status: str
) -> None:
    """Record translation processing duration with its outcome."""
    translation_duration.record(
        # Change to ms
        duration_ms,
        attributes={
            TARGET_LANGUAGE_ATTRIBUTE: target_language,
            "translation.status": status,
        },
    )


# Custom Metrics - Refactoring
def add_job_total(target_language: str, status: str) -> None:
    """Record one translation job with its outcome."""
    jobs_total.add(
        1,
        attributes={
            TARGET_LANGUAGE_ATTRIBUTE: target_language,
            "translation.status": status,
        },
    )


# Custom Metrics - Refactoring
def add_active_jobs(amount: int, target_language: str) -> None:
    """Adjust the number of active translation jobs."""
    active_jobs.add(
        amount,
        attributes={TARGET_LANGUAGE_ATTRIBUTE: target_language},
    )


# Inject trace context and publish result
def publish_result_with_context(
    queue_consumer: QueueConsumer, result: dict[str, Any]
) -> None:
    """Inject the current trace context and publish a translation result."""
    trace_context: dict[str, str] = {}
    inject_active_context(trace_context)
    result["_traceContext"] = trace_context
    queue_consumer.publish_result(result)


def _unsupported_language_result(
    span: Any,
    job_id: str,
    session_id: str,
    target_lang: str,
) -> dict[str, Any]:
    error_msg = f"Unsupported target language: {target_lang}"
    logger.error(
        "Unsupported target language",
        extra={"target_language": target_lang, "error": error_msg},
    )
    set_span_error(span, error_msg)
    add_job_total(target_lang, "error")
    return {
        "jobId": job_id,
        "sessionId": session_id,
        "targetLanguage": target_lang,
        "status": "error",
        "error": error_msg,
        "durationMs": 0,
        "completedAt": datetime.now(timezone.utc).isoformat() + "Z",
    }


def _translate_job(
    span: Any,
    translator: Translator,
    job_id: str,
    session_id: str,
    text: str,
    source_lang: str,
    target_lang: str,
    start_time: float,
) -> dict[str, Any]:
    logger.info(
        "Processing translation job",
        extra={
            "job_id": job_id,
            "source_language": source_lang,
            "target_language": target_lang,
        },
    )
    delay = random.uniform(0.5, 2.0)
    logger.debug(
        "Simulating translation latency",
        extra={"delay_seconds": round(delay, 2)},
    )
    time.sleep(delay)
    translated_text = translator.translate(text, source_lang, target_lang)
    duration_ms = int((time.time() - start_time) * 1000)
    record_translation_duration(duration_ms, target_lang, "completed")
    add_job_total(target_lang, "completed")
    set_span_attributes(
        span,
        {
            "translation.duration_ms": duration_ms,
            "trace.id": f"{span.get_span_context().trace_id:032x}",
        },
    )
    set_span_success(span)
    logger.info(
        "Translation job completed",
        extra={
            "job_id": job_id,
            "target_language": target_lang,
            "duration_ms": duration_ms,
        },
    )
    return {
        "jobId": job_id,
        "sessionId": session_id,
        "targetLanguage": target_lang,
        "translatedText": translated_text,
        "status": "completed",
        "durationMs": duration_ms,
        "completedAt": datetime.now(timezone.utc).isoformat() + "Z",
    }


def _failed_job_result(
    span: Any,
    error: Exception,
    job_id: str,
    session_id: str,
    target_lang: str,
    start_time: float,
) -> dict[str, Any]:
    duration_ms = int((time.time() - start_time) * 1000)
    error_msg = str(error)
    logger.exception(
        "Translation job failed",
        extra={
            "job_id": job_id,
            "target_language": target_lang,
            "error": error_msg,
        },
    )
    set_span_error(span, error)
    record_translation_duration(duration_ms, target_lang, "error")
    add_job_total(target_lang, "error")
    return {
        "jobId": job_id,
        "sessionId": session_id,
        "targetLanguage": target_lang,
        "status": "error",
        "error": error_msg,
        "durationMs": duration_ms,
        "completedAt": datetime.now(timezone.utc).isoformat() + "Z",
    }


def process_translation_job(
    job: dict[str, Any],
    config: Config,
    translator: Translator,
    queue_consumer: QueueConsumer,
) -> None:
    job_id = job.get("jobId")
    session_id = job.get("sessionId")
    text = job.get("text")
    source_lang = job.get("sourceLanguage", config.source_language)
    target_lang = job.get("targetLanguage")

    if not all([job_id, session_id, text, target_lang]) or not isinstance(text, str):
        logger.error("Invalid job data", extra={"job": job})
        return

    remote_ctx = extract_context(job.get("_traceContext") or {})
    with tracer.start_as_current_span(
        f"process_translation_job - {target_lang}",
        context=remote_ctx,
        kind=SpanKind.CONSUMER,
        attributes={
            "translation.job_id": job_id,
            "translation.session_id": session_id,
            TARGET_LANGUAGE_ATTRIBUTE: target_lang,
            "translation.text_length": len(text),
        },
    ) as span:
        start_time = time.time()
        add_active_jobs(1, target_lang)
        try:
            if target_lang not in config.supported_languages:
                result = _unsupported_language_result(
                    span, job_id, session_id, target_lang
                )
            else:
                result = _translate_job(
                    span,
                    translator,
                    job_id,
                    session_id,
                    text,
                    source_lang,
                    target_lang,
                    start_time,
                )
        except Exception as error:
            result = _failed_job_result(
                span, error, job_id, session_id, target_lang, start_time
            )
        finally:
            add_active_jobs(-1, target_lang)

        publish_result_with_context(queue_consumer, result)


def main() -> None:
    """Main worker loop."""
    global shutdown_flag

    # Register signal handlers
    signal.signal(signal.SIGTERM, handle_shutdown)
    signal.signal(signal.SIGINT, handle_shutdown)

    # Change here Initialise OpenTelemetry before anything else
    setup_instrumentation()

    # Load configuration
    config = Config.from_env()

    # Set log level
    logging.getLogger().setLevel(config.log_level)

    logger.info("Starting translation worker")
    logger.info(
        "Redis configuration loaded",
        extra={"redis_host": config.redis_host, "redis_port": config.redis_port},
    )
    logger.info(
        "Supported languages loaded",
        extra={"supported_languages": config.supported_languages},
    )

    # Initialize components
    queue_consumer: Optional[QueueConsumer] = None
    translator: Optional[Translator] = None

    try:
        # Connect to Redis
        queue_consumer = QueueConsumer(
            host=config.redis_host,
            port=config.redis_port,
            queue_key=config.queue_key,
            result_channel=config.result_channel,
        )
        queue_consumer.connect()

        # Initialize translator
        logger.info("Initializing translator!!!")
        translator = Translator()
        logger.info("Translator ready")

        # Main loop
        logger.info("Worker ready, waiting for jobs...")
        while not shutdown_flag:
            try:
                # Wait for job with timeout to allow checking shutdown flag
                job = queue_consumer.wait_for_job(timeout=1)

                if job is None:
                    continue

                process_translation_job(job, config, translator, queue_consumer)

            except KeyboardInterrupt:
                logger.info("Keyboard interrupt received")
                break
            except Exception as e:
                logger.exception(
                    "Error processing job",
                    extra={"error": str(e)},
                    exc_info=True,
                )
                # Continue processing next job
                time.sleep(1)

        logger.info("Worker shutting down...")

    except Exception as e:
        logger.exception("Fatal worker error", extra={"error": str(e)})
        sys.exit(1)

    finally:
        # Cleanup
        if queue_consumer:
            try:
                queue_consumer.disconnect()
            except Exception as e:
                logger.exception(
                    "Error disconnecting from Redis",
                    extra={"error": str(e)},
                    exc_info=True,
                )

        logger.info("Worker stopped")
        shutdown_instrumentation()


if __name__ == "__main__":
    main()
