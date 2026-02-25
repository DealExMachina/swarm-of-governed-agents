/**
 * Project Horizon — Governed Swarm Demo Server
 *
 * A self-contained narrative demo UI for business audiences.
 * Orchestrates the M&A due diligence scenario step by step, streams live
 * swarm events, highlights governance interventions, and surfaces the
 * human-in-the-loop review when the system reaches near-finality.
 *
 * Usage:  npm run demo
 * Opens:  http://localhost:3003
 *
 * Prerequisites:
 *   docker compose up -d && npm run swarm:all   (in a separate terminal)
 */

import "dotenv/config";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  request as httpRequest,
} from "http";
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEMO_PORT = parseInt(process.env.DEMO_PORT ?? "3003", 10);
const FEED_URL = (process.env.FEED_URL ?? "http://127.0.0.1:3002").replace(/\/$/, "");
const MITL_URL = (process.env.MITL_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");
const DOCS_DIR = join(__dirname, "scenario", "docs");
const SWARM_API_TOKEN = process.env.SWARM_API_TOKEN ?? "";

function authHeaders(): Record<string, string> {
  if (SWARM_API_TOKEN) {
    return { Authorization: `Bearer ${SWARM_API_TOKEN}` };
  }
  return {};
}

// ---------------------------------------------------------------------------
// Load demo documents at startup
// ---------------------------------------------------------------------------

interface DemoDoc {
  index: number;
  filename: string;
  title: string;
  body: string;
  excerpt: string;
}

const DEMO_DOCS: DemoDoc[] = readdirSync(DOCS_DIR)
  .filter((f) => f.endsWith(".txt"))
  .sort()
  .map((filename, index) => {
    const body = readFileSync(join(DOCS_DIR, filename), "utf-8");
    const lines = body.split("\n").filter((l) => l.trim());
    const title = lines[0] ?? filename;
    const excerpt = lines.slice(4, 10).join(" ").slice(0, 300);
    return { index, filename, title, body, excerpt };
  });

const fedSteps = new Set<number>();

// ---------------------------------------------------------------------------
// SSE proxy: forward feed server events to connected demo UI clients
// ---------------------------------------------------------------------------

const sseClients = new Set<ServerResponse>();

function startSseProxy(): void {
  const feedEventUrl = new URL(`${FEED_URL}/events`);
  // #region agent log
  fetch('http://127.0.0.1:7243/ingest/af5b746e-3a32-49ef-92b2-aa2d9876cfd3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'demo-server.ts:startSseProxy',message:'connecting',data:{hostname:feedEventUrl.hostname,port:feedEventUrl.port,path:feedEventUrl.pathname},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  const req = httpRequest(
    {
      hostname: feedEventUrl.hostname,
      port: feedEventUrl.port || 80,
      path: feedEventUrl.pathname,
      method: "GET",
      headers: { Accept: "text/event-stream", "Cache-Control": "no-cache", ...authHeaders() },
    },
    (res) => {
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/af5b746e-3a32-49ef-92b2-aa2d9876cfd3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'demo-server.ts:startSseProxy',message:'connected',data:{statusCode:res.statusCode,clients:sseClients.size},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      let chunkCount = 0;
      res.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        chunkCount++;
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/af5b746e-3a32-49ef-92b2-aa2d9876cfd3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'demo-server.ts:startSseProxy',message:'chunk',data:{chunkCount,textLen:text.length,preview:text.slice(0,200),clients:sseClients.size},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        for (const client of sseClients) {
          if (!client.writableEnded) client.write(text);
          else sseClients.delete(client);
        }
      });
      res.on("end", () => {
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/af5b746e-3a32-49ef-92b2-aa2d9876cfd3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'demo-server.ts:startSseProxy',message:'end',data:{totalChunks:chunkCount},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        setTimeout(startSseProxy, 3000);
      });
      res.on("error", (err) => {
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/af5b746e-3a32-49ef-92b2-aa2d9876cfd3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'demo-server.ts:startSseProxy',message:'res-error',data:{error:String(err)},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        setTimeout(startSseProxy, 3000);
      });
    },
  );
  req.on("error", (err) => {
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/af5b746e-3a32-49ef-92b2-aa2d9876cfd3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'demo-server.ts:startSseProxy',message:'req-error',data:{error:String(err)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    setTimeout(startSseProxy, 3000);
  });
  req.end();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

async function proxyGet(url: string): Promise<unknown> {
  const r = await fetch(url, { headers: authHeaders() });
  return r.json();
}

async function proxyPost(url: string, body: unknown): Promise<unknown> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  return r.json();
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/** GET /api/docs — return document metadata (not body) */
function handleDocs(res: ServerResponse): void {
  sendJson(
    res,
    200,
    DEMO_DOCS.map(({ index, filename, title, excerpt }) => ({
      index,
      filename,
      title,
      excerpt,
    })),
  );
}

/** POST /api/step/:n — feed document n to the swarm feed server */
async function handleStep(n: number, res: ServerResponse): Promise<void> {
  if (fedSteps.has(n)) {
    sendJson(res, 200, { ok: true, already_fed: true, doc: { index: n, title: DEMO_DOCS[n]?.title } });
    return;
  }
  const doc = DEMO_DOCS[n];
  if (!doc) {
    sendJson(res, 404, { error: `No document at index ${n}` });
    return;
  }
  try {
    const result = await proxyPost(`${FEED_URL}/context/docs`, {
      title: doc.title,
      body: doc.body,
    });
    fedSteps.add(n);
    sendJson(res, 200, { ok: true, doc: { index: n, title: doc.title }, feed: result });
  } catch (e) {
    sendJson(res, 502, { error: String(e) });
  }
}

/** GET /api/summary — proxy to feed server */
async function handleSummary(res: ServerResponse): Promise<void> {
  try {
    const data = await proxyGet(`${FEED_URL}/summary?raw=1`);
    sendJson(res, 200, data as Record<string, unknown>);
  } catch {
    sendJson(res, 502, { error: "feed_unavailable" });
  }
}

/** GET /api/pending — proxy to MITL server */
async function handlePending(res: ServerResponse): Promise<void> {
  try {
    const data = await proxyGet(`${MITL_URL}/pending`);
    sendJson(res, 200, data as Record<string, unknown>);
  } catch {
    sendJson(res, 200, { pending: [] });
  }
}

/** POST /api/finality-response — proxy to feed server */
async function handleFinalityResponse(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw) as unknown;
    const data = await proxyPost(`${FEED_URL}/finality-response`, body);
    sendJson(res, 200, data as Record<string, unknown>);
  } catch (e) {
    sendJson(res, 502, { error: String(e) });
  }
}

/** POST /api/resolution — proxy to feed /context/resolution */
async function handleResolution(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw) as unknown;
    const data = await proxyPost(`${FEED_URL}/context/resolution`, body);
    sendJson(res, 200, data as Record<string, unknown>);
  } catch (e) {
    sendJson(res, 502, { error: String(e) });
  }
}

/** POST /api/reset — clear all swarm state for a fresh demo run */
async function handleReset(res: ServerResponse): Promise<void> {
  const errors: string[] = [];

  // 1. Clear Postgres tables
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    const pool = new pg.Pool({ connectionString: dbUrl, max: 1 });
    try {
      const tables = [
        "context_events", "swarm_state", "edges", "nodes",
        "convergence_history", "decision_records", "finality_certificates",
        "mitl_pending", "scope_finality_decisions", "processed_messages",
        "agent_memory", "filter_configs",
      ];
      for (const t of tables) {
        try { await pool.query(`DELETE FROM ${t}`); } catch { /* table may not exist */ }
      }
    } catch (e) {
      errors.push(`db: ${e}`);
    } finally {
      await pool.end();
    }
  } else {
    errors.push("db: DATABASE_URL not set");
  }

  // 2. Clear S3/MinIO facts and drift
  const s3Endpoint = process.env.S3_ENDPOINT;
  const s3Bucket = process.env.S3_BUCKET ?? "swarm";
  if (s3Endpoint) {
    const s3 = new S3Client({
      region: process.env.S3_REGION || "us-east-1",
      endpoint: s3Endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY ?? "minioadmin",
        secretAccessKey: process.env.S3_SECRET_KEY ?? "minioadmin",
      },
    });
    for (const prefix of ["facts/", "drift/"]) {
      try {
        const list = await s3.send(new ListObjectsV2Command({ Bucket: s3Bucket, Prefix: prefix, MaxKeys: 1000 }));
        const keys = (list.Contents ?? []).map(c => c.Key!).filter(Boolean);
        if (keys.length > 0) {
          await s3.send(new DeleteObjectsCommand({
            Bucket: s3Bucket,
            Delete: { Objects: keys.map(Key => ({ Key })) },
          }));
        }
      } catch (e) {
        errors.push(`s3(${prefix}): ${e}`);
      }
    }
    s3.destroy();
  } else {
    errors.push("s3: S3_ENDPOINT not set");
  }

  // 3. Reset in-memory demo state
  fedSteps.clear();

  sendJson(res, 200, { ok: true, errors: errors.length ? errors : undefined });
}

/** GET /api/events — SSE stream proxied from feed server */
function handleEvents(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  res.write(
    `data: ${JSON.stringify({ type: "demo_connected", ts: new Date().toISOString() })}\n\n`,
  );

  sseClients.add(res);
  const keepalive = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(keepalive);
      sseClients.delete(res);
      return;
    }
    res.write(": keepalive\n\n");
  }, 20000);

  req.on("close", () => {
    clearInterval(keepalive);
    sseClients.delete(res);
  });
}

// ---------------------------------------------------------------------------
// Embedded HTML/CSS/JS — the full demo UI
// ---------------------------------------------------------------------------

const DEMO_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Project Horizon — Governed Swarm Demo</title>
  <meta name="theme-color" content="#0b0d12">
  <style>
    :root {
      --bg: #0b0d12; --surface: #13151c; --surface2: #1a1d27;
      --border: #252836; --border2: #303448;
      --text: #e2e4f0; --muted: #6b7080;
      --accent: #4f8ef7; --accent-dim: #1a2d55;
      --green: #22c55e; --green-dim: #14532d;
      --amber: #f59e0b; --amber-dim: #451a03;
      --red: #ef4444; --red-dim: #450a0a;
      --purple: #a78bfa; --purple-dim: #2e1065;
      --radius: 8px;
      --font: 'Inter','Segoe UI',system-ui,-apple-system,sans-serif;
      --mono: 'JetBrains Mono','Fira Code','Cascadia Code',monospace;
    }
    *{box-sizing:border-box;margin:0;padding:0}
    html{height:100%}
    html,body{min-height:100%;overflow:auto}
    body{font-family:var(--font);background:#0b0d12;background:var(--bg);color:#e2e4f0;color:var(--text);font-size:14px;line-height:1.5;display:flex;flex-direction:column}

    /* Intro */
    .intro-overlay{position:fixed;top:0;right:0;bottom:0;left:0;background:#0b0d12;background:var(--bg);display:flex;align-items:center;justify-content:center;z-index:50;flex-direction:column;gap:1.5rem;padding:2rem;text-align:center}
    .intro-overlay.hidden{display:none}
    .intro-title{font-size:2.25rem;font-weight:800;letter-spacing:-0.04em;color:#4f8ef7;color:var(--accent)}
    @supports (background-clip:text) or (-webkit-background-clip:text){
      .intro-title{background:linear-gradient(135deg,var(--accent),var(--purple));background-clip:text;-webkit-background-clip:text;-webkit-text-fill-color:transparent}
    }
    .intro-sub{font-size:1rem;color:var(--muted);max-width:560px;line-height:1.7}
    .intro-actions{display:flex;gap:0.75rem;margin-top:0.5rem;align-items:center}
    .begin-btn{padding:0.75rem 2.5rem;font-size:1rem;font-weight:700;background:var(--accent);color:#fff;border:none;border-radius:var(--radius);cursor:pointer;font-family:var(--font);transition:filter .15s}
    .begin-btn:hover{filter:brightness(1.1)}
    .reset-btn{padding:0.75rem 1.5rem;font-size:0.875rem;font-weight:600;background:transparent;color:var(--muted);border:1px solid var(--border2);border-radius:var(--radius);cursor:pointer;font-family:var(--font);transition:all .2s}
    .reset-btn:hover{color:var(--red);border-color:var(--red)}
    .reset-btn:disabled{opacity:0.5;cursor:not-allowed}
    .reset-msg{font-size:0.75rem;color:var(--green);min-height:1.2em;margin-top:0.25rem}
    .svc-status{display:flex;align-items:center;gap:0.5rem;margin-top:0.75rem;font-size:0.8125rem;color:var(--muted)}
    .svc-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
    .svc-dot.checking{background:var(--muted);animation:pulse 1s infinite}
    .svc-dot.ok{background:var(--green)}
    .svc-dot.down{background:var(--red)}
    .begin-btn:disabled{opacity:0.5;cursor:not-allowed;filter:none}

    /* Topbar */
    .topbar{display:flex;align-items:center;justify-content:space-between;padding:0 1.25rem;height:48px;border-bottom:1px solid var(--border);background:var(--surface);flex-shrink:0}
    .topbar-left{display:flex;align-items:center;gap:0.75rem}
    .brand{font-size:0.875rem;font-weight:700;color:var(--text)}
    .brand-sub{font-size:0.75rem;color:var(--muted)}
    .status-pill{display:inline-flex;align-items:center;gap:0.3rem;padding:0.15rem 0.6rem;border-radius:99px;font-size:0.6875rem;font-weight:600;letter-spacing:0.04em;text-transform:uppercase}
    .pill-dot{width:6px;height:6px;border-radius:50%}
    .pill-idle{background:var(--surface2);color:var(--muted);border:1px solid var(--border2)} .pill-idle .pill-dot{background:var(--muted)}
    .pill-running{background:var(--accent-dim);color:var(--accent);border:1px solid var(--accent)} .pill-running .pill-dot{background:var(--accent);animation:pulse 1s infinite}
    .pill-hitl{background:var(--purple-dim);color:var(--purple);border:1px solid var(--purple)} .pill-hitl .pill-dot{background:var(--purple);animation:pulse 1s infinite}
    .pill-done{background:var(--green-dim);color:var(--green);border:1px solid var(--green)} .pill-done .pill-dot{background:var(--green)}
    .pill-error{background:var(--red-dim);color:var(--red);border:1px solid var(--red)} .pill-error .pill-dot{background:var(--red)}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}

    /* Main grid */
    .main{display:grid;grid-template-columns:240px 1fr 280px;flex:1;min-height:0;overflow:hidden;background:var(--bg)}
    .panel{display:flex;flex-direction:column;border-right:1px solid var(--border);overflow:hidden}
    .panel:last-child{border-right:none}
    .panel-header{padding:0.6rem 1rem;font-size:0.6875rem;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--muted);border-bottom:1px solid var(--border);background:var(--surface);flex-shrink:0}
    .panel-body{flex:1;overflow-y:auto;padding:1rem}

    /* Left: Timeline */
    .left-panel{background:var(--surface)}
    .timeline{display:flex;flex-direction:column}
    .tl-step{display:flex;align-items:flex-start;gap:0.75rem;position:relative;padding:0.6rem 0}
    .tl-step::before{content:'';position:absolute;left:13px;top:32px;bottom:0;width:2px;background:var(--border)}
    .tl-step:last-child::before{display:none}
    .tl-dot{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:0.7rem;font-weight:700;flex-shrink:0;background:var(--surface2);border:2px solid var(--border);color:var(--muted);z-index:1;transition:all .3s}
    .tl-step.active .tl-dot{border-color:var(--accent);color:var(--accent);background:var(--accent-dim)}
    .tl-step.done .tl-dot{border-color:var(--green);color:#fff;background:var(--green)}
    .tl-step.blocked .tl-dot{border-color:var(--amber);color:#000;background:var(--amber)}
    .tl-step.hitl .tl-dot{border-color:var(--purple);color:#fff;background:var(--purple)}
    .tl-content{flex:1;min-width:0}
    .tl-title{font-size:0.8125rem;font-weight:600;color:var(--text)}
    .tl-sub{font-size:0.6875rem;color:var(--muted)}
    .tl-result{font-size:0.6875rem;margin-top:2px;font-weight:500}
    .tl-result.done{color:var(--green)} .tl-result.blocked{color:var(--amber)} .tl-result.hitl{color:var(--purple)}
    .tl-tag{display:inline-block;font-size:0.5625rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:1px 5px;border-radius:3px;margin-top:2px}
    .tl-tag.approved{background:var(--green-dim);color:var(--green)} .tl-tag.blocked{background:var(--amber-dim);color:var(--amber)} .tl-tag.hitl{background:var(--purple-dim);color:var(--purple)}

    /* Left panel step count (bottom) */
    .tl-progress{margin-top:auto;padding-top:0.75rem;border-top:1px solid var(--border);font-size:0.6875rem;color:var(--muted);text-align:center}

    /* Center: Stage */
    .center-panel{display:flex;flex-direction:column;overflow:hidden}
    .stage-header{display:flex;align-items:center;justify-content:space-between;padding:0.6rem 1rem;font-size:0.6875rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);border-bottom:1px solid var(--border);background:var(--surface);flex-shrink:0}
    .stage-label{font-size:0.75rem;color:var(--accent);font-weight:600;text-transform:none;letter-spacing:0}
    .stage{flex:1;overflow-y:auto;padding:1.25rem;display:flex;flex-direction:column;gap:1rem}
    .stage-initial{font-size:0.875rem;color:var(--text);line-height:1.7}
    .stage-initial code{background:var(--surface);padding:0.15rem 0.4rem;border-radius:4px;font-family:var(--mono);font-size:0.8rem}
    .stage-initial .prereq{padding:0.75rem;background:var(--amber-dim);border:1px solid var(--amber);border-radius:var(--radius);margin-top:0.75rem;font-size:0.8125rem}

    /* Doc card */
    .doc-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;animation:fadeIn .3s ease}
    .doc-card-head{padding:0.6rem 0.9rem;background:var(--surface2);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
    .doc-card-title{font-size:0.8125rem;font-weight:600;color:var(--text)}
    .doc-card-role{font-size:0.6875rem;color:var(--muted)}
    .doc-card-body{padding:0.75rem 0.9rem;font-size:0.8rem;color:var(--muted);line-height:1.6}
    .doc-card-status{display:inline-flex;align-items:center;gap:0.3rem;font-size:0.6875rem;font-weight:600;padding:0.15rem 0.5rem;border-radius:4px}
    .doc-card-status.feeding{background:var(--accent-dim);color:var(--accent)} .doc-card-status.done{background:var(--green-dim);color:var(--green)}

    /* Agent cards */
    .agent-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:0.75rem 0.9rem;display:flex;align-items:flex-start;gap:0.65rem;animation:fadeIn .4s ease}
    .agent-card.accent{border-left:3px solid var(--accent)} .agent-card.amber{border-left:3px solid var(--amber)} .agent-card.red{border-left:3px solid var(--red)} .agent-card.green{border-left:3px solid var(--green)} .agent-card.purple{border-left:3px solid var(--purple)}
    .agent-icon{width:28px;height:28px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:0.7rem;font-weight:800;color:#fff;flex-shrink:0}
    .agent-icon.accent{background:var(--accent)} .agent-icon.amber{background:var(--amber)} .agent-icon.red{background:var(--red)} .agent-icon.green{background:var(--green)} .agent-icon.purple{background:var(--purple)}
    .agent-card-content{flex:1;min-width:0}
    .agent-card-name{font-size:0.75rem;font-weight:700;color:var(--text)}
    .agent-card-msg{font-size:0.8rem;color:var(--muted);margin-top:2px;line-height:1.5}

    /* Step summary */
    .step-summary{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:0.75rem 0.9rem;border-left:3px solid var(--accent);animation:fadeIn .3s ease}
    .step-summary-title{font-size:0.6875rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);margin-bottom:0.3rem}
    .step-summary-body{font-size:0.8125rem;color:var(--text);line-height:1.6}

    /* HITL panel */
    .hitl-panel{animation:fadeIn .4s ease}
    .hitl-section{margin-bottom:1.25rem}
    .hitl-section-title{font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--purple);margin-bottom:0.5rem}
    .hitl-narrative{font-size:0.875rem;color:var(--text);line-height:1.7;margin-bottom:0.75rem}
    .hitl-blockers{display:flex;flex-direction:column;gap:0.5rem}
    .hitl-blocker{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:0.65rem 0.8rem;border-left:3px solid var(--amber)}
    .hitl-blocker-title{font-size:0.8125rem;font-weight:700;color:var(--amber)}
    .hitl-blocker-desc{font-size:0.8rem;color:var(--text);margin-top:2px}
    .hitl-blocker-hint{font-size:0.75rem;color:var(--muted);margin-top:4px;line-height:1.5}
    .hitl-dims{display:flex;flex-direction:column;gap:0.5rem}
    .hitl-dim{display:flex;align-items:center;gap:0.5rem}
    .hitl-dim-name{font-size:0.75rem;color:var(--muted);width:150px;flex-shrink:0}
    .hitl-dim-bar{flex:1;height:6px;background:var(--surface2);border-radius:3px;overflow:hidden}
    .hitl-dim-fill{height:100%;border-radius:3px;transition:width .6s ease}
    .hitl-dim-fill.accent{background:var(--accent)} .hitl-dim-fill.amber{background:var(--amber)} .hitl-dim-fill.purple{background:var(--purple)} .hitl-dim-fill.red{background:var(--red)} .hitl-dim-fill.green{background:var(--green)}
    .hitl-dim-val{font-size:0.75rem;font-weight:600;color:var(--text);width:36px;text-align:right}
    .hitl-dim-explain{font-size:0.6875rem;color:var(--muted);padding-left:150px;margin-top:-2px}
    .hitl-options{display:flex;flex-direction:column;gap:0.5rem}
    .hitl-option{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:0.75rem 0.9rem;cursor:pointer;text-align:left;font-family:var(--font);transition:border-color .15s;display:block;width:100%}
    .hitl-option:hover{border-color:var(--accent)}
    .hitl-option.primary{border-color:var(--green);background:var(--green-dim)}
    .hitl-option.primary:hover{filter:brightness(1.1)}
    .hitl-option-name{font-size:0.8125rem;font-weight:700;color:var(--text)}
    .hitl-option-desc{font-size:0.75rem;color:var(--muted);margin-top:2px;line-height:1.5}

    /* Resolution input */
    .resolution-area{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:0.75rem 0.9rem;animation:fadeIn .3s ease}
    .resolution-area textarea{width:100%;background:var(--surface2);border:1px solid var(--border2);border-radius:6px;color:var(--text);font-family:var(--font);font-size:0.8125rem;padding:0.6rem;resize:vertical;margin:0.5rem 0}
    .resolution-submit{padding:0.5rem 1.2rem;font-size:0.8125rem;font-weight:600;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer;font-family:var(--font)}

    /* Error / timeout */
    .stage-error{background:var(--red-dim);border:1px solid var(--red);border-radius:var(--radius);padding:1rem;color:var(--text);font-size:0.875rem;line-height:1.6;animation:fadeIn .3s ease}
    .stage-error strong{color:var(--red);display:block;margin-bottom:0.4rem}
    .stage-error code{background:var(--surface);padding:0.15rem 0.4rem;border-radius:4px;font-family:var(--mono);font-size:0.8rem}

    /* End situation / knowledge at a glance */
    .situation-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1rem 1.1rem;margin-bottom:1rem;animation:fadeIn .3s ease}
    .situation-card .situation-title{font-size:0.6875rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:0.5rem}
    .situation-line{font-size:0.9375rem;color:var(--text);line-height:1.6;margin-bottom:0.75rem}
    .situation-line strong{color:var(--text);font-weight:700}
    .situation-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:0.5rem;margin-bottom:0.75rem}
    .situation-stat{text-align:center;padding:0.5rem;background:var(--surface2);border-radius:6px;border:1px solid var(--border)}
    .situation-stat-num{font-size:1.25rem;font-weight:800;color:var(--text);display:block;line-height:1.2}
    .situation-stat-label{font-size:0.625rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-top:2px}
    .situation-stat.claims .situation-stat-num{color:var(--accent)}
    .situation-stat.goals .situation-stat-num{color:var(--purple)}
    .situation-stat.contra .situation-stat-num{color:var(--amber)}
    .situation-stat.risks .situation-stat-num{color:var(--red)}
    .situation-drift{font-size:0.8125rem;color:var(--muted);margin-bottom:0.5rem}
    .situation-drift strong{color:var(--text)}
    .situation-goals-title{font-size:0.6875rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0.5rem 0 0.35rem}
    .situation-goals-list{list-style:none;padding:0;margin:0;font-size:0.8125rem;color:var(--text);line-height:1.5}
    .situation-goals-list li{padding:0.25rem 0;padding-left:1rem;position:relative}
    .situation-goals-list li::before{content:'';position:absolute;left:0;top:0.55em;width:4px;height:4px;border-radius:50%;background:var(--purple)}
    .statement-of-position{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1.1rem 1.25rem;margin-bottom:1.25rem;border-left:4px solid var(--accent);animation:fadeIn .35s ease}
    .statement-of-position .statement-title{font-size:0.6875rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--accent);margin-bottom:0.6rem}
    .statement-of-position .statement-body{font-size:0.9375rem;color:var(--text);line-height:1.7}
    .statement-of-position .statement-body p{margin:0 0 0.6rem 0}
    .statement-of-position .statement-body p:last-child{margin-bottom:0}
    .statement-of-position .statement-resolutions{font-size:0.875rem;color:var(--text);margin-top:0.5rem;padding-top:0.5rem;border-top:1px solid var(--border)}
    .statement-of-position .statement-resolutions strong{font-size:0.75rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}

    /* Final report */
    .report{animation:fadeIn .4s ease}
    .report-header{text-align:center;margin-bottom:1.5rem}
    .report-icon{font-size:2.5rem;color:var(--green);margin-bottom:0.5rem}
    .report-title{font-size:1.5rem;font-weight:700;color:var(--text)}
    .report-sub{font-size:0.875rem;color:var(--muted);margin-top:0.25rem}
    .report-section{margin-bottom:1.25rem}
    .report-section-title{font-size:0.6875rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);margin-bottom:0.4rem}
    .report-row{display:flex;justify-content:space-between;padding:0.35rem 0;border-bottom:1px solid var(--border);font-size:0.8125rem}
    .report-row-label{color:var(--muted)} .report-row-value{color:var(--text);font-weight:600}
    .report-step{display:flex;gap:0.5rem;padding:0.4rem 0;border-bottom:1px solid var(--border);font-size:0.8125rem}
    .report-step-num{color:var(--accent);font-weight:700;flex-shrink:0;width:20px}
    .report-step-text{color:var(--text)}
    .report-step-tag{font-size:0.625rem;font-weight:600;padding:1px 4px;border-radius:3px;flex-shrink:0}

    /* Right panel */
    .right-panel{background:var(--surface);display:flex;flex-direction:column}
    .right-body{flex:1;overflow-y:auto;padding:0.75rem}
    .r-section{margin-bottom:1rem}
    .r-label{font-size:0.6875rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:0.4rem}
    .r-score{font-size:2rem;font-weight:800;color:var(--text);line-height:1}
    .r-score-sub{font-size:0.6875rem;color:var(--muted);margin-top:0.2rem}
    .r-track{height:8px;background:var(--surface2);border-radius:4px;position:relative;margin-top:0.5rem;overflow:visible}
    .r-track-fill{height:100%;border-radius:4px;background:var(--accent);transition:width .8s ease;width:0}
    .r-track-mark{position:absolute;top:-2px;width:2px;height:12px;border-radius:1px}
    .r-legend{display:flex;gap:0.75rem;margin-top:0.5rem;font-size:0.5625rem;color:var(--muted);flex-wrap:wrap}
    .r-legend-dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:3px;vertical-align:middle}

    /* Confidence dims */
    .dim-row{margin-bottom:0.5rem}
    .dim-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:2px}
    .dim-name{font-size:0.6875rem;color:var(--muted)}
    .dim-val{font-size:0.6875rem;font-weight:600;color:var(--text)}
    .dim-bar{height:4px;background:var(--surface2);border-radius:2px;overflow:hidden}
    .dim-fill{height:100%;border-radius:2px;transition:width .6s ease;width:0}
    .dim-fill.accent{background:var(--accent)} .dim-fill.amber{background:var(--amber)} .dim-fill.purple{background:var(--purple)} .dim-fill.red{background:var(--red)}
    .dim-hint{font-size:0.5625rem;color:var(--muted);margin-top:1px;display:none}
    .dim-row:hover .dim-hint{display:block}

    /* Knowledge counts */
    .counts-grid{display:grid;grid-template-columns:1fr 1fr;gap:0.4rem}
    .count-card{background:var(--surface2);border-radius:6px;padding:0.5rem;text-align:center}
    .count-num{font-size:1.125rem;font-weight:700;color:var(--text);transition:all .3s}
    .count-label{font-size:0.5625rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
    .count-num.pop{color:var(--accent);transform:scale(1.15)}

    /* Drift badge */
    .drift-badge{display:inline-flex;align-items:center;gap:0.3rem;padding:0.2rem 0.6rem;border-radius:4px;font-size:0.75rem;font-weight:600;background:var(--surface2);color:var(--muted);border:1px solid var(--border);transition:all .3s}
    .drift-badge.none{color:var(--green);border-color:var(--green-dim)}
    .drift-badge.low{color:var(--green);border-color:var(--green)}
    .drift-badge.medium{color:var(--amber);border-color:var(--amber);background:var(--amber-dim)}
    .drift-badge.high{color:var(--red);border-color:var(--red);background:var(--red-dim)}

    /* Activity feed */
    .feed-log{display:flex;flex-direction:column;gap:0.25rem;max-height:200px;overflow-y:auto}
    .feed-item{font-size:0.6875rem;color:var(--muted);padding:0.2rem 0;border-bottom:1px solid var(--border);animation:fadeIn .2s ease;display:flex;gap:0.4rem}
    .feed-item-ts{color:var(--muted);flex-shrink:0;font-family:var(--mono);font-size:0.625rem}
    .feed-item-msg{color:var(--text)}
    .feed-item.facts .feed-item-msg{color:var(--accent)}
    .feed-item.drift .feed-item-msg{color:var(--amber)}
    .feed-item.gov .feed-item-msg{color:var(--green)}
    .feed-item.hitl .feed-item-msg{color:var(--purple)}
    .feed-item.error .feed-item-msg{color:var(--red)}

    /* Situation: unfoldable groups and cards */
    .situation-group{margin-bottom:0.5rem;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;background:var(--surface2)}
    .situation-group summary{font-size:0.75rem;font-weight:600;color:var(--text);padding:0.5rem 0.65rem;cursor:pointer;list-style:none;display:flex;align-items:center;justify-content:space-between;user-select:none}
    .situation-group summary::-webkit-details-marker{display:none}
    .situation-group summary::after{content:'';width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid var(--muted);margin-left:0.25rem;transition:transform .2s}
    .situation-group[open] summary::after{transform:rotate(180deg)}
    .situation-group-count{font-size:0.6875rem;color:var(--muted);font-weight:500}
    .situation-cards{display:flex;flex-direction:column;gap:0.35rem;padding:0.5rem 0.65rem 0.65rem;border-top:1px solid var(--border)}
    .situation-card{font-size:0.75rem;padding:0.4rem 0.55rem;border-radius:6px;border-left:3px solid;background:var(--surface);color:var(--text);line-height:1.4;cursor:default;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:background .15s}
    .situation-card:hover{background:var(--border2)}
    .situation-card.type-claim{border-left-color:var(--accent)}
    .situation-card.type-goal{border-left-color:var(--purple)}
    .situation-card.type-risk{border-left-color:var(--red)}
    .situation-card.type-contradiction{border-left-color:var(--amber)}
    .situation-card.situation-new{animation:fadeIn .35s ease}
    .situation-card .situation-new-badge{font-size:0.5625rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--accent);margin-left:0.35rem}
    .situation-empty{font-size:0.6875rem;color:var(--muted);padding:0.5rem 0.65rem;font-style:italic}

    @keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
    ::-webkit-scrollbar{width:5px;height:5px} ::-webkit-scrollbar-track{background:transparent} ::-webkit-scrollbar-thumb{background:var(--border2);border-radius:99px}

    /* HITL Modal overlay */
    .hitl-modal-backdrop{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(11,13,18,0.88);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);z-index:100;display:flex;align-items:center;justify-content:center;padding:2rem;animation:modalFadeIn .3s ease}
    .hitl-modal-backdrop.hidden{display:none}
    .hitl-modal{background:var(--surface);border:1px solid var(--border2);border-radius:14px;max-width:700px;width:100%;max-height:85vh;overflow-y:auto;box-shadow:0 24px 80px rgba(0,0,0,0.6),0 0 0 1px rgba(79,142,247,0.12);animation:modalSlideIn .4s ease}
    .hitl-modal-header{display:flex;align-items:center;gap:0.85rem;padding:1.25rem 1.5rem;border-bottom:1px solid var(--border);background:var(--surface2);border-radius:14px 14px 0 0;position:sticky;top:0;z-index:1}
    .hitl-modal-header-icon{width:46px;height:46px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:1.3rem;font-weight:800;flex-shrink:0;color:#fff}
    .hitl-modal-header-icon.purple{background:var(--purple);box-shadow:0 0 24px rgba(167,139,250,0.5);animation:pulseGlowPurple 2s infinite}
    .hitl-modal-header-icon.amber{background:var(--amber);color:#000;box-shadow:0 0 24px rgba(245,158,11,0.5);animation:pulseGlowAmber 2s infinite}
    .hitl-modal-header-text{flex:1}
    .hitl-modal-header-title{font-size:1.25rem;font-weight:800;color:var(--text);letter-spacing:-0.02em}
    .hitl-modal-header-sub{font-size:0.8125rem;color:var(--muted);margin-top:3px}
    .hitl-modal-body{padding:1.5rem}
    .hitl-modal .hitl-section{margin-bottom:1.5rem}
    .hitl-modal .hitl-section-title{font-size:0.8125rem}
    .hitl-modal .hitl-narrative{font-size:0.9375rem;line-height:1.75}
    .hitl-modal .hitl-options{gap:0.75rem}
    .hitl-modal .hitl-option{padding:1rem 1.2rem;border:2px solid var(--border);transition:border-color .2s,box-shadow .2s,background .2s}
    .hitl-modal .hitl-option:hover{border-color:var(--accent);background:var(--surface2)}
    .hitl-modal .hitl-option.primary{border-color:var(--green);background:linear-gradient(135deg,var(--green-dim),rgba(20,83,45,0.5));box-shadow:0 0 20px rgba(34,197,94,0.1)}
    .hitl-modal .hitl-option.primary:hover{box-shadow:0 0 30px rgba(34,197,94,0.25);border-color:#4ade80}
    .hitl-modal .hitl-option.primary .hitl-option-name{font-size:1rem;color:var(--green)}
    .hitl-modal .situation-card{margin-bottom:0}
    @keyframes modalFadeIn{from{opacity:0}to{opacity:1}}
    @keyframes modalSlideIn{from{opacity:0;transform:translateY(24px) scale(0.96)}to{opacity:1;transform:none}}
    @keyframes pulseGlowPurple{0%,100%{box-shadow:0 0 24px rgba(167,139,250,0.5)}50%{box-shadow:0 0 40px rgba(167,139,250,0.8)}}
    @keyframes pulseGlowAmber{0%,100%{box-shadow:0 0 24px rgba(245,158,11,0.5)}50%{box-shadow:0 0 40px rgba(245,158,11,0.8)}}
  </style>
</head>
<body>

<!-- Intro -->
<div class="intro-overlay" id="introOverlay">
  <div class="intro-title">Project Horizon</div>
  <div class="intro-sub">
    Watch a governed agent swarm process five M&amp;A due diligence documents.
    See how agents extract facts, detect contradictions, and why the system
    requests human judgment when it reaches the limits of autonomous resolution.
  </div>
  <div class="svc-status" id="svcStatus">
    <div class="svc-dot checking" id="svcDot"></div>
    <span id="svcText">Checking services...</span>
  </div>
  <div class="intro-actions">
    <button class="begin-btn" id="beginBtn" onclick="beginDemo()" disabled>Begin</button>
    <button class="reset-btn" id="resetBtn" onclick="resetDemo()">Reset state</button>
  </div>
  <div class="reset-msg" id="resetMsg"></div>
</div>

<!-- Topbar -->
<div class="topbar">
  <div class="topbar-left">
    <span class="brand">Project Horizon</span>
    <span class="brand-sub">&nbsp;&middot;&nbsp;Governed Swarm Demo</span>
  </div>
  <div style="display:flex;align-items:center;gap:0.75rem">
    <div id="statusPill" class="status-pill pill-idle">
      <div class="pill-dot"></div>
      <span id="statusText">Ready</span>
    </div>
    <button class="reset-btn" style="padding:0.25rem 0.75rem;font-size:0.6875rem" onclick="restartDemo()">Restart</button>
  </div>
</div>

<!-- Main grid -->
<div class="main">

  <!-- Left: Timeline -->
  <div class="panel left-panel">
    <div class="panel-header">Timeline</div>
    <div class="panel-body">
      <div class="timeline" id="timeline"></div>
      <div class="tl-progress" id="tlProgress">Step 0 / 5</div>
    </div>
  </div>

  <!-- Center: Stage -->
  <div class="panel center-panel">
    <div class="stage-header">
      <span>Stage</span>
      <span class="stage-label" id="stageLabel"></span>
    </div>
    <div class="stage" id="stage">
      <div class="stage-initial">
        <p><strong>Click Begin</strong> to start. The demo feeds 5 documents to the swarm one by one. You will see each agent process them in real time.</p>
        <div class="prereq"><strong>Prerequisite:</strong> run <code>npm run swarm:all</code> in another terminal so agents can process documents.</div>
      </div>
    </div>
  </div>

  <!-- Right: Knowledge State -->
  <div class="panel right-panel">
    <div class="panel-header">Knowledge State</div>
    <div class="right-body">

      <div class="r-section">
        <div class="r-label">Finality Score</div>
        <div class="r-score" id="rScore">0%</div>
        <div class="r-score-sub" id="rScoreSub">Agents processing</div>
        <div class="r-track">
          <div class="r-track-fill" id="rTrackFill"></div>
          <div class="r-track-mark" style="left:75%;background:var(--amber)"></div>
          <div class="r-track-mark" style="left:92%;background:var(--green)"></div>
        </div>
        <div class="r-legend">
          <span><span class="r-legend-dot" style="background:var(--amber)"></span>75% near-finality</span>
          <span><span class="r-legend-dot" style="background:var(--green)"></span>92% auto-resolve</span>
        </div>
      </div>

      <div class="r-section" id="dimsSection">
        <div class="r-label">Confidence Dimensions</div>
        <div class="dim-row">
          <div class="dim-head"><span class="dim-name">Claim confidence</span><span class="dim-val" id="dClaim">--</span></div>
          <div class="dim-bar"><div class="dim-fill accent" id="dClaimBar"></div></div>
          <div class="dim-hint">How reliable are the extracted facts? Based on source agreement.</div>
        </div>
        <div class="dim-row">
          <div class="dim-head"><span class="dim-name">Contradiction resolution</span><span class="dim-val" id="dContra">--</span></div>
          <div class="dim-bar"><div class="dim-fill amber" id="dContraBar"></div></div>
          <div class="dim-hint">Fraction of contradictions resolved. Unresolved ones pull the score down.</div>
        </div>
        <div class="dim-row">
          <div class="dim-head"><span class="dim-name">Goal completion</span><span class="dim-val" id="dGoal">--</span></div>
          <div class="dim-bar"><div class="dim-fill purple" id="dGoalBar"></div></div>
          <div class="dim-hint">Due diligence goals with a recorded resolution. Need 90% for auto-close.</div>
        </div>
        <div class="dim-row">
          <div class="dim-head"><span class="dim-name">Risk score</span><span class="dim-val" id="dRisk">--</span></div>
          <div class="dim-bar"><div class="dim-fill red" id="dRiskBar"></div></div>
          <div class="dim-hint">Inverse of active risk severity. Critical risks lower this dimension.</div>
        </div>
      </div>

      <div class="r-section">
        <div class="r-label">Knowledge Graph</div>
        <div class="counts-grid">
          <div class="count-card"><div class="count-num" id="cClaims">0</div><div class="count-label">Claims</div></div>
          <div class="count-card"><div class="count-num" id="cGoals">0</div><div class="count-label">Goals</div></div>
          <div class="count-card"><div class="count-num" id="cContra">0</div><div class="count-label">Contradictions</div></div>
          <div class="count-card"><div class="count-num" id="cRisks">0</div><div class="count-label">Risks</div></div>
        </div>
      </div>

      <div class="r-section" id="situationSection">
        <div class="r-label">Situation</div>
        <div id="situationPanel">
          <details class="situation-group" id="situation-claims" open>
            <summary>Claims <span class="situation-group-count" id="situation-claims-count">0</span></summary>
            <div class="situation-cards" id="situation-claims-cards"></div>
          </details>
          <details class="situation-group" id="situation-goals">
            <summary>Goals <span class="situation-group-count" id="situation-goals-count">0</span></summary>
            <div class="situation-cards" id="situation-goals-cards"></div>
          </details>
          <details class="situation-group" id="situation-risks">
            <summary>Risks <span class="situation-group-count" id="situation-risks-count">0</span></summary>
            <div class="situation-cards" id="situation-risks-cards"></div>
          </details>
          <details class="situation-group" id="situation-contradictions">
            <summary>Contradictions <span class="situation-group-count" id="situation-contradictions-count">0</span></summary>
            <div class="situation-cards" id="situation-contradictions-cards"></div>
          </details>
        </div>
      </div>

      <div class="r-section">
        <div class="r-label">Drift</div>
        <div class="drift-badge none" id="driftBadge">None</div>
      </div>

      <div class="r-section">
        <div class="r-label">Activity</div>
        <div class="feed-log" id="feedLog"></div>
      </div>

    </div>
  </div>
</div>

<!-- HITL Modal -->
<div id="hitlModalBackdrop" class="hitl-modal-backdrop hidden">
  <div class="hitl-modal">
    <div class="hitl-modal-header" id="hitlModalHeader">
      <div class="hitl-modal-header-icon purple" id="hitlModalIcon">?</div>
      <div class="hitl-modal-header-text">
        <div class="hitl-modal-header-title" id="hitlModalTitle">Action Required</div>
        <div class="hitl-modal-header-sub" id="hitlModalSub">The system is paused and waiting for your decision</div>
      </div>
    </div>
    <div class="hitl-modal-body" id="hitlModalBody"></div>
  </div>
</div>

<script>
(function() {
  var STEPS = [
    { n:0, title:'Initial Analyst Briefing', sub:'Baseline', role:'Corporate Development Analyst',
      insight:'Baseline established. ARR EUR 50M, 7 patents, 45% CAGR. No contradictions yet.' },
    { n:1, title:'Financial Due Diligence', sub:'ARR overstatement, IP dispute', role:'Financial Advisory',
      insight:'ARR revised to EUR 38M (24% overstatement). 2 patent disputes identified. HIGH drift.' },
    { n:2, title:'Technical Assessment', sub:'CTO departure risk', role:'Technology Advisory',
      insight:'Core tech confirmed solid. CTO + 2 senior engineers departing in Q4. Key-person risk.' },
    { n:3, title:'Market Intelligence', sub:'Patent suit, customer risk', role:'External Counsel',
      insight:'Axion patent suit on EP3847291, same patent as Haber dispute. Largest client evaluating alternatives.' },
    { n:4, title:'Legal & Compliance Review', sub:'Resolution paths', role:'Legal Advisory',
      insight:'Resolution paths identified. Haber buyout EUR 800K-1.2M. Revised valuation EUR 270-290M.' },
  ];

  var currentStep = -1;
  var stepSeen = {};
  var stepTimeout = null;
  var lastSummary = null;
  var previousFacts = null;
  var initialPendingIds = new Set();
  var demoActive = false;
  var pendingProposalId = null;
  var stepResults = [];
  var isInResolutionLoop = false;

  buildTimeline();
  connectEvents();

  // ── HITL Modal ──
  function showHitlModal(bodyHtml, opts) {
    opts = opts || {};
    var icon = document.getElementById('hitlModalIcon');
    var title = document.getElementById('hitlModalTitle');
    var sub = document.getElementById('hitlModalSub');
    icon.textContent = opts.icon || '?';
    icon.className = 'hitl-modal-header-icon ' + (opts.iconColor || 'purple');
    title.textContent = opts.title || 'Action Required';
    sub.textContent = opts.sub || 'The system is paused and waiting for your decision';
    document.getElementById('hitlModalBody').innerHTML = bodyHtml;
    document.getElementById('hitlModalBackdrop').classList.remove('hidden');
  }
  function hideHitlModal() {
    document.getElementById('hitlModalBackdrop').classList.add('hidden');
  }

  // ── Timeline builder ──
  function buildTimeline() {
    var tl = document.getElementById('timeline');
    STEPS.forEach(function(s, i) {
      var el = document.createElement('div');
      el.className = 'tl-step';
      el.id = 'tl-' + i;
      el.innerHTML = '<div class="tl-dot">' + (i + 1) + '</div>' +
        '<div class="tl-content">' +
          '<div class="tl-title">' + s.title + '</div>' +
          '<div class="tl-sub">' + s.sub + '</div>' +
          '<div class="tl-result" id="tl-result-' + i + '"></div>' +
        '</div>';
      tl.appendChild(el);
    });
    var hd = document.createElement('div');
    hd.className = 'tl-step';
    hd.id = 'tl-5';
    hd.innerHTML = '<div class="tl-dot">?</div>' +
      '<div class="tl-content">' +
        '<div class="tl-title">Human Decision</div>' +
        '<div class="tl-sub">Review &amp; resolve</div>' +
        '<div class="tl-result" id="tl-result-5"></div>' +
      '</div>';
    tl.appendChild(hd);
  }

  function setTlState(idx, state) {
    var el = document.getElementById('tl-' + idx);
    if (!el) return;
    el.className = 'tl-step' + (state ? ' ' + state : '');
    var dot = el.querySelector('.tl-dot');
    if (dot) {
      if (state === 'done') dot.innerHTML = '&#10003;';
      else if (state === 'blocked') dot.innerHTML = '!';
      else if (state === 'hitl') dot.innerHTML = '?';
      else dot.innerHTML = idx < 5 ? String(idx + 1) : '?';
    }
  }

  function setTlResult(idx, text, cls, tag) {
    var el = document.getElementById('tl-result-' + idx);
    if (!el) return;
    el.className = 'tl-result' + (cls ? ' ' + cls : '');
    el.innerHTML = escHtml(text) + (tag ? ' <span class="tl-tag ' + tag + '">' + tag + '</span>' : '');
  }

  // ── Status pill ──
  function setStatus(type, text) {
    var pill = document.getElementById('statusPill');
    pill.className = 'status-pill pill-' + type;
    document.getElementById('statusText').textContent = text;
  }

  function setStageLabel(text) {
    document.getElementById('stageLabel').textContent = text;
  }

  // ── Stage content ──
  function clearStage() {
    document.getElementById('stage').innerHTML = '';
  }

  function appendToStage(html) {
    var div = document.createElement('div');
    div.innerHTML = html;
    while (div.firstChild) document.getElementById('stage').appendChild(div.firstChild);
    var stage = document.getElementById('stage');
    stage.scrollTop = stage.scrollHeight;
  }

  // ── Service readiness check ──
  var _svcReady = false;
  var _svcCheckTimer = null;

  function setSvcState(state, text) {
    var dot = document.getElementById('svcDot');
    var span = document.getElementById('svcText');
    if (!dot || !span) return;
    dot.className = 'svc-dot ' + state;
    span.textContent = text;
    _svcReady = (state === 'ok');
    var beginBtn = document.getElementById('beginBtn');
    if (beginBtn) beginBtn.disabled = !_svcReady;
  }

  function checkServices() {
    setSvcState('checking', 'Checking services...');
    fetch('/api/summary', { signal: AbortSignal.timeout(4000) })
      .then(function(r) {
        if (r.ok) {
          setSvcState('ok', 'Feed server ready');
          if (_svcCheckTimer) { clearInterval(_svcCheckTimer); _svcCheckTimer = null; }
        } else {
          setSvcState('down', 'Feed server not responding (HTTP ' + r.status + ')');
        }
      })
      .catch(function() {
        setSvcState('down', 'Waiting for feed server...');
      });
  }

  function startServicePolling() {
    checkServices();
    if (_svcCheckTimer) clearInterval(_svcCheckTimer);
    _svcCheckTimer = setInterval(checkServices, 3000);
  }

  startServicePolling();

  // ── Reset ──
  window.resetDemo = async function() {
    var btn = document.getElementById('resetBtn');
    var beginBtn = document.getElementById('beginBtn');
    var msg = document.getElementById('resetMsg');
    btn.disabled = true;
    beginBtn.disabled = true;
    btn.textContent = 'Resetting...';
    msg.textContent = '';
    msg.style.color = 'var(--muted)';
    setSvcState('checking', 'Resetting...');
    try {
      var r = await fetch('/api/reset', { method: 'POST' });
      var data = await r.json();
      if (data.ok) {
        msg.style.color = 'var(--green)';
        var warns = (data.errors || []);
        msg.textContent = 'State cleared.' + (warns.length ? ' (' + warns.length + ' warnings)' : '');
      } else {
        msg.style.color = 'var(--red)';
        msg.textContent = 'Reset failed: ' + JSON.stringify(data.errors);
      }
    } catch(e) {
      msg.style.color = 'var(--red)';
      msg.textContent = 'Reset error: ' + e.message;
    }
    btn.disabled = false;
    btn.textContent = 'Reset state';
    startServicePolling();
  };

  // ── Restart (back to intro) ──
  window.restartDemo = async function() {
    await resetDemo();
    demoActive = false;
    currentStep = -1;
    stepResults = [];
    previousFacts = null;
    lastSummary = null;
    pendingProposalId = null;
    initialPendingIds = new Set();
    isInResolutionLoop = false;
    hideHitlModal();

    document.getElementById('introOverlay').classList.remove('hidden');
    setStatus('idle', 'Ready');
    setStageLabel('');
    clearStage();
    document.getElementById('stage').innerHTML =
      '<div class="stage-initial">' +
        '<p><strong>Click Begin</strong> to start. The demo feeds 5 documents to the swarm one by one. You will see each agent process them in real time.</p>' +
        '<div class="prereq"><strong>Prerequisite:</strong> run <code>npm run swarm:all</code> in another terminal so agents can process documents.</div>' +
      '</div>';
    document.getElementById('timeline').innerHTML = '';
    buildTimeline();
    document.getElementById('tlProgress').textContent = 'Step 0 / 5';
    document.getElementById('rScore').textContent = '0%';
    document.getElementById('rTrackFill').style.width = '0%';
    document.getElementById('rScoreSub').textContent = 'Waiting for data';
    setDim('dClaim', 'dClaimBar', null);
    setDim('dContra', 'dContraBar', null);
    setDim('dGoal', 'dGoalBar', null);
    setDim('dRisk', 'dRiskBar', null);
    updateCount('cClaims', 0);
    updateCount('cGoals', 0);
    updateCount('cContra', 0);
    updateCount('cRisks', 0);
    document.getElementById('driftBadge').textContent = 'None';
    document.getElementById('driftBadge').className = 'drift-badge none';
    document.getElementById('feedLog').innerHTML = '';
    updateSituationPanel(null, null);
  };

  // ── Begin ──
  window.beginDemo = async function() {
    if (!_svcReady) return;
    var beginBtn = document.getElementById('beginBtn');
    beginBtn.disabled = true;
    if (_svcCheckTimer) { clearInterval(_svcCheckTimer); _svcCheckTimer = null; }
    try {
      var r = await fetch('/api/pending');
      if (r.ok) {
        var data = await r.json();
        var list = (data.pending || []).map(function(p) { return p.proposal_id; }).filter(Boolean);
        initialPendingIds = new Set(list);
      }
    } catch(_) {}
    document.getElementById('introOverlay').classList.add('hidden');
    demoActive = true;
    feedNextStep();
  };

  // ── Step flow ──
  function feedNextStep() {
    currentStep++;
    if (currentStep >= STEPS.length) {
      checkForHitl();
      return;
    }
    startStep(currentStep);
  }

  async function startStep(idx) {
    var step = STEPS[idx];
    stepSeen = { facts: false, drift: false, planner: false, complete: false };
    setTlState(idx, 'active');
    setStageLabel('Step ' + (idx + 1) + ' of 5');
    document.getElementById('tlProgress').textContent = 'Step ' + (idx + 1) + ' / 5';
    setStatus('running', 'Step ' + (idx + 1) + ' — ' + step.title);
    clearStage();

    appendToStage(
      '<div class="doc-card">' +
        '<div class="doc-card-head">' +
          '<div><div class="doc-card-title">' + escHtml(step.title) + '</div><div class="doc-card-role">' + escHtml(step.role) + '</div></div>' +
          '<div class="doc-card-status feeding"><div class="pill-dot" style="background:var(--accent);animation:pulse 1s infinite"></div> Feeding to swarm</div>' +
        '</div>' +
        '<div class="doc-card-body">' + escHtml(step.insight) + '</div>' +
      '</div>'
    );

    try {
      var r = await fetch('/api/step/' + idx, { method: 'POST' });
      if (!r.ok) {
        var data = await r.json().catch(function() { return {}; });
        showError('Could not feed document: ' + (data.error || r.statusText));
        return;
      }
    } catch(e) {
      showError('Could not reach the demo server or feed. Start the feed: pnpm run feed. Then run pnpm run swarm:all.');
      return;
    }

    addActivity('Document fed: ' + step.title, 'doc');
    startStepTimeout();
  }

  function startStepTimeout() {
    if (stepTimeout) clearTimeout(stepTimeout);
    stepTimeout = setTimeout(function() {
      if (!stepSeen.complete) showTimeout();
    }, 300000);
  }

  function resetStepTimeout() {
    if (stepTimeout) clearTimeout(stepTimeout);
    stepTimeout = setTimeout(function() {
      if (!stepSeen.complete) showTimeout();
    }, 300000);
  }

  // ── SSE ──
  function connectEvents() {
    var es = new EventSource('/api/events');
    es.onmessage = function(e) {
      try {
        var d = JSON.parse(e.data);
        if (d.type === 'demo_connected' || d.type === 'feed_connected') return;
        if (!demoActive) return;
        handleEvent(d);
      } catch(_) {}
    };
    es.onerror = function() {
      es.close();
      setTimeout(connectEvents, 5000);
    };
  }

  function handleEvent(evt) {
    var type = evt.type || '';
    var payload = evt.payload || {};
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/af5b746e-3a32-49ef-92b2-aa2d9876cfd3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'demo-ui:handleEvent',message:'event-received',data:{type:type,payloadKeys:Object.keys(payload),currentStep:currentStep,stepSeen:stepSeen},timestamp:Date.now()})}).catch(function(){});
    // #endregion

    if (type === 'facts_extracted' && !stepSeen.facts) {
      stepSeen.facts = true;
      resetStepTimeout();
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/af5b746e-3a32-49ef-92b2-aa2d9876cfd3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'demo-ui:handleEvent',message:'facts_extracted payload',data:{payload:payload},timestamp:Date.now()})}).catch(function(){});
      // #endregion
      var wrote = payload.wrote || [];
      appendToStage(agentCardHtml('F', 'Facts Agent', 'Facts extracted (' + wrote.length + ' keys written). Refreshing graph...', 'accent'));
      addActivity('Facts Agent: extraction complete', 'facts');
      refreshSummary().then(function() {
        var nn = (lastSummary && lastSummary.state_graph) ? (lastSummary.state_graph.nodes || {}) : {};
        var claims = nn.claim || 0;
        var goals = nn.goal || 0;
        addActivity('Graph: ' + claims + ' claims, ' + goals + ' goals', 'facts');
        updateCount('cClaims', claims);
        updateCount('cGoals', goals);
      });
    }

    if (type === 'drift_analyzed' && !stepSeen.drift) {
      stepSeen.drift = true;
      resetStepTimeout();
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/af5b746e-3a32-49ef-92b2-aa2d9876cfd3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'demo-ui:handleEvent',message:'drift_analyzed payload',data:{payload:payload},timestamp:Date.now()})}).catch(function(){});
      // #endregion
      var level = (payload.level || 'none').toUpperCase();
      var types = (payload.types || []).join(', ') || 'no specific types';
      var color = level === 'HIGH' ? 'red' : level === 'MEDIUM' ? 'amber' : 'green';
      appendToStage(agentCardHtml('D', 'Drift Agent', level + ' drift — ' + types, color));
      addActivity('Drift Agent: ' + level, 'drift');
      refreshSummary();
    }

    if (type === 'actions_planned' && !stepSeen.planner) {
      stepSeen.planner = true;
      resetStepTimeout();
      var actions = (payload.actions || []).map(function(a) { return typeof a === 'string' ? a : (a.action || a.name || JSON.stringify(a)); }).join(', ') || 'no actions';
      appendToStage(agentCardHtml('P', 'Planner Agent', 'Recommends: ' + actions, 'purple'));
      addActivity('Planner: ' + actions, 'planner');
    }

    if (type === 'state_transition') {
      var from = payload.from || '';
      var to = payload.to || '';
      var blocked = !!payload.blocked;

      if (blocked && !stepSeen.complete) {
        stepSeen.complete = true;
        if (stepTimeout) clearTimeout(stepTimeout);
        appendToStage(agentCardHtml('G', 'Governance', 'BLOCKED — policy rule triggered. ' + (payload.reason || ''), 'red'));
        addActivity('Governance: BLOCKED', 'gov');
        stepResults[currentStep] = 'blocked';
        setTlState(currentStep, 'blocked');
        setTlResult(currentStep, 'Blocked — high drift', 'blocked', 'blocked');
        refreshSummary();
        setTimeout(function() { showStepSummary(); }, 1500);
      } else if (to === 'ContextIngested' && stepSeen.facts && !stepSeen.complete) {
        stepSeen.complete = true;
        if (stepTimeout) clearTimeout(stepTimeout);
        appendToStage(agentCardHtml('G', 'Governance', 'Transition approved: ' + from + ' &rarr; ' + to, 'green'));
        addActivity('Governance: approved', 'gov');
        stepResults[currentStep] = 'approved';
        setTlState(currentStep, 'done');
        setTlResult(currentStep, STEPS[currentStep].insight.split('.')[0], 'done', 'approved');
        refreshSummary();
        setTimeout(function() { showStepSummary(); }, 1500);
      } else {
        addActivity('State: ' + from + ' &rarr; ' + to, 'state');
        refreshSummary();
      }
    }

    if (type === 'proposal_approved') {
      var govReason = (payload.reason || 'policy_passed').replace(/_/g, ' ');
      appendToStage(agentCardHtml('G', 'Governance', 'Approved: ' + govReason, 'green'));
      addActivity('Governance: approved (' + govReason + ')', 'gov');
    }
    if (type === 'proposal_rejected') {
      var rejReason = (payload.reason || 'rejected').replace(/_/g, ' ');
      appendToStage(agentCardHtml('G', 'Governance', 'Rejected: ' + rejReason, 'amber'));
      addActivity('Governance: rejected (' + rejReason + ')', 'gov');
    }

    if (type === 'proposal_pending_approval' && !stepSeen.complete) {
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/af5b746e-3a32-49ef-92b2-aa2d9876cfd3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'demo-ui:handleEvent',message:'proposal_pending_approval',data:{payload:payload,currentStep:currentStep,stepSeen:stepSeen},timestamp:Date.now()})}).catch(function(){});
      // #endregion
      addActivity('Governance: review required', 'gov');
      if (stepTimeout) clearTimeout(stepTimeout);
      setTimeout(function() { pollGovernancePending(); }, 500);
    }
  }

  // ── Step summary + advance ──
  function showStepSummary() {
    var step = STEPS[currentStep];
    if (!step) return;
    appendToStage(
      '<div class="step-summary">' +
        '<div class="step-summary-title">Step ' + (currentStep + 1) + ' complete</div>' +
        '<div class="step-summary-body">' + escHtml(step.insight) + '</div>' +
      '</div>'
    );
    // After any step, check if a finality review is already pending (e.g. goal score hit 75%).
    fetch('/api/pending').then(function(r) { return r.json(); }).then(function(data) {
      var pending = (data.pending || []).filter(function(item) {
        var prop = item.proposal || {};
        var pl = prop.payload || {};
        return (pl.type === 'finality_review' || prop.proposed_action === 'finality_review') && !initialPendingIds.has(item.proposal_id);
      });
      if (pending.length > 0) {
        setTlState(5, 'hitl');
        setTimeout(function() { showHitlPanel(pending[0]); }, 1500);
        return;
      }
      setTimeout(feedNextStep, 2500);
    }).catch(function() {
      setTimeout(feedNextStep, 2500);
    });
  }

  // ── Governance HITL (mid-step) ──
  function pollGovernancePending() {
    fetch('/api/pending').then(function(r) { return r.json(); }).then(function(data) {
      var items = (data.pending || []).filter(function(item) {
        var prop = item.proposal || {};
        var pl = prop.payload || {};
        return pl.type === 'governance_review' && !initialPendingIds.has(item.proposal_id);
      });
      if (items.length > 0) {
        showGovernanceHitlPanel(items[0]);
      } else {
        setTimeout(pollGovernancePending, 2000);
      }
    }).catch(function() {
      setTimeout(pollGovernancePending, 3000);
    });
  }

  function showGovernanceHitlPanel(item) {
    var prop = item.proposal || {};
    var payload = prop.payload || {};
    var driftLevel = (payload.drift_level || 'high').toUpperCase();
    var driftTypes = (payload.drift_types || []).join(', ') || 'unspecified';
    var blockReason = payload.block_reason || 'Policy rule triggered';
    var fromState = payload.from || '?';
    var toState = payload.to || '?';

    setStatus('hitl', 'Governance intervention');
    setStageLabel('Governance Review');

    var html = '<div class="hitl-panel">';

    html += '<div class="hitl-section">';
    html += '<div class="hitl-section-title">Governance intervention</div>';
    html += '<div class="hitl-narrative">';
    html += 'The governance agent has <strong>blocked</strong> the state transition ';
    html += '<strong>' + escHtml(fromState) + '</strong> &rarr; <strong>' + escHtml(toState) + '</strong> ';
    html += 'because drift is at <strong>' + escHtml(driftLevel) + '</strong> level.';
    html += '</div>';
    html += '<div class="hitl-narrative" style="margin-top:0.5rem">';
    html += '<em>Policy rule:</em> ' + escHtml(blockReason);
    html += '</div>';
    html += '</div>';

    html += '<div class="hitl-section">';
    html += '<div class="hitl-section-title">What is drift?</div>';
    html += '<div class="hitl-narrative">';
    html += 'Drift measures how much new information contradicts or changes previous knowledge. ';
    html += 'When drift is HIGH, the system pauses to avoid propagating inconsistencies. ';
    html += 'Drift types detected: <strong>' + escHtml(driftTypes) + '</strong>.';
    html += '</div>';
    html += '</div>';

    html += '<div class="hitl-section">';
    html += '<div class="hitl-section-title">Your options</div>';
    html += '<div class="hitl-options">';
    html += '<button class="hitl-option primary" onclick="approveGovernance(&#39;' + escHtml(item.proposal_id) + '&#39;)">';
    html += '<div class="hitl-option-name">Override &amp; continue</div>';
    html += '<div class="hitl-option-desc">Acknowledge the high drift and allow the state machine to advance. ';
    html += 'The agents will continue processing with the current knowledge, including contradictions. ';
    html += 'This is appropriate when new information is expected to supersede previous data.</div></button>';
    html += '<button class="hitl-option" onclick="approveGovernance(&#39;' + escHtml(item.proposal_id) + '&#39;)">';
    html += '<div class="hitl-option-name">Accept &amp; note for review</div>';
    html += '<div class="hitl-option-desc">Let the swarm proceed. The drift will be logged for post-analysis. ';
    html += 'Use this when the contradictions are expected (e.g. updated financial figures replacing estimates).</div></button>';
    html += '</div></div>';

    html += '</div>';
    showHitlModal(html, {
      title: 'Governance Intervention',
      sub: 'State transition blocked — drift is ' + driftLevel,
      icon: '!',
      iconColor: 'amber'
    });
    addActivity('Governance: blocked ' + fromState + ' -> ' + toState + ' (drift ' + driftLevel + ')', 'gov');
  }

  window.approveGovernance = async function(proposalId) {
    try {
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/af5b746e-3a32-49ef-92b2-aa2d9876cfd3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'demo-ui:approveGovernance',message:'approving',data:{proposalId:proposalId},timestamp:Date.now()})}).catch(function(){});
      // #endregion
      var r = await fetch('/api/approve/' + proposalId, { method: 'POST' });
      var result = await r.json();
      if (result.ok) {
        initialPendingIds.add(proposalId);
        hideHitlModal();
        appendToStage(agentCardHtml('G', 'Governance', 'Human override accepted. State advancing...', 'green'));
        addActivity('Human: override approved', 'hitl');
        setStatus('running', 'Processing...');
        setStageLabel('Step ' + (currentStep + 1) + ' — Agents working');
      } else {
        appendToStage(agentCardHtml('G', 'Governance', 'Approval failed: ' + (result.error || 'unknown'), 'red'));
      }
    } catch(e) {
      appendToStage(agentCardHtml('G', 'Governance', 'Approval error: ' + e.message, 'red'));
    }
  };

  // ── HITL check ──
  async function checkForHitl() {
    setStatus('running', 'Evaluating finality...');
    setStageLabel('Checking finality');
    await refreshSummary();
    var attempts = 0;
    pollPending();
    function pollPending() {
      fetch('/api/pending').then(function(r) { return r.json(); }).then(function(data) {
        var pending = (data.pending || []).filter(function(item) {
          var prop = item.proposal || {};
          var pl = prop.payload || {};
          if (pl.type !== 'finality_review' && prop.proposed_action !== 'finality_review') return false;
          if (initialPendingIds.has(item.proposal_id)) return false;
          return true;
        });
        if (pending.length > 0) {
          showHitlPanel(pending[0]);
        } else {
          attempts++;
          if (attempts < 12) setTimeout(pollPending, 3000);
          else showFinalReport();
        }
      }).catch(function() {
        attempts++;
        if (attempts < 12) setTimeout(pollPending, 3000);
        else showFinalReport();
      });
    }
  }

  // ── HITL panel ──
  function showHitlPanel(item) {
    pendingProposalId = item.proposal_id;
    var prop = item.proposal || {};
    var payload = prop.payload || {};

    setTlState(5, 'hitl');
    setStatus('hitl', 'Human review required');
    setStageLabel('Human Decision');
    clearStage();

    var gs = payload.goal_score != null ? Math.round(payload.goal_score * 100) : 0;
    var rawDims = payload.dimension_breakdown || [];
    var dim = {};
    if (Array.isArray(rawDims)) {
      rawDims.forEach(function(d) { if (d && d.name) dim[d.name] = d.score; });
    } else {
      dim = rawDims;
    }
    var blockers = payload.blockers || [];

    var html = '<div class="hitl-panel">';

    // Section 1: Why you are here
    html += '<div class="hitl-section">';
    html += '<div class="hitl-section-title">Why you are here</div>';
    html += '<div class="hitl-narrative">';
    html += 'The swarm processed all 5 documents and built a knowledge graph';
    if (lastSummary && lastSummary.state_graph) {
      var sg = lastSummary.state_graph;
      var nn = sg.nodes || {};
      html += ' with ' + (nn.claim || 0) + ' claims, ' + (nn.goal || 0) + ' goals, and ' + (nn.contradiction || 0) + ' contradictions';
    }
    html += '. The finality score reached <strong>' + gs + '%</strong> &mdash; above the <strong>75%</strong> threshold where agents stop and request human judgment, ';
    html += 'but below the <strong>92%</strong> threshold where the system would auto-resolve.';
    html += '</div>';

    if (blockers.length > 0) {
      html += '<div class="hitl-blockers">';
      blockers.forEach(function(b) {
        var tk = (b.type || '').toLowerCase().replace(/-/g, '_');
        html += '<div class="hitl-blocker">';
        html += '<div class="hitl-blocker-title">' + escHtml(blockerTitle(tk)) + '</div>';
        html += '<div class="hitl-blocker-desc">' + escHtml(b.description || '') + '</div>';
        html += '<div class="hitl-blocker-hint">' + escHtml(blockerHint(tk)) + '</div>';
        html += '</div>';
      });
      html += '</div>';
    }
    html += '</div>';

    // Knowledge state at review (clear end situation)
    var sg2 = lastSummary && lastSummary.state_graph ? lastSummary.state_graph : {};
    var nn2 = sg2.nodes || {};
    var claims = nn2.claim || 0, goals = nn2.goal || 0, contra = nn2.contradiction || 0, risks = nn2.risk || 0;
    var drift2 = lastSummary && lastSummary.drift ? lastSummary.drift : {};
    var driftLevel2 = (drift2.level || 'none').toUpperCase();
    var driftTypes2 = Array.isArray(drift2.types) ? drift2.types.join(', ') : '';
    var goalsList = (lastSummary && lastSummary.facts && Array.isArray(lastSummary.facts.goals)) ? lastSummary.facts.goals : [];
    html += '<div class="hitl-section">';
    html += '<div class="situation-card">';
    html += '<div class="situation-title">Knowledge state at review</div>';
    html += '<div class="situation-line">At this point the swarm has extracted <strong>' + claims + '</strong> claims, <strong>' + goals + '</strong> goals, <strong>' + contra + '</strong> contradictions, and <strong>' + risks + '</strong> risks from the five documents.</div>';
    html += '<div class="situation-grid">';
    html += '<div class="situation-stat claims"><span class="situation-stat-num">' + claims + '</span><span class="situation-stat-label">Claims</span></div>';
    html += '<div class="situation-stat goals"><span class="situation-stat-num">' + goals + '</span><span class="situation-stat-label">Goals</span></div>';
    html += '<div class="situation-stat contra"><span class="situation-stat-num">' + contra + '</span><span class="situation-stat-label">Contradictions</span></div>';
    html += '<div class="situation-stat risks"><span class="situation-stat-num">' + risks + '</span><span class="situation-stat-label">Risks</span></div>';
    html += '</div>';
    html += '<div class="situation-drift">Drift: <strong>' + escHtml(driftLevel2) + '</strong>' + (driftTypes2 ? ' (' + escHtml(driftTypes2) + ')' : '') + '</div>';
    if (goalsList.length > 0) {
      html += '<div class="situation-goals-title">Goals from documents</div>';
      html += '<ul class="situation-goals-list">';
      goalsList.slice(0, 8).forEach(function(g) { html += '<li>' + escHtml(typeof g === 'string' ? g : (g && g.text ? g.text : String(g))) + '</li>'; });
      if (goalsList.length > 8) html += '<li style="color:var(--muted)">+ ' + (goalsList.length - 8) + ' more</li>';
      html += '</ul>';
    }
    html += '</div></div>';

    // Section 2: Your options (confidence dimensions stay in right panel only)
    html += '<div class="hitl-section">';
    html += '<div class="hitl-section-title">Your options</div>';
    html += '<div class="hitl-options">';
    html += '<button class="hitl-option primary" onclick="hitlDecide(&#39;approve_finality&#39;)">' +
      '<div class="hitl-option-name">Approve finality</div>' +
      '<div class="hitl-option-desc">Accept the current state. The scope closes as RESOLVED with the current knowledge graph. No further agent processing.</div></button>';
    html += '<button class="hitl-option" onclick="showResolutionInput()">' +
      '<div class="hitl-option-name">Provide resolution</div>' +
      '<div class="hitl-option-desc">Add a decision or fact (e.g. &quot;ARR confirmed at EUR 38M&quot;). <strong>The system will re-process</strong>: facts agent re-extracts, drift re-evaluates, and scores update. You will see the graph change.</div></button>';
    html += '<button class="hitl-option" onclick="hitlDecide(&#39;escalate&#39;)">' +
      '<div class="hitl-option-name">Escalate</div>' +
      '<div class="hitl-option-desc">Route to a higher authority. The scope stays open.</div></button>';
    html += '<button class="hitl-option" onclick="hitlDecide(&#39;defer&#39;)">' +
      '<div class="hitl-option-name">Defer 7 days</div>' +
      '<div class="hitl-option-desc">Postpone. The scope stays open.</div></button>';
    html += '</div></div>';

    html += '<div id="resolutionArea" style="display:none"></div>';
    html += '</div>';

    appendToStage(agentCardHtml('?', 'System Paused', 'A decision is required. Review the panel that has appeared.', 'purple'));
    showHitlModal(html, {
      title: 'Human Decision Required',
      sub: 'The system has paused at ' + gs + '% finality and needs your input to proceed',
      icon: '?',
      iconColor: 'purple'
    });
    addActivity('Human review required — finality ' + gs + '%', 'hitl');
  }

  function hitlDimRow(name, value, color, explain) {
    var pct = value != null ? Math.round(value * 100) : 0;
    var label = value != null ? pct + '%' : '--';
    return '<div><div class="hitl-dim">' +
      '<span class="hitl-dim-name">' + escHtml(name) + '</span>' +
      '<div class="hitl-dim-bar"><div class="hitl-dim-fill ' + color + '" style="width:' + pct + '%"></div></div>' +
      '<span class="hitl-dim-val">' + label + '</span></div>' +
      '<div class="hitl-dim-explain">' + escHtml(explain) + '</div></div>';
  }

  // ── HITL decisions ──
  window.hitlDecide = async function(option) {
    if (!pendingProposalId) return;
    var submittedId = pendingProposalId;
    try {
      var r = await fetch('/api/finality-response', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposal_id: pendingProposalId, option: option, days: 7 }),
      });
      await r.json();
      initialPendingIds.add(submittedId);
      pendingProposalId = null;
      hideHitlModal();

      addActivity('Decision: ' + option.replace(/_/g, ' '), 'gov');
      await refreshSummary();

      if (option === 'approve_finality') {
        setTlState(5, 'done');
        setTlResult(5, 'Finality approved', 'done', 'approved');
        showFinalReport();
      } else {
        setTlResult(5, 'Decision: ' + option.replace(/_/g, ' '), 'done', 'done');
        showFinalReport();
      }
    } catch(e) {
      addActivity('Decision failed: ' + e, 'error');
    }
  };

  // ── Provide resolution ──
  window.showResolutionInput = function() {
    var area = document.getElementById('resolutionArea');
    if (!area) return;
    area.style.display = 'block';
    area.innerHTML =
      '<div class="resolution-area">' +
        '<div class="hitl-section-title">Provide resolution</div>' +
        '<p style="font-size:0.8125rem;color:var(--muted);margin-bottom:0.5rem">Enter a decision or fact. The system will re-process and update the knowledge graph.</p>' +
        '<textarea id="resolutionText" placeholder="e.g. ARR confirmed at EUR 38M after independent audit. Haber buyout approved at EUR 1M." rows="3"></textarea>' +
        '<button class="resolution-submit" onclick="submitResolution()">Submit resolution</button>' +
      '</div>';
  };

  window.submitResolution = async function() {
    var text = (document.getElementById('resolutionText') || {}).value || '';
    if (!text.trim()) return;
    isInResolutionLoop = true;
    hideHitlModal();
    stepSeen = { facts: false, drift: false, planner: false, complete: false };
    clearStage();
    setStageLabel('Re-processing with resolution');
    setStatus('running', 'Agents re-processing...');

    appendToStage(
      '<div class="doc-card">' +
        '<div class="doc-card-head"><div><div class="doc-card-title">Human Resolution</div><div class="doc-card-role">Your input</div></div>' +
          '<div class="doc-card-status feeding"><div class="pill-dot" style="background:var(--accent);animation:pulse 1s infinite"></div> Feeding</div>' +
        '</div>' +
        '<div class="doc-card-body">' + escHtml(text) + '</div>' +
      '</div>'
    );

    try {
      await fetch('/api/resolution', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: text, summary: text.slice(0, 120), text: text }),
      });
      addActivity('Resolution submitted: ' + text.slice(0, 60), 'doc');
      startStepTimeout();
    } catch(e) {
      showError('Could not submit resolution: ' + e);
    }
  };

  // Override step completion for resolution loop
  var origShowStepSummary = showStepSummary;
  showStepSummary = function() {
    if (isInResolutionLoop) {
      isInResolutionLoop = false;
      appendToStage(
        '<div class="step-summary">' +
          '<div class="step-summary-title">Re-processing complete</div>' +
          '<div class="step-summary-body">The system has re-evaluated with your resolution. Check the updated scores in the right panel.</div>' +
        '</div>'
      );
      setTimeout(function() { checkForHitl(); }, 2000);
      return;
    }
    origShowStepSummary();
  };

  // ── Final report ──
  function showFinalReport() {
    setStatus('done', 'Demo complete');
    setStageLabel('Final Report');
    clearStage();

    var fin = (lastSummary && lastSummary.finality) ? lastSummary.finality : {};
    var sg = (lastSummary && lastSummary.state_graph) ? lastSummary.state_graph : {};
    var nn = sg.nodes || {};
    var dim = fin.dimension_breakdown || {};
    var gs = fin.goal_score != null ? Math.round(fin.goal_score * 100) : '--';

    var factsReport = (lastSummary && lastSummary.facts) ? lastSummary.facts : null;
    var goalsReport = factsReport && Array.isArray(factsReport.goals) ? factsReport.goals : [];
    var driftReport = (lastSummary && lastSummary.drift) ? lastSummary.drift : {};
    var driftLevelReport = (driftReport.level || 'none').toUpperCase();
    var driftTypesReport = Array.isArray(driftReport.types) ? driftReport.types.join(', ') : '';

    var html = '<div class="report">';
    html += '<div class="report-header">';
    html += '<div class="report-icon">&#10003;</div>';
    html += '<div class="report-title">Scope ' + (fin.status === 'RESOLVED' ? 'Resolved' : 'Evaluated') + '</div>';
    html += '<div class="report-sub">All five due diligence documents were processed by the governed agent swarm.</div>';
    html += '</div>';

    html += '<div class="situation-card">';
    html += '<div class="situation-title">Outcome at close</div>';
    html += '<div class="situation-line">The knowledge graph at resolution contains <strong>' + (nn.claim || 0) + '</strong> claims, <strong>' + (nn.goal || 0) + '</strong> goals, <strong>' + (nn.contradiction || 0) + '</strong> contradictions, and <strong>' + (nn.risk || 0) + '</strong> risks. Finality score <strong>' + gs + '%</strong>; drift at close: <strong>' + escHtml(driftLevelReport) + '</strong>' + (driftTypesReport ? ' (' + escHtml(driftTypesReport) + ')' : '') + '.</div>';
    html += '<div class="situation-grid">';
    html += '<div class="situation-stat claims"><span class="situation-stat-num">' + (nn.claim || 0) + '</span><span class="situation-stat-label">Claims</span></div>';
    html += '<div class="situation-stat goals"><span class="situation-stat-num">' + (nn.goal || 0) + '</span><span class="situation-stat-label">Goals</span></div>';
    html += '<div class="situation-stat contra"><span class="situation-stat-num">' + (nn.contradiction || 0) + '</span><span class="situation-stat-label">Contradictions</span></div>';
    html += '<div class="situation-stat risks"><span class="situation-stat-num">' + (nn.risk || 0) + '</span><span class="situation-stat-label">Risks</span></div>';
    html += '</div>';
    if (goalsReport.length > 0) {
      html += '<div class="situation-goals-title">Goals addressed</div>';
      html += '<ul class="situation-goals-list">';
      goalsReport.slice(0, 8).forEach(function(g) { html += '<li>' + escHtml(typeof g === 'string' ? g : (g && g.text ? g.text : String(g))) + '</li>'; });
      if (goalsReport.length > 8) html += '<li style="color:var(--muted)">+ ' + (goalsReport.length - 8) + ' more</li>';
      html += '</ul>';
    }
    html += '</div>';

    // Human-understandable statement of the truth
    var whatChanged = (lastSummary && Array.isArray(lastSummary.what_changed)) ? lastSummary.what_changed : [];
    var resolutions = whatChanged.filter(function(ev) { return (ev.type || '') === 'resolution'; }).map(function(ev) {
      var p = ev.payload || {};
      return (p.decision || p.text || '').trim().slice(0, 200);
    }).filter(Boolean);
    var resolved = (fin.status || '') === 'RESOLVED';
    var statementP1 = 'This scope is <strong>' + (resolved ? 'resolved' : 'evaluated') + '</strong>. After processing all five due diligence documents, the swarm\u2019s knowledge graph contains <strong>' + (nn.claim || 0) + ' claims</strong>, <strong>' + (nn.goal || 0) + ' goals</strong>, <strong>' + (nn.contradiction || 0) + ' contradictions</strong>, and <strong>' + (nn.risk || 0) + ' risks</strong>. Drift at close is <strong>' + escHtml(driftLevelReport) + '</strong>.';
    if (resolved) statementP1 += ' A human reviewer approved this state as the resolved position.';
    var statementP2 = '';
    if (goalsReport.length > 0) {
      var goalTexts = goalsReport.slice(0, 5).map(function(g) { return typeof g === 'string' ? g : (g && g.text ? g.text : String(g)); });
      statementP2 = '<p>The position reflects the following objectives: ' + escHtml(goalTexts.join('; ')) + (goalsReport.length > 5 ? ' (and ' + (goalsReport.length - 5) + ' more).' : '.') + '</p>';
    }
    html += '<div class="statement-of-position">';
    html += '<div class="statement-title">Statement of position</div>';
    html += '<div class="statement-body"><p>' + statementP1 + '</p>' + statementP2;
    if (resolutions.length > 0) {
      html += '<div class="statement-resolutions"><strong>Human resolutions recorded</strong><br>';
      resolutions.forEach(function(r) { html += '<span style="display:block;margin-top:0.35rem">\u201c' + escHtml(r) + (r.length >= 200 ? '\u2026' : '') + '\u201d</span>'; });
      html += '</div>';
    }
    html += '</div></div>';

    html += '<div class="report-section">';
    html += '<div class="report-section-title">Summary</div>';
    html += reportRow('Finality score', gs + '%');
    html += reportRow('Status', fin.status || '--');
    html += reportRow('Claims', nn.claim || 0);
    html += reportRow('Goals', nn.goal || 0);
    html += reportRow('Contradictions', nn.contradiction || 0);
    html += reportRow('Risks', nn.risk || 0);
    html += '</div>';

    html += '<div class="report-section">';
    html += '<div class="report-section-title">Confidence Dimensions</div>';
    html += reportRow('Claim confidence', dimPct(dim.claim_avg_confidence));
    html += reportRow('Contradiction resolution', dimPct(dim.contradiction_resolution_ratio));
    html += reportRow('Goal completion', dimPct(dim.goal_completion_ratio));
    html += reportRow('Risk score', dimPct(dim.risk_score_inverse));
    html += '</div>';

    html += '<div class="report-section">';
    html += '<div class="report-section-title">Document Steps</div>';
    STEPS.forEach(function(s, i) {
      var result = stepResults[i] || 'done';
      var tagCls = result === 'blocked' ? 'tl-tag blocked' : 'tl-tag approved';
      html += '<div class="report-step">' +
        '<div class="report-step-num">' + (i + 1) + '</div>' +
        '<div class="report-step-text">' + escHtml(s.title) + ' &mdash; ' + escHtml(s.insight.split('.')[0]) + '</div>' +
        '<span class="report-step-tag ' + tagCls + '">' + result + '</span></div>';
    });
    html += '</div>';

    html += '<div class="report-section">';
    html += '<div class="report-section-title">Audit</div>';
    html += '<div style="font-size:0.8125rem;color:var(--muted);line-height:1.6">' +
      'Every transition was evaluated by governance policy. The human review at near-finality ensured that ' +
      'autonomous processing stopped at the right moment. All decisions, proposals, and state transitions are ' +
      'logged with timestamps, proposer, and rationale.' +
      '</div>';
    html += '</div>';

    html += '</div>';
    document.getElementById('stage').innerHTML = html;
  }

  function reportRow(label, value) {
    return '<div class="report-row"><span class="report-row-label">' + escHtml(label) + '</span><span class="report-row-value">' + escHtml(String(value)) + '</span></div>';
  }

  function dimPct(v) { return v != null ? Math.round(v * 100) + '%' : '--'; }

  var TRUNCATE_LEN = 120;

  function updateSituationPanel(facts, prevFacts) {
    if (!facts || typeof facts !== 'object') {
      previousFacts = null;
      return;
    }
    var claims = Array.isArray(facts.claims) ? facts.claims : [];
    var goals = Array.isArray(facts.goals) ? facts.goals : [];
    var risks = Array.isArray(facts.risks) ? facts.risks : [];
    var contradictions = Array.isArray(facts.contradictions) ? facts.contradictions : [];
    var prevClaims = (prevFacts && Array.isArray(prevFacts.claims)) ? prevFacts.claims : [];
    var prevGoals = (prevFacts && Array.isArray(prevFacts.goals)) ? prevFacts.goals : [];
    var prevRisks = (prevFacts && Array.isArray(prevFacts.risks)) ? prevFacts.risks : [];
    var prevContra = (prevFacts && Array.isArray(prevFacts.contradictions)) ? prevFacts.contradictions : [];

    function renderCards(list, prevList, type) {
      if (!list.length) return '<div class="situation-empty">None yet</div>';
      var html = '';
      for (var i = 0; i < list.length; i++) {
        var text = String(list[i]).trim();
        if (!text) continue;
        var full = text;
        var display = text.length > TRUNCATE_LEN ? text.slice(0, TRUNCATE_LEN) + '\u2026' : text;
        var isNew = prevList.indexOf(text) === -1;
        html += '<div class="situation-card type-' + type + (isNew ? ' situation-new' : '') + '" title="' + escHtml(full) + '">' + escHtml(display) + (isNew ? ' <span class="situation-new-badge">new</span>' : '') + '</div>';
      }
      return html || '<div class="situation-empty">None yet</div>';
    }

    document.getElementById('situation-claims-count').textContent = claims.length;
    document.getElementById('situation-goals-count').textContent = goals.length;
    document.getElementById('situation-risks-count').textContent = risks.length;
    document.getElementById('situation-contradictions-count').textContent = contradictions.length;
    document.getElementById('situation-claims-cards').innerHTML = renderCards(claims, prevClaims, 'claim');
    document.getElementById('situation-goals-cards').innerHTML = renderCards(goals, prevGoals, 'goal');
    document.getElementById('situation-risks-cards').innerHTML = renderCards(risks, prevRisks, 'risk');
    document.getElementById('situation-contradictions-cards').innerHTML = renderCards(contradictions, prevContra, 'contradiction');

    previousFacts = { claims: claims.slice(), goals: goals.slice(), risks: risks.slice(), contradictions: contradictions.slice() };
  }

  // ── Summary refresh ──
  async function refreshSummary() {
    try {
      var r = await fetch('/api/summary');
      if (!r.ok) return;
      lastSummary = await r.json();
    } catch(_) { return; }

    var fin = lastSummary.finality || {};
    var sg = lastSummary.state_graph || {};
    var nn = sg.nodes || {};
    var dim = fin.dimensions || {};
    var drift = lastSummary.drift || {};

    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/af5b746e-3a32-49ef-92b2-aa2d9876cfd3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'demo-ui:refreshSummary',message:'summary-data',data:{goal_score:fin.goal_score,dimensions:dim,nodes:nn,drift_level:drift&&drift.level,status:fin.status},timestamp:Date.now()})}).catch(function(){});
    // #endregion

    // Finality score (right panel only)
    var gs = fin.goal_score != null ? Math.round(fin.goal_score * 100) : 0;
    document.getElementById('rScore').textContent = gs + '%';
    document.getElementById('rTrackFill').style.width = gs + '%';
    if (gs >= 92) { document.getElementById('rScoreSub').textContent = 'Auto-resolve threshold reached'; }
    else if (gs >= 75) { document.getElementById('rScoreSub').textContent = 'Human review range (75-92%)'; }
    else if (gs > 0) { document.getElementById('rScoreSub').textContent = 'Agents processing (' + gs + '%)'; }
    else { document.getElementById('rScoreSub').textContent = 'Waiting for data'; }

    // Confidence dimensions (from flat dimensions object)
    setDim('dClaim', 'dClaimBar', dim.claim_avg_confidence);
    setDim('dContra', 'dContraBar', dim.contradiction_resolution_ratio);
    setDim('dGoal', 'dGoalBar', dim.goal_completion_ratio);
    setDim('dRisk', 'dRiskBar', dim.risk_score_inverse);

    // Knowledge counts
    updateCount('cClaims', nn.claim || 0);
    updateCount('cGoals', nn.goal || 0);
    updateCount('cContra', nn.contradiction || 0);
    updateCount('cRisks', nn.risk || 0);

    // Drift
    var driftLevel = (drift.level || 'none').toLowerCase();
    var badge = document.getElementById('driftBadge');
    badge.textContent = driftLevel.toUpperCase() || 'None';
    badge.className = 'drift-badge ' + driftLevel;

    // Situation panel: claims, goals, risks, contradictions (unfoldable cards with hover)
    updateSituationPanel(lastSummary.facts || null, previousFacts);
  }

  function setDim(valId, barId, value) {
    var pct = value != null ? Math.round(value * 100) : 0;
    document.getElementById(valId).textContent = value != null ? pct + '%' : '--';
    document.getElementById(barId).style.width = pct + '%';
  }

  function updateCount(id, value) {
    var el = document.getElementById(id);
    var old = parseInt(el.textContent) || 0;
    el.textContent = value;
    if (value > old) {
      el.classList.add('pop');
      setTimeout(function() { el.classList.remove('pop'); }, 400);
    }
  }

  // ── Activity feed ──
  function addActivity(msg, cls) {
    var log = document.getElementById('feedLog');
    var now = new Date();
    var ts = now.toTimeString().slice(0, 8);
    var item = document.createElement('div');
    item.className = 'feed-item' + (cls ? ' ' + cls : '');
    item.innerHTML = '<span class="feed-item-ts">' + ts + '</span><span class="feed-item-msg">' + msg + '</span>';
    log.insertBefore(item, log.firstChild);
    while (log.children.length > 40) log.removeChild(log.lastChild);
  }

  // ── Error / timeout ──
  function showError(msg) {
    setStatus('error', 'Error');
    appendToStage(
      '<div class="stage-error"><strong>Something went wrong</strong>' + escHtml(msg) +
      '<p style="margin:0.5rem 0 0">Ensure the feed server is running: <code>pnpm run feed</code>. Then run <code>pnpm run swarm:all</code> in another terminal so agents process documents. Refresh when both are up.</p></div>'
    );
  }

  function showTimeout() {
    appendToStage(
      '<div class="stage-error"><strong>Still processing...</strong>' +
      'Local LLM inference can take several minutes per document. If the swarm is not running, start it: <code>npm run swarm:all</code>' +
      '<p style="margin:0.5rem 0 0;color:var(--muted)">Events will appear as soon as agents complete their analysis.</p></div>'
    );
  }

  // ── Agent card HTML ──
  function agentCardHtml(letter, name, msg, color) {
    return '<div class="agent-card ' + color + '">' +
      '<div class="agent-icon ' + color + '">' + letter + '</div>' +
      '<div class="agent-card-content">' +
        '<div class="agent-card-name">' + escHtml(name) + '</div>' +
        '<div class="agent-card-msg">' + msg + '</div>' +
      '</div></div>';
  }

  // ── Blocker labels ──
  function blockerTitle(key) {
    return { missing_goal_resolution:'Goals not yet resolved', unresolved_contradiction:'Unresolved contradictions',
      critical_risk:'Critical risks active', low_confidence_claims:'Low-confidence claims' }[key] || key.replace(/_/g,' ');
  }
  function blockerHint(key) {
    return { missing_goal_resolution:'The system tracks goals from documents (validate ARR, confirm IP, etc.). For auto-close, 90% need a recorded resolution. You can approve anyway, or add a resolution to let agents re-evaluate.',
      unresolved_contradiction:'Contradictory claims exist without a recorded resolution. Adding a resolution lets agents reconcile them.',
      critical_risk:'Active critical risks remain. You can approve if the risk is accepted, or add context to mitigate.' }[key] || '';
  }

  // ── Helpers ──
  function escHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }
})();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  startSseProxy();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    const pathname = url.split("?")[0];

    try {
      if (req.method === "GET" && (pathname === "/" || pathname === "/demo")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(DEMO_HTML);
        return;
      }
      if (req.method === "GET" && pathname === "/api/docs") {
        handleDocs(res);
        return;
      }
      const stepMatch = pathname.match(/^\/api\/step\/(\d+)$/);
      if (req.method === "POST" && stepMatch) {
        await handleStep(parseInt(stepMatch[1], 10), res);
        return;
      }
      if (req.method === "GET" && pathname === "/api/summary") {
        await handleSummary(res);
        return;
      }
      if (req.method === "GET" && pathname === "/api/pending") {
        await handlePending(res);
        return;
      }
      if (req.method === "POST" && pathname === "/api/finality-response") {
        await handleFinalityResponse(req, res);
        return;
      }
      if (req.method === "POST" && pathname === "/api/resolution") {
        await handleResolution(req, res);
        return;
      }
      const approveMatch = pathname.match(/^\/api\/approve\/(.+)$/);
      if (req.method === "POST" && approveMatch) {
        try {
          const data = await proxyPost(`${MITL_URL}/approve/${approveMatch[1]}`, {});
          sendJson(res, 200, data as Record<string, unknown>);
        } catch (e) {
          sendJson(res, 502, { error: String(e) });
        }
        return;
      }
      if (req.method === "POST" && pathname === "/api/reset") {
        await handleReset(res);
        return;
      }
      if (req.method === "GET" && pathname === "/api/events") {
        handleEvents(req, res);
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    } catch (err) {
      if (!res.writableEnded) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    }
  });

  server.listen(DEMO_PORT, "0.0.0.0", () => {
    process.stdout.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        msg: "Demo server listening",
        port: DEMO_PORT,
        url: `http://localhost:${DEMO_PORT}`,
        docs: DEMO_DOCS.length,
      }) + "\n",
    );
    process.stdout.write(`\n  Open: http://localhost:${DEMO_PORT}\n\n`);
  });
}

main().catch((e) => {
  process.stderr.write(String(e) + "\n");
  process.exit(1);
});
