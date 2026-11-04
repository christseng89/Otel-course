"""Stable application-facing wrapper around the OpenTelemetry API."""

from collections.abc import Mapping, MutableMapping

from opentelemetry import context, metrics, propagate, trace
from opentelemetry.context import Context
from opentelemetry.metrics import Meter
from opentelemetry.trace import (
    Span,
    SpanKind,
    Status,
    StatusCode as SpanStatusCode,
    Tracer,
)

__all__ = [
    "Context", "Meter", "Span", "SpanKind", "SpanStatusCode", "Status", "Tracer",
    "extract_context", "get_active_context", "get_meter", "get_tracer",
    "inject_active_context",
]


def get_tracer(name: str, version: str | None = None) -> Tracer:
    return trace.get_tracer(name, version)


def get_meter(name: str, version: str | None = None) -> Meter:
    return metrics.get_meter(name, version)


def get_active_context() -> Context:
    return context.get_current()


def inject_active_context(carrier: MutableMapping[str, str]) -> None:
    propagate.inject(carrier)


def extract_context(carrier: Mapping[str, str]) -> Context:
    return propagate.extract(carrier)
