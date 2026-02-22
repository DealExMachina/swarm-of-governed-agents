/**
 * Resilience utilities: retry with exponential backoff and circuit breaker.
 *
 * withRetry   — retries transient PG / network errors with exponential backoff.
 * CircuitBreaker — opens after N consecutive failures; prevents cascading load.
 */

import { toErrorString } from "./errors.js";

// ── Retry ────────────────────────────────────────────────────────────────────

/** PG error codes that indicate a transient connection issue (safe to retry). */
const PG_RETRYABLE_CODES = new Set([
  "57P01", // admin_shutdown
  "57P03", // cannot_connect_now
  "08006", // connection_failure
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "08003", // connection_does_not_exist
  "40001", // serialization_failure (retry-safe in PG)
]);

export interface RetryOptions {
  maxRetries?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
  /** Custom predicate — return true if the error is retryable. Defaults to isPgRetryable. */
  retryableCheck?: (err: unknown) => boolean;
}

/**
 * Execute `fn` with retries on transient errors.
 * Default: 3 retries, 200ms initial backoff (doubles each time), 5s cap.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const backoffMs = opts.backoffMs ?? 200;
  const maxBackoffMs = opts.maxBackoffMs ?? 5000;
  const isRetryable = opts.retryableCheck ?? isPgRetryable;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt === maxRetries || !isRetryable(e)) throw e;
      const delay = Math.min(backoffMs * Math.pow(2, attempt), maxBackoffMs);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("withRetry: unreachable");
}

/** Returns true for PG connection / serialization errors and common network errors. */
export function isPgRetryable(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  if (typeof code === "string" && PG_RETRYABLE_CODES.has(code)) return true;
  const msg = (e as { message?: string })?.message;
  if (typeof msg === "string") {
    if (msg.includes("ECONNRESET")) return true;
    if (msg.includes("ECONNREFUSED")) return true;
    if (msg.includes("connection terminated")) return true;
    if (msg.includes("Connection terminated unexpectedly")) return true;
  }
  return false;
}

// ── Circuit Breaker ──────────────────────────────────────────────────────────

/**
 * Circuit breaker: opens after `threshold` consecutive failures.
 * While open, calls fail fast without invoking the underlying function.
 * After `cooldownMs`, the circuit half-opens (allows one attempt).
 *
 * States: CLOSED (normal) → OPEN (fail fast) → HALF_OPEN (probe) → CLOSED
 */
export class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;

  constructor(
    private readonly name: string,
    private readonly threshold: number = 3,
    private readonly cooldownMs: number = 60000,
  ) {}

  async call<T>(fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    if (this.failures >= this.threshold && now < this.openUntil) {
      throw new Error(`Circuit breaker '${this.name}' is open (${this.failures} failures, cooldown until ${new Date(this.openUntil).toISOString()})`);
    }
    // Half-open: reset failures on cooldown expiry to allow one probe
    if (now >= this.openUntil && this.failures >= this.threshold) {
      this.failures = 0;
    }
    try {
      const result = await fn();
      this.failures = 0;
      return result;
    } catch (e) {
      this.failures++;
      if (this.failures >= this.threshold) {
        this.openUntil = Date.now() + this.cooldownMs;
        process.stderr.write(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: "warn",
            msg: `circuit breaker '${this.name}' opened`,
            failures: this.failures,
            cooldownMs: this.cooldownMs,
            error: toErrorString(e),
          }) + "\n",
        );
      }
      throw e;
    }
  }

  /** Current state for monitoring. */
  get state(): "closed" | "open" | "half_open" {
    if (this.failures < this.threshold) return "closed";
    if (Date.now() < this.openUntil) return "open";
    return "half_open";
  }

  /** Reset for testing. */
  reset(): void {
    this.failures = 0;
    this.openUntil = 0;
  }
}
