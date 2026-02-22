import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "stream";
import type { S3Client } from "@aws-sdk/client-s3";
import { HeadObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import * as contextWal from "../../../src/contextWal";
import { runStatusAgent } from "../../../src/agents/statusAgent";

vi.mock("../../../src/contextWal", () => ({
  appendEvent: vi.fn(async (data: Record<string, unknown>) => 1),
}));

function createMockS3(responses: { [key: string]: string }): S3Client {
  return {
    send: vi.fn(async (cmd: any) => {
      if (cmd instanceof HeadObjectCommand) {
        const key = (cmd as any).input?.Key;
        if (key && responses[key] !== undefined) return {};
        throw new Error("NotFound");
      }
      if (cmd instanceof GetObjectCommand) {
        const key = (cmd as any).input?.Key;
        const body = key ? responses[key] : undefined;
        if (body != null) return { Body: Readable.from([Buffer.from(body, "utf-8")]) };
        throw new Error("NotFound");
      }
      return {};
    }),
  } as unknown as S3Client;
}

describe("statusAgent", () => {
  beforeEach(() => {
    vi.mocked(contextWal.appendEvent).mockClear();
  });

  it("reads facts and drift from S3, appends status card to WAL, returns card", async () => {
    const facts = { confidence: 0.9, goals: ["g1"] };
    const drift = { level: "low", types: [] as string[], notes: [] as string[] };
    const s3 = createMockS3({
      "facts/latest.json": JSON.stringify(facts),
      "drift/latest.json": JSON.stringify(drift),
    });

    const result = await runStatusAgent(s3, "bucket", {});

    expect(result).toMatchObject({
      type: "status_card",
      drift_level: "low",
      confidence: 0.9,
      goals: ["g1"],
    });
    expect(contextWal.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "status_card" }));
  });

  it("handles missing facts and drift (unknown level)", async () => {
    const s3 = createMockS3({});

    const result = await runStatusAgent(s3, "bucket", {});

    expect(result).toMatchObject({ type: "status_card", drift_level: "unknown" });
    expect(contextWal.appendEvent).toHaveBeenCalled();
  });
});
