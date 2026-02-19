import { describe, it, expect, vi } from "vitest";
import { Readable } from "stream";
import type { S3Client } from "@aws-sdk/client-s3";
import { HeadObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { runDriftAgent } from "../../../src/agents/driftAgent";

function createMockS3(driftLatest: string | null, putCapture: { key: string; body: string }[]) {
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
      if (cmd instanceof PutObjectCommand) {
        const input = (cmd as any).input;
        putCapture.push({ key: input.Key, body: input.Body });
        return {};
      }
      return {};
    }),
  } as unknown as S3Client;
}

describe("driftAgent", () => {
  it("reads drift from S3, writes history snapshot, returns wrote and level", async () => {
    const drift = { level: "medium", types: ["factual"], notes: ["n1"] };
    const putCapture: { key: string; body: string }[] = [];
    const s3 = createMockS3(JSON.stringify(drift), putCapture);
    const bucket = "test-bucket";

    const result = await runDriftAgent(s3, bucket, {});

    expect(putCapture).toHaveLength(1);
    expect(putCapture[0].key).toMatch(/^drift\/history\/.+/);
    expect(JSON.parse(putCapture[0].body)).toEqual(drift);
    expect(result).toMatchObject({ level: "medium", types: ["factual"] });
    expect((result as any).wrote).toHaveLength(1);
  });

  it("handles missing drift (none yet)", async () => {
    const putCapture: { key: string; body: string }[] = [];
    const s3 = createMockS3(null, putCapture);

    const result = await runDriftAgent(s3, "b", {});

    expect(result).toMatchObject({ level: "none", types: [] });
    expect(putCapture).toHaveLength(1);
  });
});
