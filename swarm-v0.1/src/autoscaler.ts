import "dotenv/config";
import { spawn } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { makeS3 } from "./s3.js";
import { countPrefix } from "./s3Counter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SWARM_SCRIPT = join(__dirname, "swarm.js");
const PROJECT_ROOT = join(__dirname, "..");

const BUCKET = process.env.S3_BUCKET!;
const MAX_FACTS = 6;
const TARGET_PER_AGENT = 20;
const CHECK_INTERVAL = 3000;
const PENDING_PREFIX = "queue/pending/extract_facts/";

const agents: Map<string, ReturnType<typeof spawn>> = new Map();

function startFactsAgent(id: string): void {
  const child = spawn("node", [SWARM_SCRIPT], {
    env: {
      ...process.env,
      AGENT_ROLE: "facts",
      AGENT_ID: id,
    },
    stdio: "inherit",
    cwd: PROJECT_ROOT,
  });

  agents.set(id, child);

  child.on("exit", () => {
    agents.delete(id);
  });
}

function currentFactsCount(): number {
  return agents.size;
}

async function main(): Promise<void> {
  const s3 = makeS3();

  while (true) {
    const pending = await countPrefix(s3, BUCKET, PENDING_PREFIX);

    let desired = Math.ceil(pending / TARGET_PER_AGENT);
    if (desired < 1) desired = 1;
    if (desired > MAX_FACTS) desired = MAX_FACTS;

    const current = currentFactsCount();

    if (desired > current) {
      const toAdd = desired - current;
      console.log(`Scaling up facts agents: ${current} -> ${desired}`);
      for (let i = 0; i < toAdd; i++) {
        const id = `facts-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
        startFactsAgent(id);
      }
    }

    if (desired < current) {
      const toRemove = current - desired;
      console.log(`Scaling down facts agents: ${current} -> ${desired}`);
      const ids = Array.from(agents.keys()).slice(0, toRemove);
      for (const id of ids) {
        agents.get(id)?.kill("SIGTERM");
      }
    }

    await new Promise((r) => setTimeout(r, CHECK_INTERVAL));
  }
}

main().catch(console.error);
