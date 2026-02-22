-- Convergence history for finality gradient descent.
-- Each row is one evaluation cycle: append-only, per-scope.
-- Tracks goal score, Lyapunov disagreement V, per-dimension scores, and pressure.

CREATE TABLE IF NOT EXISTS convergence_history (
  id               BIGSERIAL    PRIMARY KEY,
  scope_id         TEXT         NOT NULL,
  epoch            BIGINT       NOT NULL,
  goal_score       FLOAT        NOT NULL,
  lyapunov_v       FLOAT        NOT NULL,
  dimension_scores JSONB        NOT NULL DEFAULT '{}',
  pressure         JSONB        NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_convergence_history_scope
  ON convergence_history (scope_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_convergence_history_scope_epoch
  ON convergence_history (scope_id, epoch DESC);
