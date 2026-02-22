import { describe, it, expect, vi } from "vitest";
import { Readable } from "stream";
import type { S3Client } from "@aws-sdk/client-s3";
import { HeadObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { runPlannerAgent } from "../../../src/agents/plannerAgent";

function createMockS3(driftLatest: string | null): S3Client {
  return {
    send: vi.fn(async (cmd: any) => {
      if (cmd instanceof HeadObjectCommand) {
        const key = (cmd as any).input?.Key;
        if (key === "drift/latest.json" && driftLatest !== null) return {};
        throw new Error("NotFound");
      }
      if (cmd instanceof GetObjectCommand) {
        const key = (cmd as any).input?.Key;
        if (key === "drift/latest.json" && driftLatest !== null)
          return { Body: Readable.from([Buffer.from(driftLatest, "utf-8")]) };
        throw new Error("NotFound");
      }
      return {};
    }),
  } as unknown as S3Client;
}

describe("plannerAgent", () => {
  it("returns drift and evaluated actions from governance rules", async () => {
    const drift = { level: "high", types: ["contradiction"], notes: [] };
    const s3 = createMockS3(JSON.stringify(drift));

    const result = await runPlannerAgent(s3, "bucket", {});

    expect(result).toMatchObject({ drift: { level: "high", types: ["contradiction"] } });
    expect(Array.isArray((result as any).actions)).toBe(true);
    expect((result as any).actions).toContain("open_investigation");
  });

  it("returns empty actions when drift is none", async () => {
    const drift = { level: "none", types: [] };
    const s3 = createMockS3(JSON.stringify(drift));

    const result = await runPlannerAgent(s3, "bucket", {});

    expect(result).toMatchObject({ drift: { level: "none", types: [] } });
    expect((result as any).actions).toEqual([]);
  });

  it("handles missing drift file", async () => {
    const s3 = createMockS3(null);

    const result = await runPlannerAgent(s3, "bucket", {});

    expect(result).toMatchObject({ drift: { level: "none", types: [] } });
    expect((result as any).actions).toEqual([]);
  });
});
