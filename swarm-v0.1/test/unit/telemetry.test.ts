import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { initTelemetry, shutdownTelemetry, getTracer, getMeter } from "../../src/telemetry.js";

describe("telemetry", () => {
  const origEnv = process.env.OTEL_SDK_DISABLED;

  afterEach(() => {
    process.env.OTEL_SDK_DISABLED = origEnv;
  });

  it("initTelemetry does not throw when OTEL_SDK_DISABLED is true", () => {
    process.env.OTEL_SDK_DISABLED = "true";
    expect(() => initTelemetry()).not.toThrow();
  });

  it("initTelemetry does not throw when called", () => {
    process.env.OTEL_SDK_DISABLED = "true";
    initTelemetry();
    expect(() => initTelemetry()).not.toThrow();
  });

  it("getTracer returns a tracer with startSpan", () => {
    process.env.OTEL_SDK_DISABLED = "true";
    initTelemetry();
    const tracer = getTracer();
    expect(tracer).toBeDefined();
    expect(typeof tracer.startSpan).toBe("function");
    const span = tracer.startSpan("test");
    expect(span).toBeDefined();
    expect(typeof span.end).toBe("function");
    span.end();
  });

  it("getMeter returns a meter", () => {
    process.env.OTEL_SDK_DISABLED = "true";
    initTelemetry();
    const meter = getMeter();
    expect(meter).toBeDefined();
    expect(typeof meter.createCounter).toBe("function");
    expect(typeof meter.createHistogram).toBe("function");
  });

  it("shutdownTelemetry resolves", async () => {
    process.env.OTEL_SDK_DISABLED = "true";
    initTelemetry();
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });
});
