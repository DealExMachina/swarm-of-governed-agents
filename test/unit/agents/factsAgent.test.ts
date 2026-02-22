import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "stream";
import type { S3Client } from "@aws-sdk/client-s3";
import { HeadObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { runFactsAgent, createFactsMastraAgent, runFactsPipelineDirect } from "../../../src/agents/factsAgent";

vi.mock("../../../src/contextWal", () => ({
  tailEvents: vi.fn(async () => [{ data: { type: "seed", text: "hello" } }]),
}));

function createMockS3(
  getResponses: { [key: string]: string },
  putCapture: { key: string; data: unknown }[],
): S3Client {
  return {
    send: vi.fn(async (cmd: any) => {
      if (cmd instanceof HeadObjectCommand) {
        const key = (cmd as any).input?.Key;
        if (key && getResponses[key] !== undefined) return {};
        throw new Error("NotFound");
      }
      if (cmd instanceof GetObjectCommand) {
        const key = (cmd as any).input?.Key;
        const body = key ? getResponses[key] : undefined;
        if (body != null) return { Body: Readable.from([Buffer.from(body, "utf-8")]) };
        throw new Error("NotFound");
      }
      if (cmd instanceof PutObjectCommand) {
        const input = (cmd as any).input;
        putCapture.push({ key: input.Key, data: JSON.parse(input.Body) });
        return {};
      }
      return {};
    }),
  } as unknown as S3Client;
}

describe("factsAgent", () => {
  beforeEach(() => {
    global.fetch = vi.fn(async (_url: string, opts: any) => {
      const body = JSON.parse(opts?.body ?? "{}");
      expect(body.context).toBeDefined();
      return {
        ok: true,
        json: async () => ({
          facts: { version: 2, entities: [], hash: "h1" },
          drift: { level: "none", types: [] },
        }),
      } as Response;
    });
  });

  it("reads context from WAL, previous facts from S3, calls worker, writes facts and drift", async () => {
    const putCapture: { key: string; data: unknown }[] = [];
    const s3 = createMockS3({ "facts/latest.json": JSON.stringify({ version: 1 }) }, putCapture);

    const result = await runFactsAgent(s3, "bucket", {});

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/extract"),
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(putCapture.some((p) => p.key === "facts/latest.json")).toBe(true);
    expect(putCapture.some((p) => p.key === "drift/latest.json")).toBe(true);
    expect(putCapture.some((p) => p.key.startsWith("facts/history/"))).toBe(true);
    expect(result).toMatchObject({ facts_hash: "h1" });
    expect((result as any).wrote).toHaveLength(3);
  });

  it("handles no previous facts", async () => {
    const putCapture: { key: string; data: unknown }[] = [];
    const s3 = createMockS3({}, putCapture);

    const result = await runFactsAgent(s3, "bucket", {});

    expect(putCapture).toHaveLength(3);
    expect(result).toBeDefined();
  });

  it("runFactsPipelineDirect runs readContext, extractFacts, writeFacts in sequence", async () => {
    const putCapture: { key: string; data: unknown }[] = [];
    const s3 = createMockS3({}, putCapture);

    const result = await runFactsPipelineDirect(s3, "bucket");

    expect(putCapture).toHaveLength(3);
    expect(result).toMatchObject({ facts_hash: "h1" });
    expect((result as { wrote: string[] }).wrote).toHaveLength(3);
  });

  it("createFactsMastraAgent returns agent with readContext, extractFacts, writeFacts tools", async () => {
    const putCapture: { key: string; data: unknown }[] = [];
    const s3 = createMockS3({}, putCapture);
    const { agent, getLastResult } = createFactsMastraAgent(s3, "bucket");

    const tools = await Promise.resolve(agent.getTools());
    expect(tools).toBeDefined();
    expect(Object.keys(tools as object)).toContain("readContext");
    expect(Object.keys(tools as object)).toContain("extractFacts");
    expect(Object.keys(tools as object)).toContain("writeFacts");
    expect(getLastResult()).toBeNull();
  });
});
