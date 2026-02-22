import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import pg from "pg";
import {
  loadState,
  initState,
  advanceState,
  ensureStateTable,
  _resetStateTableEnsured,
} from "../../src/stateGraph";

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("stateGraph integration", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL! });
    _resetStateTableEnsured();
    await ensureStateTable(pool);
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM swarm_state");
    _resetStateTableEnsured();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("initState creates singleton and loadState retrieves it", async () => {
    const state = await initState("run-1", "ContextIngested", pool);
    expect(state.runId).toBe("run-1");
    expect(state.lastNode).toBe("ContextIngested");
    expect(state.epoch).toBe(0);

    const loaded = await loadState(pool);
    expect(loaded).not.toBeNull();
    expect(loaded!.runId).toBe("run-1");
  });

  it("initState is idempotent (DO NOTHING on conflict)", async () => {
    const first = await initState("run-1", "ContextIngested", pool);
    const second = await initState("run-2", "FactsExtracted", pool);

    expect(second.runId).toBe("run-1");
    expect(second.lastNode).toBe("ContextIngested");
  });

  it("advanceState succeeds with correct epoch", async () => {
    await initState("run-1", "ContextIngested", pool);

    const advanced = await advanceState(0, pool);
    expect(advanced).not.toBeNull();
    expect(advanced!.lastNode).toBe("FactsExtracted");
    expect(advanced!.epoch).toBe(1);
  });

  it("advanceState fails with wrong epoch (CAS)", async () => {
    await initState("run-1", "ContextIngested", pool);

    const result = await advanceState(999, pool);
    expect(result).toBeNull();

    const state = await loadState(pool);
    expect(state!.lastNode).toBe("ContextIngested");
    expect(state!.epoch).toBe(0);
  });

  it("two concurrent advanceState calls: only one wins", async () => {
    await initState("run-1", "ContextIngested", pool);

    const [a, b] = await Promise.all([
      advanceState(0, pool),
      advanceState(0, pool),
    ]);

    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.lastNode).toBe("FactsExtracted");
    expect(winners[0]!.epoch).toBe(1);
  });

  it("full cycle: ContextIngested -> FactsExtracted -> DriftChecked -> ContextIngested", async () => {
    await initState("run-1", "ContextIngested", pool);

    const s1 = await advanceState(0, pool);
    expect(s1!.lastNode).toBe("FactsExtracted");

    const s2 = await advanceState(1, pool);
    expect(s2!.lastNode).toBe("DriftChecked");

    const s3 = await advanceState(2, pool);
    expect(s3!.lastNode).toBe("ContextIngested");
    expect(s3!.epoch).toBe(3);
  });
});
