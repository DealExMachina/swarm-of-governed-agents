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
import { loadPolicies, evaluateRules } from "./governance.js";

const FEED_PORT = parseInt(process.env.FEED_PORT ?? "3002", 10);
const NATS_STREAM = process.env.NATS_STREAM ?? "SWARM_JOBS";
const S3_BUCKET = process.env.S3_BUCKET ?? null;
const GOVERNANCE_PATH = process.env.GOVERNANCE_PATH ?? join(process.cwd(), "governance.yaml");

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
    sendJson(res, 200, { seq, ok: true, message: "Document added; facts pipeline will run when agents process it." });
  } catch (e) {
    sendJson(res, 500, { error: toErrorString(e) });
  }
}

/** GET /summary: state, facts summary, drift, and recent pipeline events for demo output. */
async function handleSummary(res: ServerResponse): Promise<void> {
  try {
    const state = await loadState();
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
          const config = loadPolicies(GOVERNANCE_PATH);
          suggested_actions = evaluateRules({ level, types }, config);
        } catch {
          // governance file optional for summary
        }
        const references = (drift.references as Array<{ type?: string; doc?: string; excerpt?: string }>) ?? [];
        return { level, types, notes, suggested_actions, references };
      })(),
      what_changed: recent
        .filter((e) => ["state_transition", "facts_extracted", "drift_analyzed", "context_doc", "bootstrap"].includes((e.data as { type?: string })?.type ?? ""))
        .slice(-10)
        .map((e) => ({
          seq: e.seq,
          type: (e.data as { type?: string }).type,
          ts: e.ts,
          payload: (e.data as { payload?: Record<string, unknown> }).payload ?? {},
        })),
    };
    sendJson(res, 200, summary);
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
    .what-changed { font-size: 0.8125rem; }
    .what-changed .event { padding: 0.5rem 0; border-bottom: 1px solid var(--border); }
    .what-changed .event:last-child { border-bottom: none; }
    .what-changed .event-type { font-weight: 500; color: var(--accent); }
    .what-changed .event-ts { color: var(--muted); font-size: 0.75rem; }
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
          html += '<h2 style="margin-top: 1rem;">Recent changes</h2><div class="what-changed">';
          w.forEach(function(ev) {
            html += '<div class="event"><span class="event-type">' + escapeHtml(ev.type || '') + '</span> <span class="event-ts">' + (ev.ts || '').slice(0, 19) + '</span> seq ' + ev.seq + '</div>';
          });
          html += '</div>';
        }
        summaryContent.innerHTML = html;
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
        await handleAddDoc(req, res);
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
