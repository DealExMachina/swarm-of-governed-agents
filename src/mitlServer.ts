import pg from "pg";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import type { Proposal } from "./events.js";
import type { Action } from "./events.js";
import { requireBearer } from "./auth.js";
import { getPool as getSharedPool } from "./db.js";

interface PendingItem {
  proposal: Proposal;
  actionPayload: Record<string, unknown>;
}

let _tableEnsured = false;
let _testPool: pg.Pool | null = null;

function getPool(pool?: pg.Pool): pg.Pool {
  return pool ?? _testPool ?? getSharedPool();
}

export function _resetMitlTableEnsured(): void {
  _tableEnsured = false;
}

/** Test only: inject pool (e.g. in-memory mock). Call with null to reset. */
export function _setMitlPoolForTest(pool: pg.Pool | null): void {
  _testPool = pool;
  _tableEnsured = false;
}

export async function ensureMitlPendingTable(pool?: pg.Pool): Promise<void> {
  if (_tableEnsured) return;
  const p = getPool(pool);
  await p.query(`
    CREATE TABLE IF NOT EXISTS mitl_pending (
      proposal_id   TEXT PRIMARY KEY,
      proposal      JSONB NOT NULL,
      action_payload JSONB,
      status        TEXT NOT NULL DEFAULT 'pending',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await p.query("CREATE INDEX IF NOT EXISTS idx_mitl_pending_status ON mitl_pending (status)");
  _tableEnsured = true;
}

let publishAction: (subject: string, data: Record<string, unknown>) => Promise<void> = async () => {};
let publishRejection: (subject: string, data: Record<string, unknown>) => Promise<void> = async () => {};

export function setMitlPublishFns(
  action: (subject: string, data: Record<string, unknown>) => Promise<void>,
  rejection: (subject: string, data: Record<string, unknown>) => Promise<void>,
): void {
  publishAction = action;
  publishRejection = rejection;
}

export async function addPending(
  proposalId: string,
  proposal: Proposal,
  actionPayload: Record<string, unknown>,
  pool?: pg.Pool,
): Promise<void> {
  const p = getPool(pool);
  await ensureMitlPendingTable(p);
  await p.query(
    `INSERT INTO mitl_pending (proposal_id, proposal, action_payload, status, created_at)
     VALUES ($1, $2::jsonb, $3::jsonb, 'pending', now())
     ON CONFLICT (proposal_id) DO UPDATE SET proposal = $2::jsonb, action_payload = $3::jsonb, status = 'pending', created_at = now()`,
    [proposalId, JSON.stringify(proposal), JSON.stringify(actionPayload)],
  );
}

export async function getPending(pool?: pg.Pool): Promise<Array<{ proposal_id: string; proposal: Proposal }>> {
  const p = getPool(pool);
  await ensureMitlPendingTable(p);
  const res = await p.query(
    "SELECT proposal_id, proposal FROM mitl_pending WHERE status = 'pending' ORDER BY created_at",
  );
  return res.rows.map((row) => ({
    proposal_id: row.proposal_id,
    proposal: typeof row.proposal === "string" ? (JSON.parse(row.proposal) as Proposal) : (row.proposal as Proposal),
  }));
}

/** True if there is already a pending finality_review for this scope (avoids duplicate HITL entries). */
export async function hasPendingFinalityReviewForScope(scopeId: string, pool?: pg.Pool): Promise<boolean> {
  const p = getPool(pool);
  await ensureMitlPendingTable(p);
  const prefix = `finality-${scopeId}-`;
  const res = await p.query(
    "SELECT 1 FROM mitl_pending WHERE status = 'pending' AND proposal_id LIKE $1 LIMIT 1",
    [prefix + "%"],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function _clearPendingForTest(pool?: pg.Pool): Promise<void> {
  const p = getPool(pool);
  await p.query("DELETE FROM mitl_pending");
  _tableEnsured = false;
}

async function getPendingItem(proposalId: string, pool?: pg.Pool): Promise<PendingItem | null> {
  const p = getPool(pool);
  await ensureMitlPendingTable(p);
  const res = await p.query(
    "SELECT proposal, action_payload FROM mitl_pending WHERE proposal_id = $1 AND status = 'pending'",
    [proposalId],
  );
  if (res.rowCount === 0) return null;
  const row = res.rows[0];
  const proposal = typeof row.proposal === "string" ? (JSON.parse(row.proposal) as Proposal) : (row.proposal as Proposal);
  const actionPayload = (typeof row.action_payload === "string" ? JSON.parse(row.action_payload) : row.action_payload) ?? {};
  return { proposal, actionPayload };
}

async function removePending(proposalId: string, pool?: pg.Pool): Promise<void> {
  const p = getPool(pool);
  await p.query("DELETE FROM mitl_pending WHERE proposal_id = $1", [proposalId]);
}

export async function approvePending(proposalId: string, pool?: pg.Pool): Promise<{ ok: boolean; error?: string }> {
  const item = await getPendingItem(proposalId, pool);
  if (!item) return { ok: false, error: "not_found" };
  if (item.actionPayload?.type === "finality_review") {
    return { ok: false, error: "use_finality_response" };
  }
  const action: Action = {
    proposal_id: proposalId,
    approved_by: "human",
    result: "approved",
    reason: "mitl_approved",
    action_type: "advance_state",
    payload: item.actionPayload,
  };
  await publishAction("swarm.actions.advance_state", action as unknown as Record<string, unknown>);
  await removePending(proposalId, pool);
  return { ok: true };
}

export type FinalityOptionAction = "approve_finality" | "provide_resolution" | "escalate" | "defer";

export async function resolveFinalityPending(
  proposalId: string,
  option: FinalityOptionAction,
  days?: number,
  pool?: pg.Pool,
): Promise<{ ok: boolean; error?: string }> {
  const item = await getPendingItem(proposalId, pool);
  if (!item) return { ok: false, error: "not_found" };
  if (item.actionPayload?.type !== "finality_review") {
    return { ok: false, error: "not_finality_review" };
  }
  const actionPayload = {
    proposal_id: proposalId,
    approved_by: "human",
    result: "finality_response",
    action_type: "finality",
    option,
    days,
    payload: item.actionPayload,
  };
  await publishAction("swarm.actions.finality", actionPayload as unknown as Record<string, unknown>);
  await removePending(proposalId, pool);
  return { ok: true };
}

export async function rejectPending(proposalId: string, reason?: string, pool?: pg.Pool): Promise<{ ok: boolean; error?: string }> {
  const item = await getPendingItem(proposalId, pool);
  if (!item) return { ok: false, error: "not_found" };
  await publishRejection("swarm.rejections.advance_state", {
    proposal_id: proposalId,
    reason: reason ?? "mitl_rejected",
    result: "rejected",
  });
  await removePending(proposalId, pool);
  return { ok: true };
}

function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        resolve(body);
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

export function startMitlServer(port: number): void {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";
    const match = url.match(/^\/approve\/([^/]+)$/);
    const matchReject = url.match(/^\/reject\/([^/]+)$/);
    const matchFinality = url.match(/^\/finality-response\/([^/]+)$/);

    res.setHeader("Content-Type", "application/json");
    const send = (status: number, data: object) => {
      res.writeHead(status);
      res.end(JSON.stringify(data));
    };

    if (method === "GET" && url === "/health") {
      try {
        await getSharedPool().query("SELECT 1");
        send(200, { status: "ok", pg: "connected" });
      } catch (e) {
        send(503, { status: "unhealthy", pg: String(e) });
      }
      return;
    }
    if (method === "GET" && url === "/pending") {
      if (!requireBearer(req, res)) return;
      try {
        const pending = await getPending();
        send(200, { pending });
      } catch (e) {
        send(500, { error: String(e) });
      }
      return;
    }
    if (method === "POST" && match) {
      if (!requireBearer(req, res)) return;
      const result = await approvePending(match[1]);
      send(result.ok ? 200 : 404, result);
      return;
    }
    if (method === "POST" && matchReject) {
      if (!requireBearer(req, res)) return;
      const body = await parseBody(req);
      const result = await rejectPending(matchReject[1], body.reason as string);
      send(result.ok ? 200 : 404, result);
      return;
    }
    if (method === "POST" && matchFinality) {
      if (!requireBearer(req, res)) return;
      const body = await parseBody(req);
      const option = body.option as FinalityOptionAction | undefined;
      const valid: FinalityOptionAction[] = ["approve_finality", "provide_resolution", "escalate", "defer"];
      if (!option || !valid.includes(option)) {
        send(400, { ok: false, error: "invalid_option" });
        return;
      }
      const days = option === "defer" ? Number(body.days) ?? 7 : undefined;
      const result = await resolveFinalityPending(matchFinality[1], option, days);
      send(result.ok ? 200 : 404, result);
      return;
    }
    send(404, { error: "not_found" });
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      process.stderr.write(
        JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "MITL server port in use, retrying after kill", port }) + "\n",
      );
      try { require("child_process").execSync(`lsof -ti :${port} | xargs kill -9`, { stdio: "ignore" }); } catch {}
      setTimeout(() => server.listen(port), 1000);
    } else {
      throw err;
    }
  });
  server.listen(port, () => {
    process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "MITL server listening", port }) + "\n");
  });
}
