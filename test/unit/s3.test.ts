import { describe, it, expect, vi } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "stream";
import { s3PutJson, s3GetText } from "../../src/s3";

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

});
