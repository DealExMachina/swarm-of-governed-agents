CREATE TABLE IF NOT EXISTS context_events (
  seq  BIGSERIAL PRIMARY KEY,
  ts   TIMESTAMPTZ NOT NULL DEFAULT now(),
  data JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_context_events_ts ON context_events (ts);
