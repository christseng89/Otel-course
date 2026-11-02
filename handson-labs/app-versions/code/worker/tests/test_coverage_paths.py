import json
import logging
from unittest.mock import MagicMock, patch

import pytest
import redis

from src.config import Config
from src import main as main_module
from src.main import process_translation_job
from src.otel_api import (
    extract_context,
    get_active_context,
    get_meter,
    get_tracer,
    inject_active_context,
)
from src.queue import QueueConsumer
from src.translator import Translator


def test_config_from_env_uses_defaults_and_filters_languages(monkeypatch):
    monkeypatch.setenv("SUPPORTED_LANGUAGES", " es, ,fr ")
    config = Config.from_env()

    assert config.redis_host == "localhost"
    assert config.redis_port == 6379
    assert config.supported_languages == ["es", "fr"]
    assert config.log_level == "INFO"


def test_otel_api_wrappers_delegate_to_global_api():
    assert get_tracer("test") is not None
    assert get_meter("test") is not None
    assert get_active_context() is not None

    carrier = {}
    inject_active_context(carrier)
    assert extract_context(carrier) is not None


def test_queue_connect_rethrows_redis_error():
    queue = QueueConsumer("localhost", 6379, "jobs", "results")
    with patch("src.queue.redis.Redis", side_effect=redis.RedisError("offline")):
        with pytest.raises(redis.RedisError, match="offline"):
            queue.connect()


def test_queue_wait_requires_connection():
    queue = QueueConsumer("localhost", 6379, "jobs", "results")
    with pytest.raises(RuntimeError, match="not connected"):
        queue.wait_for_job()


def test_queue_wait_rethrows_redis_error(mock_redis):
    queue = QueueConsumer("localhost", 6379, "jobs", "results")
    queue.client = mock_redis
    mock_redis.brpop.side_effect = redis.RedisError("read failed")

    with pytest.raises(redis.RedisError, match="read failed"):
        queue.wait_for_job(timeout=1)


def test_queue_publish_requires_connection():
    queue = QueueConsumer("localhost", 6379, "jobs", "results")
    with pytest.raises(RuntimeError, match="not connected"):
        queue.publish_result({"jobId": "1"})


def test_queue_publish_rethrows_redis_error(mock_redis):
    queue = QueueConsumer("localhost", 6379, "jobs", "results")
    queue.publisher = mock_redis
    mock_redis.publish.side_effect = redis.RedisError("write failed")

    with pytest.raises(redis.RedisError, match="write failed"):
        queue.publish_result({"jobId": "1"})


def test_queue_publish_rethrows_json_error(mock_redis):
    queue = QueueConsumer("localhost", 6379, "jobs", "results")
    queue.publisher = mock_redis

    with patch("src.queue.json.dumps", side_effect=json.JSONDecodeError("bad", "", 0)):
        with pytest.raises(json.JSONDecodeError):
            queue.publish_result({"jobId": "1"})


def test_process_translation_job_ignores_invalid_job(config):
    queue = MagicMock()
    translator = MagicMock()

    process_translation_job({"jobId": "missing-fields"}, config, translator, queue)

    translator.translate.assert_not_called()
    queue.publish_result.assert_not_called()


def test_process_translation_job_handles_disconnect_error(config):
    queue = MagicMock()
    queue.publish_result.side_effect = RuntimeError("publish failed")
    translator = MagicMock()
    translator.translate.return_value = "Hola"

    job = {
        "jobId": "job-1",
        "sessionId": "session-1",
        "text": "Hello",
        "sourceLanguage": "en",
        "targetLanguage": "es",
    }
    with patch("src.main.random.uniform", return_value=0), patch("src.main.time.sleep"):
        with pytest.raises(RuntimeError, match="publish failed"):
            process_translation_job(job, config, translator, queue)


def test_shutdown_handler_sets_shutdown_flag(monkeypatch):
    monkeypatch.setattr(main_module, "shutdown_flag", False)
    main_module.handle_shutdown(15, None)
    assert main_module.shutdown_flag is True


def test_main_handles_idle_and_processing_failures(config, monkeypatch):
    queue = MagicMock()
    queue.wait_for_job.side_effect = [None, RuntimeError("loop failed"), KeyboardInterrupt()]
    translator = MagicMock()

    with (
        patch.object(main_module, "setup_instrumentation"),
        patch.object(main_module, "shutdown_instrumentation"),
        patch.object(main_module.Config, "from_env", return_value=config),
        patch.object(main_module, "QueueConsumer", return_value=queue),
        patch.object(main_module, "Translator", return_value=translator),
        patch.object(main_module.time, "sleep") as sleep,
    ):
        monkeypatch.setattr(main_module, "shutdown_flag", False)
        main_module.main()

    sleep.assert_any_call(1)


def test_main_exits_on_fatal_configuration_failure(config, monkeypatch):
    with (
        patch.object(main_module, "setup_instrumentation"),
        patch.object(main_module, "shutdown_instrumentation"),
        patch.object(main_module.Config, "from_env", return_value=config),
        patch.object(main_module.QueueConsumer, "__init__", side_effect=RuntimeError("bad queue")),
        patch.object(main_module.sys, "exit") as exit_process,
    ):
        monkeypatch.setattr(main_module, "shutdown_flag", False)
        main_module.main()

    exit_process.assert_called_once_with(1)


def test_main_logs_disconnect_failure(config, monkeypatch):
    queue = MagicMock()
    queue.wait_for_job.side_effect = KeyboardInterrupt()
    queue.disconnect.side_effect = RuntimeError("disconnect failed")

    with (
        patch.object(main_module, "setup_instrumentation"),
        patch.object(main_module, "shutdown_instrumentation"),
        patch.object(main_module.Config, "from_env", return_value=config),
        patch.object(main_module, "QueueConsumer", return_value=queue),
        patch.object(main_module, "Translator", return_value=MagicMock()),
    ):
        monkeypatch.setattr(main_module, "shutdown_flag", False)
        main_module.main()

    queue.disconnect.assert_called_once()


def test_translator_initialization_error_is_rethrown():
    with patch("argostranslate.package.update_package_index", side_effect=RuntimeError("index failed")):
        with pytest.raises(RuntimeError, match="index failed"):
            Translator()


@patch("src.otel_sdk.RedisInstrumentor")
@patch("src.otel_sdk.SystemMetricsInstrumentor")
@patch("src.otel_sdk.BatchSpanProcessor")
@patch("src.otel_sdk.OTLPSpanExporter")
@patch("src.otel_sdk.TracerProvider")
@patch("src.otel_sdk.LoggingHandler")
@patch("src.otel_sdk.BatchLogRecordProcessor")
@patch("src.otel_sdk.OTLPLogExporter")
@patch("src.otel_sdk.LoggerProvider")
@patch("src.otel_sdk.PeriodicExportingMetricReader")
@patch("src.otel_sdk.OTLPMetricExporter")
@patch("src.otel_sdk.MeterProvider")
@patch("src.otel_sdk.Resource")
def test_open_telemetry_lifecycle(
    resource,
    meter_provider,
    metric_exporter,
    metric_reader,
    logger_provider,
    log_exporter,
    log_processor,
    logging_handler,
    tracer_provider,
    span_exporter,
    span_processor,
    redis_instrumentor,
    system_metrics_instrumentor,
):
    from src import otel_sdk

    logging_handler.return_value.level = logging.NOTSET
    with (
        patch("src.otel_sdk.metrics.set_meter_provider"),
        patch("src.otel_sdk.trace.set_tracer_provider"),
        patch("src.otel_sdk.set_logger_provider"),
    ):
        try:
            otel_sdk.start_open_telemetry()
        finally:
            otel_sdk.shutdown_open_telemetry()

    meter_provider.return_value.shutdown.assert_called_once()
    logger_provider.return_value.shutdown.assert_called_once()
    tracer_provider.return_value.shutdown.assert_called_once()
    redis_instrumentor.return_value.instrument.assert_called_once()
    redis_instrumentor.return_value.uninstrument.assert_called_once()
    system_metrics_instrumentor.return_value.instrument.assert_called_once()
    system_metrics_instrumentor.return_value.uninstrument.assert_called_once()
