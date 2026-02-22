/**
 * OpenTelemetry setup and helpers for the swarm.
 * Import this at process entry (e.g. swarm.ts top) so the SDK is registered before other code runs.
 */
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { trace, metrics } from "@opentelemetry/api";

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? "swarm-v0.1";

let sdk: NodeSDK | null = null;

export function initTelemetry(): void {
  if (process.env.OTEL_SDK_DISABLED === "true") return;

  const traceExporter = new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`
      : undefined,
  });

  sdk = new NodeSDK({
    serviceName: SERVICE_NAME,
    traceExporter,
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

/** Get the global meter for swarm metrics (requires OTEL_METRICS_EXPORTER or default OTLP). */
export function getMeter(_name: string = "swarm") {
  return metrics.getMeter(SERVICE_NAME, "0.1.0");
}
