import { describe, it, expect, vi } from "vitest";

const mockMessages = [
  { seq: 1, data: new TextEncoder().encode(JSON.stringify({ type: "test", n: "1" })), ack: vi.fn() },
];

const mockFetchFn = vi.fn(async function* () {
  for (const m of mockMessages) yield m;
});

vi.mock("nats", () => {
  const StringCodec = () => ({
    encode: (s: string) => new TextEncoder().encode(s),
    decode: (b: Uint8Array) => new TextDecoder().decode(b),
  });

  const mockConsumer = {
    fetch: vi.fn(async () => mockFetchFn()),
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

import { makeEventBus, type EventBusMessage, SWARM_EVENTS_PREFIX } from "../../src/eventBus";
import { createSwarmEvent } from "../../src/events";

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

  it("publishEvent returns sequence id", async () => {
    const event = createSwarmEvent("state_transition", { from: "A", to: "B" }, { source: "state_graph" });
    const bus = await makeEventBus("nats://mock");
    const id = await bus.publishEvent(event);
    expect(id).toBe("42");
    await bus.close();
  });

  it("publishEvent uses swarm.events.<type> subject", async () => {
    const event = createSwarmEvent("test_type", {});
    const bus = await makeEventBus("nats://mock");
    await bus.publishEvent(event);
    const nats = await import("nats");
    const connectMock = nats.connect as ReturnType<typeof vi.fn>;
    const nc = await connectMock.mock.results[connectMock.mock.results.length - 1]?.value;
    const js = nc?.jetstream();
    const publishCalls = (js?.publish as ReturnType<typeof vi.fn>)?.mock?.calls ?? [];
    expect(publishCalls.some((c: [string]) => c[0] === `${SWARM_EVENTS_PREFIX}.test_type`)).toBe(true);
    await bus.close();
  });

  it("ensureStream does not throw when stream exists", async () => {
    const bus = await makeEventBus("nats://mock");
    await expect(bus.ensureStream("JOBS", ["jobs.>"])).resolves.not.toThrow();
    await bus.close();
  });

  it("consume returns 0 when no messages (empty stream)", async () => {
    const emptyAsyncIter = async function* () {};
    mockFetchFn.mockImplementationOnce(async () => emptyAsyncIter());
    const bus = await makeEventBus("nats://mock");
    const count = await bus.consume("JOBS", "jobs.>", "c-empty", async () => {});
    expect(count).toBe(0);
    await bus.close();
  });

  it("close() resolves and drains connection", async () => {
    const drainFn = vi.fn(async () => {});
    const mockNc = {
      jetstream: () => ({ publish: vi.fn(), consumers: { get: vi.fn(async () => ({ fetch: vi.fn(async () => mockFetchFn()) })) } }),
      jetstreamManager: async () => ({ streams: { info: vi.fn(), add: vi.fn() }, consumers: { info: vi.fn(), add: vi.fn() } }),
      drain: drainFn,
    };
    const nats = await import("nats");
    (nats.connect as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockNc);
    const bus = await makeEventBus("nats://mock");
    await bus.close();
    expect(drainFn).toHaveBeenCalled();
  });
});
