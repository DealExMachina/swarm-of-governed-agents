import pg from "pg";
import { getPool } from "./db.js";

let _tableEnsured = false;

export async function ensureProcessedMessagesTable(pool?: pg.Pool): Promise<void> {
  if (_tableEnsured) return;
  const p = pool ?? getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS processed_messages (
      consumer_name TEXT NOT NULL,
      message_id    TEXT NOT NULL,
      processed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (consumer_name, message_id)
    )
  `);
  await p.query(
    "CREATE INDEX IF NOT EXISTS idx_processed_messages_processed_at ON processed_messages (processed_at)",
  );
  _tableEnsured = true;
}

export async function isProcessed(consumerName: string, messageId: string, pool?: pg.Pool): Promise<boolean> {
  const p = pool ?? getPool();
  await ensureProcessedMessagesTable(p);
  const res = await p.query(
    "SELECT 1 FROM processed_messages WHERE consumer_name = $1 AND message_id = $2",
    [consumerName, messageId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function markProcessed(consumerName: string, messageId: string, pool?: pg.Pool): Promise<void> {
  const p = pool ?? getPool();
  await ensureProcessedMessagesTable(p);
  await p.query(
    "INSERT INTO processed_messages (consumer_name, message_id, processed_at) VALUES ($1, $2, now()) ON CONFLICT (consumer_name, message_id) DO NOTHING",
    [consumerName, messageId],
  );
}
