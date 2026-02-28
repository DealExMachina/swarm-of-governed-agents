import { describe, it, expect } from "vitest";
import {
  ArrivalRateEstimator,
  computeServiceRate,
  computeOptimalWorkers,
  littlesLawQueueDepth,
} from "../../src/hatcheryMetrics";

describe("ArrivalRateEstimator", () => {
  it("returns 0 for empty estimator", () => {
    const est = new ArrivalRateEstimator(60_000);
    expect(est.estimateLambda()).toBe(0);
  });

  it("returns 0 for single sample", () => {
    const est = new ArrivalRateEstimator(60_000);
    est.addSample(10, 1000);
    expect(est.estimateLambda()).toBe(0);
  });

  it("computes arrival rate from sliding window", () => {
    const est = new ArrivalRateEstimator(60_000);
    const base = Date.now();
    est.addSample(5, base);
    est.addSample(10, base + 1000);
    est.addSample(15, base + 2000);
    const lambda = est.estimateLambda();
    // total = 30, dt = 2s => lambda = 15 msgs/sec
    expect(lambda).toBe(15);
  });

  it("prunes samples outside window", () => {
    const est = new ArrivalRateEstimator(5000);
    const base = Date.now();
    est.addSample(100, base - 10000); // outside window
    est.addSample(5, base);
    est.addSample(5, base + 1000);
    const lambda = est.estimateLambda();
    // only 2 samples within window: total = 10, dt = 1s => 10 msgs/sec
    expect(lambda).toBe(10);
  });
});

describe("computeServiceRate", () => {
  it("converts latency to throughput", () => {
    expect(computeServiceRate(200)).toBeCloseTo(5);
    expect(computeServiceRate(1000)).toBeCloseTo(1);
  });

  it("returns role-aware fallback for zero latency", () => {
    expect(computeServiceRate(0, "facts")).toBeCloseTo(0.003, 3);
    expect(computeServiceRate(0, "governance")).toBeCloseTo(0.033, 3);
  });

  it("returns generic fallback for unknown role", () => {
    expect(computeServiceRate(0, "unknown")).toBeCloseTo(0.01, 2);
    expect(computeServiceRate(-1, "unknown")).toBeCloseTo(0.01, 2);
  });
});

describe("computeOptimalWorkers", () => {
  it("computes M/M/c formula", () => {
    // lambda=10, mu=2, rho=0.75 => c = ceil(10/(2*0.75)) = ceil(6.67) = 7
    expect(computeOptimalWorkers(10, 2, 0.75, 1, 10)).toBe(7);
  });

  it("clamps to min", () => {
    expect(computeOptimalWorkers(0.1, 2, 0.75, 3, 10)).toBe(3);
  });

  it("clamps to max", () => {
    expect(computeOptimalWorkers(100, 2, 0.75, 1, 4)).toBe(4);
  });

  it("returns min for zero lambda", () => {
    expect(computeOptimalWorkers(0, 2, 0.75, 2, 10)).toBe(2);
  });

  it("returns min for zero mu", () => {
    expect(computeOptimalWorkers(10, 0, 0.75, 1, 10)).toBe(1);
  });

  it("returns min for zero rho", () => {
    expect(computeOptimalWorkers(10, 2, 0, 1, 10)).toBe(1);
  });
});

describe("littlesLawQueueDepth", () => {
  it("computes L = lambda/mu", () => {
    expect(littlesLawQueueDepth(10, 2)).toBe(5);
  });

  it("returns 0 for zero mu", () => {
    expect(littlesLawQueueDepth(10, 0)).toBe(0);
  });
});
