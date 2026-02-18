import { describe, it, expect, vi } from "vitest";

const mockMessages = [
  { seq: 1, data: new TextEncoder().encode(JSON.stringify({ type: "test", n: "1" })), ack: vi.fn() },
];

vi.mock("nats", () => {
  const StringCodec = () => ({
    encode: (s: string) => new TextEncoder().encode(s),
    decode: (b: Uint8Array) => new TextDecoder().decode(b),
  });

  const mockConsumer = {
    fetch: vi.fn(async () => mockMessages),
  };

  const mockJs = {
    publish: vi.fn(async () => ({ seq: 42 })),
    consumers: { get: vi.fn(async () => mockConsumer) },
  };

  const mockJsm = {
    streams: {
      info: vi.fn(async () => ({})),
      add: vi.fn(async () => ({})),
    },
    consumers: {
      info: vi.fn(async () => ({})),
      add: vi.fn(async () => ({})),
    },
  };

  const mockNc = {
    jetstream: () => mockJs,
    jetstreamManager: async () => mockJsm,
    drain: vi.fn(async () => {}),
  };

  return {
    connect: vi.fn(async () => mockNc),
    StringCodec,
    AckPolicy: { Explicit: "explicit" },
    DeliverPolicy: { All: "all" },
  };
});

import { makeEventBus, type EventBusMessage } from "../../src/eventBus";

describe("eventBus (NATS mocked)", () => {
  it("publish returns a sequence id", async () => {
    const bus = await makeEventBus("nats://mock");
    const id = await bus.publish("jobs.extract_facts", { type: "extract_facts" });
    expect(id).toBe("42");
    await bus.close();
  });

  it("consume processes messages and calls handler", async () => {
    const bus = await makeEventBus("nats://mock");
    await bus.ensureStream("JOBS", ["jobs.>"]);

    const received: EventBusMessage[] = [];
    const count = await bus.consume("JOBS", "jobs.>", "c1", async (msg) => {
      received.push(msg);
    });

    expect(count).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0].data).toEqual({ type: "test", n: "1" });
    expect(mockMessages[0].ack).toHaveBeenCalled();
    await bus.close();
  });

  it("ensureStream does not throw when stream exists", async () => {
    const bus = await makeEventBus("nats://mock");
    await expect(bus.ensureStream("JOBS", ["jobs.>"])).resolves.not.toThrow();
    await bus.close();
  });
});
