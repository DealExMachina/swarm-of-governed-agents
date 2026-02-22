import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "path";
import {
  nextState,
  transitions,
  advanceState,
  loadState,
  initState,
  _resetStateTableEnsured,
  type GraphState,
  type Node,
} from "../../src/stateGraph";
import { loadPolicies } from "../../src/governance";

const baseState: GraphState = {
  runId: "test-run",
  lastNode: "ContextIngested",
  updatedAt: "2025-01-01T00:00:00.000Z",
  epoch: 0,
};

describe("stateGraph (pure)", () => {
  it("transitions ContextIngested -> FactsExtracted", () => {
    expect(transitions.ContextIngested).toBe("FactsExtracted");
    const next = nextState(baseState);
    expect(next.lastNode).toBe("FactsExtracted");
    expect(next.runId).toBe(baseState.runId);
    expect(next.epoch).toBe(1);
  });

  it("transitions FactsExtracted -> DriftChecked", () => {
    const state: GraphState = { ...baseState, lastNode: "FactsExtracted" };
    const next = nextState(state);
    expect(next.lastNode).toBe("DriftChecked");
  });

  it("transitions DriftChecked -> ContextIngested", () => {
    const state: GraphState = { ...baseState, lastNode: "DriftChecked" };
    const next = nextState(state);
    expect(next.lastNode).toBe("ContextIngested");
  });

  it("cycles through all nodes", () => {
    const nodes: Node[] = ["ContextIngested", "FactsExtracted", "DriftChecked"];
    let s: GraphState = { ...baseState, lastNode: nodes[0] };
    for (let i = 0; i < 3; i++) {
      expect(s.lastNode).toBe(nodes[i]);
      s = nextState(s);
    }
    expect(s.lastNode).toBe("ContextIngested");
  });

  it("preserves runId, increments epoch, updates updatedAt", () => {
    const next = nextState(baseState);
    expect(next.runId).toBe(baseState.runId);
    expect(next.epoch).toBe(baseState.epoch + 1);
    expect(next.updatedAt).not.toBe(baseState.updatedAt);
  });
});

describe("stateGraph (Postgres-backed)", () => {
  function mockPool(overrides?: (text: string, values?: any[]) => any) {
    const calls: Array<{ text: string; values: any[] }> = [];
    const pool = {
      query: vi.fn(async (text: string, values?: any[]) => {
        calls.push({ text, values: values ?? [] });
        if (overrides) {
          const result = overrides(text, values);
          if (result !== undefined) return result;
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    return { pool: pool as any, calls };
  }

  beforeEach(() => _resetStateTableEnsured());

  describe("loadState", () => {
    it("returns null when no state row exists", async () => {
      const { pool } = mockPool();
      const state = await loadState("default", pool);
      expect(state).toBeNull();
    });

    it("returns the state when a row exists", async () => {
      const { pool } = mockPool((text) => {
        if (text.includes("SELECT")) {
          return {
            rowCount: 1,
            rows: [{ run_id: "r1", last_node: "FactsExtracted", epoch: "5", updated_at: new Date("2025-06-01") }],
          };
        }
      });
      const state = await loadState("default", pool);
      expect(state).toEqual({
        runId: "r1",
        lastNode: "FactsExtracted",
        epoch: 5,
        updatedAt: expect.any(String),
      });
    });
  });

  describe("advanceState", () => {
    it("returns null when epoch does not match (CAS failure)", async () => {
      const { pool } = mockPool((text) => {
        if (text.includes("SELECT")) {
          return {
            rowCount: 1,
            rows: [{ run_id: "r1", last_node: "ContextIngested", epoch: "3", updated_at: new Date() }],
          };
        }
        if (text.includes("UPDATE")) {
          return { rowCount: 0, rows: [] };
        }
      });

      const result = await advanceState(999, undefined, pool);
      expect(result).toBeNull();
    });

    it("advances state when epoch matches and emits transition event", async () => {
      const { pool, calls } = mockPool((text) => {
        if (text.includes("SELECT")) {
          return {
            rowCount: 1,
            rows: [{ run_id: "r1", last_node: "ContextIngested", epoch: "3", updated_at: new Date() }],
          };
        }
        if (text.includes("UPDATE")) {
          return {
            rowCount: 1,
            rows: [{ run_id: "r1", last_node: "FactsExtracted", epoch: "4", updated_at: new Date() }],
          };
        }
        if (text.includes("INSERT INTO context_events")) {
          return { rows: [{ seq: "1" }] };
        }
      });

      const result = await advanceState(3, undefined, pool);
      expect(result).not.toBeNull();
      expect(result!.lastNode).toBe("FactsExtracted");
      expect(result!.epoch).toBe(4);

      const update = calls.find((c) => c.text.includes("UPDATE"));
      expect(update).toBeDefined();
      expect(update!.text).toContain("WHERE scope_id = $3 AND epoch = $4");
      expect(update!.values).toEqual(["FactsExtracted", 4, "default", 3]);

      const eventInsert = calls.find((c) => c.text.includes("INSERT INTO context_events"));
      expect(eventInsert).toBeDefined();
      const eventData = JSON.parse(eventInsert!.values[0]);
      expect(eventData.type).toBe("state_transition");
      expect(eventData.payload).toBeDefined();
      expect(eventData.payload.from).toBe("ContextIngested");
      expect(eventData.payload.to).toBe("FactsExtracted");
      expect(eventData.payload.epoch).toBe(4);
    });
  });

  describe("initState", () => {
    it("creates initial state with ContextIngested", async () => {
      const { pool, calls } = mockPool((text) => {
        if (text.includes("INSERT")) {
          return {
            rowCount: 1,
            rows: [{ run_id: "r-new", last_node: "ContextIngested", epoch: "0", updated_at: new Date() }],
          };
        }
      });

      const state = await initState("default", "r-new", "ContextIngested", pool);
      expect(state.runId).toBe("r-new");
      expect(state.lastNode).toBe("ContextIngested");
      expect(state.epoch).toBe(0);

      const insert = calls.find((c) => c.text.includes("INSERT INTO swarm_state"));
      expect(insert).toBeDefined();
      expect(insert!.text).toContain("ON CONFLICT (scope_id) DO NOTHING");
    });
  });

  describe("advanceState with governance", () => {
    it("returns null and does not UPDATE when canTransition blocks (high drift)", async () => {
      const govPath = join(process.cwd(), "governance.yaml");
      const governance = loadPolicies(govPath);
      const drift = { level: "critical", types: [] as string[] };

      const { pool, calls } = mockPool((text) => {
        if (text.includes("SELECT") && text.includes("swarm_state")) {
          return {
            rowCount: 1,
            rows: [{ run_id: "r1", last_node: "DriftChecked", epoch: "5", updated_at: new Date() }],
          };
        }
        return { rows: [], rowCount: 0 };
      });

      const result = await advanceState(5, { scopeId: "default", drift, governance }, pool);
      expect(result).toBeNull();

      const updateCalls = calls.filter((c) => c.text.includes("UPDATE") && c.text.includes("swarm_state"));
      expect(updateCalls).toHaveLength(0);
    });
  });
});
