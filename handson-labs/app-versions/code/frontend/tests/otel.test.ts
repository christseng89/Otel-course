import { describe, expect, it, jest } from '@jest/globals';
import { SpanStatusCode } from '@opentelemetry/api';
import {
  extractContext,
  getActiveContext,
  getMeter,
  getTracer,
  injectActiveContext,
} from '../src/otel-api.js';
import {
  createTranslationTracer,
  setSpanAttributes,
  setSpanError,
  setSpanSuccess,
} from '../src/otel-tracing.js';
import {
  recordJobEnqueued,
  recordRequestDuration,
  recordServerError,
  recordTranslationRequest,
  recordValidationError,
} from '../src/metrics.js';

describe('OpenTelemetry application wrappers', () => {
  it('exposes tracer, meter, and context helpers', () => {
    expect(getTracer('test')).toBeDefined();
    expect(getMeter('test')).toBeDefined();
    expect(getActiveContext()).toBeDefined();

    const carrier: Record<string, string> = {};
    injectActiveContext(carrier);
    expect(extractContext(carrier)).toBeDefined();
  });

  it('configures spans for success and error outcomes', () => {
    const span = {
      setAttributes: jest.fn(),
      setStatus: jest.fn(),
      recordException: jest.fn(),
    } as any;

    setSpanAttributes(span, { operation: 'translate' });
    setSpanSuccess(span);
    setSpanError(span, 'failed');
    setSpanError(span, new Error('broken'));

    expect(span.setAttributes).toHaveBeenCalledWith({ operation: 'translate' });
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(span.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: 'failed',
    });
    expect(span.recordException).toHaveBeenCalledTimes(2);
    expect(createTranslationTracer()).toBeDefined();
  });

  it('records all business metric dimensions', () => {
    expect(() => {
      recordValidationError('empty_text');
      recordJobEnqueued('es');
      recordRequestDuration(12, 2);
      recordTranslationRequest('success', 2);
      recordServerError('create_translation');
    }).not.toThrow();
  });
});
