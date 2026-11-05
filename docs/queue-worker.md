# Shared project-knowledge workers

One `linux/amd64` image runs with capabilities selected by environment variables. Debian runs an `embedding` service and a separate `scheduler,maintenance` service continuously. Docker Desktop starts `source-sync,publish` on demand with the projects mount read-only and the Obsidian vault mount read-write. PostgreSQL is the queue and canonical coordination store; queue payloads contain identifiers rather than file contents.

Build and deploy with dry runs first:

```powershell
$build = .\scripts\build-shared-worker-image.ps1 -WhatIf
.\scripts\migrate-project-knowledge.ps1 -WhatIf
.\scripts\deploy-queue-worker.ps1 -Image '<registry image@sha256 digest>' -Release '<content hash>' -WhatIf
```

Apply the migration, build and push the image, then deploy the returned digest:

```powershell
.\scripts\migrate-project-knowledge.ps1
$image = .\scripts\build-shared-worker-image.ps1 | ConvertFrom-Json
.\scripts\deploy-queue-worker.ps1 -Image $image.image -Release $image.release
$env:PROJECT_KNOWLEDGE_WORKER_IMAGE = $image.image
```

The Debian profile uses host networking, a 512 MB memory limit, a 384 MB Node heap, and embedding batches of 16. The scheduler holds a dedicated PostgreSQL advisory lock, so processing replicas can be scaled while only one instance creates hourly requests. Leases and `FOR UPDATE SKIP LOCKED` prevent simultaneous claims. Expired portable work returns to its original capability; source jobs continue waiting for Windows.

Apply migrations `0014_embedding_compute_leases`, `0015_retrieval_epochs`, and `0016_worker_maintenance_schedule` before starting the updated connector and workers. Query and document inference share renewable PostgreSQL computation leases keyed by model identity and the exact input hash. Separate workers claiming different chunks with identical text therefore share one computation. Publication and failure updates check the job owner, attempt, and lease; an expired worker cannot overwrite a reclaimed job. Processing workers release database connections while waiting for inference.

After updating the model service, `RETRIEVAL_MODEL_MAX_CONCURRENCY` bounds all inference and `RETRIEVAL_MODEL_MAX_BACKGROUND` bounds background embeddings. Defaults are two total slots and one background slot, reserving capacity for queries and reranking. One-slot deployments prioritize waiting interactive requests without starving an already running background computation. These limits are per model-service process; independently scaling model-service processes requires an aggregate resource budget.

Scale only the `queue-worker` service, for example with `docker compose ... up -d --scale queue-worker=3`; keep `queue-maintenance` separate. Orphan repair uses a shared ten-minute schedule, and daily maintenance uses a renewable lease with a short retry after failure. More processing replicas do not increase the model service's global capacity within that process. Measure unique model inputs, cache hits, queue age, and query latency before increasing concurrency.

Run an on-demand source synchronization:

```powershell
.\scripts\sync-project-knowledge.ps1 `
  -ProjectKey MC-Platform `
  -WorktreePath 'C:\Users\luann\Documents\MC-Platform' `
  -Wait
```

The command inserts or reuses one live `source_sync` job for the worktree, starts the Windows Compose worker, and waits for the PostgreSQL receipt. The receipt includes the final content-aware fingerprint, snapshot ID, whether the snapshot was created or reused, child queue counts, assigned worker, projection state, pending count, and failures. Completion is recorded only when the final source fingerprint matches the requested source.

If compact status reports only pending projection work, finalize generated vault notes without a model call:

```powershell
.\scripts\finalize-project-projection.ps1 `
  -ProjectKey MC-Platform `
  -WorktreePath 'C:\Users\luann\Documents\MC-Platform' `
  -Wait
```

The finalizer runs the status-first projection path in deep mode, publishes managed `Published/` notes from PostgreSQL state, waits up to five minutes by default, and exits nonzero when failed jobs, projection conflicts, stale projections, or pending jobs remain.

The Windows profile does not enable embedding while a fresh Debian embedding heartbeat exists. A Windows fallback instance may include `embedding`; it begins portable work only after the Debian heartbeat becomes stale. Embedding content is coalesced by project and content hash, so one model response fans out to matching current chunks.

Source synchronization stages parsing and tokenization before its activation transaction, checks file hashes before replacing dirty files, copies only retained rows, and reuses compatible vectors before enqueueing misses. Activation is serialized by worktree and rechecks the source fingerprint. Canonical documents bind to that worktree's exact snapshot and use item-level version/hash checks.

Knowledge metadata and evidence-only updates retain compatible embeddings while preserving new versions and citations. Recall caches at most 64 requests for up to 30 seconds, bounded by claim expiry. Transactional retrieval epochs invalidate cached results for source, knowledge, freshness, and vector changes; worker heartbeats do not invalidate them. An unchanged recall still validates its epoch, but skips retrieval and reranking. A missing epoch migration disables recall caching; a missing computation-lease migration makes semantic retrieval degrade to lexical search with a warning.

Maintenance keeps retired jobs auditable as `superseded`. It deletes only superseded snapshots older than seven days that have no source evidence, task, file activity, note projection, or domain synchronization references. Separately, the daily payload cleanup removes the chunks, symbols, and unreferenced files of superseded snapshots older than two days (`PROJECT_KNOWLEDGE_SNAPSHOT_PAYLOAD_RETENTION_DAYS`) for every project while keeping the snapshot rows and evidence-referenced chunks. Embedding vectors are cached by normalized content hash in `embedding_cache`, so re-indexed or copied content is not embedded again.

Run the isolated PostgreSQL concurrency suite with Docker Desktop running:

```powershell
.\scripts\test-parallel-knowledge.ps1
```

The script creates a fresh localhost-only database using a digest-pinned ParadeDB image, applies the migrations, runs the parallel integration suite plus the legacy retrieval tests with isolated fixtures, and removes its container. It does not use live knowledge credentials. The suite covers duplicate inference, stale leases, default versus explicit historical snapshots, freshness invalidation, source/knowledge write concurrency, and vector reuse. Run `python -B services/retrieval-model/test_server.py` separately for model admission tests, as well as the repository TypeScript checks.
