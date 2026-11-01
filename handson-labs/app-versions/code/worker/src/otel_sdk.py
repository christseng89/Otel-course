"""OpenTelemetry SDK setup and lifecycle for the translation worker."""

import logging
import os

from opentelemetry import metrics, trace
from opentelemetry._logs import set_logger_provider
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.redis import RedisInstrumentor
from opentelemetry.instrumentation.system_metrics import SystemMetricsInstrumentor
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

logger = logging.getLogger(__name__)
_meter_provider: MeterProvider | None = None
_logger_provider: LoggerProvider | None = None
_otel_handler: LoggingHandler | None = None
_tracer_provider: TracerProvider | None = None
_redis_instrumentor: RedisInstrumentor | None = None
_system_metrics_instrumentor: SystemMetricsInstrumentor | None = None


def start_open_telemetry() -> None:
    global _meter_provider, _logger_provider, _otel_handler, _tracer_provider
    global _redis_instrumentor, _system_metrics_instrumentor

    resource = Resource.create()
    metric_reader = PeriodicExportingMetricReader(
        exporter=OTLPMetricExporter(),
        export_interval_millis=int(os.getenv("OTEL_METRIC_EXPORT_INTERVAL", "60000")),
    )
    _meter_provider = MeterProvider(resource=resource, metric_readers=[metric_reader])
    metrics.set_meter_provider(_meter_provider)

    _logger_provider = LoggerProvider(resource=resource)
    _logger_provider.add_log_record_processor(
        BatchLogRecordProcessor(OTLPLogExporter())
    )
    set_logger_provider(_logger_provider)
    _otel_handler = LoggingHandler(logger_provider=_logger_provider)
    logging.getLogger().addHandler(_otel_handler)

    _tracer_provider = TracerProvider(resource=resource)
    _tracer_provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(_tracer_provider)

    _redis_instrumentor = RedisInstrumentor()
    _redis_instrumentor.instrument()
    _system_metrics_instrumentor = SystemMetricsInstrumentor()
    _system_metrics_instrumentor.instrument()
    logger.info("OpenTelemetry instrumentation initialised")


def shutdown_open_telemetry() -> None:
    root_logger = logging.getLogger()
    if _otel_handler:
        root_logger.removeHandler(_otel_handler)
    if _redis_instrumentor:
        _redis_instrumentor.uninstrument()
    if _system_metrics_instrumentor:
        _system_metrics_instrumentor.uninstrument()
    if _logger_provider:
        _logger_provider.shutdown()
    if _meter_provider:
        _meter_provider.shutdown()
    if _tracer_provider:
        _tracer_provider.shutdown()
