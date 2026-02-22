/**
 * SSE endpoint for live event feed, demo API: GET /summary, POST /context/docs.
 */

import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { join } from "path";
import { makeEventBus } from "./eventBus.js";
import type { PushSubscription } from "./eventBus.js";
import { appendEvent } from "./contextWal.js";
import { createSwarmEvent } from "./events.js";
import { loadState } from "./stateGraph.js";
import { tailEvents } from "./contextWal.js";
import { makeS3 } from "./s3.js";
import { s3GetText } from "./s3.js";
import { toErrorString } from "./errors.js";
import { loadPolicies, getGovernanceForScope, evaluateRules } from "./governance.js";
import { evaluateFinality, computeGoalScoreForScope, loadFinalityConfig, loadFinalitySnapshot } from "./finalityEvaluator.js";
import { getConvergenceState, type ConvergenceState } from "./convergenceTracker.js";
import { getGraphSummary, appendResolutionGoal } from "./semanticGraph.js";
import { getLatestFinalityDecision } from "./finalityDecisions.js";
import { requireBearer } from "./auth.js";

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
    const bus = await makeEventBus();
    await bus.publishEvent(event);
    await bus.close();
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
    const bus = await makeEventBus();
    await bus.publishEvent(event);
    await bus.close();
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
            goals: facts.goals ?? [],
            confidence: facts.confidence ?? null,
            hash: (facts as { hash?: string }).hash ?? null,
            keys: Object.keys(facts).filter((k) => !["hash", "goals", "confidence"].includes(k)),
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
              history: convState.history.map((p) => ({
                epoch: p.epoch,
                score: p.goal_score,
                v: p.lyapunov_v,
              })),
            };
          } catch {
            // convergence_history table may not exist
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

  const bus = await makeEventBus();
  await bus.ensureStream(NATS_STREAM, ["swarm.events.>"]);

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

  const consumer = `feed-sse-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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

  sub = await bus.subscribe(NATS_STREAM, "swarm.events.>", consumer, onMessage);

  req.on("close", () => {
    clearInterval(keepalive);
    if (sub) {
      sub.unsubscribe().catch(() => {});
    }
  });
}

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Swarm feed</title>
  <style>
    :root {
      --bg: #0f0f12;
      --surface: #18181c;
      --border: #2a2a30;
      --text: #e4e4e7;
      --muted: #71717a;
      --accent: #3b82f6;
      --accent-dim: #1e3a5f;
      --success: #166534;
      --warn: #854d0e;
      --danger: #991b1b;
      --radius: 8px;
      --font: 'Segoe UI', system-ui, -apple-system, sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      font-family: var(--font);
      margin: 0;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      min-height: 100vh;
    }
    .container { max-width: 960px; margin: 0 auto; padding: 1.5rem; }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 1rem;
      margin-bottom: 1.5rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid var(--border);
    }
    h1 { font-size: 1.25rem; font-weight: 600; margin: 0; letter-spacing: -0.02em; }
    .btn {
      display: inline-block;
      padding: 0.5rem 1rem;
      font-size: 0.875rem;
      font-family: inherit;
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: var(--radius);
      cursor: pointer;
      text-decoration: none;
    }
    .btn:hover { filter: brightness(1.1); }
    .btn.secondary { background: var(--surface); color: var(--text); border: 1px solid var(--border); }
    .section {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 1.25rem;
      margin-bottom: 1rem;
    }
    .section h2 {
      font-size: 0.8125rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--muted);
      margin: 0 0 0.75rem 0;
    }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 1rem; }
    .card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 1rem;
    }
    .card .label { font-size: 0.75rem; color: var(--muted); margin-bottom: 0.25rem; }
    .card .value { font-size: 0.9375rem; font-weight: 500; }
    .card .value.high { color: #f97316; }
    .card .value.mid { color: #eab308; }
    .drift-card .drift-why { margin: 0; font-size: 0.875rem; color: var(--text); }
    .drift-card .drift-suggested { margin: 0.25rem 0 0 0; padding-left: 1.25rem; font-size: 0.875rem; }
    .drift-card .drift-suggested li { margin: 0.2rem 0; }
    .drift-card .drift-refs { margin: 0.25rem 0 0 0; padding-left: 1.25rem; font-size: 0.8125rem; list-style: none; }
    .drift-card .drift-refs .drift-ref { margin: 0.35rem 0; padding: 0.25rem 0; border-bottom: 1px solid var(--border); }
    .drift-card .drift-refs .drift-ref:last-child { border-bottom: none; }
    .drift-card .ref-doc { font-weight: 500; color: var(--accent); }
    .drift-card .ref-type { color: var(--muted); font-size: 0.75rem; margin-right: 0.25rem; }
    .drift-card .ref-excerpt { display: block; margin-top: 0.15rem; color: var(--text); font-style: italic; }
    .summary-loading { color: var(--muted); font-size: 0.875rem; }
    .summary-error { color: #ef4444; font-size: 0.875rem; }
    ul.goals { margin: 0; padding-left: 1.25rem; font-size: 0.875rem; }
    ul.goals li { margin: 0.25rem 0; }
    .events-wrap { margin-top: 1.5rem; }
    #events {
      list-style: none;
      padding: 0;
      margin: 0;
      max-height: 420px;
      overflow-y: auto;
    }
    #events li {
      padding: 0.75rem 1rem;
      margin: 0.25rem 0;
      border-radius: var(--radius);
      font-size: 0.8125rem;
      border-left: 3px solid var(--border);
      background: var(--bg);
    }
    #events li .ts { color: var(--muted); font-size: 0.75rem; margin-right: 0.5rem; }
    #events li .type { font-weight: 600; color: var(--accent); }
    #events li.feed_connected { border-left-color: var(--accent); }
    #events li.bootstrap { border-left-color: var(--success); }
    #events li.state_transition { border-left-color: #6366f1; }
    #events li.facts_extracted { border-left-color: #22c55e; }
    #events li.drift_analyzed { border-left-color: #eab308; }
    #events li.context_doc { border-left-color: var(--muted); }
    #events li.resolution { border-left-color: #a78bfa; }
    #events li .payload {
      margin-top: 0.5rem;
      padding: 0.5rem;
      background: var(--surface);
      border-radius: 4px;
      font-size: 0.75rem;
      overflow-x: auto;
      max-height: 120px;
      overflow-y: auto;
    }
    #status { color: var(--muted); font-size: 0.75rem; margin-top: 0.5rem; }
    .resolution-form { margin-top: 1rem; }
    .resolution-form .label { font-size: 0.75rem; color: var(--muted); margin-bottom: 0.25rem; display: block; }
    .resolution-form textarea, .resolution-form input { width: 100%; max-width: 100%; padding: 0.5rem 0.75rem; font-family: var(--font); font-size: 0.875rem; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); margin-bottom: 0.75rem; box-sizing: border-box; }
    .resolution-form textarea { min-height: 4rem; resize: vertical; }
    .resolution-form .hint { font-size: 0.75rem; color: var(--muted); margin-top: -0.5rem; margin-bottom: 0.5rem; }
    .resolution-form .msg { font-size: 0.8125rem; margin-top: 0.5rem; }
    .resolution-form .msg.success { color: #22c55e; }
    .resolution-form .msg.error { color: #ef4444; }
    .what-changed { font-size: 0.8125rem; }
    .what-changed .event { padding: 0.5rem 0; border-bottom: 1px solid var(--border); }
    .what-changed .event:last-child { border-bottom: none; }
    .what-changed .event-type { font-weight: 500; color: var(--accent); }
    .what-changed .event-ts { color: var(--muted); font-size: 0.75rem; }
    .what-changed .event { cursor: pointer; }
    .what-changed .event-details { margin-top: 0.5rem; padding: 0.5rem; background: var(--bg); border-radius: 4px; font-size: 0.75rem; white-space: pre-wrap; word-break: break-word; }
    .finality-card .value.resolved { color: #22c55e; }
    .finality-card .value.near { color: #eab308; }
    .finality-card .value.active { color: var(--muted); }
    .dimension-breakdown, .blockers-list { font-size: 0.8125rem; margin-top: 0.5rem; }
    .state-graph table { font-size: 0.8125rem; width: 100%; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Swarm feed</h1>
      <div>
        <button class="btn" id="refreshSummary" type="button">Refresh summary</button>
        <a class="btn secondary" href="/summary?raw=1" target="_blank" rel="noopener">Summary (JSON)</a>
      </div>
    </header>

    <section class="section" id="summarySection">
      <h2>Summary</h2>
      <div id="summaryContent" class="summary-loading">Loading…</div>
    </section>

    <section class="section">
      <h2>Add resolution</h2>
      <p class="resolution-form hint">Add a manual decision so it is integrated into context. The pipeline will re-run and drift may clear. The graph and fact history will record this resolution.</p>
      <form id="resolutionForm" class="resolution-form">
        <label class="label" for="resolutionDecision">Decision</label>
        <textarea id="resolutionDecision" name="decision" placeholder="e.g. We decided to change the 20+ engineer hire target to 15+. This is the official resolution." required></textarea>
        <label class="label" for="resolutionSummary">Summary (optional)</label>
        <input type="text" id="resolutionSummary" name="summary" placeholder="e.g. Hiring target aligned to 15+">
        <button class="btn" type="submit">Submit resolution</button>
        <div id="resolutionMsg" class="msg" aria-live="polite"></div>
      </form>
    </section>

    <section class="section" id="pendingSection">
      <h2>Pending reviews</h2>
      <p id="pendingStatus">Loading…</p>
      <div id="pendingList"></div>
      <button class="btn secondary" id="refreshPending" type="button">Refresh</button>
    </section>

    <section class="section events-wrap">
      <h2>Live events</h2>
      <ul id="events"></ul>
      <p id="status">Connecting…</p>
    </section>
  </div>
  <script>
    (function() {
      const summaryContent = document.getElementById('summaryContent');
      const refreshBtn = document.getElementById('refreshSummary');
      function renderSummary(data) {
        const s = data.state;
        const f = data.facts;
        const d = data.drift;
        const w = data.what_changed || [];
        let html = '<div class="grid">';
        if (s) {
          html += '<div class="card"><div class="label">State</div><div class="value">' + escapeHtml(s.lastNode) + '</div><div class="label">Epoch ' + s.epoch + ' · ' + (s.updatedAt || '').slice(0, 19) + '</div></div>';
        }
        if (data.finality) {
          var fin = data.finality;
          var statusClass = (fin.status === 'RESOLVED' ? 'resolved' : fin.status === 'near_finality' ? 'near' : 'active');
          html += '<div class="card finality-card" style="grid-column: 1 / -1;"><div class="label">Finality (confidence)</div><div class="value ' + statusClass + '">' + escapeHtml(fin.status) + (fin.resolved ? ' (final)' : '') + '</div><div class="label">Goal score ' + (fin.goal_score != null ? (fin.goal_score * 100).toFixed(1) + '%' : '—') + ' · near ' + (fin.near_threshold != null ? (fin.near_threshold * 100) + '%' : '—') + ' · auto ' + (fin.auto_threshold != null ? (fin.auto_threshold * 100) + '%' : '—') + '</div>';
          if (fin.last_decision && fin.last_decision.option) {
            html += '<div class="label" style="margin-top: 0.25rem;">Last human decision: ' + escapeHtml(fin.last_decision.option) + (fin.last_decision.created_at ? ' at ' + escapeHtml(String(fin.last_decision.created_at).slice(0, 19)) : '') + '</div>';
          }
          if (fin.dimension_breakdown && fin.dimension_breakdown.length) {
            html += '<details class="dimension-breakdown"><summary>Dimension breakdown</summary><ul>';
            fin.dimension_breakdown.forEach(function(d) {
              html += '<li>' + escapeHtml(d.name) + ': ' + (d.score != null ? (d.score * 100).toFixed(0) + '%' : '') + ' ' + escapeHtml(d.detail || '') + ' (' + escapeHtml(d.status || '') + ')</li>';
            });
            html += '</ul></details>';
          }
          if (fin.blockers && fin.blockers.length) {
            html += '<details class="blockers-list"><summary>Blockers</summary><ul>';
            fin.blockers.forEach(function(b) {
              html += '<li>' + escapeHtml(b.type || '') + ': ' + escapeHtml(b.description || '') + '</li>';
            });
            html += '</ul></details>';
          }
          html += '</div>';
        }
        if (data.state_graph) {
          var g = data.state_graph;
          html += '<div class="card state-graph" style="grid-column: 1 / -1;"><div class="label">State graph (supporting)</div><table><tr><th>Nodes</th><td>' + (Object.keys(g.nodes || {}).length ? Object.entries(g.nodes).map(function(e) { return escapeHtml(e[0]) + ': ' + e[1]; }).join(' · ') : '—') + '</td></tr><tr><th>Edges</th><td>' + (Object.keys(g.edges || {}).length ? Object.entries(g.edges).map(function(e) { return escapeHtml(e[0]) + ': ' + e[1]; }).join(' · ') : '—') + '</td></tr></table></div>';
        }
        if (d) {
          const levelClass = (d.level === 'high' ? 'high' : d.level === 'medium' ? 'mid' : '');
          html += '<div class="card drift-card" style="grid-column: 1 / -1;"><div class="label">Drift</div><div class="value ' + levelClass + '">' + escapeHtml(d.level) + '</div><div class="label">Types: ' + (Array.isArray(d.types) ? d.types.join(', ') : '') + '</div>';
          if (Array.isArray(d.notes) && d.notes.length) {
            var genericNotes = ['automatic structured drift detection', 'initial snapshot'];
            var whyNotes = d.notes.filter(function(n){ return genericNotes.indexOf(String(n).toLowerCase()) === -1; });
            if (whyNotes.length === 0) whyNotes = d.notes;
            html += '<div class="label" style="margin-top: 0.5rem;">Why</div><p class="drift-why">' + whyNotes.map(function(n){ return escapeHtml(n); }).join(' ') + '</p>';
          }
          if (Array.isArray(d.suggested_actions) && d.suggested_actions.length) {
            html += '<div class="label" style="margin-top: 0.5rem;">Suggested</div><ul class="drift-suggested">' + d.suggested_actions.map(function(a){ return '<li>' + escapeHtml(String(a).replace(/_/g, ' ').replace(/\\b\\w/g, function(c){ return c.toUpperCase(); })) + '</li>'; }).join('') + '</ul>';
          }
          if (Array.isArray(d.references) && d.references.length) {
            html += '<div class="label" style="margin-top: 0.5rem;">Sources &amp; references</div><ul class="drift-refs">';
            d.references.forEach(function(r){
              var doc = r.doc ? '<span class="ref-doc">' + escapeHtml(r.doc) + '</span>' : '';
              var excerpt = r.excerpt ? ' <span class="ref-excerpt">' + escapeHtml(r.excerpt) + '</span>' : '';
              var type = r.type ? ' <span class="ref-type">' + escapeHtml(r.type) + '</span>' : '';
              html += '<li class="drift-ref">' + doc + type + excerpt + '</li>';
            });
            html += '</ul>';
          }
          html += '</div>';
        }
        if (f && f.goals && f.goals.length) {
          html += '<div class="card" style="grid-column: 1 / -1;"><div class="label">Goals</div><ul class="goals">' + f.goals.map(function(g){ return '<li>' + escapeHtml(g) + '</li>'; }).join('') + '</ul></div>';
        }
        html += '</div>';
        if (w.length) {
          html += '<h2 style="margin-top: 1rem;">Recent changes (click to unfold)</h2><div class="what-changed">';
          w.forEach(function(ev, idx) {
            var payloadStr = ev.payload && Object.keys(ev.payload).length ? JSON.stringify(ev.payload, null, 2) : '';
            var id = 'ev-' + idx;
            html += '<div class="event" data-id="' + id + '" role="button" tabindex="0" aria-expanded="false"><span class="event-type">' + escapeHtml(ev.type || '') + '</span> <span class="event-ts">' + (ev.ts || '').slice(0, 19) + '</span> seq ' + ev.seq + (payloadStr ? ' <span class="label">(details)</span>' : '') + '</div>';
            if (payloadStr) html += '<pre class="event-details" id="' + id + '" hidden>' + escapeHtml(payloadStr) + '</pre>';
          });
          html += '</div>';
        }
        summaryContent.innerHTML = html;
        var events = summaryContent.querySelectorAll('.what-changed .event[data-id]');
        events.forEach(function(el) {
          el.addEventListener('click', function() {
            var id = el.getAttribute('data-id');
            var details = id ? summaryContent.querySelector('#' + id) : null;
            if (details) {
              var open = details.hidden;
              details.hidden = !open;
              el.setAttribute('aria-expanded', open ? 'true' : 'false');
            }
          });
        });
      }
      function escapeHtml(str) {
        if (str == null) return '';
        var div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
      }
      function loadSummary() {
        summaryContent.textContent = 'Loading…';
        fetch('/summary').then(function(r) {
          if (!r.ok) throw new Error(r.status);
          return r.json();
        }).then(renderSummary).catch(function(e) {
          summaryContent.className = 'summary-error';
          summaryContent.textContent = 'Failed to load: ' + e.message;
        });
      }
      refreshBtn.addEventListener('click', loadSummary);
      loadSummary();

      var pendingList = document.getElementById('pendingList');
      var pendingStatus = document.getElementById('pendingStatus');
      var refreshPendingBtn = document.getElementById('refreshPending');
      function loadPending() {
        if (!pendingStatus) return;
        pendingStatus.textContent = 'Loading…';
        fetch('/pending').then(function(r) { return r.json(); }).then(function(data) {
          var list = data.pending || [];
          if (!pendingStatus) return;
          pendingStatus.textContent = list.length ? list.length + ' pending' : 'No pending reviews';
          if (!pendingList) return;
          pendingList.innerHTML = '';
          list.forEach(function(item) {
            var pid = item.proposal_id;
            var prop = item.proposal || {};
            var payload = prop.payload || {};
            if (payload.type !== 'finality_review' && prop.proposed_action !== 'finality_review') return;
            var scopeId = payload.scope_id || '—';
            var goalScore = payload.goal_score != null ? (payload.goal_score * 100).toFixed(1) + '%' : '—';
            var blockers = Array.isArray(payload.blockers) ? payload.blockers : [];
            var card = document.createElement('div');
            card.className = 'card pending-review-card';
            card.style.cssText = 'grid-column: 1 / -1; margin-bottom: 0.75rem;';
            var blockerHtml = blockers.length ? '<ul class="blockers-list">' + blockers.map(function(b) { return '<li>' + escapeHtml(b.type || '') + ': ' + escapeHtml(b.description || '') + '</li>'; }).join('') + '</ul>' : '';
            card.innerHTML = '<div class="label">' + escapeHtml(pid) + ' · scope ' + escapeHtml(scopeId) + ' · goal score ' + escapeHtml(goalScore) + '</div>' + blockerHtml + '<div class="pending-actions" style="margin-top: 0.5rem; display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center;"></div>';
            var actions = card.querySelector('.pending-actions');
            ['approve_finality', 'provide_resolution', 'escalate', 'defer'].forEach(function(opt) {
              var btn = document.createElement('button');
              btn.className = 'btn secondary';
              btn.type = 'button';
              btn.textContent = opt === 'approve_finality' ? 'Approve finality' : opt === 'provide_resolution' ? 'Provide resolution' : opt === 'escalate' ? 'Escalate' : 'Defer';
              if (opt === 'defer') {
                var wrap = document.createElement('span');
                wrap.style.display = 'inline-flex';
                wrap.style.gap = '0.25rem';
                wrap.style.alignItems = 'center';
                var inp = document.createElement('input');
                inp.type = 'number';
                inp.min = '1';
                inp.value = '7';
                inp.style.width = '3rem';
                inp.style.padding = '0.25rem';
                wrap.appendChild(btn);
                wrap.appendChild(document.createTextNode(' days'));
                wrap.appendChild(inp);
                btn = wrap;
                var realBtn = wrap.querySelector('button');
                (realBtn || btn).addEventListener('click', function() {
                  var days = parseInt(inp.value, 10) || 7;
                  fetch('/finality-response', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proposal_id: pid, option: 'defer', days: days }) }).then(function(r) { return r.json(); }).then(function(result) {
                    if (result.ok) { loadPending(); loadSummary(); } else { alert(result.error || 'Failed'); }
                  }).catch(function(e) { alert(e.message || 'Request failed'); });
                });
                actions.appendChild(wrap);
                return;
              }
              btn.addEventListener('click', function() {
                fetch('/finality-response', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proposal_id: pid, option: opt }) }).then(function(r) { return r.json(); }).then(function(result) {
                  if (result.ok) { loadPending(); loadSummary(); } else { alert(result.error || 'Failed'); }
                }).catch(function(e) { alert(e.message || 'Request failed'); });
              });
              actions.appendChild(btn);
            });
            pendingList.appendChild(card);
          });
        }).catch(function(e) {
          if (pendingStatus) pendingStatus.textContent = 'Error: ' + e.message;
          if (pendingList) pendingList.innerHTML = '';
        });
      }
      if (refreshPendingBtn) refreshPendingBtn.addEventListener('click', loadPending);
      loadPending();

      var resolutionForm = document.getElementById('resolutionForm');
      var resolutionMsg = document.getElementById('resolutionMsg');
      if (resolutionForm && resolutionMsg) {
        resolutionForm.addEventListener('submit', function(e) {
          e.preventDefault();
          var decision = document.getElementById('resolutionDecision');
          var summary = document.getElementById('resolutionSummary');
          var dec = decision && decision.value ? decision.value.trim() : '';
          if (!dec) { resolutionMsg.textContent = 'Enter a decision.'; resolutionMsg.className = 'msg error'; return; }
          resolutionMsg.textContent = 'Sending…';
          resolutionMsg.className = 'msg';
          fetch('/context/resolution', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision: dec, summary: summary && summary.value ? summary.value.trim() : '' })
          }).then(function(r) {
            return r.json().then(function(data) {
              if (r.ok) {
                resolutionMsg.textContent = data.message || 'Resolution added. Refresh summary to see updates.';
                resolutionMsg.className = 'msg success';
                if (decision) decision.value = '';
                if (summary) summary.value = '';
                loadSummary();
              } else {
                resolutionMsg.textContent = data.error || 'Request failed.';
                resolutionMsg.className = 'msg error';
              }
            });
          }).catch(function(err) {
            resolutionMsg.textContent = err.message || 'Request failed.';
            resolutionMsg.className = 'msg error';
          });
        });
      }

      var ul = document.getElementById('events');
      var status = document.getElementById('status');
      var es = new EventSource('/events');
      es.onopen = function() { status.textContent = 'Connected. Listening for swarm.events.*'; };
      es.onerror = function() { status.textContent = 'Connection closed or error.'; };
      es.onmessage = function(e) {
        try {
          var d = JSON.parse(e.data);
          var li = document.createElement('li');
          li.className = (d.type || '').replace(/\\./g, '_').split('_')[0] || 'event';
          var type = d.type || 'event';
          var ts = (d.ts || '').slice(0, 19);
          var src = d.source || '';
          var payload = d.payload && Object.keys(d.payload).length ? JSON.stringify(d.payload, null, 2) : '';
          li.innerHTML = '<span class="ts">' + escapeHtml(ts) + '</span> <span class="type">' + escapeHtml(type) + '</span>' + (src ? ' <span style="color: var(--muted)">' + escapeHtml(src) + '</span>' : '') + (payload ? '<pre class="payload">' + escapeHtml(payload) + '</pre>' : '');
          ul.insertBefore(li, ul.firstChild);
        } catch (err) {}
      };
    })();
  </script>
</body>
</html>
`;

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
