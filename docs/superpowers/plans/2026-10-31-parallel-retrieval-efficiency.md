# Parallel retrieval and storage efficiency

User authorized implementation of the preceding audit with three parallel runners, correctness first, followed by combined verification. Preserve existing APIs, canonical version history, optimistic concurrency, explicit historical snapshots, and degraded lexical search.

## Execution and ownership

1. Retrieval runner: `src/knowledge/pg-store.ts`, `embedding-cache.ts`, related unit tests. First fix exact snapshot scope, query cache input identity, freshness scope/hash. Then coalesce concurrent queries, add safely invalidated bounded recall caching, and reuse compatible vectors for metadata-only writes.
2. Source runner: `src/worker/knowledge-worker.ts`, `source-sync-job-handler.ts`, related unit tests. First bind canonical-document evidence to the exact reconciled worktree snapshot. Then shorten project-row locks, compare dirty file hashes before replacement, selectively copy retained rows, batch inserts, and use per-item conflict checks for document synchronization.
3. Queue/model runner: `src/worker/embedding-queue-processor.ts`, shared worker scheduling, embedding client, model service, migrations if necessary, related tests. First fence stale worker failure/completion and vector publication by current ownership. Then coordinate identical embedding input across processes, reserve model capacity for interactive requests, and isolate maintenance from processing replicas.

All three runners add regressions and demonstrate failure before each fix. They stop after correctness fixes for a shared verification gate, then continue performance changes. Shared files have one owner; coordinate interfaces before editing outside ownership. Root owns integration tests, documentation, final review, and combined verification. Do not deploy, mutate live application data, or commit unrelated files.

## Review focus

- Distinct long queries must have distinct keys matching the exact model input; concurrent equal inputs compute once; failure releases coordination.
- Default searches exclude superseded source snapshots while explicit historical searches work; worktree freshness and expiry changes invalidate recall responses.
- Expired embedding owners cannot overwrite completed/reclaimed jobs or newer vectors; cache contention has bounded waiting and retry behavior.
- Different worktrees cannot mix document bodies and source evidence; staged source updates must revalidate fingerprints before atomic activation.
- Metadata-only writes preserve versions and citations without embedding jobs; model changes and changed text still require compatible vectors.
- Background capacity must not consume the interactive reservation; one-slot deployments and failure paths remain functional.

## Combined validation

Run focused regressions after the correctness gate and after each lane. Then run `npm run typecheck`, `npx eslint src tests`, `npx vitest run tests/unit`, `npm run build`, full `npm test`, and Python model-service tests. Add real PostgreSQL concurrency tests using an isolated test database when available; distinguish skipped integration coverage from executed checks. Format only changed files. Record verified behavior and remaining limitations in project knowledge after source evidence can be refreshed.

## Verification receipt

Implemented in the shared checkout with three parallel runners and cross-review. Regression tests were observed failing before fixes. Review also corrected rolled-back model-ID caching, completion of jobs whose vectors were supplied by a sibling, deterministic model-row acquisition, worktree HEAD/dirty freshness propagation, and bounded epoch scopes.

- `npm run typecheck`, `npx eslint src tests`, and `npm run build`: passed.
- `npx vitest run tests/unit --maxWorkers=2`: 331 passed.
- `npm test -- --maxWorkers=2 --testTimeout=15000`: 338 passed; 17 database tests intentionally run separately below. The timeout accommodates Windows Git subprocesses; it does not change production timeouts.
- `scripts/test-parallel-knowledge.ps1`: all 17 real PostgreSQL tests passed on a fresh disposable database, including three legacy retrieval checks with isolated fixtures. Containers removed afterward.
- `python -B services/retrieval-model/test_server.py`: 6 passed. Existing Starlette/httpx deprecation warning remains.

Measured fixture outcomes: eight independent simultaneous query providers share one model call; two worker jobs with equal input compute one vector and both finish; metadata-only updates add no embedding job; unchanged recall skips search and invalidates on source/vector/freshness changes.

No live schema migration, service deployment, or Git commit was performed. Rollout requires migrations 0014–0016 before updated services. Live source evidence remains stale and needs refresh before recording deployed behavior. Model capacity is per service process; this work does not benchmark production throughput or implement cross-process model-service admission.
