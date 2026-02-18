import { createHash } from "crypto";

const SHARD_COUNT = parseInt(process.env.SHARD_COUNT || "8", 10);

export function shardForEventId(eventId: string, shardCount: number = SHARD_COUNT): number {
  const h = createHash("sha256").update(eventId).digest();
  const n = h.readUInt32BE(0);
  return Math.abs(n) % shardCount;
}

export function shardKey(shardIndex: number): string {
  return `context/shards/shard-${String(shardIndex).padStart(2, "0")}.jsonl`;
}
