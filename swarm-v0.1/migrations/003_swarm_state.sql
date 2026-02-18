CREATE TABLE IF NOT EXISTS swarm_state (
  id         TEXT PRIMARY KEY DEFAULT 'singleton',
  run_id     TEXT NOT NULL,
  last_node  TEXT NOT NULL,
  epoch      BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
