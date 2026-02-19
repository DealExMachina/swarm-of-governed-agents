/**
 * Seed the context WAL with one or more events so the facts agent has input to extract from.
 * Run after agents and Postgres are up. Then trigger an extract_facts job (e.g. npm run loadgen -- 1)
 * or wait for the next cycle.
 *
 * Usage: npx ts-node --esm scripts/seed-context.ts [path to text file]
 *   If no file: inserts a short sample. If file: reads and inserts one event with file content.
 */
import "dotenv/config";
import { readFileSync } from "fs";
import { appendEvent } from "../src/contextWal.js";
import { createSwarmEvent } from "../src/events.js";

async function main(): Promise<void> {
  const filePath = process.argv[2];
  const text = filePath
    ? readFileSync(filePath, "utf-8")
    : "Acme Corp announced Q3 revenue of $2.1M, up 15% YoY. The CEO stated that growth was driven by the new product line. Next quarter they plan to hire 20 engineers.";

  const event = createSwarmEvent("context_doc", { text, title: filePath ?? "sample", source: "seed-context" }, { source: "seed-script" });
  const seq = await appendEvent(event as unknown as Record<string, unknown>);
  console.log("Seeded context_events:", seq, "type: context_doc, length:", text.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
