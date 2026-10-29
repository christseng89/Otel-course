import os
import logging

from opentelemetry import metrics
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.instrumentation.redis import RedisInstrumentor
from opentelemetry.instrumentation.system_metrics import SystemMetricsInstrumentor

logger = logging.getLogger(__name__)


def setup_instrumentation() -> None:
    """Configure OpenTelemetry metrics pipeline."""
    resource = Resource(
        {
            "service.name": os.getenv("OTEL_SERVICE_NAME", "translation-worker"),
        }
    )

    otlp_endpoint = os.getenv(
        "OTEL_EXPORTER_OTLP_ENDPOINT", "http://otel-collector:4318"
    )

    metric_reader = PeriodicExportingMetricReader(
        exporter=OTLPMetricExporter(
            endpoint=f"{otlp_endpoint}/v1/metrics",
        ),
        export_interval_millis=int(
            os.getenv("OTEL_METRIC_EXPORT_INTERVAL_MS", "10000")
        ),
    )

    meter_provider = MeterProvider(
        resource=resource,
        metric_readers=[metric_reader],
    )
    metrics.set_meter_provider(meter_provider)

    # Auto-instrument Redis client — patches redis-py to create spans for every Redis command.
    # Note: the Python RedisInstrumentor produces traces only, not metrics.
    # Business metrics will be added manually in Lab 5.
    RedisInstrumentor().instrument()

    # Auto-collect system and process metrics: CPU, memory, network I/O, GC counts.
    SystemMetricsInstrumentor().instrument()

    logger.info("OpenTelemetry instrumentation initialised")
