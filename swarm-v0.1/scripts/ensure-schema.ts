/**
 * Run all SQL migrations idempotently via the pg library.
 * No psql dependency required. Safe to run on every startup.
 *
 * Usage: node --loader ts-node/esm scripts/ensure-schema.ts
 */
import "dotenv/config";
import { Pool } from "pg";
import { readdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url, max: 1 });

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.log("No migration files found.");
    await pool.end();
    return;
  }

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    try {
      await pool.query(sql);
      console.log(`  ${file}: OK`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("already exists")) {
        console.log(`  ${file}: OK (already exists)`);
      } else {
        console.error(`  ${file}: FAILED — ${msg}`);
        await pool.end();
        process.exit(1);
      }
    }
  }

  console.log("Schema ready.");
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
