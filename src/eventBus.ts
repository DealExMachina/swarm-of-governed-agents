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
   * Push-based subscription: handler is invoked for each message as it arrives.
   * No polling. Returns an unsubscribe function.
   */
  subscribe(
    stream: string,
    subject: string,
    consumer: string,
    handler: (msg: EventBusMessage) => Promise<void>,
  ): Promise<PushSubscription>;
  ensureStream(stream: string, subjects: string[]): Promise<void>;
  close(): Promise<void>;
}

const CONNECT_TIMEOUT_MS = 10000;

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
      await jsm.streams.info(stream);
      return;
    } catch {
      // stream not found, try to add
    }
    try {
      await jsm.streams.add({ name: stream, subjects });
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
      const payload = JSON.stringify(data);
      const pa = await js.publish(subject, sc.encode(payload));
      return `${pa.seq}`;
    },

    async publishEvent(event) {
      const subject = `${SWARM_EVENTS_PREFIX}.${event.type}`;
      const pa = await js.publish(subject, sc.encode(JSON.stringify(event)));
      return `${pa.seq}`;
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
          await handler({ id, data });
          m.ack();
          processed++;
        }
      } catch {
        // timeout or no messages -- not an error
      }

      return processed;
    },

    async subscribe(stream, subject, consumer, handler) {
      await ensureStreamFn(stream, [subject]);
      const inbox = createInbox();
      const opts = consumerOpts()
        .durable(consumer)
        .deliverTo(inbox)
        .ackExplicit()
        .deliverNew()
        .filterSubject(subject);

      const sub = await js.subscribe(subject, opts);
      let closed = false;

      (async () => {
        try {
          for await (const m of sub) {
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
          if (!closed) {
            const msg = toErrorString(err);
            process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "subscribe loop error", error: msg }) + "\n");
            process.exit(1);
          }
        }
      })();

      return {
        async unsubscribe() {
          closed = true;
          await sub.destroy();
        },
      };
    },

    async close() {
      await nc.drain();
    },
  };
}
