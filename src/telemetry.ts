/**
 * OpenTelemetry setup: traces + metrics for the swarm.
 * Import at process entry (e.g. swarm.ts top) so the SDK is registered before other code runs.
 */
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { trace, metrics } from "@opentelemetry/api";

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? "swarm-v0.1";

let sdk: NodeSDK | null = null;

export function initTelemetry(): void {
  if (process.env.OTEL_SDK_DISABLED === "true") return;

  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318";

  const traceExporter = new OTLPTraceExporter({
    url: `${endpoint.replace(/\/$/, "")}/v1/traces`,
  });

  const metricExporter = new OTLPMetricExporter({
    url: `${endpoint.replace(/\/$/, "")}/v1/metrics`,
  });

  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 15000,
  });

  sdk = new NodeSDK({
    serviceName: SERVICE_NAME,
    traceExporter,
    metricReader,
    instrumentations: [new HttpInstrumentation()],
  });
  sdk.start();
}

export function shutdownTelemetry(): Promise<void> {
  if (sdk) {
    const p = sdk.shutdown();
    sdk = null;
    return p;
  }
  return Promise.resolve();
}

export function getTracer(_name: string = "swarm") {
  return trace.getTracer(SERVICE_NAME, "0.1.0");
}

export function getMeter(_name: string = "swarm") {
  return metrics.getMeter(SERVICE_NAME, "0.1.0");
}
