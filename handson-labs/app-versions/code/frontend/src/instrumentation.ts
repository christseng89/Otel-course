import { startOpenTelemetry } from "./otel-sdk.js";

// The SDK and exporters read the standard OTel environment variables below
// automatically. Only OTEL_METRIC_EXPORT_INTERVAL is read explicitly here.
//   OTEL_SERVICE_NAME                   — service name (required)
//   OTEL_EXPORTER_OTLP_ENDPOINT         — base URL for all signals, e.g. http://otel-collector:4318
//   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT  — per-signal traces endpoint override
//   OTEL_EXPORTER_OTLP_METRICS_ENDPOINT — per-signal metrics endpoint override
//   OTEL_EXPORTER_OTLP_LOGS_ENDPOINT    — per-signal logs endpoint override
//   OTEL_METRIC_EXPORT_INTERVAL         — metrics export interval in ms (default 60000)

startOpenTelemetry();
