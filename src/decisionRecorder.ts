/**
 * Persist governance DecisionRecords for audit and policy versioning.
 */

import type { DecisionRecord } from "./policyEngine.js";
import { getPool } from "./db.js";
import type pg from "pg";

export async function persistDecisionRecord(
  record: DecisionRecord,
  pool?: pg.Pool,
): Promise<void> {
  const p = pool ?? getPool();
  await p.query(
    `INSERT INTO decision_records (decision_id, timestamp, policy_version, result, reason, obligations, binding, suggested_actions)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb)`,
    [
      record.decision_id,
      record.timestamp,
      record.policy_version,
      record.result,
      record.reason,
      JSON.stringify(record.obligations ?? []),
      record.binding ?? "yaml",
      record.suggested_actions ? JSON.stringify(record.suggested_actions) : null,
    ],
  );
}
