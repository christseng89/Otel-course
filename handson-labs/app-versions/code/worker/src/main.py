# Context Propagation
from opentelemetry import trace, propagate
from opentelemetry.trace import SpanKind, Status, StatusCode

import signal
import sys
import logging
import time
import random
from datetime import datetime, timezone
from typing import Optional
from .config import Config
from .queue import QueueConsumer
from .translator import Translator

from .instrumentation import setup_instrumentation, shutdown_instrumentation

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)

logger = logging.getLogger(__name__)

# Context Propagation # Add this line
tracer = trace.get_tracer(__name__)

# Global shutdown flag
shutdown_flag = False


def handle_shutdown(signum: int, frame) -> None:
    """Handle shutdown signals gracefully."""
    global shutdown_flag
    logger.info(f"Received signal {signum}, initiating graceful shutdown...")
    shutdown_flag = True


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
    logger.info(f"Redis: {config.redis_host}:{config.redis_port}")
    logger.info(f"Supported languages: {', '.join(config.supported_languages)}")

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

                # Extract job details
                job_id = job.get("jobId")
                session_id = job.get("sessionId")
                text = job.get("text")
                source_lang = job.get("sourceLanguage", config.source_language)
                target_lang = job.get("targetLanguage")

                if not all([job_id, session_id, text, target_lang]):
                    logger.error(f"Invalid job data: {job}")
                    continue

                # Context Propagation
                # Extract the W3C trace context injected by the frontend.
                # Missing or malformed context produces a background context,
                # so the worker still processes the job as a new root trace.
                remote_ctx = propagate.extract(job.get("_traceContext") or {})

                with tracer.start_as_current_span(
                    f"process_translation_job - {target_lang}",
                    context=remote_ctx,
                    kind=SpanKind.CONSUMER,
                    attributes={
                        "translation.job_id": job_id,
                        "translation.session_id": session_id,
                        "translation.target_language": target_lang,
                        "translation.text_length": len(text) if text else 0,
                    },
                ) as span:
                    try:
                        # Validate target language
                        if target_lang not in config.supported_languages:
                            error_msg = f"Unsupported target language: {target_lang}"
                            logger.error(error_msg)
                            # Context Propagation
                            span.set_status(Status(StatusCode.ERROR, error_msg))
                            result = {
                                "jobId": job_id,
                                "sessionId": session_id,
                                "targetLanguage": target_lang,
                                "status": "error",
                                "error": error_msg,
                                "durationMs": 0,
                                "completedAt": datetime.now(timezone.utc).isoformat()
                                + "Z",
                            }
                            queue_consumer.publish_result(result)
                            continue

                        # Translate
                        # Ensure text is not None 
                        assert text is not None
                        logger.info(
                            f"Processing job {job_id}: {source_lang} -> {target_lang}"
                        )
                        start_time = time.time()

                        # Simulate realistic API latency (0.5-2 seconds)
                        delay = random.uniform(0.5, 2.0)
                        logger.debug(f"Simulating {delay:.2f}s translation latency")
                        time.sleep(delay)

                        translated_text = translator.translate(
                            text, source_lang, target_lang
                        )
                        duration_ms = int((time.time() - start_time) * 1000)

                        # Context Propagation
                        span.set_attribute("translation.duration_ms", duration_ms)

                        result = {
                            "jobId": job_id,
                            "sessionId": session_id,
                            "targetLanguage": target_lang,
                            "translatedText": translated_text,
                            "status": "completed",
                            "durationMs": duration_ms,
                            "completedAt": datetime.now(timezone.utc).isoformat() + "Z",
                        }

                        logger.info(
                            f"Job {job_id} completed successfully in {duration_ms}ms"
                        )

                    except Exception as e:
                        duration_ms = int((time.time() - start_time) * 1000)
                        error_msg = str(e)
                        logger.error(
                            f"Translation failed for job {job_id}: {error_msg}"
                        )
                        # Context Propagation
                        span.record_exception(e)
                        span.set_status(Status(StatusCode.ERROR, error_msg))
                        result = {
                            "jobId": job_id,
                            "sessionId": session_id,
                            "targetLanguage": target_lang,
                            "status": "error",
                            "error": error_msg,
                            "durationMs": duration_ms,
                            "completedAt": datetime.now(timezone.utc).isoformat() + "Z",
                        }

                    # Publish result
                    queue_consumer.publish_result(result)

            except KeyboardInterrupt:
                logger.info("Received keyboard interrupt")
                break
            except Exception as e:
                logger.error(f"Error processing job: {e}", exc_info=True)
                # Continue processing next job
                time.sleep(1)

        logger.info("Worker shutting down...")

    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
        sys.exit(1)

    finally:
        # Cleanup
        if queue_consumer:
            try:
                queue_consumer.disconnect()
            except Exception as e:
                logger.error(f"Error disconnecting from Redis: {e}")

        logger.info("Worker stopped")
        shutdown_instrumentation()


if __name__ == "__main__":
    main()
