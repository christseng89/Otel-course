import {
  getTracer,
  SpanKind,
  SpanStatusCode,
} from "./otel-api.js";
import type { Attributes, Span, Tracer } from "./otel-api.js";

export { SpanKind, SpanStatusCode };

/** Creates the tracer used by the translation frontend service. */
export const createTranslationTracer = (): Tracer =>
  getTracer("translation-frontend", "1.0.0");

export const tracer = createTranslationTracer();

export const setSpanAttributes = (
  span: Span,
  attributes: Attributes,
): void => {
  span.setAttributes(attributes);
};

export const setSpanSuccess = (span: Span): void => {
  span.setStatus({ code: SpanStatusCode.OK });
};

export const setSpanError = (span: Span, error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error);

  span.recordException(error instanceof Error ? error : new Error(message));
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message,
  });
};
