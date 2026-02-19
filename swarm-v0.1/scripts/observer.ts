/**
 * CLI observer: tail swarm.events.> and pretty-print to terminal.
 * Run: npm run observe
 */

import "dotenv/config";
import { makeEventBus } from "../src/eventBus.js";

const NATS_STREAM = process.env.NATS_STREAM ?? "SWARM_JOBS";

const colors: Record<string, string> = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

function colorize(type: string): string {
  if (type.includes("briefing")) return colors.cyan;
  if (type.includes("state") || type.includes("transition")) return colors.green;
  if (type.includes("proposal") || type.includes("action")) return colors.yellow;
  if (type.includes("facts") || type.includes("drift")) return colors.blue;
  return colors.magenta;
}

function formatEvent(id: string, data: Record<string, unknown>): string {
  const type = (data.type as string) ?? "event";
  const ts = (data.ts as string) ?? new Date().toISOString();
  const source = (data.source as string) ?? "";
  const c = colorize(type);
  const head = `${colors.dim}${ts}${colors.reset} ${c}[${type}]${colors.reset} ${source ? `source=${source}` : ""}`;
  const payload = data.payload ?? data;
  const body = typeof payload === "object" && payload !== null && Object.keys(payload as object).length > 0
    ? "\n  " + JSON.stringify(payload, null, 2).split("\n").join("\n  ")
    : "";
  return `${head}${body}\n`;
}

async function main(): Promise<void> {
  const bus = await makeEventBus();
  await bus.ensureStream(NATS_STREAM, ["swarm.events.>"]);

  const consumer = `observer-${Date.now()}`;
  process.stderr.write(`Observing swarm.events.> (consumer: ${consumer}). Ctrl+C to stop.\n`);

  await bus.subscribe(NATS_STREAM, "swarm.events.>", consumer, async (msg) => {
    process.stdout.write(formatEvent(msg.id, msg.data as Record<string, unknown>));
  });

  await new Promise<void>(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
