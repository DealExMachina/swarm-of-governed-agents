import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkPermission } from "../../src/policy";

describe("policy", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = originalFetch;
  });

  it("returns allowed when OPENFGA_STORE_ID is not set (default allow)", async () => {
    vi.stubEnv("OPENFGA_STORE_ID", "");
    const result = await checkPermission("facts-1", "writer", "FactsExtracted");
    expect(result.allowed).toBe(true);
  });

  it("returns allowed when OpenFGA check returns true", async () => {
    vi.stubEnv("OPENFGA_STORE_ID", "store-1");
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ allowed: true }),
    })) as any;
    const result = await checkPermission("facts-1", "writer", "node:FactsExtracted");
    expect(result.allowed).toBe(true);
  });

  it("returns not allowed when OpenFGA check returns false", async () => {
    vi.stubEnv("OPENFGA_STORE_ID", "store-1");
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ allowed: false }),
    })) as any;
    const result = await checkPermission("facts-1", "writer", "FactsExtracted");
    expect(result.allowed).toBe(false);
  });

  it("returns not allowed on fetch error when OPENFGA_ALLOW_IF_UNAVAILABLE is not set", async () => {
    vi.stubEnv("OPENFGA_STORE_ID", "store-1");
    vi.stubEnv("OPENFGA_ALLOW_IF_UNAVAILABLE", "0");
    global.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as any;
    const result = await checkPermission("agent:facts-1", "writer", "node:FactsExtracted");
    expect(result.allowed).toBe(false);
    expect(result.error).toBeDefined();
  });
});
