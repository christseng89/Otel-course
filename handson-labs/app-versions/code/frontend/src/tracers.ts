import { trace, SpanStatusCode } from '@opentelemetry/api';

export { SpanStatusCode };
export const tracer = trace.getTracer('translation-frontend', '1.0.0');
