/**
 * Real integration test: exercises every LLM access path used by the swarm.
 * Run: node --loader ts-node/esm scripts/test-llm-paths.ts
 */
import "dotenv/config";
import { Agent } from "@mastra/core/agent";
import { getChatModelConfig, getOllamaBaseUrl, getEmbeddingModel, getHitlModel } from "../src/modelConfig.js";

const DBG = "http://127.0.0.1:7243/ingest/af5b746e-3a32-49ef-92b2-aa2d9876cfd3";
function dbg(loc: string, msg: string, data: Record<string, unknown> = {}) {
  fetch(DBG, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ location: loc, message: msg, data, timestamp: Date.now() }),
  }).catch(() => {});
}

async function testOllamaRaw() {
  const base = getOllamaBaseUrl();
  console.log("\n=== Test 1: Ollama native /api/tags ===");
  dbg("test-llm:1", "ollama-raw-start", { base });
  if (!base) {
    console.log("SKIP: OLLAMA_BASE_URL not set");
    dbg("test-llm:1", "ollama-raw-skip", { reason: "no base" });
    return;
  }
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/api/tags`, { signal: AbortSignal.timeout(5000) });
    const data = await res.json() as { models?: Array<{ name: string }> };
    const models = (data.models ?? []).map((m: { name: string }) => m.name);
    console.log(`OK: ${models.length} models:`, models.slice(0, 5).join(", "));
    dbg("test-llm:1", "ollama-raw-ok", { status: res.status, modelCount: models.length, models: models.slice(0, 5) });
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    console.log("FAIL:", err);
    dbg("test-llm:1", "ollama-raw-fail", { error: err });
  }
}

async function testOpenAIRaw() {
  console.log("\n=== Test 2: OpenAI /v1/models ===");
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const base = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  dbg("test-llm:2", "openai-raw-start", { base, hasKey: !!apiKey });
  if (!apiKey) {
    console.log("SKIP: OPENAI_API_KEY not set");
    dbg("test-llm:2", "openai-raw-skip", {});
    return;
  }
  try {
    const url = base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    console.log(`OK: HTTP ${res.status}`);
    dbg("test-llm:2", "openai-raw-ok", { status: res.status, url });
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    console.log("FAIL:", err);
    dbg("test-llm:2", "openai-raw-fail", { error: err });
  }
}

async function testOllamaChatDirect() {
  const base = getOllamaBaseUrl();
  console.log("\n=== Test 3: Ollama /v1/chat/completions (OpenAI-compatible) ===");
  if (!base) {
    console.log("SKIP: OLLAMA_BASE_URL not set");
    return;
  }
  const url = `${base.replace(/\/$/, "")}/v1/chat/completions`;
  dbg("test-llm:3", "ollama-v1-chat-start", { url });
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.EXTRACTION_MODEL || "qwen3:8b",
        messages: [{ role: "user", content: "Say OK" }],
        max_tokens: 5,
      }),
      signal: AbortSignal.timeout(60000),
    });
    const data = await res.json() as Record<string, unknown>;
    console.log(`OK: HTTP ${res.status}, response keys:`, Object.keys(data));
    dbg("test-llm:3", "ollama-v1-chat-ok", { status: res.status, keys: Object.keys(data) });
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    console.log("FAIL:", err);
    dbg("test-llm:3", "ollama-v1-chat-fail", { error: err });
  }
}

async function testMastraAgent() {
  console.log("\n=== Test 4: Mastra Agent via getChatModelConfig() ===");
  const config = getChatModelConfig();
  dbg("test-llm:4", "mastra-config", { config });
  console.log("Config:", JSON.stringify(config));
  if (!config) {
    console.log("SKIP: getChatModelConfig() returned null");
    return;
  }
  try {
    const agent = new Agent({
      id: "test-agent",
      name: "Test Agent",
      instructions: "You are a test agent. Reply with exactly: OK",
      model: config,
    });
    dbg("test-llm:4", "mastra-agent-created", { id: config.id, url: config.url });
    const result = await agent.generate("Say OK", { maxSteps: 1 });
    const text = result.text ?? "";
    console.log(`OK: "${text.slice(0, 100)}"`);
    dbg("test-llm:4", "mastra-agent-ok", { text: text.slice(0, 200) });
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    const cause = (e as any)?.cause?.message ?? "";
    const url = (e as any)?.url ?? "";
    console.log("FAIL:", err);
    dbg("test-llm:4", "mastra-agent-fail", { error: err, cause, url });
  }
}

async function testFactsWorker() {
  console.log("\n=== Test 5: facts-worker /extract (real LLM call) ===");
  const fwUrl = process.env.FACTS_WORKER_URL ?? "http://localhost:8010";
  dbg("test-llm:5", "facts-worker-start", { fwUrl });
  try {
    const res = await fetch(`${fwUrl}/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        context: [{ type: "context_doc", payload: { text: "NovaTech AG has ARR of 50M EUR.", title: "Test" } }],
        previous_facts: null,
      }),
      signal: AbortSignal.timeout(120000),
    });
    const data = await res.json() as Record<string, unknown>;
    console.log(`HTTP ${res.status}, keys:`, Object.keys(data));
    if (res.ok) {
      const facts = data.facts as Record<string, unknown> | undefined;
      console.log("Facts entities:", (facts as any)?.entities?.slice?.(0, 3));
    } else {
      console.log("Error:", JSON.stringify(data).slice(0, 300));
    }
    dbg("test-llm:5", res.ok ? "facts-worker-ok" : "facts-worker-error", {
      status: res.status,
      keys: Object.keys(data),
      sample: JSON.stringify(data).slice(0, 500),
    });
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    console.log("FAIL:", err);
    dbg("test-llm:5", "facts-worker-fail", { error: err });
  }
}

async function testMastraWithOpenAI() {
  console.log("\n=== Test 6: Mastra Agent forced to OpenAI (no Ollama) ===");
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    console.log("SKIP: OPENAI_API_KEY not set");
    return;
  }
  const config = {
    id: "openai/gpt-4o-mini" as const,
    url: "https://api.openai.com/v1",
    apiKey,
  };
  dbg("test-llm:6", "mastra-openai-start", { id: config.id, url: config.url });
  try {
    const agent = new Agent({
      id: "test-openai-agent",
      name: "Test OpenAI Agent",
      instructions: "Reply with exactly: OK",
      model: config,
    });
    const result = await agent.generate("Say OK", { maxSteps: 1 });
    const text = result.text ?? "";
    console.log(`OK: "${text.slice(0, 100)}"`);
    dbg("test-llm:6", "mastra-openai-ok", { text: text.slice(0, 200) });
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    const url = (e as any)?.url ?? "";
    console.log("FAIL:", err);
    dbg("test-llm:6", "mastra-openai-fail", { error: err, url });
  }
}

async function main() {
  console.log("LLM Path Integration Test");
  console.log("=========================");
  console.log("OLLAMA_BASE_URL:", process.env.OLLAMA_BASE_URL ?? "(unset)");
  console.log("OPENAI_BASE_URL:", process.env.OPENAI_BASE_URL ?? "(unset)");
  console.log("OPENAI_API_KEY:", process.env.OPENAI_API_KEY ? "set (redacted)" : "(unset)");
  console.log("EXTRACTION_MODEL:", process.env.EXTRACTION_MODEL ?? "(default)");

  dbg("test-llm:main", "start", {
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL ?? null,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? null,
    hasOpenAIKey: !!process.env.OPENAI_API_KEY,
    EXTRACTION_MODEL: process.env.EXTRACTION_MODEL ?? null,
  });

  await testOllamaRaw();       // Hyp A: is Ollama even running?
  await testOpenAIRaw();        // Hyp C: is OpenAI reachable?
  await testOllamaChatDirect(); // Hyp B: does /v1/chat/completions work?
  await testMastraAgent();      // Hyp B+E: does Mastra route correctly?
  await testFactsWorker();      // Hyp D: does the Python worker work?
  await testMastraWithOpenAI(); // Hyp E: does Mastra work with OpenAI directly?

  // Give logs time to flush
  await new Promise(r => setTimeout(r, 1000));
  console.log("\n=== Done ===");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
