# Overall fix: pg_type_typname_nsp_index race

## Why this should not happen

- **Schema is applied once before any agent starts.** `scripts/swarm-all.sh` runs `ensure-schema` (single connection) before starting the four agents. Migrations `002_context_wal.sql` and `003_swarm_state.sql` / `007_swarm_state_scope.sql` already create `context_events` and `swarm_state`.
- **App code should not create these tables.** Having multiple processes run `CREATE TABLE IF NOT EXISTS` for the same table can race in PostgreSQL (composite type registration in `pg_type`), causing `duplicate key value violates unique constraint "pg_type_typname_nsp_index"`.

## Plan

1. **Single source of truth**  
   Tables `context_events` and `swarm_state` are defined only in migrations. The only process that creates them is `ensure-schema` (one connection, sequential migrations).

2. **App: verify, never create**  
   Replace `ensureContextTable` / `ensureStateTable` with "verify table exists; if not, throw a clear error" (no `CREATE TABLE` in app code). This removes the race by design.

3. **Clear failure when schema missing**  
   If someone runs an agent without running `ensure-schema` first, the app fails fast with a message like: "Table context_events does not exist. Run schema migrations first (e.g. `pnpm run ensure-schema` or start the stack with `pnpm run swarm:all`)."

4. **Tests and scripts**  
   Integration tests and scripts that need the schema either run migrations first (e.g. test setup) or rely on the test DB having been migrated. No in-app CREATE keeps tests consistent with production.

5. **Remove advisory locks**  
   Once app code no longer creates tables, the advisory lock workaround is removed (done).

## Implementation summary

- In `contextWal.ts`: `ensureContextTable` checks that `context_events` exists (e.g. `SELECT 1 FROM information_schema.tables WHERE table_name = 'context_events'`), sets `_tableEnsured = true`, and throws with the message above if missing.
- In `stateGraph.ts`: same for `swarm_state` in `ensureStateTable`; remove lock and CREATE.
- Integration tests: they call `ensureContextTable`/`ensureStateTable` in `beforeAll`; with verify-only, tables must already exist (run `pnpm run ensure-schema` or use a DB with migrations applied). No test code change needed.
