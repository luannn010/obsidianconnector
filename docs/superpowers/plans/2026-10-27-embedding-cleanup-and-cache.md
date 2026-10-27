# Embedding cleanup + "embed less" strategy

## Context
Live DB (read-only measurements, 2026-10-27): `search_chunks` holds 559,400 rows / 1.4 GB, but 530,190 (95%) belong to 170 superseded snapshots that are never pruned (pruning skips any snapshot referenced by activity/tasks/evidence, and only runs for the queue worker's one `PROJECT_KEY`). Superseded chunks stay `active=true`, so un-scoped vector search can return them. Active data is only ~29k chunks / ~7.1k distinct contents, yet 203k rows carry duplicated vectors. 5,302 active MC-Platform chunks have no vector and no live job (orphans); 153 ObsidianConnector jobs sit in `processing` although their chunks are embedded. 16% of active chunks exceed bge-small's 512-token window (silently truncated), and `symbol` chunks (13.9k) dominate embedding work though identifiers are better served by exact/BM25 search.

Goal: (1) clean up the existing mess safely, (2) make embedding work scale with genuinely new *meaningful* content: embed fewer, better-sized chunks, compute each distinct text once ever (content-addressed cache shared across snapshots/worktrees/projects), and avoid query-time model calls when possible.

## Approach

### A. Content-addressed embedding cache (foundation)
- Migration `0011_embedding_cache` (append to `src/knowledge/migrations.ts`; update `tests/unit/knowledge-migrations.test.ts` last-id assertion):
  - `project_knowledge.embedding_cache(model_key text, text_hash char(64), embedding vector NOT NULL, created_at, last_used_at, PRIMARY KEY(model_key,text_hash))` — unconstrained `vector` so a future model change just adds rows; `model_key = name@revision:dims`.
  - `search_chunks.embed_hash char(64)` (nullable) + index `(embed_hash) WHERE embedding IS NULL`.
- New `src/knowledge/embed-text.ts`: `embeddingText(chunk)` (normalize CRLF→LF, strip trailing spaces, collapse 3+ blank lines, cap 1,500 chars) and `embeddingHash(text)` (sha256 of normalized text). Reuse `sha256` helpers in `src/knowledge/hash.ts`.
- `EmbeddingQueueProcessor` (`src/worker/embedding-queue-processor.ts`):
  - Sweep: replace the project-scoped `reusable` CTE with a cache join (`chunks.embed_hash = cache.text_hash AND model_key=$1`) → fill vector, mark job `done` reason `cache_hit`, touch `last_used_at`.
  - Batch: dedupe by `embed_hash`, call model only for cache misses, `INSERT … ON CONFLICT DO NOTHING` into cache, then one `UPDATE … FROM unnest($ids,$vectors)` for all chunks sharing those hashes (drops per-vector round trips). Cache `modelId()` per project in memory.
  - Claim order: `priority DESC, created_at`.
- `CachingEmbeddingProvider` (new, `src/knowledge/embedding-cache.ts`) wrapping `OpenAiCompatibleEmbeddingClient` for queries: in-memory LRU (≈500) → DB cache (`model_key`, hash of `"query:" + normalized query`) → model. Adds the BGE query instruction prefix (queries only). Wire in `createPgKnowledgeStore` callers (`src/server.ts`/`src/index.ts` runtime construction).

### B. Embedding policy — embed less
- `src/worker/knowledge-worker.ts` enqueue (`:376-386`) only for embeddable kinds: `documentation`, `api_endpoint`, `database_table`, new `file_summary`, and knowledge items. `symbol` chunks keep lexical/exact search only (no job, no vector).
- Set `embed_hash` on insert for embeddable chunks (worker `:360-375`, knowledge items `pg-store.ts:1553-1575`); knowledge-item hash uses the chunk text, not `canonicalHash(record)`.
- Priorities: knowledge items 100, documentation 50, api/table 40, file_summary 30; non-primary worktrees −20.
- `src/worker/source-parser.ts`:
  - New `file_summary` unit per code file (path, exported/declared names + signatures, leading doc comment; ≤1,200 chars), built from the outline so body-only edits keep the same hash.
  - Split documentation sections and the 4,000-char fallback (`knowledge-worker.ts:324-335`) into ≤1,500-char parts at paragraph boundaries, heading repeated.
  - Bump `SOURCE_PARSER_REVISION` to `structural-v3` (forces one re-chunk; cache warm-start keeps re-embedding small).
- Vector search fix (`pg-store.ts:669-678`): exclude chunks of non-active snapshots when `snapshotId` is null (join `source_snapshots`), matching the processor's rule.

### C. Cleanup — existing mess and ongoing hygiene
- New `pruneSupersededSnapshotPayload(pool, {retentionDays, batchSnapshots})` in `src/worker/snapshot-cleanup.ts`: for **all projects**, superseded snapshots older than retention → delete their `embed_chunk` jobs, `code_symbols`, `search_chunks` (except chunks whose `chunk:<id>` appears in `source_evidence.metadata->>'ref'`), and `code_files` without remaining symbols; keep the `source_snapshots` row (activity/tasks/evidence still reference it). Batched per snapshot to stay under the 30 s statement timeout. Existing `pruneSupersededSnapshots` stays for unreferenced snapshots.
- Sweep additions in the processor: re-enqueue orphans (active/NULL-snapshot embeddable chunks with `embedding IS NULL` and no live `embed:<id>` job); complete `processing` jobs whose chunk already has a vector; supersede jobs of inactive knowledge-item chunks (claim/sweep currently ignore `active`).
- `src/queue-worker.ts`: run payload prune for all projects daily (drop the single-project restriction).
- One-off `src/knowledge-maintenance.ts` + `npm run knowledge:maintenance -- [--dry-run]`:
  1. report counts (dry-run default);
  2. backfill `embedding_cache` from existing embedded active chunks whose normalized text is ≤1,500 chars (TS computes hashes, batches of 500) — warm start so the v3 re-chunk mostly hits cache;
  3. payload prune in batches; 4. orphan/stuck repair;
  5. if `PROJECT_KNOWLEDGE_MIGRATION_DATABASE_URL` is set: `VACUUM (ANALYZE) project_knowledge.search_chunks` and `REINDEX INDEX CONCURRENTLY search_chunks_embedding_hnsw` (outside a transaction); otherwise print the commands.

### Delegation (Codex implements, Claude checks and hands off)
Codex's sandbox cannot commit, edit `.codex/`, or run vitest, and auto worktrees start from `origin/master`. So Claude creates each worktree from local `master` (`.worktrees/emb-*`, `node_modules` junction), writes a self-contained brief, and Codex (`codex:codex-rescue`, edit-only, may run `tsc --noEmit`) implements code + tests. Claude reviews the diff, runs typecheck/eslint/vitest/build, fixes or sends follow-ups to the same Codex session, commits, and merges `--no-ff`.

| Phase | Codex task | Worktree / branch | Scope |
|---|---|---|---|
| 1 (parallel) | **E1 cache foundation** | `emb-cache` / `feat/embedding-cache` | Section A + processor sweep repairs from C (orphan re-enqueue, stuck `processing`, inactive knowledge-item jobs) |
| 1 (parallel) | **E2 payload pruning** | `emb-prune` / `feat/snapshot-payload-prune` | `pruneSupersededSnapshotPayload`, all-project daily run in `queue-worker.ts` |
| 2 (after E1 merge) | **E3 embedding policy** | `emb-policy` / `feat/embedding-policy` | Section B (parser v3, file_summary, splitting, enqueue policy/priorities, embed_hash on insert, vector-search snapshot fix) |
| 2 (after E1+E2) | **E4 maintenance CLI** | `emb-maint` / `feat/knowledge-maintenance` | `knowledge-maintenance.ts` (dry-run report, cache backfill, batched prune, repair, VACUUM/REINDEX) |

E1/E2 touch disjoint files; E3/E4 touch disjoint files. Claude alone runs the rollout below (migrations, maintenance, deploy, restarts) after merges, pausing for the user before the first destructive maintenance run (after reviewing the dry-run counts).

### Rollout order
1. Code + tests (A, B, C) on a branch, merge `--no-ff` to master.
2. `scripts/migrate-project-knowledge.ps1` (migration 0011).
3. `npm run knowledge:maintenance -- --dry-run`, review counts, then run for real.
4. Redeploy Debian queue worker: `scripts/deploy-queue-worker.ps1` (health-checked, auto-rollback).
5. Restart local scheduled tasks (`ObsidianProjectKnowledgeWorker`, `ObsidianProjectKnowledgeActivity`); MCP servers pick up on next session.
6. Re-sync ObsidianConnector and MC-Platform (`scripts/sync-project-knowledge.ps1 … -Wait`) to apply parser v3.

## Critical files
`src/knowledge/migrations.ts`, `src/worker/embedding-queue-processor.ts`, `src/worker/knowledge-worker.ts`, `src/worker/source-parser.ts`, `src/worker/snapshot-cleanup.ts`, `src/knowledge/pg-store.ts` (vector query, knowledge-item chunk insert, `createPgKnowledgeStore`), `src/queue-worker.ts`, new `src/knowledge/embed-text.ts`, `src/knowledge/embedding-cache.ts`, `src/knowledge-maintenance.ts`, `package.json` (script).

## Verification
- Unit tests (existing fake-pool style): `embedding-worker.test.ts` (cache hit skips model; misses deduped by hash; unnest apply; orphan re-enqueue; stuck processing completed), `snapshot-cleanup.test.ts` (payload prune keeps snapshot row and evidence-referenced chunks, all projects), `source-parser.test.ts` (file_summary stable under body edits; ≤1,500-char doc splits), new `embed-text.test.ts`, `embedding-cache.test.ts` (LRU/DB/model fallthrough, query prefix), `knowledge-migrations.test.ts`, vector-query test in `pg-knowledge-store.test.ts`.
- `npm run typecheck`, `npx eslint src tests`, `npx vitest run tests/unit`, `npm run build`.
- Live (after rollout): re-run the read-only stats script — expect superseded chunk rows ≈0, no active embeddable chunk without vector or job, `processing` ≈0, cache rows ≈ distinct embeddable texts; second sync of an unchanged worktree enqueues 0 model calls (all `cache_hit`); `recall_project_knowledge` / hybrid `search_project_context` still return results; `npm run activity:doctor` passes; queue worker health shows the new release.
