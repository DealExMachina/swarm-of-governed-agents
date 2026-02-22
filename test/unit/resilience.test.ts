import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withRetry, isPgRetryable, CircuitBreaker } from "../../src/resilience";

// ── withRetry ────────────────────────────────────────────────────────────────

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("succeeds on first attempt when fn succeeds", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on retryable PG error code 57P01 and succeeds on retry", async () => {
    const pgError = Object.assign(new Error("admin_shutdown"), { code: "57P01" });
    const fn = vi.fn()
      .mockRejectedValueOnce(pgError)
      .mockResolvedValue("recovered");

    const promise = withRetry(fn, { backoffMs: 100 });
    // Advance past the first backoff (100ms * 2^0 = 100ms)
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;

    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on retryable PG error code 08006 and succeeds on retry", async () => {
    const pgError = Object.assign(new Error("connection_failure"), { code: "08006" });
    const fn = vi.fn()
      .mockRejectedValueOnce(pgError)
      .mockResolvedValue("back");

    const promise = withRetry(fn, { backoffMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    const result = await promise;

    expect(result).toBe("back");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on ECONNRESET network error and succeeds", async () => {
    const netError = new Error("read ECONNRESET");
    const fn = vi.fn()
      .mockRejectedValueOnce(netError)
      .mockResolvedValue("reconnected");

    const promise = withRetry(fn, { backoffMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    const result = await promise;

    expect(result).toBe("reconnected");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws immediately on non-retryable errors (does not retry)", async () => {
    const nonRetryable = new Error("syntax error at position 42");
    const fn = vi.fn().mockRejectedValue(nonRetryable);

    await expect(withRetry(fn)).rejects.toThrow("syntax error at position 42");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws immediately on non-retryable PG error code", async () => {
    const pgError = Object.assign(new Error("unique_violation"), { code: "23505" });
    const fn = vi.fn().mockRejectedValue(pgError);

    await expect(withRetry(fn)).rejects.toThrow("unique_violation");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws after maxRetries exhausted", async () => {
    // Use real timers with tiny backoff to avoid unhandled-rejection issues with fake timers
    vi.useRealTimers();
    const pgError = Object.assign(new Error("admin_shutdown"), { code: "57P01" });
    const fn = vi.fn().mockImplementation(async () => { throw pgError; });

    await expect(withRetry(fn, { maxRetries: 2, backoffMs: 1 })).rejects.toThrow("admin_shutdown");
    expect(fn).toHaveBeenCalledTimes(3); // attempts 0, 1, 2
    vi.useFakeTimers();
  });

  it("applies exponential backoff: each delay doubles", async () => {
    // Use real timers with spy to verify delay values
    vi.useRealTimers();
    const pgError = Object.assign(new Error("connection_failure"), { code: "08006" });
    const fn = vi.fn().mockImplementation(async () => { throw pgError; });

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await expect(
      withRetry(fn, { maxRetries: 3, backoffMs: 100, maxBackoffMs: 5000 }),
    ).rejects.toThrow("connection_failure");
    expect(fn).toHaveBeenCalledTimes(4); // initial + 3 retries

    // Verify the setTimeout calls had increasing delays
    const delayCalls = setTimeoutSpy.mock.calls
      .map((call) => call[1] as number)
      .filter((d) => typeof d === "number" && d >= 100);
    expect(delayCalls).toEqual([100, 200, 400]);

    setTimeoutSpy.mockRestore();
    vi.useFakeTimers();
  });

  it("caps backoff at maxBackoffMs", async () => {
    // Use real timers with spy to verify delay capping
    vi.useRealTimers();
    const pgError = Object.assign(new Error("cannot_connect_now"), { code: "57P03" });
    const fn = vi.fn().mockImplementation(async () => { throw pgError; });

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await expect(
      withRetry(fn, { maxRetries: 4, backoffMs: 1, maxBackoffMs: 3 }),
    ).rejects.toThrow("cannot_connect_now");

    const delayCalls = setTimeoutSpy.mock.calls
      .map((call) => call[1] as number)
      .filter((d) => typeof d === "number" && d >= 1);
    // delays: min(1*2^0,3)=1, min(1*2^1,3)=2, min(1*2^2,3)=3, min(1*2^3,3)=3
    expect(delayCalls).toEqual([1, 2, 3, 3]);

    setTimeoutSpy.mockRestore();
    vi.useFakeTimers();
  });

  it("accepts a custom retryableCheck predicate", async () => {
    const customError = new Error("custom transient");
    const fn = vi.fn()
      .mockRejectedValueOnce(customError)
      .mockResolvedValue("done");

    const promise = withRetry(fn, {
      backoffMs: 10,
      retryableCheck: (e) => (e as Error).message.includes("custom transient"),
    });
    await vi.advanceTimersByTimeAsync(10);
    const result = await promise;

    expect(result).toBe("done");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

// ── isPgRetryable ────────────────────────────────────────────────────────────

describe("isPgRetryable", () => {
  it("returns true for known PG retryable codes", () => {
    for (const code of ["57P01", "57P03", "08006", "08001", "08004", "08003", "40001"]) {
      expect(isPgRetryable({ code })).toBe(true);
    }
  });

  it("returns false for non-retryable PG codes", () => {
    expect(isPgRetryable({ code: "23505" })).toBe(false);
    expect(isPgRetryable({ code: "42601" })).toBe(false);
  });

  it("returns true for ECONNRESET message", () => {
    expect(isPgRetryable(new Error("read ECONNRESET"))).toBe(true);
  });

  it("returns true for ECONNREFUSED message", () => {
    expect(isPgRetryable(new Error("connect ECONNREFUSED 127.0.0.1:5432"))).toBe(true);
  });

  it("returns true for 'connection terminated' message", () => {
    expect(isPgRetryable(new Error("connection terminated"))).toBe(true);
    expect(isPgRetryable(new Error("Connection terminated unexpectedly"))).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isPgRetryable(new Error("syntax error"))).toBe(false);
    expect(isPgRetryable(null)).toBe(false);
    expect(isPgRetryable(undefined)).toBe(false);
  });
});

// ── CircuitBreaker ───────────────────────────────────────────────────────────

describe("CircuitBreaker", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    // Suppress circuit-breaker warning logs during tests
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    stderrSpy.mockRestore();
  });

  it("calls succeed when circuit is closed", async () => {
    const cb = new CircuitBreaker("test", 3, 1000);
    const fn = vi.fn().mockResolvedValue("ok");

    const result = await cb.call(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(cb.state).toBe("closed");
  });

  it("state is 'closed' initially", () => {
    const cb = new CircuitBreaker("test", 3, 1000);
    expect(cb.state).toBe("closed");
  });

  it("stays closed when failures are below threshold", async () => {
    const cb = new CircuitBreaker("test", 3, 1000);
    const failing = vi.fn().mockRejectedValue(new Error("fail"));

    // 2 failures (threshold is 3) — should stay closed
    await expect(cb.call(failing)).rejects.toThrow("fail");
    await expect(cb.call(failing)).rejects.toThrow("fail");
    expect(cb.state).toBe("closed");
  });

  it("opens after threshold consecutive failures", async () => {
    const cb = new CircuitBreaker("test", 3, 1000);
    const failing = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(cb.call(failing)).rejects.toThrow("boom");
    await expect(cb.call(failing)).rejects.toThrow("boom");
    await expect(cb.call(failing)).rejects.toThrow("boom");

    expect(cb.state).toBe("open");
  });

  it("throws immediately when open (does not call fn)", async () => {
    const cb = new CircuitBreaker("test-open", 2, 5000);
    const failing = vi.fn().mockRejectedValue(new Error("down"));

    // Trip the breaker
    await expect(cb.call(failing)).rejects.toThrow("down");
    await expect(cb.call(failing)).rejects.toThrow("down");
    expect(cb.state).toBe("open");

    // Next call should fail fast without invoking fn
    const probeFn = vi.fn().mockResolvedValue("should not run");
    await expect(cb.call(probeFn)).rejects.toThrow(/Circuit breaker 'test-open' is open/);
    expect(probeFn).not.toHaveBeenCalled();
  });

  it("transitions to half_open after cooldown expires", async () => {
    const cb = new CircuitBreaker("test-half", 2, 1000);
    const failing = vi.fn().mockRejectedValue(new Error("err"));

    await expect(cb.call(failing)).rejects.toThrow("err");
    await expect(cb.call(failing)).rejects.toThrow("err");
    expect(cb.state).toBe("open");

    // Advance past cooldown
    vi.advanceTimersByTime(1001);
    expect(cb.state).toBe("half_open");
  });

  it("resets to closed after successful call in half_open state", async () => {
    const cb = new CircuitBreaker("test-reset", 2, 500);
    const failing = vi.fn().mockRejectedValue(new Error("err"));

    // Trip the breaker
    await expect(cb.call(failing)).rejects.toThrow("err");
    await expect(cb.call(failing)).rejects.toThrow("err");
    expect(cb.state).toBe("open");

    // Wait for cooldown -> half_open
    vi.advanceTimersByTime(501);
    expect(cb.state).toBe("half_open");

    // Successful probe should close the circuit
    const success = vi.fn().mockResolvedValue("healed");
    const result = await cb.call(success);
    expect(result).toBe("healed");
    expect(cb.state).toBe("closed");
  });

  it("re-opens if probe call fails in half_open state", async () => {
    const cb = new CircuitBreaker("test-reopen", 2, 500);
    const failing = vi.fn().mockRejectedValue(new Error("still-down"));

    // Trip the breaker
    await expect(cb.call(failing)).rejects.toThrow("still-down");
    await expect(cb.call(failing)).rejects.toThrow("still-down");
    expect(cb.state).toBe("open");

    // Wait for cooldown -> half_open
    vi.advanceTimersByTime(501);
    expect(cb.state).toBe("half_open");

    // Probe fails -> circuit should re-open
    // In half_open the failures are reset to 0 on entry, so we need
    // threshold (2) consecutive failures to re-open
    await expect(cb.call(failing)).rejects.toThrow("still-down");
    await expect(cb.call(failing)).rejects.toThrow("still-down");
    expect(cb.state).toBe("open");
  });

  it("state getter returns correct values through lifecycle", async () => {
    const cb = new CircuitBreaker("lifecycle", 2, 300);
    expect(cb.state).toBe("closed");

    const failing = vi.fn().mockRejectedValue(new Error("x"));
    await expect(cb.call(failing)).rejects.toThrow();
    expect(cb.state).toBe("closed"); // 1 failure, below threshold

    await expect(cb.call(failing)).rejects.toThrow();
    expect(cb.state).toBe("open"); // 2 failures = threshold

    vi.advanceTimersByTime(301);
    expect(cb.state).toBe("half_open"); // cooldown expired

    const success = vi.fn().mockResolvedValue("ok");
    await cb.call(success);
    expect(cb.state).toBe("closed"); // recovered
  });

  it("reset() clears failures and returns to closed", async () => {
    const cb = new CircuitBreaker("test-manual-reset", 2, 5000);
    const failing = vi.fn().mockRejectedValue(new Error("x"));

    await expect(cb.call(failing)).rejects.toThrow();
    await expect(cb.call(failing)).rejects.toThrow();
    expect(cb.state).toBe("open");

    cb.reset();
    expect(cb.state).toBe("closed");

    // Should be able to call again normally
    const success = vi.fn().mockResolvedValue("fresh");
    const result = await cb.call(success);
    expect(result).toBe("fresh");
    expect(cb.state).toBe("closed");
  });

  it("successful calls reset consecutive failure count", async () => {
    const cb = new CircuitBreaker("test-reset-count", 3, 1000);
    const failing = vi.fn().mockRejectedValue(new Error("err"));
    const success = vi.fn().mockResolvedValue("ok");

    // 2 failures
    await expect(cb.call(failing)).rejects.toThrow();
    await expect(cb.call(failing)).rejects.toThrow();
    expect(cb.state).toBe("closed");

    // 1 success resets count
    await cb.call(success);
    expect(cb.state).toBe("closed");

    // 2 more failures — should still be closed (count restarted from 0)
    await expect(cb.call(failing)).rejects.toThrow();
    await expect(cb.call(failing)).rejects.toThrow();
    expect(cb.state).toBe("closed");
  });

  it("logs a warning to stderr when the circuit opens", async () => {
    const cb = new CircuitBreaker("log-test", 2, 1000);
    const failing = vi.fn().mockRejectedValue(new Error("db-down"));

    await expect(cb.call(failing)).rejects.toThrow();
    await expect(cb.call(failing)).rejects.toThrow();

    expect(stderrSpy).toHaveBeenCalled();
    const logged = (stderrSpy.mock.calls[0][0] as string);
    const entry = JSON.parse(logged);
    expect(entry.msg).toContain("circuit breaker 'log-test' opened");
    expect(entry.level).toBe("warn");
  });
});
