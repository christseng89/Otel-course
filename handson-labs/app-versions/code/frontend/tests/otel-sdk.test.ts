import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockSdkStart = jest.fn();
const MockNodeSDK = jest.fn().mockImplementation(() => ({
  start: mockSdkStart,
}));
const MockOTLPLogExporter = jest.fn();
const MockOTLPMetricExporter = jest.fn();
const MockOTLPTraceExporter = jest.fn();
const MockBatchLogRecordProcessor = jest.fn();
const MockPeriodicExportingMetricReader = jest.fn();
const MockWinstonInstrumentation = jest.fn();
const mockGetNodeAutoInstrumentations = jest.fn(() => ({
  instrumentation: 'auto',
}));

jest.unstable_mockModule('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: mockGetNodeAutoInstrumentations,
}));
jest.unstable_mockModule('@opentelemetry/exporter-logs-otlp-http', () => ({
  OTLPLogExporter: MockOTLPLogExporter,
}));
jest.unstable_mockModule('@opentelemetry/exporter-metrics-otlp-http', () => ({
  OTLPMetricExporter: MockOTLPMetricExporter,
}));
jest.unstable_mockModule('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: MockOTLPTraceExporter,
}));
jest.unstable_mockModule('@opentelemetry/instrumentation-winston', () => ({
  WinstonInstrumentation: MockWinstonInstrumentation,
}));
jest.unstable_mockModule('@opentelemetry/sdk-logs', () => ({
  BatchLogRecordProcessor: MockBatchLogRecordProcessor,
}));
jest.unstable_mockModule('@opentelemetry/sdk-metrics', () => ({
  PeriodicExportingMetricReader: MockPeriodicExportingMetricReader,
}));
jest.unstable_mockModule('@opentelemetry/sdk-node', () => ({
  NodeSDK: MockNodeSDK,
}));

const { startOpenTelemetry } = await import('../src/otel-sdk.js');

describe('OpenTelemetry SDK setup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.OTEL_METRIC_EXPORT_INTERVAL;
  });

  it('starts the SDK with configured exporters and instrumentations', () => {
    startOpenTelemetry();

    expect(MockOTLPTraceExporter).toHaveBeenCalledTimes(1);
    expect(MockOTLPMetricExporter).toHaveBeenCalledTimes(1);
    expect(MockOTLPLogExporter).toHaveBeenCalledTimes(1);
    expect(MockPeriodicExportingMetricReader).toHaveBeenCalledWith({
      exporter: expect.any(Object),
      exportIntervalMillis: 60000,
    });
    expect(MockBatchLogRecordProcessor).toHaveBeenCalledWith(
      expect.any(Object),
    );
    expect(MockWinstonInstrumentation).toHaveBeenCalledTimes(1);
    expect(mockGetNodeAutoInstrumentations).toHaveBeenCalledTimes(1);
    expect(MockNodeSDK).toHaveBeenCalledWith({
      traceExporter: expect.any(Object),
      metricReader: expect.any(Object),
      logRecordProcessors: [expect.any(Object)],
      instrumentations: [
        { instrumentation: 'auto' },
        expect.any(Object),
      ],
    });
    expect(mockSdkStart).toHaveBeenCalledTimes(1);
  });

  it('uses the configured metric export interval', () => {
    process.env.OTEL_METRIC_EXPORT_INTERVAL = '1500';

    startOpenTelemetry();

    expect(MockPeriodicExportingMetricReader).toHaveBeenCalledWith({
      exporter: expect.any(Object),
      exportIntervalMillis: 1500,
    });
  });
});
