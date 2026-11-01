"""Worker tracing helpers and instrumentation-scope configuration."""

from .otel_api import Span, SpanKind, SpanStatusCode, Tracer, get_tracer

__all__ = [
    "SpanKind", "SpanStatusCode", "create_translation_tracer",
    "set_span_attributes", "set_span_error", "set_span_success", "tracer",
]


def create_translation_tracer() -> Tracer:
    return get_tracer("translation-worker", "1.0.0")


tracer = create_translation_tracer()


def set_span_attributes(span: Span, attributes: dict[str, object]) -> None:
    span.set_attributes(attributes)


def set_span_success(span: Span) -> None:
    span.set_status(SpanStatusCode.OK)


def set_span_error(span: Span, error: BaseException | str) -> None:
    exception = error if isinstance(error, BaseException) else ValueError(error)
    span.record_exception(exception)
    span.set_status(SpanStatusCode.ERROR, str(exception))
