-- Bitemporal schema: valid time (valid_from, valid_to) and transaction time (recorded_at, superseded_at).
-- Backward compatible: new columns nullable; "current" view = superseded_at IS NULL AND (valid_to IS NULL OR valid_to > now()).
-- Requires migrations 005 (nodes, edges) to have been applied.

-- Nodes: valid time and transaction time
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS recorded_at TIMESTAMPTZ;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

-- Backfill nodes: treat existing rows as current; recorded_at = created_at, valid_from = created_at
UPDATE nodes SET recorded_at = created_at WHERE recorded_at IS NULL;
UPDATE nodes SET valid_from = created_at WHERE valid_from IS NULL;
-- valid_to, superseded_at remain NULL (current / not superseded)

-- Edges: same
ALTER TABLE edges ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ;
ALTER TABLE edges ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ;
ALTER TABLE edges ADD COLUMN IF NOT EXISTS recorded_at TIMESTAMPTZ;
ALTER TABLE edges ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

UPDATE edges SET recorded_at = created_at WHERE recorded_at IS NULL;
UPDATE edges SET valid_from = created_at WHERE valid_from IS NULL;

-- Default for new rows (optional; application can set explicitly)
ALTER TABLE nodes ALTER COLUMN recorded_at SET DEFAULT now();
ALTER TABLE edges ALTER COLUMN recorded_at SET DEFAULT now();

-- Indexes for as-of queries (current view and time-travel).
-- Note: Index predicates cannot use now() (STABLE); application filters valid_to > now() at query time.
CREATE INDEX IF NOT EXISTS idx_nodes_bitemporal_current
  ON nodes (scope_id, type, status)
  WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_nodes_valid_time
  ON nodes (scope_id, valid_from, valid_to)
  WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_edges_bitemporal_current
  ON edges (scope_id, edge_type)
  WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_edges_valid_time
  ON edges (scope_id, valid_from, valid_to)
  WHERE superseded_at IS NULL;
