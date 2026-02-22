import {
  connect,
  createInbox,
  type NatsConnection,
  type JetStreamClient,
  type JetStreamManager,
  StringCodec,
  AckPolicy,
  DeliverPolicy,
  consumerOpts,
} from "nats";
import type { SwarmEvent } from "./events.js";
import { toErrorString } from "./errors.js";

const sc = StringCodec();

export const SWARM_EVENTS_PREFIX = "swarm.events";

export interface EventBusMessage {
  id: string;
  data: Record<string, unknown>;
}

export interface PushSubscription {
  unsubscribe(): Promise<void>;
}

export interface EventBus {
  publish(subject: string, data: Record<string, string>): Promise<string>;
  /** Publish a SwarmEvent envelope to swarm.events.<event.type> */
  publishEvent(event: SwarmEvent): Promise<string>;
  consume(
    stream: string,
    subject: string,
    consumer: string,
    handler: (msg: EventBusMessage) => Promise<void>,
    opts?: { maxMessages?: number; timeoutMs?: number },
  ): Promise<number>;
  /**
   * Push-based durable subscription: handler is invoked for each message as it arrives.
   * No polling. Returns an unsubscribe function.
   */
  subscribe(
    stream: string,
    subject: string,
    consumer: string,
    handler: (msg: EventBusMessage) => Promise<void>,
  ): Promise<PushSubscription>;
  /**
   * Ephemeral push-based subscription — same as subscribe but without a durable consumer.
   * Use for transient clients (SSE) that don't need to resume from where they left off.
   * Avoids consumer accumulation in NATS.
   */
  subscribeEphemeral(
    stream: string,
    subject: string,
    handler: (msg: EventBusMessage) => Promise<void>,
  ): Promise<PushSubscription>;
  ensureStream(stream: string, subjects: string[]): Promise<void>;
  close(): Promise<void>;
}

const CONNECT_TIMEOUT_MS = 10000;

// ── Retry helper for publish ─────────────────────────────────────────────────

async function publishWithRetry(
  js: JetStreamClient,
  subject: string,
  payload: Uint8Array,
  maxRetries = 3,
  backoffMs = 300,
): Promise<number> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const pa = await js.publish(subject, payload);
      return pa.seq;
    } catch (e) {
      if (attempt === maxRetries) throw e;
      await new Promise((r) => setTimeout(r, backoffMs * Math.pow(2, attempt)));
    }
  }
  throw new Error("publishWithRetry: unreachable");
}

// ── Stream retention defaults ────────────────────────────────────────────────

/** 7 days in nanoseconds (NATS uses ns for max_age). */
const DEFAULT_MAX_AGE_NS = 7 * 24 * 60 * 60 * 1e9;
/** 500 MB max stream size. */
const DEFAULT_MAX_BYTES = 500 * 1024 * 1024;

// ── Factory ──────────────────────────────────────────────────────────────────

export async function makeEventBus(natsUrl?: string): Promise<EventBus> {
  const url = natsUrl ?? process.env.NATS_URL ?? "nats://localhost:4222";
  const nc: NatsConnection = await connect({
    servers: url,
    timeout: CONNECT_TIMEOUT_MS,
    maxReconnectAttempts: 10,
  });
  const js: JetStreamClient = nc.jetstream();
  const jsm: JetStreamManager = await nc.jetstreamManager();

  const ensureStreamFn = async (stream: string, subjects: string[]) => {
    try {
      const info = await jsm.streams.info(stream);
      const current = info.config?.subjects ?? [];
      const merged = [...new Set([...current, ...subjects])];
      if (merged.length > current.length) {
        await jsm.streams.update(stream, { subjects: merged });
      }
      return;
    } catch {
      // stream not found, try to add
    }
    try {
      await jsm.streams.add({
        name: stream,
        subjects,
        max_age: DEFAULT_MAX_AGE_NS,
        max_bytes: DEFAULT_MAX_BYTES,
      });
    } catch (addErr) {
      try {
        await jsm.streams.info(stream);
      } catch {
        throw addErr;
      }
    }
  };

  return {
    async publish(subject, data) {
      const payload = sc.encode(JSON.stringify(data));
      const seq = await publishWithRetry(js, subject, payload);
      return `${seq}`;
    },

    async publishEvent(event) {
      const subject = `${SWARM_EVENTS_PREFIX}.${event.type}`;
      const payload = sc.encode(JSON.stringify(event));
      const seq = await publishWithRetry(js, subject, payload);
      return `${seq}`;
    },

    async ensureStream(stream, subjects) {
      await ensureStreamFn(stream, subjects);
    },

    async consume(stream, subject, consumer, handler, opts) {
      const maxMessages = opts?.maxMessages ?? 10;
      const timeoutMs = opts?.timeoutMs ?? 2000;

      try {
        await jsm.consumers.info(stream, consumer);
      } catch {
        await jsm.consumers.add(stream, {
          durable_name: consumer,
          ack_policy: AckPolicy.Explicit,
          deliver_policy: DeliverPolicy.All,
          filter_subject: subject,
          max_ack_pending: 100,
          max_deliver: 5, // Drop poisoned messages after 5 redelivery attempts
        });
      }

      const c = await js.consumers.get(stream, consumer);
      let processed = 0;

      try {
        const messages = await c.fetch({ max_messages: maxMessages, expires: timeoutMs });
        for await (const m of messages) {
          const raw = sc.decode(m.data);
          const data = JSON.parse(raw) as Record<string, unknown>;
          const id = `${m.seq}`;
          try {
            await handler({ id, data });
            m.ack();
            processed++;
          } catch (err) {
            // Explicit NAK: tells NATS to redeliver (up to max_deliver times)
            m.nak();
            process.stderr.write(
              JSON.stringify({
                ts: new Date().toISOString(),
                level: "error",
                msg: "message handler failed, nacking for redelivery",
                consumer,
                message_id: id,
                error: toErrorString(err),
              }) + "\n",
            );
          }
        }
      } catch {
        // timeout or no messages -- not an error
      }

      return processed;
    },

    async subscribe(stream, subject, consumer, handler) {
      await ensureStreamFn(stream, [subject]);
      let closed = false;
      let currentSub: Awaited<ReturnType<typeof js.subscribe>> | null = null;
      const BACKOFF_MS = 1000;
      const BACKOFF_MAX_MS = 30000;

      (async () => {
        let delayMs = BACKOFF_MS;
        while (!closed) {
          try {
            const inbox = createInbox();
            const opts = consumerOpts()
              .durable(consumer)
              .deliverTo(inbox)
              .ackExplicit()
              .deliverNew()
              .filterSubject(subject);
            currentSub = await js.subscribe(subject, opts);
            delayMs = BACKOFF_MS;

            for await (const m of currentSub) {
              if (closed) break;
              const raw = sc.decode(m.data);
              let data: Record<string, unknown>;
              try {
                data = JSON.parse(raw) as Record<string, unknown>;
              } catch {
                data = { raw };
              }
              const id = String(m.seq ?? "");
              try {
                await handler({ id: String(id), data });
              } finally {
                m.ack();
              }
            }
          } catch (err) {
            if (closed) break;
            const msg = toErrorString(err);
            process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "subscribe loop error, reconnecting", error: msg }) + "\n");
            if (currentSub) {
              try { await currentSub.destroy(); } catch {}
              currentSub = null;
            }
            await new Promise((r) => setTimeout(r, delayMs));
            delayMs = Math.min(delayMs * 2, BACKOFF_MAX_MS);
          }
        }
      })();

      return {
        async unsubscribe() {
          closed = true;
          if (currentSub) {
            try { await currentSub.destroy(); } catch {}
          }
        },
      };
    },

    async subscribeEphemeral(stream, subject, handler) {
      await ensureStreamFn(stream, [subject]);
      let closed = false;
      let currentSub: Awaited<ReturnType<typeof js.subscribe>> | null = null;
      const BACKOFF_MS = 1000;
      const BACKOFF_MAX_MS = 30000;

      (async () => {
        let delayMs = BACKOFF_MS;
        while (!closed) {
          try {
            const inbox = createInbox();
            // Ephemeral: no .durable() — consumer is not persisted in NATS
            const opts = consumerOpts()
              .deliverTo(inbox)
              .ackExplicit()
              .deliverNew()
              .filterSubject(subject);
            currentSub = await js.subscribe(subject, opts);
            delayMs = BACKOFF_MS;

            for await (const m of currentSub) {
              if (closed) break;
              const raw = sc.decode(m.data);
              let data: Record<string, unknown>;
              try {
                data = JSON.parse(raw) as Record<string, unknown>;
              } catch {
                data = { raw };
              }
              const id = String(m.seq ?? "");
              try {
                await handler({ id: String(id), data });
              } finally {
                m.ack();
              }
            }
          } catch (err) {
            if (closed) break;
            const msg = toErrorString(err);
            process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "ephemeral subscribe error, reconnecting", error: msg }) + "\n");
            if (currentSub) {
              try { await currentSub.destroy(); } catch {}
              currentSub = null;
            }
            await new Promise((r) => setTimeout(r, delayMs));
            delayMs = Math.min(delayMs * 2, BACKOFF_MAX_MS);
          }
        }
      })();

      return {
        async unsubscribe() {
          closed = true;
          if (currentSub) {
            try { await currentSub.destroy(); } catch {}
          }
        },
      };
    },

    async close() {
      await nc.drain();
    },
  };
}
