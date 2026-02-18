"""
Live test: calls DSPy + OpenAI (no mocks). Requires OPENAI_API_KEY and OPENAI_BASE_URL in env.
Loads .env from project root (swarm-v0.1/.env) if present.
Run from swarm-v0.1: python workers/facts-worker/scripts/test_live_openai.py
Or from workers/facts-worker: python scripts/test_live_openai.py (loads ../../.env)
"""
import os
import sys

# Project root = swarm-v0.1 (two levels up from workers/facts-worker)
_script_dir = os.path.dirname(os.path.abspath(__file__))
_worker_dir = os.path.dirname(_script_dir)
_root = os.path.dirname(os.path.dirname(_worker_dir))
_env_path = os.path.join(_root, ".env")
if os.path.isfile(_env_path):
    with open(_env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                v = v.strip().strip('"').strip("'")
                os.environ[k] = v

# Ensure worker dir is on path so we can import rlm_facts
sys.path.insert(0, _worker_dir)
os.chdir(_worker_dir)

from rlm_facts import extract_facts_and_drift

if not os.getenv("OPENAI_API_KEY"):
    print("OPENAI_API_KEY not set. Set it in .env or environment.")
    sys.exit(1)

context = [
    {"text": "We use RustFS for storage. The goal is auditability and a single source of truth."},
    {"text": "The facts-worker extracts entities, claims, and goals from context."},
]
print("Calling DSPy + OpenAI (no stub)...")
facts, drift = extract_facts_and_drift(context, None)

assert facts.get("version") == 2, facts
assert "entities" in facts
assert "claims" in facts
assert "goals" in facts
assert "hash" in facts
assert drift.get("facts_hash") == facts["hash"]
assert "level" in drift
assert "types" in drift

print("OK – live DSPy + OpenAI response:")
print("  facts.version:", facts["version"])
print("  facts.entities:", facts.get("entities"))
print("  facts.claims:", facts.get("claims")[:3] if facts.get("claims") else [])
print("  facts.goals:", facts.get("goals"))
print("  drift.level:", drift["level"])
print("  drift.types:", drift.get("types"))
