# Rust Evaluation

> Should any part of the governed agent swarm be rewritten in Rust?

Back to [README.md](../README.md).

---

## 1. Current stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Language | TypeScript (ES2022, strict mode) | ~40 source files in `src/` |
| Runtime | Node.js (ESM, ts-node loader) | pnpm 10, vitest |
| Messaging | NATS 2 (JetStream) | `nats` npm client v2.29 |
| Database | PostgreSQL 15 + pgvector | `pg` npm client v8.13 |
| Object store | MinIO (S3-compatible) | `@aws-sdk/client-s3` v3 |
| Agent framework | `@mastra/core` v0.24 | LLM tool-calling agents |
| Authorization | OpenFGA | Per-agent permission checks |
| Observability | OpenTelemetry SDK + OTLP exporter | Traces to collector |
| Sidecar | Python facts-worker | Embedding pipeline |
| Rust code | **None** | No `.rs` files in the repository |

---

## 2. Bottleneck analysis

The system is **I/O bound**. CPU utilization is negligible relative to external wait times.

| Operation | Typical latency | Bottleneck? |
|-----------|----------------|-------------|
| LLM inference (tool-calling agent) | ~30 s per call | **Yes -- dominant** |
| PostgreSQL queries (state, WAL, semantic graph) | < 100 ms | No |
| NATS publish / consume round-trip | < 1 ms | No |
| S3 (MinIO) object reads | < 50 ms | No |
| Activation filter evaluation (pure JS) | < 1 ms | No |
| Convergence tracker computation | < 5 ms | No |

Each agent spends >99% of its wall-clock time waiting on LLM API responses. Node.js async I/O handles PG, NATS, and S3 concurrency without contention. The event loop is never saturated.

---

## 3. What Rust would buy

| Benefit | Detail |
|---------|--------|
| Memory safety guarantees | No null-pointer dereferences, no data races at compile time. TypeScript's `strict` mode catches type errors but not concurrency bugs. |
| Lower RSS per agent | ~5-10 MB per Rust process vs. ~80 MB per Node.js process (V8 heap overhead). With 4+ agents, that is 20-40 MB vs. 320+ MB. |
| No GC pauses | V8's GC introduces occasional 5-50 ms stop-the-world pauses. Irrelevant when LLM calls take 30 s, but matters at high message throughput. |
| Structured concurrency | tokio provides cancellation, select!, JoinSet, and structured task hierarchies. Node.js has AbortController but no native structured concurrency. |
| Native NATS client | `nats.rs` is the reference JetStream client, supports all JetStream 2.10+ features natively. The JS client (`nats.ws` / `nats` npm) lags on edge features. |
| Native async PG | `tokio-postgres` is zero-copy async. The `pg` npm client uses libuv thread pool for DNS and TLS. |
| Typed state machines | Rust enums with exhaustive match enforce state transition correctness at compile time. TypeScript's `stateGraph.ts` uses string literals with runtime guards. |

---

## 4. What Rust would NOT fix

All 16 vulnerabilities identified in the robustness hardening audit (V1 through V13, plus sub-items) are **protocol-level gaps**, not language-level deficiencies:

| ID | Gap | Language-agnostic? |
|----|-----|-------------------|
| V1 | Missing retry with backoff on PG/NATS transient errors | Yes -- must be explicitly coded in any language |
| V2 | Missing PG transactions around multi-statement writes | Yes -- same SQL semantics in any client |
| V3 | Missing SIGTERM / SIGINT graceful shutdown handlers | Yes -- signal handling is OS-level |
| V4 | Missing circuit breakers on external service calls | Yes -- pattern implementation, not language feature |
| V5 | Missing dead letter queue for poisoned NATS messages | Yes -- NATS configuration + handler logic |
| V6 | Missing idempotency guards on message processing | Yes -- requires dedup table or NATS dedup window |
| V7 | Missing health check / readiness probe endpoints | Yes -- HTTP server in any language |
| V8 | Missing connection pool size limits and timeouts | Yes -- pool config, not language concern |
| V9 | Missing structured error classification | Yes -- error taxonomy is a design decision |
| V10 | Missing backpressure on consumer fetch loops | Yes -- consumer configuration |
| V11 | Missing OTEL span propagation across NATS | Yes -- header injection, any language |
| V12 | Missing WAL retention / compaction policy | Yes -- PG table maintenance |
| V13 | Missing stale consumer cleanup | Yes -- NATS admin API calls |

The `resilience.ts` module already implements retry (V1) and circuit breaker (V4) patterns. The `eventBus.ts` module already handles explicit ack/nak with `max_deliver: 5` (V5 partial). These are TypeScript implementations that would need identical logic in Rust.

---

## 5. Comparison table

| Dimension | TypeScript (current) | Rust (hypothetical) |
|-----------|---------------------|---------------------|
| **Primary bottleneck** | LLM inference (~30 s) | Same -- LLM is external |
| **RSS per agent** | ~80 MB (V8 heap) | ~5-10 MB |
| **GC pauses** | 5-50 ms occasional | None |
| **Concurrency model** | Event loop + async/await | tokio tasks + structured concurrency |
| **NATS client** | `nats` npm (JS, maintained) | `nats.rs` (reference impl, native) |
| **PG client** | `pg` npm (libuv thread pool) | `tokio-postgres` (native async) |
| **S3 client** | `@aws-sdk/client-s3` (official) | `aws-sdk-rust` (official) |
| **LLM integration** | `@mastra/core` (TypeScript-native) | No equivalent; would need custom HTTP client |
| **OpenFGA integration** | HTTP client (JS SDK available) | HTTP client (no official Rust SDK) |
| **OTEL integration** | `@opentelemetry/sdk-node` (official) | `opentelemetry-rust` (official) |
| **Migration effort** | 0 (status quo) | 4-8 weeks full rewrite |
| **FFI bridge (napi-rs)** | N/A | ~2 weeks per component |
| **Team Rust experience** | Not assessed | Hiring/ramp-up cost unknown |
| **Ecosystem maturity** | Broad (npm, Mastra, Zod) | Narrower for agent/LLM tooling |

---

## 6. Potential Rust candidates (future)

These components would benefit from Rust **only if** the indicated trigger condition is met:

### 6.1 NATS consumer hot path

**Trigger:** Message volume exceeds ~10K messages/second sustained.

Currently, the agent loop in `agentLoop.ts` pulls batches of 10 messages with a 5 s timeout. At current volumes (low hundreds of messages per cycle), Node.js handles this without pressure. If the swarm scales to >10K msg/s (e.g., multi-tenant, hundreds of scopes), a Rust NATS consumer using `nats.rs` with `async-nats` would reduce per-message overhead and eliminate GC jitter on the hot path.

**Approach:** napi-rs native addon exposing a `consume(stream, subject, batchSize) -> Promise<Message[]>` binding. TypeScript orchestration unchanged.

### 6.2 Embeddings computation

**Trigger:** On-device NLP replaces external embedding API calls.

Currently, embeddings are computed by the Python facts-worker calling an external API. If the system moves to on-device embedding (e.g., ONNX Runtime, candle), Rust's zero-copy tensor handling and lack of GIL/GC would provide 2-5x throughput improvement over Python and eliminate a sidecar process.

**Approach:** Standalone Rust binary or napi-rs addon wrapping `candle` or `ort` (ONNX Runtime bindings).

### 6.3 State machine core

**Trigger:** State machine complexity grows beyond the current 3-node cycle.

Rust enums with `#[non_exhaustive]` and exhaustive `match` enforce that every state transition is handled at compile time. The current `stateGraph.ts` uses a `Record<string, string>` for transitions with runtime validation. As the state machine grows (more nodes, conditional transitions, parallel states), compile-time transition verification becomes increasingly valuable.

**Approach:** Shared Rust library compiled to WASM or napi-rs addon, exporting `validate_transition(from, to, context) -> Result<(), TransitionError>`.

---

## 7. Recommendation

**Harden TypeScript first.** The current robustness work (retry, circuit breakers, graceful shutdown, dead letter queues, idempotency) addresses the actual failure modes. These are protocol-level fixes that must exist regardless of language.

**Evaluate Rust only after profiling shows a CPU bottleneck.** Today, the system spends >99% of wall time on I/O (LLM, PG, NATS, S3). Rewriting I/O-bound code in Rust does not reduce latency -- it reduces memory footprint and eliminates GC pauses, neither of which is a current problem.

**Most likely first Rust component:** A high-throughput NATS consumer (section 6.1), introduced as a napi-rs native addon, if message volume exceeds what Node.js can handle at acceptable latency. This is the smallest surface area with the clearest performance trigger.

**Decision gate:** Profile with `clinic.js` or `0x` under realistic load. If the flame graph shows >10% CPU time in V8 GC or NATS message deserialization, evaluate a Rust addon for that specific path. Until then, the TypeScript implementation is the correct choice.

---

## 8. RustFS — S3-compatible storage replacement

### What is RustFS?

[RustFS](https://github.com/rustfs/rustfs) is an S3-compatible object storage server written in Rust. It positions itself as a high-performance, Apache 2.0-licensed alternative to MinIO, which moved to AGPLv3 and entered maintenance mode in late 2025.

### Current setup

The swarm uses **MinIO** as its S3-compatible object store (`docker-compose.yml` → `minio/minio:latest`). All S3 interactions go through `@aws-sdk/client-s3` with a configurable `S3_ENDPOINT` environment variable. The `src/s3.ts` module creates an `S3Client` pointing at this endpoint.

### Migration effort: zero code changes

Because the project uses the standard AWS S3 SDK with a configurable endpoint, switching from MinIO to RustFS requires **no source code changes**. The migration is purely infrastructure:

```yaml
# docker-compose.yml — before (MinIO)
s3:
  image: minio/minio:latest
  command: server /data --console-address ":9001"

# docker-compose.yml — after (RustFS)
s3:
  image: rustfs/rustfs:latest
  command: server /data --console-address ":9001"
```

Environment variables (`S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`) remain identical. The AWS CLI and `mc` (MinIO Client) also work with RustFS out of the box.

### Performance comparison

| Benchmark | MinIO | RustFS | Delta |
|-----------|-------|--------|-------|
| 4 KB objects (PUT/GET) | baseline | ~2.3x faster | RustFS advantage for small objects |
| Large sequential reads (>1 MB) | faster | slower | MinIO advantage for bulk transfers |
| Memory footprint | ~200-400 MB | ~50-100 MB | RustFS is leaner |
| Startup time | ~2-3 s | < 1 s | RustFS faster cold start |

The swarm's S3 usage pattern is predominantly **small objects** (JSON documents, drift reports, fact extracts — typically 1-50 KB). RustFS's small-object performance advantage is directly relevant.

### Licensing

| | MinIO | RustFS |
|---|-------|--------|
| License | AGPLv3 (since 2021) | Apache 2.0 |
| Commercial impact | AGPL requires source disclosure for network-accessible modifications | Permissive; no copyleft obligation |

For teams deploying modified builds of the storage layer or embedding it in proprietary infrastructure, RustFS's Apache 2.0 license removes the AGPL compliance burden.

### Maturity assessment

| Dimension | Status |
|-----------|--------|
| Version | v1.0.0-alpha (as of Feb 2026) |
| Production readiness | **Alpha** — not recommended for production data |
| S3 API coverage | Core operations (PutObject, GetObject, ListObjects, DeleteObject, multipart upload) |
| Missing S3 features | Some advanced features (object lock, bucket policies, replication) may be incomplete |
| Community | Active development, growing contributor base |
| Ecosystem | Compatible with AWS CLI, mc, any S3 SDK |

### Recommendation

**Wait for RustFS v1.0 stable before switching production workloads.** The alpha status means data durability guarantees are not yet battle-tested.

**Use RustFS now for development and CI environments.** The faster startup, lower memory footprint, and Apache 2.0 license make it attractive for non-production use. Add a `docker-compose.rustfs.yml` override or a `STORAGE_BACKEND` toggle in the Makefile.

**Switch production when:**
1. RustFS reaches stable v1.0 with documented durability guarantees
2. The project's S3 usage patterns (small JSON objects) continue to align with RustFS's performance strengths
3. MinIO's maintenance mode becomes a concern (security patches, compatibility with newer S3 SDK versions)

**No code changes required.** The migration is a single docker-compose image swap. The `@aws-sdk/client-s3` + `S3_ENDPOINT` pattern ensures complete decoupling from the storage backend.
