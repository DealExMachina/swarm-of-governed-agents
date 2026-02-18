import type { S3Client } from "@aws-sdk/client-s3";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";

interface ListPage {
  KeyCount?: number;
  IsTruncated?: boolean;
  NextContinuationToken?: string;
}

export async function countPrefix(
  s3: S3Client,
  bucket: string,
  prefix: string
): Promise<number> {
  let continuationToken: string | undefined = undefined;
  let total = 0;

  do {
    const res: ListPage = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );

    total += res.KeyCount ?? 0;
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);

  return total;
}
