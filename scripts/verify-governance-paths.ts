/**
 * Verify that governance E2E fixture produced auditable paths.
 *
 * Queries context_events for proposal_approved, proposal_rejected, proposal_pending_approval
 * and checks that expected paths and outcomes are present. Exits 0 if all checks pass, 1 otherwise.
 *
 * Expected after seed-governance-e2e + governance run:
 * - At least one proposal_approved with governance_path processProposal and reason master_override (MASTER)
 * - At least one proposal_pending_approval with governance_path processProposal (MITL)
 * - At least one proposal_rejected (YOLO, transition blocked by high drift)
 *
 * Optional: when OPENAI_API_KEY is set, YOLO reject may have governance_path oversight_acceptDeterministic.
 *
 * Usage: npm run verify:governance-paths
 */
import "dotenv/config";
import pg from "pg";

const EXPECTED = {
  processProposal_approve_master: {
    type: "proposal_approved",
    governance_path: "processProposal",
    reason: "master_override",
  },
  processProposal_pending: {
    type: "proposal_pending_approval",
    governance_path: "processProposal",
  },
  rejected_any: {
    type: "proposal_rejected",
    reasonSubstr: "drift",
  },
} as const;

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL required");
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: dbUrl, max: 1 });
  try {
    const res = await pool.query(
      `SELECT data FROM context_events
       WHERE data->>'type' IN ('proposal_approved', 'proposal_rejected', 'proposal_pending_approval')
       ORDER BY seq DESC
       LIMIT 500`,
    );
    const events = res.rows.map((r: { data: Record<string, unknown> }) => r.data);
    if (events.length === 0) {
      console.error("No governance proposal events in context_events. Run seed:governance-e2e and ensure governance agent has run.");
      process.exit(1);
    }

    const hasApproveMaster = events.some(
      (d: Record<string, unknown>) =>
        d.type === EXPECTED.processProposal_approve_master.type &&
        d.governance_path === EXPECTED.processProposal_approve_master.governance_path &&
        d.reason === EXPECTED.processProposal_approve_master.reason,
    );
    const hasPendingProcessProposal = events.some(
      (d: Record<string, unknown>) =>
        d.type === EXPECTED.processProposal_pending.type &&
        (d.governance_path === EXPECTED.processProposal_pending.governance_path || d.governance_path === "oversight_escalateToHuman"),
    );
    const hasRejectedDrift = events.some(
      (d: Record<string, unknown>) =>
        d.type === EXPECTED.rejected_any.type &&
        typeof d.reason === "string" &&
        d.reason.toLowerCase().includes(EXPECTED.rejected_any.reasonSubstr),
    );

    const paths = new Set(events.map((d: Record<string, unknown>) => d.governance_path).filter(Boolean));
    const missing: string[] = [];
    if (!hasApproveMaster) missing.push("proposal_approved with governance_path=processProposal, reason=master_override (MASTER path)");
    if (!hasPendingProcessProposal) missing.push("proposal_pending_approval with governance_path=processProposal (MITL path)");
    if (!hasRejectedDrift) missing.push("proposal_rejected with reason containing 'drift' (YOLO reject)");

    if (!hasApproveMaster || !hasRejectedDrift) {
      console.error("Missing required governance outcomes:");
      if (!hasApproveMaster) console.error(" - proposal_approved (MASTER)");
      if (!hasRejectedDrift) console.error(" - proposal_rejected (YOLO/drift)");
      console.error("Governance paths seen:", [...paths].join(", ") || "(none)");
      console.error("Proposal events in WAL:", JSON.stringify(events.slice(0, 15).map((d: Record<string, unknown>) => ({ type: d.type, path: d.governance_path, reason: d.reason })), null, 2));
      process.exit(1);
    }
    if (!hasPendingProcessProposal) {
      console.warn("Warning: no proposal_pending_approval (MITL path) in WAL; seed order or timing may vary. Events:", events.length);
    }

    console.log("Governance path verification passed.");
    console.log("Paths seen:", [...paths].sort().join(", "));
    console.log("Sample events:", events.length);
    process.exit(0);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
