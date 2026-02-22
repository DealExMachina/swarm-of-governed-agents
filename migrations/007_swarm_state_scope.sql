-- Migrate swarm_state from singleton (id) to per-scope (scope_id PK).
-- Idempotent: if swarm_state already has scope_id, skip.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'swarm_state' AND column_name = 'id'
  ) THEN
    CREATE TABLE IF NOT EXISTS swarm_state_new (
      scope_id   TEXT PRIMARY KEY,
      run_id     TEXT NOT NULL,
      last_node  TEXT NOT NULL,
      epoch      BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    INSERT INTO swarm_state_new (scope_id, run_id, last_node, epoch, updated_at)
    SELECT 'default', run_id, last_node, epoch, updated_at FROM swarm_state
    ON CONFLICT (scope_id) DO NOTHING;
    DROP TABLE swarm_state;
    ALTER TABLE swarm_state_new RENAME TO swarm_state;
  ELSIF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'swarm_state' AND column_name = 'scope_id'
  ) THEN
    -- Table exists but has neither id nor scope_id (shouldn't happen); create new schema
    CREATE TABLE IF NOT EXISTS swarm_state_new (
      scope_id   TEXT PRIMARY KEY,
      run_id     TEXT NOT NULL,
      last_node  TEXT NOT NULL,
      epoch      BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    DROP TABLE IF EXISTS swarm_state;
    ALTER TABLE swarm_state_new RENAME TO swarm_state;
  END IF;
END $$;
