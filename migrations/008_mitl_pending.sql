CREATE TABLE IF NOT EXISTS mitl_pending (
  proposal_id   TEXT PRIMARY KEY,
  proposal      JSONB NOT NULL,
  action_payload JSONB,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mitl_pending_status ON mitl_pending (status);
