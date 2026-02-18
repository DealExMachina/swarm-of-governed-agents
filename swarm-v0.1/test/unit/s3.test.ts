import { describe, it, expect, vi } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "stream";
import { s3PutJson, s3GetText, s3AppendJsonl } from "../../src/s3";

function createMockS3(sendFn: (input: unknown) => Promise<unknown>): S3Client {
  return { send: vi.fn(sendFn) } as unknown as S3Client;
}

describe("s3", () => {
  const bucket = "test-bucket";
  const key = "test/key.json";

  describe("s3PutJson", () => {
    it("sends PutObjectCommand with JSON body and content-type", async () => {
      let captured: { Body?: string; ContentType?: string; Bucket?: string; Key?: string } = {};
      const mock = createMockS3(async (input: any) => {
        if (input instanceof PutObjectCommand) {
          const params = (input as any).input ?? input;
          captured = {
            Body: params.Body,
            ContentType: params.ContentType,
            Bucket: params.Bucket,
            Key: params.Key,
          };
        }
        return {};
      });

      await s3PutJson(mock, bucket, key, { foo: "bar" });

      expect(captured.Bucket).toBe(bucket);
      expect(captured.Key).toBe(key);
      expect(captured.ContentType).toBe("application/json");
      expect(JSON.parse(captured.Body!)).toEqual({ foo: "bar" });
    });
  });

  describe("s3GetText", () => {
    it("returns null when HeadObject throws (object does not exist)", async () => {
      const mock = createMockS3(async (input: any) => {
        if (input instanceof HeadObjectCommand) throw new Error("NotFound");
        return {};
      });

      const result = await s3GetText(mock, bucket, key);
      expect(result).toBeNull();
    });

    it("returns body text when object exists", async () => {
      const stream = Readable.from([Buffer.from("hello"), Buffer.from(" world")]);
      const mock = createMockS3(async (input: any) => {
        if (input instanceof HeadObjectCommand) return {};
        if (input instanceof GetObjectCommand) return { Body: stream };
        return {};
      });

      const result = await s3GetText(mock, bucket, key);
      expect(result).toBe("hello world");
    });
  });

  describe("s3AppendJsonl", () => {
    it("writes single line when key does not exist", async () => {
      let putBody: string | undefined;
      const mock = createMockS3(async (input: any) => {
        if (input instanceof HeadObjectCommand) throw new Error("NotFound");
        if (input instanceof PutObjectCommand) {
          putBody = (input as any).input?.Body ?? (input as any).input?.Body;
          if (typeof putBody !== "string") putBody = undefined;
        }
        return {};
      });

      await s3AppendJsonl(mock, bucket, key, { a: 1 });

      expect(putBody).toBe(JSON.stringify({ a: 1 }) + "\n");
    });

    it("appends line to existing content", async () => {
      const existing = JSON.stringify({ x: 1 }) + "\n";
      let putBody: string | undefined;
      const mock = createMockS3(async (input: any) => {
        if (input instanceof HeadObjectCommand) return {};
        if (input instanceof GetObjectCommand) return { Body: Readable.from([Buffer.from(existing, "utf-8")]) };
        if (input instanceof PutObjectCommand) {
          const params = (input as any).input;
          if (params?.Body) putBody = params.Body as string;
        }
        return {};
      });

      await s3AppendJsonl(mock, bucket, key, { b: 2 });

      expect(putBody).toBe(existing + JSON.stringify({ b: 2 }) + "\n");
    });
  });
});
