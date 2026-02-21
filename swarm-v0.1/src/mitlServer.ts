import { createServer, type IncomingMessage, type ServerResponse } from "http";
import type { Proposal } from "./events.js";
import type { Action } from "./events.js";

interface PendingItem {
  proposal: Proposal;
  actionPayload: Record<string, unknown>;
}

const pending = new Map<string, PendingItem>();
let publishAction: (subject: string, data: Record<string, unknown>) => Promise<void> = async () => {};
let publishRejection: (subject: string, data: Record<string, unknown>) => Promise<void> = async () => {};

export function setMitlPublishFns(
  action: (subject: string, data: Record<string, unknown>) => Promise<void>,
  rejection: (subject: string, data: Record<string, unknown>) => Promise<void>,
): void {
  publishAction = action;
  publishRejection = rejection;
}

export function addPending(proposalId: string, proposal: Proposal, actionPayload: Record<string, unknown>): void {
  pending.set(proposalId, { proposal, actionPayload });
}

export function getPending(): Array<{ proposal_id: string; proposal: Proposal }> {
  return Array.from(pending.entries()).map(([id, item]) => ({ proposal_id: id, proposal: item.proposal }));
}

export function _clearPendingForTest(): void {
  pending.clear();
}

export async function approvePending(proposalId: string): Promise<{ ok: boolean; error?: string }> {
  const item = pending.get(proposalId);
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
  pending.delete(proposalId);
  return { ok: true };
}

export type FinalityOptionAction = "approve_finality" | "provide_resolution" | "escalate" | "defer";

export async function resolveFinalityPending(
  proposalId: string,
  option: FinalityOptionAction,
  days?: number,
): Promise<{ ok: boolean; error?: string }> {
  const item = pending.get(proposalId);
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
  pending.delete(proposalId);
  return { ok: true };
}

export async function rejectPending(proposalId: string, reason?: string): Promise<{ ok: boolean; error?: string }> {
  const item = pending.get(proposalId);
  if (!item) return { ok: false, error: "not_found" };
  await publishRejection("swarm.rejections.advance_state", {
    proposal_id: proposalId,
    reason: reason ?? "mitl_rejected",
    result: "rejected",
  });
  pending.delete(proposalId);
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

    if (method === "GET" && url === "/pending") {
      send(200, { pending: getPending() });
      return;
    }
    if (method === "POST" && match) {
      const result = await approvePending(match[1]);
      send(result.ok ? 200 : 404, result);
      return;
    }
    if (method === "POST" && matchReject) {
      const body = await parseBody(req);
      const result = await rejectPending(matchReject[1], body.reason as string);
      send(result.ok ? 200 : 404, result);
      return;
    }
    if (method === "POST" && matchFinality) {
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
  server.listen(port, () => {
    process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "MITL server listening", port }) + "\n");
  });
}
