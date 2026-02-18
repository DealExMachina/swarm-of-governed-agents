/**
 * Create S3 bucket if it does not exist (for MinIO/local dev).
 * Usage: node --loader ts-node/esm scripts/ensure-bucket.ts
 */
import "dotenv/config";
import { CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { makeS3 } from "../src/s3.js";

const bucket = process.env.S3_BUCKET ?? "swarm";

async function main() {
  const s3 = makeS3();
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    console.log(`Bucket "${bucket}" already exists.`);
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log(`Bucket "${bucket}" created.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
