import { describe, it, expect } from "vitest";
import { readdirSync } from "fs";
import { join } from "path";
import {
  CLAIMS,
  GOALS,
  RISKS,
  CONTRADICTION_EDGES,
  RESOLUTION_EDGES,
  EXPECTED_NODE_COUNT,
  EXPECTED_EDGE_COUNT,
  HITL_CREATED_BY,
  HITL_SCOPE_ID,
} from "../../src/seed-data/hitl-scenario.js";
import { createSwarmEvent, isSwarmEvent } from "../../src/events.js";

const SEED_DOCS_DIR = join(process.cwd(), "seed-docs");

describe("seed fixture: hitl-scenario-data", () => {
  it("exports expected claim count and content shape", () => {
    expect(CLAIMS).toHaveLength(5);
    CLAIMS.forEach((c) => {
      expect(typeof c).toBe("string");
      expect(c.length).toBeGreaterThan(0);
    });
  });

  it("exports expected goal count and content/status shape", () => {
    expect(GOALS).toHaveLength(5);
    GOALS.forEach((g) => {
      expect(typeof g.content).toBe("string");
      expect(["active", "resolved"]).toContain(g.status);
    });
  });

  it("exports expected risk count and content shape", () => {
    expect(RISKS).toHaveLength(2);
    RISKS.forEach((r) => expect(typeof r).toBe("string"));
  });

  it("defines contradiction edges with valid claim indices", () => {
    expect(CONTRADICTION_EDGES).toHaveLength(2);
    CONTRADICTION_EDGES.forEach((e) => {
      expect(e.sourceIndex).toBeGreaterThanOrEqual(0);
      expect(e.sourceIndex).toBeLessThan(CLAIMS.length);
      expect(e.targetIndex).toBeGreaterThanOrEqual(0);
      expect(e.targetIndex).toBeLessThan(CLAIMS.length);
      expect(typeof e.raw).toBe("string");
    });
  });

  it("defines resolution edges with valid claim indices", () => {
    expect(RESOLUTION_EDGES).toHaveLength(1);
    RESOLUTION_EDGES.forEach((e) => {
      expect(e.sourceIndex).toBeGreaterThanOrEqual(0);
      expect(e.sourceIndex).toBeLessThan(CLAIMS.length);
      expect(e.targetIndex).toBeGreaterThanOrEqual(0);
      expect(e.targetIndex).toBeLessThan(CLAIMS.length);
      expect(typeof e.note).toBe("string");
    });
  });

  it("expected node and edge counts match fixture arrays", () => {
    expect(EXPECTED_NODE_COUNT).toBe(CLAIMS.length + GOALS.length + RISKS.length);
    expect(EXPECTED_EDGE_COUNT).toBe(CONTRADICTION_EDGES.length + RESOLUTION_EDGES.length);
  });

  it("exports scope and created_by constants", () => {
    expect(HITL_SCOPE_ID).toBe("default");
    expect(HITL_CREATED_BY).toBe("seed-hitl-scenario");
  });
});

describe("seed-docs directory", () => {
  it("contains at least one .txt or .md file (excluding README)", () => {
    const files = readdirSync(SEED_DOCS_DIR)
      .filter((f) => (f.endsWith(".txt") || f.endsWith(".md")) && f !== "README.md")
      .sort();
    expect(files.length).toBeGreaterThanOrEqual(1);
  });
});

describe("context_doc event shape (seed:all)", () => {
  it("createSwarmEvent context_doc yields valid SwarmEvent with payload.text, title, filename", () => {
    const payload = {
      text: "Sample seed doc content.",
      title: "01-announcement.txt",
      filename: "01-announcement.txt",
      source: "seed-docs",
    };
    const event = createSwarmEvent("context_doc", payload, { source: "seed-all" });
    expect(isSwarmEvent(event)).toBe(true);
    expect(event.type).toBe("context_doc");
    expect(event.payload).toEqual(payload);
    expect(typeof (event.payload as { text: string }).text).toBe("string");
    expect((event.payload as { title: string }).title).toBe("01-announcement.txt");
    expect((event.payload as { filename: string }).filename).toBe("01-announcement.txt");
  });
});
