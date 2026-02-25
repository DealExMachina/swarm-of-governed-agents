-- Finality certificates (JWS) for RESOLVED/ESCALATED/BLOCKED/EXPIRED. Phase 6-4.
CREATE TABLE IF NOT EXISTS finality_certificates (
  id              BIGSERIAL PRIMARY KEY,
  scope_id        TEXT NOT NULL,
  certificate_jws TEXT NOT NULL,
  payload         JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_finality_certificates_scope ON finality_certificates (scope_id);
CREATE INDEX IF NOT EXISTS idx_finality_certificates_created ON finality_certificates (scope_id, created_at DESC);
