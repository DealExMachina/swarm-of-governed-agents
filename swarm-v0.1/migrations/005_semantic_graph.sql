-- Layer 1: Addressable semantic nodes and edges (pgvector for embeddings).
-- Requires Postgres 15+ with pgvector (use image pgvector/pgvector:pg15).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS nodes (
  node_id       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id      TEXT         NOT NULL,
  type          TEXT         NOT NULL,
  content       TEXT         NOT NULL,
  embedding     vector(1024),
  confidence    FLOAT        NOT NULL DEFAULT 1.0,
  status        TEXT         NOT NULL DEFAULT 'active',
  source_ref    JSONB        NOT NULL DEFAULT '{}',
  metadata      JSONB        NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_by    TEXT,
  version       INT          NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS edges (
  edge_id       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id      TEXT         NOT NULL,
  source_id     UUID         NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
  target_id     UUID         NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
  edge_type     TEXT         NOT NULL,
  weight        FLOAT        NOT NULL DEFAULT 1.0,
  metadata      JSONB        NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_by    TEXT
);

CREATE INDEX IF NOT EXISTS idx_nodes_scope_type   ON nodes (scope_id, type, status);
CREATE INDEX IF NOT EXISTS idx_nodes_scope_conf   ON nodes (scope_id, confidence) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_nodes_created      ON nodes (scope_id, created_at);
CREATE INDEX IF NOT EXISTS idx_edges_scope_type   ON edges (scope_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_edges_target       ON edges (target_id);
CREATE INDEX IF NOT EXISTS idx_edges_source      ON edges (source_id);

CREATE OR REPLACE FUNCTION notify_node_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'node_delta',
    json_build_object(
      'scope_id', NEW.scope_id,
      'node_id',  NEW.node_id,
      'type',     NEW.type,
      'status',   NEW.status,
      'op',       TG_OP
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS nodes_notify ON nodes;
CREATE TRIGGER nodes_notify
  AFTER INSERT OR UPDATE ON nodes
  FOR EACH ROW EXECUTE FUNCTION notify_node_change();
