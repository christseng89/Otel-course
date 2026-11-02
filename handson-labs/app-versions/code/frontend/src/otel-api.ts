import {
  context,
  metrics,
  propagation,
  trace,
} from "@opentelemetry/api";
import type {
  Context,
  Meter,
  Tracer,
} from "@opentelemetry/api";

export type { Attributes, Context, Counter, Meter, Span, Tracer } from "@opentelemetry/api";
export { SpanKind, SpanStatusCode } from "@opentelemetry/api";

export const getTracer = (name: string, version?: string): Tracer =>
  trace.getTracer(name, version);

export const getMeter = (name: string, version?: string): Meter =>
  metrics.getMeter(name, version);

export const getActiveContext = (): Context => context.active();

export const injectActiveContext = (
  carrier: Record<string, string>,
): void => {
  propagation.inject(getActiveContext(), carrier);
};

export const extractContext = (
  carrier: Record<string, string>,
): Context => propagation.extract(getActiveContext(), carrier);
