/**
 * Initial-condition checks for NATS and JetStream with retries and backoff.
 * Ensures stream exists before agents or bootstrap run.
 */

import { connect, type NatsConnection, type JetStreamManager } from "nats";

export interface WaitForNatsAndStreamOptions {
  natsUrl?: string;
  streamName: string;
  streamSubjects: string[];
  connectTimeoutMs?: number;
  connectRetries?: number;
  retryDelayMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_CONNECT_RETRIES = 5;
const DEFAULT_RETRY_DELAY_MS = 2000;

/**
 * Connect to NATS with timeout and optional retries. Throws after retries exhausted.
 */
export async function connectNats(options?: {
  url?: string;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}): Promise<NatsConnection> {
  const url = options?.url ?? process.env.NATS_URL ?? "nats://localhost:4222";
  const timeoutMs = options?.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const retries = options?.retries ?? 1;
  const retryDelayMs = options?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const nc = await connect({
        servers: url,
        timeout: timeoutMs,
        maxReconnectAttempts: 0,
      });
      return nc;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (attempt < retries) {
        await sleep(retryDelayMs);
      }
    }
  }
  throw new Error(
    `NATS unreachable at ${url} after ${retries} attempt(s): ${lastErr?.message ?? "unknown"}`
  );
}

/**
 * Verify JetStream is enabled on the server. Throws if not available.
 */
export async function ensureJetStreamReady(nc: NatsConnection): Promise<JetStreamManager> {
  try {
    const jsm = await nc.jetstreamManager();
    await jsm.getAccountInfo();
    return jsm;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`JetStream not enabled on server: ${msg}`);
  }
}

/**
 * Idempotent stream creation: create if missing; if add fails (e.g. already exists), re-check info and succeed.
 * When stream already exists, ensures all required subjects are in the stream config (updates if needed).
 */
export async function ensureStreamIdempotent(
  jsm: JetStreamManager,
  streamName: string,
  subjects: string[]
): Promise<void> {
  try {
    const info = await jsm.streams.info(streamName);
    const current = info.config?.subjects ?? [];
    const merged = [...new Set([...current, ...subjects])];
    if (merged.length > current.length) {
      await jsm.streams.update(streamName, { subjects: merged });
    }
    return;
  } catch {
    // stream not found, try to add
  }
  try {
    await jsm.streams.add({ name: streamName, subjects });
    return;
  } catch (addErr) {
    try {
      await jsm.streams.info(streamName);
      return;
    } catch {
      throw new Error(
        `Stream creation failed for ${streamName}: ${addErr instanceof Error ? addErr.message : String(addErr)}`
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for NATS to be reachable, JetStream enabled, and stream to exist (creating it if needed).
 * Closes the connection before returning; callers should use makeEventBus() afterward.
 */
export async function waitForNatsAndStream(
  options: WaitForNatsAndStreamOptions
): Promise<void> {
  const {
    natsUrl = process.env.NATS_URL ?? "nats://localhost:4222",
    streamName,
    streamSubjects,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    connectRetries = DEFAULT_CONNECT_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  } = options;

  const nc = await connectNats({
    url: natsUrl,
    timeoutMs: connectTimeoutMs,
    retries: connectRetries,
    retryDelayMs,
  });

  try {
    const jsm = await ensureJetStreamReady(nc);
    await ensureStreamIdempotent(jsm, streamName, streamSubjects);
  } finally {
    await nc.close();
  }
}
