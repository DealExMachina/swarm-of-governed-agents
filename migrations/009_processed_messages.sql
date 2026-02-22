CREATE TABLE IF NOT EXISTS processed_messages (
  consumer_name TEXT NOT NULL,
  message_id    TEXT NOT NULL,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_name, message_id)
);

CREATE INDEX IF NOT EXISTS idx_processed_messages_processed_at ON processed_messages (processed_at);
