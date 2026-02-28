/**
 * Swarm API + Observability dashboard (port 3002).
 * SSE event feed, GET /summary, POST /context/docs, convergence, health.
 */

import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { makeEventBus, type EventBus } from "./eventBus.js";
import type { PushSubscription } from "./eventBus.js";
import { appendEvent } from "./contextWal.js";
import { createSwarmEvent } from "./events.js";
import { loadState } from "./stateGraph.js";
import { tailEvents } from "./contextWal.js";
import { makeS3 } from "./s3.js";
import { s3GetText } from "./s3.js";
import { toErrorString } from "./errors.js";
import { getPool } from "./db.js";
import { loadPolicies, getGovernanceForScope, evaluateRules } from "./governance.js";
import { evaluateFinality, computeGoalScoreForScope, loadFinalityConfig, loadFinalitySnapshot } from "./finalityEvaluator.js";
import { getConvergenceState, type ConvergenceState } from "./convergenceTracker.js";
import { getGraphSummary, appendResolutionGoal } from "./semanticGraph.js";
import { getLatestFinalityDecision } from "./finalityDecisions.js";
import { getGovernancePolicyVersion, getFinalityPolicyVersion } from "./policyVersions.js";
import { getLatestCertificate } from "./finalityCertificates.js";
import { requireBearer } from "./auth.js";
import { getHatcheryInstance } from "./hatchery.js";

// ── Persistent EventBus singleton ────────────────────────────────────────────
// Reused across all requests (avoids creating/destroying NATS connections per POST).

let _feedBus: EventBus | null = null;

async function getFeedBus(): Promise<EventBus> {
  if (!_feedBus) {
    _feedBus = await makeEventBus();
    await _feedBus.ensureStream(
      process.env.NATS_STREAM ?? "SWARM_JOBS",
      ["swarm.events.>"],
    );
  }
  return _feedBus;
}

const FEED_PORT = parseInt(process.env.FEED_PORT ?? "3002", 10);
const NATS_STREAM = process.env.NATS_STREAM ?? "SWARM_JOBS";
const S3_BUCKET = process.env.S3_BUCKET ?? null;
const GOVERNANCE_PATH = process.env.GOVERNANCE_PATH ?? join(process.cwd(), "governance.yaml");
const SCOPE_ID = process.env.SCOPE_ID ?? "default";
const MITL_URL = (process.env.MITL_URL ?? "http://localhost:3001").replace(/\/$/, "");

function getPathname(url: string): string {
  try {
    return new URL(url, "http://localhost").pathname;
  } catch {
    return url.split("?")[0] ?? "/";
  }
}

function getQuery(url: string): Record<string, string> {
  try {
    const u = new URL(url, "http://localhost");
    const out: Record<string, string> = {};
    u.searchParams.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  } catch {
    return {};
  }
}

function sendJson(res: ServerResponse, status: number, data: Record<string, unknown>): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/** POST /context/docs: add a document to the WAL (type context_doc). Triggers facts pipeline. */
async function handleAddDoc(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readJsonBody(req);
    const title = typeof body.title === "string" ? body.title : "doc";
    const text = typeof body.body === "string" ? body.body : typeof body.text === "string" ? body.text : "";
    if (!text) {
      sendJson(res, 400, { error: "body or text required" });
      return;
    }
    const event = createSwarmEvent(
      "context_doc",
      { title, text, source: "api" },
      { source: "feed" },
    );
    const seq = await appendEvent(event as unknown as Record<string, unknown>);
    const bus = await getFeedBus();
    await bus.publishEvent(event);
    sendJson(res, 200, { seq, ok: true, message: "Document added; facts pipeline will run when agents process it." });
  } catch (e) {
    sendJson(res, 500, { error: toErrorString(e) });
  }
}

/** POST /context/resolution: add a manual resolution/decision to the WAL (type resolution). Integrates as new context so facts re-run and drift can clear; graph and fact history record the resolution. */
async function handleAddResolution(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readJsonBody(req);
    const decision = typeof body.decision === "string" ? body.decision : typeof body.text === "string" ? body.text : "";
    if (!decision.trim()) {
      sendJson(res, 400, { error: "decision or text required" });
      return;
    }
    const summary = typeof body.summary === "string" ? body.summary : "";
    const event = createSwarmEvent(
      "resolution",
      {
        decision: decision.trim(),
        summary: summary.trim() || decision.trim().slice(0, 80),
        text: decision.trim(),
        source: "user",
      },
      { source: "feed" },
    );
    const seq = await appendEvent(event as unknown as Record<string, unknown>);
    const bus = await getFeedBus();
    await bus.publishEvent(event);
    try {
      await appendResolutionGoal(SCOPE_ID, decision.trim(), summary.trim());
    } catch (err) {
      process.stderr.write(
        `[feed] appendResolutionGoal failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    sendJson(res, 200, {
      seq,
      ok: true,
      message: "Resolution added to context. Facts pipeline will run; drift may clear. Graph and fact history will record this manual resolution.",
    });
  } catch (e) {
    sendJson(res, 500, { error: toErrorString(e) });
  }
}

/** GET /pending: proxy to MITL server pending list (for finality reviews and other proposals). */
async function handleGetPending(res: ServerResponse): Promise<void> {
  try {
    const r = await fetch(`${MITL_URL}/pending`, { method: "GET" });
    if (!r.ok) {
      sendJson(res, 502, { error: "mitl_unavailable", pending: [] });
      return;
    }
    const data = (await r.json()) as { pending?: Array<{ proposal_id: string; proposal: Record<string, unknown> }> };
    sendJson(res, 200, { pending: data.pending ?? [] });
  } catch (e) {
    sendJson(res, 502, { error: toErrorString(e), pending: [] });
  }
}

/** POST /finality-response: proxy to MITL finality-response for a given proposal. Body: { proposal_id, option, days? }. */
async function handleFinalityResponse(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readJsonBody(req);
    const proposalId = typeof body.proposal_id === "string" ? body.proposal_id : "";
    const option = body.option as string | undefined;
    const valid: string[] = ["approve_finality", "provide_resolution", "escalate", "defer"];
    if (!proposalId || !option || !valid.includes(option)) {
      sendJson(res, 400, { ok: false, error: "proposal_id and option (one of: " + valid.join(", ") + ") required" });
      return;
    }
    const days = option === "defer" && body.days != null ? Number(body.days) : undefined;
    const r = await fetch(`${MITL_URL}/finality-response/${encodeURIComponent(proposalId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ option, days }),
    });
    const data = (await r.json()) as { ok?: boolean; error?: string };
    sendJson(res, r.ok ? 200 : 404, data);
  } catch (e) {
    sendJson(res, 502, { ok: false, error: toErrorString(e) });
  }
}

/** Normalize S3 facts list fields to string[] (handles raw strings, dicts with claim/risk/goal/text, or arrays). */
function toFactStringList(val: unknown): string[] {
  if (val == null) return [];
  if (Array.isArray(val)) {
    return val
      .map((item) => {
        if (typeof item === "string") return item.trim() || null;
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const obj = item as Record<string, unknown>;
          const s =
            (obj.claim as string) ??
            (obj.risk as string) ??
            (obj.goal as string) ??
            (obj.assumption as string) ??
            (obj.contradiction as string) ??
            (obj.text as string) ??
            (obj.entity as string);
          if (typeof s === "string") return s.trim() || null;
        }
        return null;
      })
      .filter((s): s is string => typeof s === "string" && s.length > 0);
  }
  if (typeof val === "string") return val.trim() ? [val.trim()] : [];
  return [];
}

/** GET /summary: state, facts summary, drift, and recent pipeline events for demo output. */
async function handleSummary(res: ServerResponse): Promise<void> {
  try {
    const state = await loadState(SCOPE_ID);
    const recent = await tailEvents(20);
    let facts: Record<string, unknown> | null = null;
    let drift: Record<string, unknown> | null = null;
    if (S3_BUCKET) {
      try {
        const s3 = makeS3();
        const factsRaw = await s3GetText(s3, S3_BUCKET, "facts/latest.json");
        const driftRaw = await s3GetText(s3, S3_BUCKET, "drift/latest.json");
        if (factsRaw) facts = JSON.parse(factsRaw) as Record<string, unknown>;
        if (driftRaw) drift = JSON.parse(driftRaw) as Record<string, unknown>;
      } catch {
        // S3 optional for summary
      }
    }
    const summary = {
      state: state
        ? { lastNode: state.lastNode, epoch: state.epoch, runId: state.runId, updatedAt: state.updatedAt }
        : null,
      facts: facts
        ? {
            goals: toFactStringList(facts.goals),
            claims: toFactStringList(facts.claims),
            risks: toFactStringList(facts.risks),
            contradictions: toFactStringList(facts.contradictions),
            assumptions: toFactStringList(facts.assumptions),
            confidence: facts.confidence ?? null,
            hash: (facts as { hash?: string }).hash ?? null,
            keys: Object.keys(facts).filter((k) => !["hash", "goals", "confidence", "claims", "risks", "contradictions", "assumptions"].includes(k)),
          }
        : null,
      drift: (() => {
        if (!drift) return null;
        const level = String(drift.level ?? "unknown");
        const types = (drift.types as string[]) ?? [];
        const notes = (drift.notes as string[]) ?? [];
        let suggested_actions: string[] = [];
        try {
          const config = getGovernanceForScope(SCOPE_ID, loadPolicies(GOVERNANCE_PATH));
          suggested_actions = evaluateRules({ level, types }, config);
        } catch {
          // governance file optional for summary
        }
        const references = (drift.references as Array<{ type?: string; doc?: string; excerpt?: string }>) ?? [];
        return { level, types, notes, suggested_actions, references };
      })(),
      what_changed: recent
        .filter((e) => ["state_transition", "facts_extracted", "drift_analyzed", "context_doc", "bootstrap", "resolution"].includes((e.data as { type?: string })?.type ?? ""))
        .slice(-10)
        .map((e) => ({
          seq: e.seq,
          type: (e.data as { type?: string }).type,
          ts: e.ts,
          payload: (e.data as { payload?: Record<string, unknown> }).payload ?? {},
        })),
      finality: await (async () => {
        try {
          const config = loadFinalityConfig();
          const near = config.goal_gradient?.near_finality_threshold ?? 0.75;
          const auto = config.goal_gradient?.auto_finality_threshold ?? 0.92;
          const goal_score = await computeGoalScoreForScope(SCOPE_ID);
          const result = await evaluateFinality(SCOPE_ID);
          const status = result?.kind === "status" ? result.status : result?.kind === "review" ? "near_finality" : "ACTIVE";
          let last_decision: { option: string; created_at: string } | null = null;
          try {
            const decision = await getLatestFinalityDecision(SCOPE_ID);
            if (decision) last_decision = { option: decision.option, created_at: decision.created_at };
          } catch {
            // table may not exist
          }
          // Convergence data (graceful degradation)
          let convergence: Record<string, unknown> | null = null;
          try {
            const convConfig = config.convergence ?? {};
            const convState: ConvergenceState = await getConvergenceState(SCOPE_ID, convConfig, auto);
            convergence = {
              rate: convState.convergence_rate,
              estimated_rounds: convState.estimated_rounds,
              is_plateaued: convState.is_plateaued,
              plateau_rounds: convState.plateau_rounds,
              lyapunov_v: convState.history.length > 0 ? convState.history[convState.history.length - 1].lyapunov_v : null,
              highest_pressure: convState.highest_pressure_dimension,
              is_monotonic: convState.is_monotonic,
              trajectory_quality: convState.trajectory_quality,
              oscillation_detected: convState.oscillation_detected,
              history: convState.history.map((p) => ({
                epoch: p.epoch,
                score: p.goal_score,
                v: p.lyapunov_v,
              })),
            };
          } catch {
            // convergence_history table may not exist
          }

          let policy_version: { governance?: string; finality?: string } | undefined;
          let finality_certificate: { decision: string; timestamp: string; has_jws: boolean } | null = null;
          try {
            policy_version = { governance: getGovernancePolicyVersion(), finality: getFinalityPolicyVersion() };
          } catch {
            // optional
          }
          try {
            const cert = await getLatestCertificate(SCOPE_ID);
            if (cert) {
              finality_certificate = {
                decision: cert.payload.decision,
                timestamp: cert.payload.timestamp,
                has_jws: !!cert.certificate_jws,
              };
            }
          } catch {
            // table may not exist
          }
          return {
            goal_score: Math.round(goal_score * 100) / 100,
            status,
            near_threshold: near,
            auto_threshold: auto,
            resolved: status === "RESOLVED",
            dimension_breakdown: result?.kind === "review" ? result.request.dimension_breakdown : null,
            blockers: result?.kind === "review" ? result.request.blockers : null,
            last_decision: last_decision ?? undefined,
            policy_version: policy_version ?? undefined,
            finality_certificate: finality_certificate ?? undefined,
            convergence,
            dimensions: await (async () => {
              try {
                const snap = await loadFinalitySnapshot(SCOPE_ID);
                const contraTotal = snap.contradictions_total_count || 0;
                const contraResolved = contraTotal === 0 ? 1 : 1 - (snap.contradictions_unresolved_count / contraTotal);
                return {
                  claim_avg_confidence: snap.claims_active_avg_confidence,
                  contradiction_resolution_ratio: contraResolved,
                  goal_completion_ratio: snap.goals_completion_ratio,
                  risk_score_inverse: 1 - Math.min(snap.scope_risk_score, 1),
                };
              } catch { return null; }
            })(),
          };
        } catch {
          return null;
        }
      })(),
      state_graph: await (async () => {
        try {
          return await getGraphSummary(SCOPE_ID);
        } catch {
          return null;
        }
      })(),
    };
    sendJson(res, 200, summary);
  } catch (e) {
    sendJson(res, 500, { error: toErrorString(e) });
  }
}

/** GET /convergence?scope=<id>: full convergence state for a scope (debugging + benchmark). */
async function handleConvergence(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const query = getQuery(req.url ?? "");
    const scopeId = query.scope ?? SCOPE_ID;
    const config = loadFinalityConfig();
    const convConfig = config.convergence ?? {};
    const auto = config.goal_gradient?.auto_finality_threshold ?? 0.92;
    const convState = await getConvergenceState(scopeId, convConfig, auto);
    sendJson(res, 200, {
      scope_id: scopeId,
      convergence_rate: convState.convergence_rate,
      estimated_rounds: convState.estimated_rounds,
      is_monotonic: convState.is_monotonic,
      is_plateaued: convState.is_plateaued,
      plateau_rounds: convState.plateau_rounds,
      highest_pressure_dimension: convState.highest_pressure_dimension,
      history: convState.history,
    });
  } catch (e) {
    sendJson(res, 500, { error: toErrorString(e) });
  }
}

async function handleEvents(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const pathname = getPathname(req.url ?? "/");
  if (req.method !== "GET" || pathname !== "/events") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }

  const bus = await getFeedBus();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  const socket = res.socket;
  if (socket) socket.setNoDelay(true);

  // Send an initial event so the client sees something immediately
  const connected = {
    type: "feed_connected",
    ts: new Date().toISOString(),
    source: "feed",
    payload: { message: "Listening for swarm.events.>", stream: NATS_STREAM },
  };
  res.write(`id: 0\ndata: ${JSON.stringify(connected)}\n\n`);

  let sub: PushSubscription | null = null;
  const keepalive = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(keepalive);
      return;
    }
    res.write(": keepalive\n\n");
  }, 25000);

  const onMessage = async (msg: { id: string; data: Record<string, unknown> }) => {
    if (res.writableEnded) return;
    const line = `id: ${msg.id}\ndata: ${JSON.stringify(msg.data)}\n\n`;
    res.write(line);
  };

  // Ephemeral consumer: no durable name → no accumulation in NATS when clients disconnect
  sub = await bus.subscribeEphemeral(NATS_STREAM, "swarm.events.>", onMessage);

  req.on("close", () => {
    clearInterval(keepalive);
    if (sub) {
      sub.unsubscribe().catch(() => {});
    }
  });
}

const __feed_dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = readFileSync(join(__feed_dirname, "observability.html"), "utf-8");


async function main(): Promise<void> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const pathname = getPathname(req.url ?? "/");
      if (req.method === "GET" && pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(INDEX_HTML);
        return;
      }
      if (req.method === "GET" && pathname === "/summary") {
        const query = getQuery(req.url ?? "");
        const wantJson = query.raw === "1" || query.format === "json";
        const accept = (req.headers["accept"] ?? "").toLowerCase();
        if (!wantJson && accept.includes("text/html")) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(INDEX_HTML);
          return;
        }
        await handleSummary(res);
        return;
      }
      if (req.method === "POST" && pathname === "/context/docs") {
        if (!requireBearer(req, res)) return;
        await handleAddDoc(req, res);
        return;
      }
      if (req.method === "POST" && pathname === "/context/resolution") {
        if (!requireBearer(req, res)) return;
        await handleAddResolution(req, res);
        return;
      }
      if (req.method === "GET" && pathname === "/pending") {
        if (!requireBearer(req, res)) return;
        await handleGetPending(res);
        return;
      }
      if (req.method === "POST" && pathname === "/finality-response") {
        if (!requireBearer(req, res)) return;
        await handleFinalityResponse(req, res);
        return;
      }
      if (req.method === "GET" && pathname === "/convergence") {
        if (!requireBearer(req, res)) return;
        await handleConvergence(req, res);
        return;
      }
      if (req.method === "GET" && pathname === "/hatchery/snapshot") {
        const hatchery = getHatcheryInstance();
        if (!hatchery) {
          sendJson(res, 404, { error: "hatchery not active (legacy mode)" });
        } else {
          sendJson(res, 200, hatchery.getSnapshot() as unknown as Record<string, unknown>);
        }
        return;
      }
      if (req.method === "GET" && pathname === "/health") {
        try {
          await getPool().query("SELECT 1");
          sendJson(res, 200, { status: "ok", pg: "connected" });
        } catch (e) {
          sendJson(res, 503, { status: "unhealthy", pg: toErrorString(e) });
        }
        return;
      }
      await handleEvents(req, res);
    } catch (err) {
      if (!res.writableEnded) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    }
  });

  server.listen(FEED_PORT, "0.0.0.0", () => {
    process.stdout.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        msg: "feed SSE server listening",
        port: FEED_PORT,
        path: "/events",
      }) + "\n",
    );
  });
}

main().catch((e) => {
  process.stderr.write(JSON.stringify({ error: toErrorString(e) }) + "\n");
  process.exit(1);
});
