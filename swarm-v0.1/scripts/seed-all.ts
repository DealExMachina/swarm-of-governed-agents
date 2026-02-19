/**
 * Seed the context WAL with all documents in seed-docs/ (in filename order).
 * Run after agents and Postgres are up. Then trigger extract_facts (e.g. npm run loadgen -- 1).
 *
 * Usage: npm run seed:all
 */
import "dotenv/config";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { appendEvent } from "../src/contextWal.js";
import { createSwarmEvent } from "../src/events.js";

const SEED_DIR = join(process.cwd(), "seed-docs");

async function main(): Promise<void> {
  const files = readdirSync(SEED_DIR)
    .filter((f) => (f.endsWith(".txt") || f.endsWith(".md")) && f !== "README.md")
    .sort();

  if (files.length === 0) {
    console.error("No .txt or .md files in seed-docs/");
    process.exit(1);
  }

  console.log(`Seeding ${files.length} docs from ${SEED_DIR}...`);
  const seqs: number[] = [];

  for (const file of files) {
    const filePath = join(SEED_DIR, file);
    const text = readFileSync(filePath, "utf-8");
    const event = createSwarmEvent(
      "context_doc",
      { text, title: file, filename: file, source: "seed-docs" },
      { source: "seed-all" },
    );
    const seq = await appendEvent(event as unknown as Record<string, unknown>);
    seqs.push(seq);
    console.log("  ", file, "-> seq", seq, "(" + text.length, "chars)");
  }

  console.log("Done. Seeded", seqs.length, "events (seq", seqs[0], "..", seqs[seqs.length - 1], ").");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
