import os
import logging

from opentelemetry import metrics
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.instrumentation.redis import RedisInstrumentor
from opentelemetry.instrumentation.system_metrics import SystemMetricsInstrumentor

# Change here ...
from opentelemetry._logs import set_logger_provider
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter

logger = logging.getLogger(__name__)

# Change here by AI ...
_meter_provider: MeterProvider | None = None
_logger_provider: LoggerProvider | None = None
_otel_handler: LoggingHandler | None = None


def setup_instrumentation() -> None:
    """Configure OpenTelemetry metrics and logs pipelines."""
    # Change here by AI ...
    global _meter_provider, _logger_provider, _otel_handler

    # Refactor here ...
    resource = Resource.create()

    metric_reader = PeriodicExportingMetricReader(
        exporter=OTLPMetricExporter(),
        export_interval_millis=int(
            os.getenv("OTEL_METRIC_EXPORT_INTERVAL", "10000")
        ),
    )

    _meter_provider = MeterProvider(
        resource=resource,
        metric_readers=[metric_reader],
    )

    metrics.set_meter_provider(_meter_provider)

    # Change here ...
    _logger_provider = LoggerProvider(resource=resource)
    _logger_provider.add_log_record_processor(
        BatchLogRecordProcessor(OTLPLogExporter())
    )
    set_logger_provider(_logger_provider)
    # Attach OTel handler to Python root logger.
    # This exports all log records via OTLP and injects trace_id/span_id automatically
    # when the log is emitted inside an active span.
    _otel_handler = LoggingHandler(logger_provider=_logger_provider)
    logging.getLogger().addHandler(_otel_handler)

    RedisInstrumentor().instrument()

    # Auto-collect system and process metrics: CPU, memory, network I/O, GC counts.
    SystemMetricsInstrumentor().instrument()

    logger.info("OpenTelemetry instrumentation initialised")

# Change here by AI ...
def shutdown_instrumentation() -> None:
    """Flush and shut down OpenTelemetry providers."""
    root_logger = logging.getLogger()

    if _otel_handler:
        root_logger.removeHandler(_otel_handler)

    if _logger_provider:
        _logger_provider.shutdown()

    if _meter_provider:
        _meter_provider.shutdown()
