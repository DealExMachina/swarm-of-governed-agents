import { describe, it, expect, beforeAll } from "vitest";
import { makeS3, s3PutJson, s3GetText, s3AppendJsonl } from "../../src/s3";

const hasS3 =
  process.env.S3_ENDPOINT && process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY;

describe.runIf(hasS3)("s3 integration (real S3/MinIO)", () => {
  const bucket = process.env.S3_BUCKET ?? "swarm";
  const key = "test/integration/roundtrip.json";
  const keyJsonl = "test/integration/stream.jsonl";

  let s3: ReturnType<typeof makeS3>;

  beforeAll(() => {
    s3 = makeS3();
  });

  it("put and get JSON roundtrip", async () => {
    const data = { foo: "bar", num: 42 };
    await s3PutJson(s3, bucket, key, data);
    const raw = await s3GetText(s3, bucket, key);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual(data);
  });

  it("append Jsonl builds correct stream", async () => {
    const uniqueKey = `${keyJsonl}.${Date.now()}`;
    await s3AppendJsonl(s3, bucket, uniqueKey, { id: 1, t: "a" });
    await s3AppendJsonl(s3, bucket, uniqueKey, { id: 2, t: "b" });
    const raw = await s3GetText(s3, bucket, uniqueKey);
    expect(raw).not.toBeNull();
    const lines = raw!.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ id: 1, t: "a" });
    expect(JSON.parse(lines[1])).toEqual({ id: 2, t: "b" });
  });
});
