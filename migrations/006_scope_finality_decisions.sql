-- Human finality decisions (approve_finality, provide_resolution, escalate, defer) for audit and to skip re-HITL.
CREATE TABLE IF NOT EXISTS scope_finality_decisions (
  scope_id TEXT NOT NULL,
  option TEXT NOT NULL,
  days INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, created_at)
);

CREATE INDEX IF NOT EXISTS idx_scope_finality_decisions_scope_created
  ON scope_finality_decisions (scope_id, created_at DESC);
