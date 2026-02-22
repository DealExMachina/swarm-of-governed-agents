import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import pg from "pg";
import {
  appendEvent,
  tailEvents,
  eventsSince,
  ensureContextTable,
  _resetTableEnsured,
} from "../../src/contextWal";

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("contextWal integration", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL! });
    _resetTableEnsured();
    await ensureContextTable(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE context_events RESTART IDENTITY");
    _resetTableEnsured();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("appends and retrieves a single event", async () => {
    const seq = await appendEvent({ type: "hello", n: 1 }, pool);
    expect(seq).toBe(1);

    const events = await tailEvents(10, pool);
    expect(events).toHaveLength(1);
    expect(events[0].seq).toBe(1);
    expect(events[0].data).toEqual({ type: "hello", n: 1 });
    expect(events[0].ts).toBeDefined();
  });

  it("concurrent appends never lose data", async () => {
    const N = 50;
    const promises = Array.from({ length: N }, (_, i) =>
      appendEvent({ index: i, type: "concurrent" }, pool),
    );
    const seqs = await Promise.all(promises);

    expect(new Set(seqs).size).toBe(N);

    const events = await tailEvents(N + 10, pool);
    expect(events).toHaveLength(N);
  });

  it("tailEvents returns the last N events in ascending order", async () => {
    for (let i = 1; i <= 5; i++) {
      await appendEvent({ i }, pool);
    }

    const events = await tailEvents(3, pool);
    expect(events).toHaveLength(3);
    expect(events[0].data).toEqual({ i: 3 });
    expect(events[1].data).toEqual({ i: 4 });
    expect(events[2].data).toEqual({ i: 5 });
  });

  it("eventsSince returns events after cursor", async () => {
    for (let i = 1; i <= 5; i++) {
      await appendEvent({ i }, pool);
    }

    const events = await eventsSince(3, 100, pool);
    expect(events).toHaveLength(2);
    expect(events[0].data).toEqual({ i: 4 });
    expect(events[1].data).toEqual({ i: 5 });
  });

  it("eventsSince with cursor 0 returns all events", async () => {
    await appendEvent({ a: 1 }, pool);
    await appendEvent({ b: 2 }, pool);

    const events = await eventsSince(0, 100, pool);
    expect(events).toHaveLength(2);
    expect(events[0].data).toEqual({ a: 1 });
    expect(events[1].data).toEqual({ b: 2 });
  });
});
