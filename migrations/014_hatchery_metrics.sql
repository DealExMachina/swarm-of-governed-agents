CREATE TABLE IF NOT EXISTS hatchery_events (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  role TEXT NOT NULL,
  action TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  instance_count_before INT NOT NULL,
  instance_count_after INT NOT NULL,
  lambda FLOAT,
  mu FLOAT,
  consumer_lag BIGINT,
  pressure FLOAT,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_hatchery_events_ts ON hatchery_events (ts DESC);
CREATE INDEX IF NOT EXISTS idx_hatchery_events_role ON hatchery_events (role, ts DESC);
