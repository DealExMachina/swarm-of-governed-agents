# Package manager (npm → pnpm) review

The repo uses **pnpm** (`pnpm-lock.yaml`); there is no `package-lock.json`. Below are the issues that can arise and what was done.

---

## 1. Docker: feed service (fixed)

- **Issue:** `docker-compose.yml` had `npm ci && npm run feed`. `npm ci` requires `package-lock.json`, so the feed container failed on startup.
- **Fix applied:** Command changed to `corepack enable && pnpm install --frozen-lockfile && pnpm run feed`. The feed container now installs with pnpm and starts correctly.
- **Note:** The feed service uses the `node:20-alpine` image and mounts the repo; Corepack is available and enables pnpm.

---

## 2. Shell scripts assume `npm run` (fixed)

- **Issue:** `scripts/swarm-all.sh` and `scripts/run-e2e.sh` called `npm run swarm`, etc. If only pnpm is installed, `npm run` may be wrong or missing.
- **Fix applied:** Each script sets `RUNNER=pnpm` when `pnpm` is in PATH and `pnpm-lock.yaml` exists, otherwise `RUNNER=npm`. All `npm run` invocations were replaced with `$RUNNER run ...` in `swarm-all.sh`, `run-e2e.sh`, and `open-demo.sh`.

---

## 3. open-demo.sh (fixed)

- **Issue:** Ran `npm run demo` to start the demo server.
- **Fix applied:** Uses the same `RUNNER` logic as in (2); starts the demo with `$RUNNER run demo`.

---

## 4. Documentation (README, DEMO.md, STATUS.md, etc.) (fixed)

- **Issue:** Docs said "run `npm run swarm:all`", "`npm run seed:demo`", etc. With pnpm as the actual lockfile, this could confuse contributors who run `npm install` (and get no lockfile) or expect to use pnpm.
- **Fix applied:** README, DEMO.md, STATUS.md, and seed-docs/README.md now state that the project uses **pnpm** and show `pnpm run <script>` for all commands. README Prerequisites include: "Node 20+; pnpm (recommended; lockfile is pnpm-lock.yaml)." DEMO.md prerequisites: "Node.js 20+ and pnpm (or npm; lockfile is pnpm-lock.yaml)."

---

## 5. package.json: `packageManager` field (fixed)

- **Issue:** Without `"packageManager": "pnpm@x.y.z"`, Corepack does not pin the package manager version.
- **Fix applied:** Added `"packageManager": "pnpm@10.30.1"` to `package.json`. Use the same version as in your lockfile or update as needed.

---

## 6. npx in script comments (fixed)

- **Issue:** `scripts/test-postgres-ollama.ts` and `scripts/seed-context.ts` mentioned "Run: npx ts-node ...".
- **Fix applied:** Comments updated to "Run: pnpm run test:postgres-ollama" and "Usage: pnpm run seed -- [path to text file]" so they match package.json scripts and the chosen package manager.

---

## 7. Other Docker services

- **Checked:** Only the **feed** service uses Node/npm. Other services:
  - **facts-worker:** Python image, `pip install`; no change.
  - postgres, nats, s3, otel-collector, openfga: no Node.
- **Conclusion:** No further Docker changes needed for the package-manager switch.

---

## 8. CI (GitHub Actions, etc.)

- No CI config in repo; no change.

---

## 9. pnpm-specific behavior

- **node_modules layout:** pnpm uses a content-addressable store and symlinks. Scripts run via `node --loader ts-node/esm ...` resolve modules through Node; as long as dependencies are declared in `package.json`, resolution is fine. No deep `require('foo/bar')` into undeclared paths were assumed.
- **Lifecycle scripts:** The feed container log showed a pnpm message about "approve-builds" for some packages; install completed successfully.
- **Hoisting:** pnpm does not hoist by default. All runtime scripts use dependencies that are declared (e.g. in `dependencies` or `devDependencies`). No issue identified.

---

## 10. Summary

| Area              | Status / action                                      |
|-------------------|------------------------------------------------------|
| Docker feed       | Fixed: use pnpm in compose command                   |
| swarm-all.sh      | Fixed: `$RUNNER` (pnpm if lockfile present)         |
| run-e2e.sh        | Fixed: same `$RUNNER`                               |
| open-demo.sh      | Fixed: same `$RUNNER`                              |
| Docs              | Fixed: pnpm as primary, lockfile note in README/DEMO |
| package.json      | Fixed: added `packageManager` for Corepack          |
| npx in comments   | Fixed: point to `pnpm run <script>`                  |
| Other Docker      | No change                                           |
| CI                | No CI in repo                                       |
| pnpm behavior     | No code changes required for current usage          |
