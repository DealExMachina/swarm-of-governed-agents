import { connect, type NatsConnection, type JetStreamClient, type JetStreamManager, StringCodec, AckPolicy, DeliverPolicy } from "nats";

const sc = StringCodec();

export interface EventBusMessage {
  id: string;
  data: Record<string, string>;
}

export interface EventBus {
  publish(subject: string, data: Record<string, string>): Promise<string>;
  consume(
    stream: string,
    subject: string,
    consumer: string,
    handler: (msg: EventBusMessage) => Promise<void>,
    opts?: { maxMessages?: number; timeoutMs?: number },
  ): Promise<number>;
  ensureStream(stream: string, subjects: string[]): Promise<void>;
  close(): Promise<void>;
}

export async function makeEventBus(natsUrl?: string): Promise<EventBus> {
  const url = natsUrl ?? process.env.NATS_URL ?? "nats://localhost:4222";
  const nc: NatsConnection = await connect({ servers: url });
  const js: JetStreamClient = nc.jetstream();
  const jsm: JetStreamManager = await nc.jetstreamManager();

  return {
    async publish(subject, data) {
      const payload = JSON.stringify(data);
      const pa = await js.publish(subject, sc.encode(payload));
      return `${pa.seq}`;
    },

    async ensureStream(stream, subjects) {
      try {
        await jsm.streams.info(stream);
      } catch {
        await jsm.streams.add({ name: stream, subjects });
      }
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
          const data = JSON.parse(raw) as Record<string, string>;
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

    async close() {
      await nc.drain();
    },
  };
}
