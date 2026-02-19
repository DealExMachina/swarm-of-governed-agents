import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { Readable } from "stream";

function streamToString(stream: any): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: any[] = [];
    (stream as Readable).on("data", (chunk) => chunks.push(chunk));
    (stream as Readable).on("error", reject);
    (stream as Readable).on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
}

export function makeS3() {
  const endpoint = process.env.S3_ENDPOINT!;
  const region = process.env.S3_REGION || "us-east-1";

  return new S3Client({
    region,
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY!,
      secretAccessKey: process.env.S3_SECRET_KEY!,
    },
  });
}

export async function s3GetText(s3: S3Client, bucket: string, key: string): Promise<string | null> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  } catch {
    return null;
  }
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = (res as any).Body;
  return streamToString(body);
}

export async function s3PutJson(s3: S3Client, bucket: string, key: string, data: any) {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(data, null, 2),
      ContentType: "application/json",
    })
  );
}

export async function s3ListKeys(s3: S3Client, bucket: string, prefix: string, maxKeys: number = 1000): Promise<string[]> {
  const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: maxKeys }));
  return (res.Contents ?? []).map((c) => c.Key!).filter(Boolean);
}
