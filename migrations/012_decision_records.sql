-- Decision records for governance audit and policy versioning (Phase 5-2).
CREATE TABLE IF NOT EXISTS decision_records (
  id             BIGSERIAL PRIMARY KEY,
  decision_id    TEXT NOT NULL,
  timestamp      TIMESTAMPTZ NOT NULL,
  policy_version TEXT NOT NULL,
  result         TEXT NOT NULL CHECK (result IN ('allow', 'deny')),
  reason         TEXT NOT NULL,
  obligations    JSONB NOT NULL DEFAULT '[]',
  binding        TEXT NOT NULL DEFAULT 'yaml',
  suggested_actions JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_decision_records_ts ON decision_records (timestamp);
CREATE INDEX IF NOT EXISTS idx_decision_records_policy_version ON decision_records (policy_version);
