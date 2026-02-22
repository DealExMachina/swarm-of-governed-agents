/**
 * Preflight: verify Postgres, S3, NATS (+ stream), and facts-worker are reachable.
 * Use before starting the swarm to avoid "fetch failed" and similar provisioning issues.
 *
 * Env:
 *   CHECK_SERVICES_MAX_WAIT_SEC  If set, retry until all pass or this many seconds (for slow first-time facts-worker).
 *   Otherwise: up to 5 attempts per service with 3s delay.
 *
 * Usage: node --loader ts-node/esm scripts/check-services.ts
 *        CHECK_SERVICES_MAX_WAIT_SEC=300 node --loader ts-node/esm scripts/check-services.ts
 */
import "dotenv/config";
import { Pool } from "pg";
import { HeadBucketCommand, CreateBucketCommand } from "@aws-sdk/client-s3";
import { makeS3 } from "../src/s3.js";
import { waitForNatsAndStream } from "../src/readiness.js";

const NATS_STREAM = process.env.NATS_STREAM ?? "SWARM_JOBS";
const STREAM_SUBJECTS = [
  "swarm.jobs.>",
  "swarm.proposals.>",
  "swarm.actions.>",
  "swarm.rejections.>",
  "swarm.events.>",
];

const RETRIES = 5;
const DELAY_MS = 3000;
/** Facts-worker /extract can be slow (LLM + optional GLiNER/NLI). Default 60s. */
const FACTS_WORKER_TIMEOUT_MS = Number(process.env.CHECK_FACTS_WORKER_TIMEOUT_MS) || 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function checkPostgres(): Promise<string | null> {
  const url = process.env.DATABASE_URL;
  if (!url) return "DATABASE_URL not set";
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await pool.query("SELECT 1");
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    await pool.end();
  }
}

async function checkS3(): Promise<string | null> {
  const bucket = process.env.S3_BUCKET ?? "swarm";
  if (!process.env.S3_ENDPOINT) return "S3_ENDPOINT not set";
  try {
    const s3 = makeS3();
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    }
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function checkNats(): Promise<string | null> {
  try {
    await waitForNatsAndStream({
      streamName: NATS_STREAM,
      streamSubjects: STREAM_SUBJECTS,
      connectTimeoutMs: 5000,
      connectRetries: 2,
      retryDelayMs: 1000,
    });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function checkFactsWorker(): Promise<string | null> {
  const url = process.env.FACTS_WORKER_URL;
  if (!url) return "FACTS_WORKER_URL not set";
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: [], previous_facts: null }),
      signal: AbortSignal.timeout(FACTS_WORKER_TIMEOUT_MS),
    });
    // 400/422 = bad request (endpoint is up); 405 = method not allowed (still up)
    // 500 = endpoint is up but downstream (LLM) may be misconfigured — still counts as reachable
    if (res.ok || [400, 405, 422, 500].includes(res.status)) return null;
    const text = await res.text();
    let detail = text;
    try {
      const j = JSON.parse(text) as { error?: string; detail?: string };
      if (j.error) detail = j.detail ? `${j.error}\n${j.detail}` : j.error;
    } catch {
      // use raw text
    }
    return `HTTP ${res.status}: ${detail.split("\n")[0].slice(0, 200)}`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function checkOpenAI(): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return "OPENAI_API_KEY not set";
  const base = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const url = base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) return null;
    const text = await res.text();
    return `HTTP ${res.status}: ${text.slice(0, 120)}`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function checkOllama(): Promise<string | null> {
  const base = process.env.OLLAMA_BASE_URL?.trim();
  if (!base) return "OLLAMA_BASE_URL not set";
  const url = `${base.replace(/\/$/, "")}/api/tags`;
  const t0 = Date.now();
  // #region agent log
  fetch('http://127.0.0.1:7243/ingest/af5b746e-3a32-49ef-92b2-aa2d9876cfd3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'check-services.ts:checkOllama',message:'start',data:{url,timeoutMs:15000},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
    });
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/af5b746e-3a32-49ef-92b2-aa2d9876cfd3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'check-services.ts:checkOllama',message:'ok',data:{status:res.status,elapsedMs:Date.now()-t0},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    if (res.ok) return null;
    return `HTTP ${res.status}`;
  } catch (e: any) {
    const errMsg = e instanceof Error ? e.message : String(e);
    const cause = e?.cause ? (e.cause instanceof Error ? e.cause.message : String(e.cause)) : 'none';
    const errName = e?.name ?? 'unknown';
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/af5b746e-3a32-49ef-92b2-aa2d9876cfd3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'check-services.ts:checkOllama',message:'error',data:{errName,errMsg,cause,elapsedMs:Date.now()-t0},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    return errMsg;
  }
}

async function checkFeed(): Promise<string | null> {
  const base = process.env.FEED_URL ?? "http://localhost:3002";
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/summary`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) return null;
    return `HTTP ${res.status}`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function runOne(
  name: string,
  check: () => Promise<string | null>
): Promise<{ name: string; err: string | null }> {
  const err = await check();
  return { name, err };
}

export async function checkAllServices(opts?: {
  maxWaitSec?: number;
  retries?: number;
  delayMs?: number;
}): Promise<{ ok: boolean; results: Array<{ name: string; err: string | null }> }> {
  const envWait = process.env.CHECK_SERVICES_MAX_WAIT_SEC;
  const maxWaitSec = opts?.maxWaitSec ?? (envWait !== undefined && envWait !== "" ? Number(envWait) : 0);
  const retries = opts?.retries ?? RETRIES;
  const delayMs = opts?.delayMs ?? DELAY_MS;

  const checks: Array<{ name: string; check: () => Promise<string | null> }> = [
    { name: "Postgres", check: checkPostgres },
    { name: "S3", check: checkS3 },
    { name: "NATS", check: checkNats },
    { name: "facts-worker", check: checkFactsWorker },
  ];
  if (process.env.OLLAMA_BASE_URL?.trim()) {
    checks.push({ name: "Ollama", check: checkOllama });
  } else if (process.env.OPENAI_API_KEY?.trim()) {
    checks.push({ name: "OpenAI", check: checkOpenAI });
  }
  if (process.env.CHECK_FEED === "1") {
    checks.push({ name: "feed", check: checkFeed });
  }

  const deadline = maxWaitSec > 0 ? Date.now() + maxWaitSec * 1000 : 0;

  for (let round = 0; ; round++) {
    const results = await Promise.all(checks.map((c) => runOne(c.name, c.check)));
    const failed = results.filter((r) => r.err != null);
    if (failed.length === 0) {
      return { ok: true, results };
    }
    if (maxWaitSec > 0 && Date.now() >= deadline) {
      return { ok: false, results };
    }
    if (maxWaitSec === 0 && round >= retries - 1) {
      return { ok: false, results };
    }
    const wait = maxWaitSec > 0 ? Math.min(delayMs, (deadline - Date.now()) / 2) : delayMs;
    if (round === 0) {
      console.error("Services not ready:");
      for (const r of failed) console.error(`  ${r.name}: ${r.err}`);
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/af5b746e-3a32-49ef-92b2-aa2d9876cfd3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'check-services.ts:retry-loop',message:'first-failure',data:{failed:failed.map(r=>({name:r.name,err:r.err})),round},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
    }
    console.error(`Retrying in ${Math.round(wait / 1000)}s...`);
    await sleep(wait);
  }
}

async function main(): Promise<void> {
  // #region agent log
  fetch('http://127.0.0.1:7243/ingest/af5b746e-3a32-49ef-92b2-aa2d9876cfd3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'check-services.ts:main',message:'env-snapshot',data:{OLLAMA_BASE_URL:process.env.OLLAMA_BASE_URL,FACTS_WORKER_URL:process.env.FACTS_WORKER_URL,nodeVersion:process.version},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  const { ok, results } = await checkAllServices();
  if (ok) {
    const list = results.map((r) => r.name).join(", ");
    console.log(`All services OK (${list}).`);
    process.exit(0);
  }
  console.error("Preflight failed:");
  for (const r of results) {
    if (r.err) console.error(`  ${r.name}: ${r.err}`);
  }
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
