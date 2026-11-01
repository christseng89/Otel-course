import json as std_json
import logging

from src.logger import setup_logging


def test_json_formatter_includes_structured_context():
    setup_logging()
    handler = next(
        handler
        for handler in logging.getLogger().handlers
        if getattr(handler, "_translation_worker_marker", None)
        == "translation-worker-json"
    )

    record = logging.LogRecord(
        name="src.worker",
        level=logging.INFO,
        pathname=__file__,
        lineno=10,
        msg="Processing translation job",
        args=(),
        exc_info=None,
    )
    record.job_id = "job-123"
    record.target_language = "es"

    payload = std_json.loads(handler.formatter.format(record))

    assert payload["message"] == "Processing translation job"
    assert payload["level"] == "INFO"
    assert payload["job_id"] == "job-123"
    assert payload["target_language"] == "es"
    assert payload["timestamp"]


def test_setup_logging_is_idempotent():
    root_logger = logging.getLogger()
    marker = "translation-worker-json"

    setup_logging()
    setup_logging()

    matching_handlers = [
        handler
        for handler in root_logger.handlers
        if getattr(handler, "_translation_worker_marker", None) == marker
    ]

    assert len(matching_handlers) == 1


def test_setup_logging_quiets_translation_library_info_logs():
    setup_logging()

    assert logging.getLogger("argostranslate").level == logging.WARNING
    assert logging.getLogger("argostranslate.utils").level == logging.WARNING
    assert logging.getLogger("ctranslate2").level == logging.WARNING
