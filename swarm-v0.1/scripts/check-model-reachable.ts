/**
 * Test if the OpenAI-compatible model is reachable with current env.
 * Uses the same OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL as the facts agent and facts-worker.
 * Run: npm run check:model
 */
import "dotenv/config";

const API_KEY = process.env.OPENAI_API_KEY;
const BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

async function main(): Promise<void> {
  if (!API_KEY || API_KEY === "sk-xxxx") {
    console.error("OPENAI_API_KEY not set or still placeholder. Set it in .env");
    process.exit(1);
  }

  const url = `${BASE_URL}/chat/completions`;
  const body = {
    model: MODEL,
    max_tokens: 5,
    messages: [{ role: "user", content: "Say OK" }],
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`Model unreachable: ${res.status} ${res.statusText}`);
      console.error(text.slice(0, 500));
      process.exit(1);
    }

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content ?? "";
    console.log("Model reachable:", BASE_URL, "model:", MODEL);
    console.log("Response:", content.slice(0, 80).trim() || "(empty)");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Model unreachable:", msg);
    process.exit(1);
  }
}

main();
