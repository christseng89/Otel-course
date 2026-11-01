"""Backward-compatible import shim for the OpenTelemetry SDK helpers."""

from .otel_sdk import shutdown_open_telemetry, start_open_telemetry

setup_instrumentation = start_open_telemetry
shutdown_instrumentation = shutdown_open_telemetry

__all__ = ["setup_instrumentation", "shutdown_instrumentation"]
