import { describe, it, expect, beforeAll } from "vitest";
import { makeS3, s3PutJson, s3GetText } from "../../src/s3";

const hasS3 =
  process.env.S3_ENDPOINT && process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY;

describe.runIf(hasS3)("s3 integration (real S3/MinIO)", () => {
  const bucket = process.env.S3_BUCKET ?? "swarm";
  const key = "test/integration/roundtrip.json";

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
});
