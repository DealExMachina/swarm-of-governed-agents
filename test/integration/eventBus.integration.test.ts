import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { connect, type NatsConnection, type JetStreamManager } from "nats";
import { makeEventBus, type EventBusMessage } from "../../src/eventBus";

const NATS_URL = process.env.NATS_URL;
const STREAM = "TEST_JOBS";
const SUBJECT = "test.jobs.>";

describe.skipIf(!NATS_URL)("eventBus NATS integration", () => {
  let nc: NatsConnection;
  let jsm: JetStreamManager;

  beforeAll(async () => {
    nc = await connect({ servers: NATS_URL! });
    jsm = await nc.jetstreamManager();
  });

  beforeEach(async () => {
    try {
      await jsm.streams.delete(STREAM);
    } catch {
      // stream may not exist
    }
  });

  afterAll(async () => {
    try {
      await jsm.streams.delete(STREAM);
    } catch {}
    await nc.drain();
  });

  it("publish and consume a single message", async () => {
    const bus = await makeEventBus(NATS_URL!);
    await bus.ensureStream(STREAM, ["test.jobs.>"]);

    const pubId = await bus.publish("test.jobs.extract", { type: "extract_facts", payload: '{"reason":"test"}' });
    expect(pubId).toBeDefined();

    const received: EventBusMessage[] = [];
    const count = await bus.consume(STREAM, "test.jobs.>", "c1", async (msg) => {
      received.push(msg);
    }, { timeoutMs: 2000, maxMessages: 10 });

    expect(count).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0].data.type).toBe("extract_facts");

    await bus.close();
  });

  it("two consumers on the same durable get distinct messages", async () => {
    const publisher = await makeEventBus(NATS_URL!);
    await publisher.ensureStream(STREAM, ["test.jobs.>"]);

    const N = 10;
    for (let i = 0; i < N; i++) {
      await publisher.publish("test.jobs.work", { index: String(i) });
    }

    const bus1 = await makeEventBus(NATS_URL!);
    const bus2 = await makeEventBus(NATS_URL!);

    const c1Messages: EventBusMessage[] = [];
    const c2Messages: EventBusMessage[] = [];

    const n1 = await bus1.consume(STREAM, "test.jobs.>", "shared-consumer", async (msg) => {
      c1Messages.push(msg);
    }, { timeoutMs: 2000, maxMessages: N });

    const n2 = await bus2.consume(STREAM, "test.jobs.>", "shared-consumer", async (msg) => {
      c2Messages.push(msg);
    }, { timeoutMs: 1000, maxMessages: N });

    expect(n1 + n2).toBe(N);

    await publisher.close();
    await bus1.close();
    await bus2.close();
  });
});
